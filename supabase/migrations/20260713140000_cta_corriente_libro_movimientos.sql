-- ============================================================
-- Cuenta corriente: libro de movimientos (arquitectura de MesaYa)
--
-- Reemplaza el cálculo ad-hoc "suma de ventas − suma de cobranzas" (con imputación
-- FIFO) por un LIBRO DE MOVIMIENTOS único, como en MesaYa:
--
--   · Cada comprobante que va a cuenta corriente genera un DEBITO (sube la deuda).
--   · Cada cobranza y cada nota de crédito a cuenta genera un CREDITO (baja la deuda).
--   · El saldo del cliente NUNCA se guarda: se deriva siempre de Σ DÉBITOS − Σ
--     CRÉDITOS. Así no puede descuadrar con la realidad.
--
-- Diferencia con MesaYa a pedido: SE SACA el flujo de confirmación (el "fiado
-- pendiente" que un encargado tiene que aprobar). Acá todo movimiento nace
-- CONFIRMADO y cuenta al instante. El estado ANULADO queda sólo para cuando se
-- anula el comprobante que lo originó.
--
-- La cuenta es el propio cliente (clientes.condicion_cta_cte), no una entidad
-- aparte: es lo que corresponde a una pinturería (a diferencia del restaurante,
-- que separa persona/empresa/socio).
-- ============================================================

CREATE TYPE public.cc_mov_tipo AS ENUM ('DEBITO', 'CREDITO');
CREATE TYPE public.cc_mov_estado AS ENUM ('CONFIRMADO', 'ANULADO');

CREATE TABLE public.cuenta_corriente_movimientos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id   uuid NOT NULL REFERENCES public.clientes(id),
  sucursal_id  uuid NOT NULL REFERENCES public.sucursales(id),
  tipo         public.cc_mov_tipo NOT NULL,
  -- Siempre > 0. El signo lo da el tipo (DEBITO suma, CREDITO resta).
  monto        numeric(14,2) NOT NULL CHECK (monto > 0),
  estado       public.cc_mov_estado NOT NULL DEFAULT 'CONFIRMADO',

  -- Documento que originó el movimiento. Uno de los dos, según el caso.
  -- venta_id UNIQUE: idempotencia dura, una venta genera UN solo movimiento.
  venta_id     uuid UNIQUE REFERENCES public.ventas(id) ON DELETE CASCADE,
  cobranza_id  uuid UNIQUE REFERENCES public.cobranzas_cta_cte(id) ON DELETE CASCADE,

  forma_pago   text,   -- sólo en CRÉDITOS que vienen de una cobranza
  descripcion  text,
  usuario_id   uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ccmov_cliente ON public.cuenta_corriente_movimientos (cliente_id, estado);
CREATE INDEX idx_ccmov_sucfecha ON public.cuenta_corriente_movimientos (sucursal_id, created_at DESC);

GRANT SELECT ON public.cuenta_corriente_movimientos TO authenticated;
GRANT ALL ON public.cuenta_corriente_movimientos TO service_role;
ALTER TABLE public.cuenta_corriente_movimientos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ccmov select" ON public.cuenta_corriente_movimientos
  FOR SELECT TO authenticated USING (
    public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id()
  );
-- Escritura sólo desde las funciones SECURITY DEFINER (crear_venta / registrar_
-- cobranza / anular_venta). Nadie inserta un movimiento a mano.


-- ------------------------------------------------------------
-- Saldo de un cliente: Σ DÉBITOS − Σ CRÉDITOS, sólo CONFIRMADOS. Derivado.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cc_saldo(_cliente_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(CASE WHEN tipo = 'DEBITO' THEN monto ELSE -monto END), 0)
    FROM public.cuenta_corriente_movimientos
   WHERE cliente_id = _cliente_id AND estado = 'CONFIRMADO';
$$;
GRANT EXECUTE ON FUNCTION public.cc_saldo(uuid) TO authenticated;

-- Saldos de todos los clientes con cuenta corriente, en una consulta.
CREATE OR REPLACE VIEW public.cuenta_corriente_saldos
WITH (security_invoker = true) AS
SELECT
  c.id AS cliente_id,
  c.razon_social,
  c.cuit_dni,
  c.telefono,
  c.limite_credito,
  COALESCE(SUM(CASE WHEN m.tipo = 'DEBITO' THEN m.monto ELSE 0 END), 0) AS total_debe,
  COALESCE(SUM(CASE WHEN m.tipo = 'CREDITO' THEN m.monto ELSE 0 END), 0) AS total_pagado,
  COALESCE(SUM(CASE WHEN m.tipo = 'DEBITO' THEN m.monto ELSE -m.monto END), 0) AS saldo
FROM public.clientes c
LEFT JOIN public.cuenta_corriente_movimientos m
  ON m.cliente_id = c.id AND m.estado = 'CONFIRMADO'
WHERE c.condicion_cta_cte = true AND c.activo = true
GROUP BY c.id, c.razon_social, c.cuit_dni, c.telefono, c.limite_credito;
GRANT SELECT ON public.cuenta_corriente_saldos TO authenticated, service_role;


-- ------------------------------------------------------------
-- Helper: registra el movimiento que corresponde a una venta que va a cuenta
-- corriente. Se llama desde crear_venta.
--   · NOTA_CREDITO  -> CRÉDITO (baja la deuda)
--   · el resto (facturas, remitos, notas de débito) -> DÉBITO (sube la deuda)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cc_registrar_por_venta(_venta_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.ventas%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.ventas WHERE id = _venta_id;
  IF NOT FOUND OR v.condicion_venta <> 'CTA_CTE' THEN
    RETURN;
  END IF;

  INSERT INTO public.cuenta_corriente_movimientos (
    cliente_id, sucursal_id, tipo, monto, venta_id, descripcion, usuario_id
  ) VALUES (
    v.cliente_id, v.sucursal_id,
    -- El CASE unifica los dos literales como text; hay que castear al enum.
    (CASE WHEN v.tipo_comprobante = 'NOTA_CREDITO' THEN 'CREDITO' ELSE 'DEBITO' END)::public.cc_mov_tipo,
    ABS(v.total),
    v.id,
    v.tipo_comprobante::text || ' ' || v.numero_comprobante,
    v.usuario_id
  )
  ON CONFLICT (venta_id) DO NOTHING;
END; $$;


-- ------------------------------------------------------------
-- crear_venta: al final, si la venta va a cuenta corriente, registra el movimiento.
-- (Sólo cambia el bloque final; el resto de la función queda igual.)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crear_venta(
  p_sucursal_id      uuid,
  p_cliente_id       uuid,
  p_tipo_comprobante public.tipo_comprobante,
  p_condicion_venta  public.condicion_venta,
  p_items            jsonb,
  p_pagos            jsonb,
  p_percepciones     numeric DEFAULT 0,
  p_observaciones    text    DEFAULT NULL,
  p_nombre_obra      text    DEFAULT NULL,
  p_fecha            timestamptz DEFAULT NULL,
  p_cbte_asoc_id     uuid    DEFAULT NULL
)
RETURNS TABLE (venta_id uuid, numero text, es_cta_cte boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_permite_neg    boolean;
  v_numero         text;
  v_venta_id       uuid;
  v_es_cta_cte     boolean;
  v_signo          integer;
  v_cliente        public.clientes%ROWTYPE;
  v_sub_sin_iva    numeric(14,2) := 0;
  v_iva_total      numeric(14,2) := 0;
  v_total          numeric(14,2);
  v_percepciones   numeric(14,2);
  v_total_pagado   numeric(14,2) := 0;
  v_pagos_suma     numeric(14,2) := 0;
  v_vuelto         numeric(14,2) := 0;
  v_estado_pago    public.estado_pago;
  it               jsonb;
  pg               jsonb;
  v_prod           public.productos%ROWTYPE;
  v_cant           numeric(14,2);
  v_desc           numeric(5,2);
  v_precio         numeric(14,2);
  v_precio_lista   numeric(14,2);
  v_sub_item       numeric(14,2);
  v_iva_item       numeric(14,2);
  v_stock_ant      numeric(14,2);
  v_stock_nue      numeric(14,2);
  v_calc           jsonb := '[]'::jsonb;
  v_saldo_actual   numeric(14,2);
  v_monto          numeric(14,2);
  v_forma          public.forma_pago;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés facturar en una sucursal que no es la tuya';
  END IF;

  SELECT * INTO v_cliente FROM public.clientes WHERE id = p_cliente_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  IF COALESCE(p_percepciones, 0) < 0 THEN
    RAISE EXCEPTION 'Las percepciones no pueden ser negativas';
  END IF;

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg
    FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);

  v_signo := CASE WHEN p_tipo_comprobante = 'NOTA_CREDITO' THEN -1 ELSE 1 END;

  IF p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') THEN
    IF p_cbte_asoc_id IS NULL THEN
      RAISE EXCEPTION 'Una nota de crédito/débito tiene que indicar el comprobante que rectifica';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.ventas
       WHERE id = p_cbte_asoc_id AND cliente_id = p_cliente_id
         AND tipo_comprobante IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C')
    ) THEN
      RAISE EXCEPTION 'El comprobante a rectificar no existe o no es una factura de este cliente';
    END IF;
  END IF;

  v_es_cta_cte := p_tipo_comprobante IN ('REMITO', 'REMITO_OBRA', 'FAC_INTERNA_CTA_CTE')
                  OR p_condicion_venta = 'CTA_CTE';

  IF v_es_cta_cte AND p_tipo_comprobante NOT IN ('NOTA_CREDITO', 'NOTA_DEBITO')
     AND NOT COALESCE(v_cliente.condicion_cta_cte, false) THEN
    RAISE EXCEPTION 'El cliente % no tiene cuenta corriente habilitada', v_cliente.razon_social;
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    SELECT * INTO v_prod FROM public.productos
      WHERE id = (it->>'producto_id')::uuid AND activo
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto % inexistente o inactivo', it->>'producto_id';
    END IF;

    v_cant := COALESCE((it->>'cantidad')::numeric, 0);
    v_desc := LEAST(GREATEST(COALESCE((it->>'descuento_porcentaje')::numeric, 0), 0), 100);
    IF v_cant < 0 THEN
      RAISE EXCEPTION 'Cantidad negativa en el producto %', v_prod.codigo;
    END IF;

    v_precio_lista := v_prod.precio_sin_iva;
    v_precio := COALESCE((it->>'precio_unitario_sin_iva')::numeric, v_precio_lista);
    IF v_precio < 0 THEN
      RAISE EXCEPTION 'Precio negativo en el producto %', v_prod.codigo;
    END IF;

    v_sub_item := ROUND(v_precio * (1 - v_desc / 100) * v_cant, 2) * v_signo;
    v_iva_item := ROUND(v_sub_item * v_prod.iva_porcentaje / 100, 2);

    v_sub_sin_iva := v_sub_sin_iva + v_sub_item;
    v_iva_total   := v_iva_total   + v_iva_item;

    v_calc := v_calc || jsonb_build_object(
      'producto_id', v_prod.id, 'codigo', v_prod.codigo, 'descripcion', v_prod.nombre,
      'cantidad', v_cant, 'precio', v_precio, 'precio_lista', v_precio_lista,
      'iva_porcentaje', v_prod.iva_porcentaje, 'descuento', v_desc,
      'sub_item', v_sub_item, 'iva_item', v_iva_item
    );
  END LOOP;

  v_percepciones := ROUND(COALESCE(p_percepciones, 0), 2) * v_signo;
  v_total := ROUND(v_sub_sin_iva + v_iva_total + v_percepciones, 2);

  IF NOT v_es_cta_cte THEN
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := COALESCE((pg->>'monto')::numeric, 0);
      IF v_monto < 0 THEN
        RAISE EXCEPTION 'Un pago no puede ser negativo';
      END IF;
      v_pagos_suma := v_pagos_suma + v_monto;
    END LOOP;

    IF v_pagos_suma > ABS(v_total) THEN
      v_vuelto := ROUND(v_pagos_suma - ABS(v_total), 2);
    END IF;
    v_total_pagado := ROUND(LEAST(v_pagos_suma, ABS(v_total)), 2) * v_signo;
  END IF;

  v_estado_pago := CASE
    WHEN v_es_cta_cte THEN 'PENDIENTE'::public.estado_pago
    WHEN ABS(v_total_pagado) >= ABS(v_total) - 0.01 THEN 'PAGADO'::public.estado_pago
    WHEN ABS(v_total_pagado) > 0 THEN 'PARCIAL'::public.estado_pago
    ELSE 'PENDIENTE'::public.estado_pago
  END;

  -- Límite de crédito: se compara contra el SALDO del libro de movimientos.
  IF v_es_cta_cte AND v_cliente.limite_credito IS NOT NULL AND v_signo > 0
     AND p_tipo_comprobante <> 'NOTA_CREDITO' THEN
    v_saldo_actual := public.cc_saldo(p_cliente_id);
    IF v_saldo_actual + ABS(v_total) > v_cliente.limite_credito THEN
      RAISE EXCEPTION 'Supera el límite de crédito del cliente (límite %, saldo actual %, esta venta %)',
        v_cliente.limite_credito, v_saldo_actual, ABS(v_total);
    END IF;
  END IF;

  v_numero := public.next_comprobante_numero(p_sucursal_id, p_tipo_comprobante);

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, fecha, numero_comprobante, tipo_comprobante,
    condicion_venta, subtotal_sin_iva, iva_total, percepciones, total, total_pagado,
    estado_pago, observaciones, nombre_obra, afip_cbte_asoc_id
  ) VALUES (
    p_sucursal_id, p_cliente_id, v_uid, COALESCE(p_fecha, now()), v_numero, p_tipo_comprobante,
    CASE WHEN v_es_cta_cte THEN 'CTA_CTE'::public.condicion_venta ELSE p_condicion_venta END,
    v_sub_sin_iva, v_iva_total, v_percepciones, v_total, v_total_pagado,
    v_estado_pago, p_observaciones, p_nombre_obra, p_cbte_asoc_id
  ) RETURNING id INTO v_venta_id;

  FOR it IN SELECT * FROM jsonb_array_elements(v_calc)
  LOOP
    v_cant := (it->>'cantidad')::numeric;

    INSERT INTO public.venta_items (
      venta_id, producto_id, codigo, descripcion, cantidad,
      precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
      subtotal_sin_iva, iva_monto, subtotal_con_iva
    ) VALUES (
      v_venta_id, (it->>'producto_id')::uuid, it->>'codigo', it->>'descripcion', v_cant,
      (it->>'precio')::numeric, (it->>'precio_lista')::numeric,
      (it->>'iva_porcentaje')::numeric, (it->>'descuento')::numeric,
      (it->>'sub_item')::numeric, (it->>'iva_item')::numeric,
      (it->>'sub_item')::numeric + (it->>'iva_item')::numeric
    );

    CONTINUE WHEN p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') OR v_cant = 0;

    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES ((it->>'producto_id')::uuid, p_sucursal_id, -v_cant)
      ON CONFLICT (producto_id, sucursal_id)
      DO UPDATE SET cantidad = stock_sucursal.cantidad - v_cant
      RETURNING cantidad + v_cant, cantidad INTO v_stock_ant, v_stock_nue;
    ELSE
      UPDATE public.stock_sucursal
         SET cantidad = cantidad - v_cant
       WHERE producto_id = (it->>'producto_id')::uuid
         AND sucursal_id = p_sucursal_id
         AND cantidad >= v_cant
      RETURNING cantidad + v_cant, cantidad INTO v_stock_ant, v_stock_nue;

      IF NOT FOUND THEN
        SELECT COALESCE(cantidad, 0) INTO v_stock_ant
          FROM public.stock_sucursal
         WHERE producto_id = (it->>'producto_id')::uuid AND sucursal_id = p_sucursal_id;
        RAISE EXCEPTION 'Stock insuficiente de % (%): hay %, se piden %',
          it->>'descripcion', it->>'codigo', COALESCE(v_stock_ant, 0), v_cant;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      (it->>'producto_id')::uuid, p_sucursal_id, 'VENTA', -v_cant, v_stock_ant, v_stock_nue,
      p_tipo_comprobante::text || ' ' || v_numero, v_venta_id, v_uid
    );
  END LOOP;

  IF NOT v_es_cta_cte THEN
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := ROUND(ABS(COALESCE((pg->>'monto')::numeric, 0)), 2);
      v_forma := (pg->>'forma_pago')::public.forma_pago;

      IF v_vuelto > 0 AND v_forma = 'EFECTIVO' THEN
        IF v_monto >= v_vuelto THEN
          v_monto := v_monto - v_vuelto;
          v_vuelto := 0;
        ELSE
          v_vuelto := v_vuelto - v_monto;
          v_monto := 0;
        END IF;
      END IF;

      CONTINUE WHEN v_monto = 0;

      INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
      VALUES (v_venta_id, v_forma, v_monto * v_signo, COALESCE(pg->'detalle', '{}'::jsonb));
    END LOOP;
  END IF;

  -- LIBRO DE CUENTA CORRIENTE: si va a cuenta, registra el movimiento.
  IF v_es_cta_cte THEN
    PERFORM public.cc_registrar_por_venta(v_venta_id);
  END IF;

  RETURN QUERY SELECT v_venta_id, v_numero, v_es_cta_cte;
