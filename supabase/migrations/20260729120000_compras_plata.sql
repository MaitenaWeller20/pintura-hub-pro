-- ============================================================
-- COMPRAS REGISTRA PLATA (no mercadería).
--
-- El pedido: "en la pestañita compras deberíamos dejar solamente cuánto compraron
-- en plata, no agregar los productos ni nada de eso"; "de última sí dejar el
-- remito cargado, pero que no tome nada del stock".
--
-- De acá en adelante hay un solo camino que suma stock: Ingresos de mercadería,
-- que desde el 29/07/2026 se carga a mano.
--
-- Ver docs/superpowers/specs/2026-07-29-compras-plata-ingresos-mano-design.md
-- ============================================================

-- ------------------------------------------------------------
-- 1. Numeración de documentos INTERNOS
--
-- `comprobante_secuencias.tipo` es el enum FISCAL `tipo_comprobante`, y por ahí
-- pasan la facturación AFIP y los reportes. Meterle un "PAGO_PROVEEDOR" sería
-- colar un documento interno en el circuito fiscal: cualquier CASE sin ELSE o
-- cualquier consulta que asuma el conjunto cerrado de tipos se rompe o, peor,
-- lo cuenta como comprobante.
--
-- Por eso los documentos internos (recibos de pago hoy, presupuestos después)
-- numeran acá, en su propia tabla, con la misma garantía de atomicidad.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.documento_secuencias (
  sucursal_id   uuid NOT NULL REFERENCES public.sucursales(id),
  tipo          text NOT NULL,
  ultimo_numero integer NOT NULL DEFAULT 0,
  PRIMARY KEY (sucursal_id, tipo)
);
GRANT SELECT ON public.documento_secuencias TO authenticated;
GRANT ALL ON public.documento_secuencias TO service_role;
ALTER TABLE public.documento_secuencias ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "doc_sec read" ON public.documento_secuencias;
CREATE POLICY "doc_sec read" ON public.documento_secuencias
  FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.next_documento_numero(
  _sucursal_id uuid, _tipo text, _prefijo text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _next integer; _pref_suc text;
BEGIN
  -- Mismo UPSERT atómico que next_comprobante_numero: dos pagos simultáneos no
  -- pueden sacar el mismo número.
  INSERT INTO public.documento_secuencias (sucursal_id, tipo, ultimo_numero)
  VALUES (_sucursal_id, _tipo, 1)
  ON CONFLICT (sucursal_id, tipo)
  DO UPDATE SET ultimo_numero = documento_secuencias.ultimo_numero + 1
  RETURNING ultimo_numero INTO _next;

  SELECT CASE codigo WHEN 'OHIGGINS' THEN 'OHI' WHEN 'GENERALPAZ' THEN 'GPZ' ELSE 'SUC' END
    INTO _pref_suc FROM public.sucursales WHERE id = _sucursal_id;

  RETURN COALESCE(_pref_suc,'SUC') || '-' || _prefijo || '-' || lpad(_next::text, 4, '0');
END; $$;

-- ------------------------------------------------------------
-- 2. El recibo de pago necesita número y saldo congelado
--
-- Un comprobante que cambia solo no sirve como comprobante: si el PDF calculara
-- el saldo del momento de imprimirlo, reimprimir un recibo de hace un mes
-- mostraría un número distinto.
-- ------------------------------------------------------------
ALTER TABLE public.proveedor_pagos
  ADD COLUMN IF NOT EXISTS numero text,
  ADD COLUMN IF NOT EXISTS saldo_posterior numeric(14,2);

COMMENT ON COLUMN public.proveedor_pagos.saldo_posterior IS
  'Saldo del proveedor JUSTO DESPUÉS de este pago, congelado. No se recalcula: es lo que dice el recibo impreso.';

-- ------------------------------------------------------------
-- 3. Los montos de una compra no pueden ser cualquier cosa
--
-- Hasta ahora la RPC los derivaba de los ítems (validando costo, cantidad e IVA
-- de cada uno), así que la tabla no necesitaba CHECK. Con montos escritos a mano
-- eso desaparece, y estos números alimentan la deuda del proveedor y la salida de
-- caja: un total negativo corrompe el saldo y el arqueo.
-- ------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE public.compras
    ADD CONSTRAINT compras_montos_no_negativos
    CHECK (subtotal_sin_iva >= 0 AND iva_total >= 0 AND percepciones >= 0 AND total >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 4. crear_compra: montos escritos, sin ítems, sin stock
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crear_compra(
  p_proveedor_id      uuid,
  p_sucursal_id       uuid,
  p_tipo_comprobante  text,
  p_numero            text,
  p_fecha_comprobante date,
  p_fecha_vencimiento date,
  p_subtotal_sin_iva  numeric,
  p_iva_total         numeric,
  p_percepciones      numeric,
  p_pagos             jsonb,
  p_condicion         text DEFAULT 'CONTADO',
  p_observaciones     text DEFAULT NULL
)
RETURNS TABLE (compra_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_compra_id uuid;
  v_sub       numeric(14,2) := ROUND(COALESCE(p_subtotal_sin_iva, 0), 2);
  v_iva       numeric(14,2) := ROUND(COALESCE(p_iva_total, 0), 2);
  v_perc      numeric(14,2) := ROUND(COALESCE(p_percepciones, 0), 2);
  v_total     numeric(14,2);
  v_sesion    uuid;
  v_monto     numeric(14,2);
  v_forma     text;
  pg          jsonb;
  LIMITE      constant numeric := 999999999;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés registrar una compra en una sucursal que no es la tuya';
  END IF;
  IF p_condicion NOT IN ('CONTADO', 'CTA_CTE') THEN
    RAISE EXCEPTION 'Condición inválida: %', p_condicion;
  END IF;
  -- Una nota de crédito/débito del proveedor tiene el signo contrario y es otro
  -- flujo (fuera de alcance): se rechaza para no generar deuda al revés.
  IF p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') THEN
    RAISE EXCEPTION 'Las notas de crédito/débito del proveedor no se cargan como compra';
  END IF;

  -- Los montos ya no salen de ítems validados: hay que mirarlos acá.
  IF v_sub < 0 OR v_iva < 0 OR v_perc < 0 THEN
    RAISE EXCEPTION 'Los montos de la compra no pueden ser negativos';
  END IF;
  v_total := ROUND(v_sub + v_iva + v_perc, 2);
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'El total de la compra tiene que ser mayor a cero';
  END IF;
  IF v_total > LIMITE THEN
    RAISE EXCEPTION 'El total (%) no parece un monto válido. Revisá los números.', v_total;
  END IF;

  INSERT INTO public.compras (
    proveedor_id, sucursal_id, usuario_id, tipo_comprobante, numero_comprobante,
    fecha_comprobante, fecha_vencimiento, subtotal_sin_iva, iva_total, percepciones,
    total, condicion, estado, observaciones
  ) VALUES (
    p_proveedor_id, p_sucursal_id, v_uid, p_tipo_comprobante, p_numero,
    p_fecha_comprobante, p_fecha_vencimiento, v_sub, v_iva, v_perc,
    v_total, p_condicion, 'ACTIVA', p_observaciones
  ) RETURNING id INTO v_compra_id;

  -- Deliberadamente NO se escriben compra_items ni stock_movimientos: esta RPC
  -- registra PLATA. La mercadería entra por Ingresos de mercadería.

  IF p_condicion = 'CTA_CTE' THEN
    IF (SELECT COALESCE(SUM((x->>'monto')::numeric), 0)
          FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb)) x) > 0 THEN
      RAISE EXCEPTION 'Una compra a cuenta corriente no lleva pagos: quedan como deuda';
    END IF;
    INSERT INTO public.proveedor_cc_movimientos (
      proveedor_id, sucursal_id, tipo, monto, estado, compra_id, descripcion, usuario_id
    ) VALUES (
      p_proveedor_id, p_sucursal_id, 'DEBITO', v_total, 'CONFIRMADO', v_compra_id,
      'Compra ' || p_tipo_comprobante || ' ' || p_numero, v_uid
    );
  ELSE
    -- CONTADO: la plata sale de la caja. FOR SHARE serializa contra cerrar_caja.
    SELECT id INTO v_sesion FROM public.caja_sesiones
      WHERE sucursal_id = p_sucursal_id AND estado = 'ABIERTA'
      ORDER BY abierta_en DESC LIMIT 1
      FOR SHARE;
    IF v_sesion IS NULL THEN
      RAISE EXCEPTION 'Abrí la caja antes de registrar una compra al contado (la plata sale de la caja)';
    END IF;

    v_monto := 0;
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_forma := pg->>'forma_pago';
      IF v_forma = 'CTA_CTE' THEN
        RAISE EXCEPTION 'CTA_CTE no es una forma de pago. Para comprar a cuenta usá la condición CTA_CTE.';
      END IF;
      IF COALESCE((pg->>'monto')::numeric, 0) < 0 THEN
        RAISE EXCEPTION 'Un pago no puede ser negativo';
      END IF;
      v_monto := v_monto + ROUND(COALESCE((pg->>'monto')::numeric, 0), 2);
    END LOOP;
    IF ABS(v_monto - v_total) > 0.01 THEN
      RAISE EXCEPTION 'Los pagos (%) no cubren el total de la compra (%). Una compra contado se paga completa.',
        v_monto, v_total;
    END IF;

    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := ROUND(COALESCE((pg->>'monto')::numeric, 0), 2);
      IF v_monto <= 0 THEN CONTINUE; END IF;
      INSERT INTO public.proveedor_pagos (
        proveedor_id, sucursal_id, usuario_id, monto, forma_pago, detalle, compra_id, caja_sesion_id
      ) VALUES (
        p_proveedor_id, p_sucursal_id, v_uid, v_monto, pg->>'forma_pago',
        COALESCE(pg->'detalle', '{}'::jsonb), v_compra_id, v_sesion
      );
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_compra_id;
END; $$;

REVOKE ALL ON FUNCTION public.crear_compra(uuid, uuid, text, text, date, date, numeric, numeric, numeric, jsonb, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_compra(uuid, uuid, text, text, date, date, numeric, numeric, numeric, jsonb, text, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. La firma VIEJA pasa a ser un puente — y NO suma stock
--
-- Postgres identifica una función por nombre + tipos de parámetros. La firma
-- nueva tiene 12 y la vieja 11, así que `CREATE OR REPLACE` crea una SEGUNDA
-- función y deja la vieja viva, con su GRANT intacto: un camino paralelo que
-- seguiría sumando stock, que es justo lo que este cambio viene a cerrar.
--
-- Dropearla a secas rompe /compras/nueva durante la ventana entre el db push y
-- el deploy del frontend. Vaciarle el cuerpo cierra las dos puntas: el frontend
-- viejo sigue andando y ya no toca stock, y el nuevo usa la firma nueva.
--
-- SE PUEDE DROPEAR una vez que el frontend nuevo esté en producción.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crear_compra(
  p_proveedor_id      uuid,
  p_sucursal_id       uuid,
  p_tipo_comprobante  text,
  p_numero            text,
  p_fecha_comprobante date,
  p_fecha_vencimiento date,
  p_items             jsonb,
  p_pagos             jsonb,
  p_percepciones      numeric DEFAULT 0,
  p_condicion         text    DEFAULT 'CONTADO',
  p_observaciones     text    DEFAULT NULL
)
RETURNS TABLE (compra_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub numeric(14,2) := 0;
  v_iva numeric(14,2) := 0;
  it    jsonb;
  v_c   numeric(14,2);
  v_cu  numeric(14,2);
  v_ip  numeric(5,2);
BEGIN
  -- Se derivan los totales de los ítems que llegan, sólo para no perder el monto.
  -- Los productos y el stock se ignoran a propósito.
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_c  := ROUND(COALESCE((it->>'cantidad')::numeric, 0), 2);
    v_cu := ROUND(COALESCE((it->>'costo_unitario_sin_iva')::numeric, 0), 2);
    v_ip := COALESCE((it->>'iva_porcentaje')::numeric, 21);
    v_sub := v_sub + ROUND(v_c * v_cu, 2);
    v_iva := v_iva + ROUND(v_c * v_cu * v_ip / 100.0, 2);
  END LOOP;

  RETURN QUERY SELECT * FROM public.crear_compra(
    p_proveedor_id, p_sucursal_id, p_tipo_comprobante, p_numero,
    p_fecha_comprobante, p_fecha_vencimiento,
    v_sub, v_iva, COALESCE(p_percepciones, 0),
    p_pagos, p_condicion, p_observaciones);
END; $$;

COMMENT ON FUNCTION public.crear_compra(uuid, uuid, text, text, date, date, jsonb, jsonb, numeric, text, text) IS
  'PUENTE de compatibilidad (29/07/2026). Deriva los totales de los ítems y llama a la firma nueva. NO suma stock ni escribe compra_items. Existe sólo para que el frontend viejo no rompa entre el db push y el deploy; se puede DROPear una vez que el frontend nuevo esté en producción.';

-- ------------------------------------------------------------
-- 6. registrar_pago_proveedor: número y saldo congelado
--
-- Se conserva TODO lo que ya hacía (validación de sucursal, caja auto-abierta,
-- movimiento de cuenta corriente, salida de caja). Sólo se le agrega el número
-- del recibo y el saldo del momento.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_pago_proveedor(
  p_proveedor_id uuid,
  p_sucursal_id  uuid,
  p_monto        numeric,
  p_forma_pago   text,
  p_detalle      jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_monto  numeric(14,2) := ROUND(COALESCE(p_monto, 0), 2);
  v_pago   uuid;
  v_sesion uuid;
  v_saldo  numeric(14,2);
  v_numero text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés pagar desde una sucursal que no es la tuya';
  END IF;
  IF v_monto <= 0 THEN RAISE EXCEPTION 'El monto tiene que ser mayor a cero'; END IF;
  IF p_forma_pago = 'CTA_CTE' THEN RAISE EXCEPTION 'CTA_CTE no es una forma de pago'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.proveedores WHERE id = p_proveedor_id AND activo) THEN
    RAISE EXCEPTION 'Proveedor inexistente o inactivo';
  END IF;

  v_sesion := public.caja_sesion_actual(p_sucursal_id);
  v_numero := public.next_documento_numero(p_sucursal_id, 'PAGO_PROVEEDOR', 'PAGO');

  INSERT INTO public.proveedor_pagos (
    proveedor_id, sucursal_id, usuario_id, monto, forma_pago, detalle,
    caja_sesion_id, numero
  ) VALUES (
    p_proveedor_id, p_sucursal_id, v_uid, v_monto, p_forma_pago,
    COALESCE(p_detalle, '{}'::jsonb), v_sesion, v_numero
  ) RETURNING id INTO v_pago;

  INSERT INTO public.proveedor_cc_movimientos (
    proveedor_id, sucursal_id, tipo, monto, estado, pago_id, descripcion, usuario_id
  ) VALUES (
    p_proveedor_id, p_sucursal_id, 'CREDITO', v_monto, 'CONFIRMADO', v_pago,
    'Pago a proveedor ' || v_numero, v_uid
  );

  -- El saldo DESPUÉS de este pago, congelado: el recibo impreso no puede cambiar
  -- porque después se hicieron otros pagos.
  SELECT COALESCE(SUM(CASE WHEN tipo = 'DEBITO' THEN monto ELSE -monto END), 0)
    INTO v_saldo
    FROM public.proveedor_cc_movimientos
   WHERE proveedor_id = p_proveedor_id AND estado = 'CONFIRMADO';
  UPDATE public.proveedor_pagos SET saldo_posterior = v_saldo WHERE id = v_pago;

  RETURN v_pago;
END; $$;

REVOKE ALL ON FUNCTION public.registrar_pago_proveedor(uuid, uuid, numeric, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.registrar_pago_proveedor(uuid, uuid, numeric, text, jsonb) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 7. El rate limit de los ingresos era para la IA
--
-- 30 borradores por hora frenaba el gasto del modelo. Sin IA no cuesta nada y
-- puede trabar una carga manual de varios remitos seguidos. Se sube el tope; no
-- se saca, porque sigue siendo una defensa contra un bucle accidental.
-- ------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'crear_borrador_ingreso';
  IF v_src IS NOT NULL AND v_src LIKE '%RATE_LIMIT  constant integer := 30%' THEN
    EXECUTE replace(
      pg_get_functiondef((SELECT oid FROM pg_proc WHERE proname = 'crear_borrador_ingreso')),
      'RATE_LIMIT  constant integer := 30',
      'RATE_LIMIT  constant integer := 200');
  END IF;
END $$;
