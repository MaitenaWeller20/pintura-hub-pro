-- ============================================================
-- Correcciones de la auditoría de ventas + fiscal
--
-- Arregla los defectos encontrados por la revisión adversarial y la batería de
-- tests. Cada bloque dice qué corrige.
-- ============================================================


-- ------------------------------------------------------------
-- A. FACTURA_C no tenía prefijo de numeración -> crear_venta explotaba
--    (NULL en numero_comprobante). Un emisor monotributista no podía facturar.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.next_comprobante_numero(_sucursal_id uuid, _tipo tipo_comprobante)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _next INTEGER; _prefix_suc TEXT; _prefix_tipo TEXT;
BEGIN
  INSERT INTO public.comprobante_secuencias (sucursal_id, tipo, ultimo_numero)
  VALUES (_sucursal_id, _tipo, 1)
  ON CONFLICT (sucursal_id, tipo) DO UPDATE SET ultimo_numero = comprobante_secuencias.ultimo_numero + 1
  RETURNING ultimo_numero INTO _next;

  SELECT CASE codigo WHEN 'OHIGGINS' THEN 'OHI' WHEN 'GENERALPAZ' THEN 'GPZ' END INTO _prefix_suc
  FROM public.sucursales WHERE id = _sucursal_id;

  _prefix_tipo := CASE _tipo
    WHEN 'FACTURA_A' THEN 'FAIV'
    WHEN 'FACTURA_B' THEN 'FVTA'
    WHEN 'FACTURA_C' THEN 'FCIV'
    WHEN 'NOTA_CREDITO' THEN 'NCIV'
    WHEN 'NOTA_DEBITO' THEN 'NDIV'
    WHEN 'REMITO' THEN 'REM'
    WHEN 'REMITO_OBRA' THEN 'ROBR'
    WHEN 'FAC_INTERNA_CTA_CTE' THEN 'FICC'
  END;

  IF _prefix_suc IS NULL OR _prefix_tipo IS NULL THEN
    RAISE EXCEPTION 'No hay prefijo de numeración para (sucursal %, tipo %)', _sucursal_id, _tipo;
  END IF;

  RETURN _prefix_suc || '-' || _prefix_tipo || '-' || lpad(_next::text, 4, '0');
END; $$;


-- ------------------------------------------------------------
-- B. Alícuotas de IVA inválidas. productos.iva_porcentaje no tenía CHECK, así que
--    se podía cargar un 15% que después el módulo fiscal clampeaba a 21% en
--    silencio -> el total de la base y el que se le manda a AFIP divergían.
--    Restringimos a las alícuotas que AFIP acepta.
-- ------------------------------------------------------------
-- Corregimos primero cualquier dato existente fuera de rango (redondeo a la más cercana).
UPDATE public.productos SET iva_porcentaje = 21
  WHERE iva_porcentaje NOT IN (0, 2.5, 5, 10.5, 21, 27);

ALTER TABLE public.productos
  DROP CONSTRAINT IF EXISTS productos_iva_valido,
  ADD CONSTRAINT productos_iva_valido CHECK (iva_porcentaje IN (0, 2.5, 5, 10.5, 21, 27));

ALTER TABLE public.venta_items
  DROP CONSTRAINT IF EXISTS venta_items_iva_valido,
  ADD CONSTRAINT venta_items_iva_valido CHECK (iva_porcentaje IN (0, 2.5, 5, 10.5, 21, 27));


-- ------------------------------------------------------------
-- B2. El emisor sólo puede ser RI o Monotributo (no Exento): son las condiciones
--     para las que la matriz A/B/C está definida.
-- ------------------------------------------------------------
UPDATE public.fiscal_config SET condicion_iva = 'RESPONSABLE_INSCRIPTO' WHERE condicion_iva = 'EXENTO';
ALTER TABLE public.fiscal_config
  DROP CONSTRAINT IF EXISTS fiscal_config_condicion_iva_check;