END; $$;

REVOKE ALL ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid) TO authenticated;


-- ------------------------------------------------------------
-- registrar_cobranza: ahora sólo registra el cobro y su CRÉDITO en el libro.
-- Se retira la imputación FIFO (el saldo sale del libro, no de imputar por factura).
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.registrar_cobranza(uuid, uuid, numeric, text, jsonb, text);

CREATE OR REPLACE FUNCTION public.registrar_cobranza(
  p_cliente_id    uuid,
  p_sucursal_id   uuid,
  p_monto         numeric,
  p_forma_pago    text,
  p_detalle       jsonb DEFAULT '{}'::jsonb,
  p_observaciones text  DEFAULT NULL
)
RETURNS TABLE (cobranza_id uuid, saldo numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_cobranza_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés cobrar en una sucursal que no es la tuya';
  END IF;

  IF COALESCE(p_monto, 0) <= 0 THEN
    RAISE EXCEPTION 'El monto del cobro debe ser mayor a cero';
  END IF;

  INSERT INTO public.cobranzas_cta_cte (
    cliente_id, sucursal_id, usuario_id, monto, forma_pago, detalle, observaciones
  ) VALUES (
    p_cliente_id, p_sucursal_id, v_uid, p_monto, p_forma_pago,
    COALESCE(p_detalle, '{}'::jsonb), p_observaciones
  ) RETURNING id INTO v_cobranza_id;

  -- El cobro es un CRÉDITO: baja la deuda del cliente.
  INSERT INTO public.cuenta_corriente_movimientos (
    cliente_id, sucursal_id, tipo, monto, cobranza_id, forma_pago, descripcion, usuario_id
  ) VALUES (
    p_cliente_id, p_sucursal_id, 'CREDITO', ROUND(p_monto, 2), v_cobranza_id, p_forma_pago,
    'Cobro cuenta corriente', v_uid
  );

  RETURN QUERY SELECT v_cobranza_id, public.cc_saldo(p_cliente_id);
END; $$;

REVOKE ALL ON FUNCTION public.registrar_cobranza(uuid, uuid, numeric, text, jsonb, text) FROM public;
GRANT EXECUTE ON FUNCTION public.registrar_cobranza(uuid, uuid, numeric, text, jsonb, text) TO authenticated;


-- ------------------------------------------------------------
-- anular_venta: al anular una venta de cuenta corriente, su DÉBITO/CRÉDITO se
-- ANULA (sale del saldo). La nota de crédito de anulación va en CONTADO, así que
-- NO genera movimiento (no habría que sumarla al saldo).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anular_venta(p_venta_id uuid)
RETURNS TABLE (nc_id uuid, nc_numero text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_v         public.ventas%ROWTYPE;
  v_numero    text;
  v_nc_id     uuid;
  r           RECORD;
  v_stock_ant numeric(14,2);
  v_stock_nue numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_v FROM public.ventas WHERE id = p_venta_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  IF NOT public.is_admin(v_uid) AND v_v.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés anular una venta de otra sucursal';
  END IF;

  IF v_v.estado = 'ANULADA' THEN
    RAISE EXCEPTION 'La venta ya fue anulada';
  END IF;

  IF v_v.tipo_comprobante NOT IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C',
                                  'REMITO', 'REMITO_OBRA', 'FAC_INTERNA_CTA_CTE') THEN
    RAISE EXCEPTION 'Una % no se anula (las notas se corrigen con otra nota)', v_v.tipo_comprobante;
  END IF;

  v_numero := public.next_comprobante_numero(v_v.sucursal_id, 'NOTA_CREDITO');

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, numero_comprobante, tipo_comprobante,
    condicion_venta, subtotal_sin_iva, iva_total, percepciones, total, total_pagado,
    estado_pago, observaciones, afip_cbte_asoc_id
  ) VALUES (
    v_v.sucursal_id, v_v.cliente_id, v_uid, v_numero, 'NOTA_CREDITO',
    'CONTADO', -v_v.subtotal_sin_iva, -v_v.iva_total, -v_v.percepciones,
    -v_v.total, 0, 'PENDIENTE',
    'Nota de crédito por anulación de ' || v_v.numero_comprobante,
    v_v.id
  ) RETURNING id INTO v_nc_id;

  INSERT INTO public.venta_items (
    venta_id, producto_id, codigo, descripcion, cantidad,
    precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
    subtotal_sin_iva, iva_monto, subtotal_con_iva
  )
  SELECT
    v_nc_id, producto_id, codigo, descripcion, cantidad,
    precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
    -subtotal_sin_iva, -iva_monto, -subtotal_con_iva
  FROM public.venta_items WHERE venta_id = v_v.id;

  UPDATE public.ventas
     SET estado = 'ANULADA', venta_anulada_por = v_nc_id
   WHERE id = v_v.id;

  -- Anula el movimiento de cuenta corriente que había generado la venta original.
  UPDATE public.cuenta_corriente_movimientos
     SET estado = 'ANULADO'
   WHERE venta_id = v_v.id AND estado = 'CONFIRMADO';

  FOR r IN SELECT producto_id, cantidad FROM public.venta_items WHERE venta_id = v_v.id
  LOOP
    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
    VALUES (r.producto_id, v_v.sucursal_id, r.cantidad)
    ON CONFLICT (producto_id, sucursal_id)
    DO UPDATE SET cantidad = stock_sucursal.cantidad + r.cantidad
    RETURNING cantidad - r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      r.producto_id, v_v.sucursal_id, 'ANULACION_VENTA', r.cantidad, v_stock_ant, v_stock_nue,
      'Anulación ' || v_v.numero_comprobante, v_v.id, v_uid
    );
  END LOOP;

  RETURN QUERY SELECT v_nc_id, v_numero;
END; $$;

REVOKE ALL ON FUNCTION public.anular_venta(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid) TO authenticated;


-- ------------------------------------------------------------
-- Se retira la imputación FIFO por comprobante: el saldo ahora sale del libro.
-- (La base no tiene datos reales todavía, así que no hay nada que migrar.)
-- ------------------------------------------------------------
DROP TABLE IF EXISTS public.cobranza_imputaciones;