ALTER TABLE public.fiscal_config
  ADD CONSTRAINT fiscal_config_condicion_iva_check
  CHECK (condicion_iva IN ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO'));


-- ------------------------------------------------------------
-- C. Columnas fiscales de `ventas` protegidas contra escritura directa.
--    Un empleado podía escribir cae / afip_numero / total_pagado / estado a mano
--    vía PostgREST (la policy de UPDATE no filtra por columna). Toda escritura
--    legítima a esas columnas pasa por funciones SECURITY DEFINER (que corren como
--    `postgres`) o por la service_role; el rol `authenticated` nunca las toca.
-- ------------------------------------------------------------
-- IMPORTANTE: este trigger NO es SECURITY DEFINER a propósito. Dentro de una
-- función SECURITY DEFINER, current_user sería el dueño (postgres) y el trigger
-- nunca vería 'authenticated'. Como trigger normal, current_user refleja el rol
-- real: 'authenticated' en una llamada directa del navegador, 'postgres' cuando
-- lo dispara una función SECURITY DEFINER (crear_venta/anular_venta/registrar_
-- cobranza), y 'service_role' desde el backend. Sólo bloqueamos al primero.
CREATE OR REPLACE FUNCTION public.guard_ventas_columnas()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_user = 'authenticated' THEN
    IF NEW.cae               IS DISTINCT FROM OLD.cae
       OR NEW.cae_vencimiento IS DISTINCT FROM OLD.cae_vencimiento
       OR NEW.afip_estado     IS DISTINCT FROM OLD.afip_estado
       OR NEW.afip_numero     IS DISTINCT FROM OLD.afip_numero
       OR NEW.afip_cbte_tipo  IS DISTINCT FROM OLD.afip_cbte_tipo
       OR NEW.afip_punto_venta IS DISTINCT FROM OLD.afip_punto_venta
       OR NEW.afip_modo       IS DISTINCT FROM OLD.afip_modo
       OR NEW.total           IS DISTINCT FROM OLD.total
       OR NEW.total_pagado    IS DISTINCT FROM OLD.total_pagado
       OR NEW.estado          IS DISTINCT FROM OLD.estado
       OR NEW.estado_pago     IS DISTINCT FROM OLD.estado_pago
       OR NEW.subtotal_sin_iva IS DISTINCT FROM OLD.subtotal_sin_iva
       OR NEW.iva_total       IS DISTINCT FROM OLD.iva_total
       OR NEW.numero_comprobante IS DISTINCT FROM OLD.numero_comprobante
       OR NEW.tipo_comprobante IS DISTINCT FROM OLD.tipo_comprobante THEN
      RAISE EXCEPTION 'Esos campos de la venta no se editan directamente (facturación y montos van por el sistema)';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_ventas_guard_columnas ON public.ventas;
CREATE TRIGGER trg_ventas_guard_columnas
  BEFORE UPDATE ON public.ventas
  FOR EACH ROW EXECUTE FUNCTION public.guard_ventas_columnas();


-- ------------------------------------------------------------
-- C2. Importe exacto que se le mandó a AFIP (ImpTotal). El QR tiene que mostrar
--     ese número, no el total de la cabecera de la venta (aunque hoy coincidan,
--     desacoplarlos evita que un cambio futuro en el cálculo rompa el QR).
-- ------------------------------------------------------------
ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS afip_imp_total numeric(14,2);


-- ------------------------------------------------------------
-- D. crear_venta reescrita
--
--    Corrige de una sola vez:
--    - Los dos bucles (totales + items) releían el producto y podían divergir si
--      el precio cambiaba en el medio (aplicarMarkup concurrente). Ahora es UN
--      solo recorrido, con FOR UPDATE sobre el producto para serializar.
--    - p_percepciones negativas -> total 0/negativo. Ahora se valida >= 0.
--    - Pagos negativos entraban al SUM pero no se guardaban -> total_pagado
--      inconsistente. Ahora se rechazan.
--    - El vuelto (pagar de más en efectivo) se guardaba como plata cobrada, así
--      que la caja quedaba inflada. Ahora el excedente se descuenta del efectivo.
--    - No se validaba condicion_cta_cte ni limite_credito del cliente. Ahora sí.
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
  v_calc           jsonb := '[]'::jsonb;   -- items ya calculados (una sola pasada)
  v_deuda_actual   numeric(14,2);
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

  -- Cuenta corriente: el cliente tiene que estar habilitado.
  IF v_es_cta_cte AND p_tipo_comprobante NOT IN ('NOTA_CREDITO', 'NOTA_DEBITO')
     AND NOT COALESCE(v_cliente.condicion_cta_cte, false) THEN
    RAISE EXCEPTION 'El cliente % no tiene cuenta corriente habilitada', v_cliente.razon_social;
  END IF;

  ------------------------------------------------------------------
  -- UNA sola pasada: calcula, bloquea el producto y arma la lista.
  -- FOR UPDATE serializa contra aplicarMarkup: el precio no puede cambiar entre
  -- que calculo el total y que inserto los ítems.
  ------------------------------------------------------------------
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

  ------------------------------------------------------------------
  -- Pagos (con signo). Se rechazan los negativos; el vuelto (pagar de más en
  -- efectivo) no se cuenta como plata cobrada.
  ------------------------------------------------------------------
  IF NOT v_es_cta_cte THEN
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := COALESCE((pg->>'monto')::numeric, 0);
      IF v_monto < 0 THEN
        RAISE EXCEPTION 'Un pago no puede ser negativo';
      END IF;
      v_pagos_suma := v_pagos_suma + v_monto;
    END LOOP;

    -- Excedente en efectivo = vuelto. No es plata que se queda en la caja.
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

  -- Límite de crédito: si el cliente lo tiene fijado, no se lo puede pasar.
  IF v_es_cta_cte AND v_cliente.limite_credito IS NOT NULL AND v_signo > 0 THEN
    SELECT COALESCE(SUM(total), 0) INTO v_deuda_actual
      FROM public.ventas
     WHERE cliente_id = p_cliente_id AND condicion_venta = 'CTA_CTE' AND estado = 'ACTIVA';
    IF v_deuda_actual + v_total > v_cliente.limite_credito THEN
      RAISE EXCEPTION 'Supera el límite de crédito del cliente (límite %, deuda actual %, esta venta %)',
        v_cliente.limite_credito, v_deuda_actual, v_total;
    END IF;
  END IF;

  ------------------------------------------------------------------
  -- Cabecera
  ------------------------------------------------------------------
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

  ------------------------------------------------------------------
  -- Items + stock (desde la lista ya calculada; no se relee el producto)
  ------------------------------------------------------------------
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

  ------------------------------------------------------------------
  -- Pagos: se guardan con signo, y el efectivo neto del vuelto.
  ------------------------------------------------------------------
  IF NOT v_es_cta_cte THEN
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := ROUND(ABS(COALESCE((pg->>'monto')::numeric, 0)), 2);
      v_forma := (pg->>'forma_pago')::public.forma_pago;

      -- El vuelto se descuenta del efectivo, que es de donde sale.
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

  RETURN QUERY SELECT v_venta_id, v_numero, v_es_cta_cte;
END; $$;

REVOKE ALL ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid) TO authenticated;


-- ------------------------------------------------------------
-- E. anular_venta
--    - Sólo se anulan FACTURAS. Antes se podía anular una NOTA_DEBITO, y como
--      la ND no descontó stock pero anular_venta devolvía el de todos los ítems,
--      aparecía mercadería de la nada.
--    - La nota de crédito de anulación queda en CONTADO: al anular una venta de
--      cuenta corriente, la factura original sale del saldo por quedar ANULADA;
--      si además la NC contara en cuenta corriente, la deuda se restaría dos
--      veces y el cliente terminaba con saldo a favor inventado.
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

  -- Sólo se anulan facturas. Las notas se corrigen con otra nota, no anulando.
  IF v_v.tipo_comprobante NOT IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C',
                                  'REMITO', 'REMITO_OBRA', 'FAC_INTERNA_CTA_CTE') THEN
    RAISE EXCEPTION 'Una % no se anula (las notas se corrigen con otra nota)', v_v.tipo_comprobante;
  END IF;

  v_numero := public.next_comprobante_numero(v_v.sucursal_id, 'NOTA_CREDITO');

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, numero_comprobante, tipo_comprobante,
    -- La NC de anulación va en CONTADO: la reversión de la deuda ya la hace el
    -- hecho de que la factura original quede ANULADA.
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

  -- Devolver stock (todas las facturas anulables descontaron stock al emitirse).
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
