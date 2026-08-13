-- ============================================================
-- Correcciones del review de 20260729120000 (compras registra plata).
--
-- Dos regresiones que introdujo aquella migración al reescribir funciones
-- vigentes, y una limpieza. La lección se repite: reescribir una función con
-- CREATE OR REPLACE hay que hacerlo mirando la versión VIGENTE, no una vieja.
-- ============================================================

-- ------------------------------------------------------------
-- 1. crear_compra: vuelven las validaciones del proveedor
--
-- La versión vieja rechazaba proveedor inactivo y CTA_CTE si el proveedor no
-- tenía cuenta corriente habilitada. La nueva las perdió, así que por RPC se
-- podía generar deuda contra un proveedor inactivo o sin crédito. Habilitar la
-- cuenta corriente de un proveedor es una decisión de admin (hay un trigger que
-- la protege); saltearla por acá la vuelve decorativa.
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
  v_prov      public.proveedores%ROWTYPE;
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
  IF p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') THEN
    RAISE EXCEPTION 'Las notas de crédito/débito del proveedor no se cargan como compra';
  END IF;

  -- Las dos validaciones que se habían perdido.
  SELECT * INTO v_prov FROM public.proveedores WHERE id = p_proveedor_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proveedor inexistente o inactivo';
  END IF;
  IF p_condicion = 'CTA_CTE' AND NOT COALESCE(v_prov.condicion_cta_cte, false) THEN
    RAISE EXCEPTION 'El proveedor % no tiene cuenta corriente habilitada', v_prov.razon_social;
  END IF;

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
      -- Estos pagos NO llevan número de recibo: son el pago de la propia compra,
      -- no un pago suelto a cuenta. El recibo se emite desde Pagos a proveedores.
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
-- 2. registrar_pago_proveedor: vuelve forma_pago al libro de cuenta corriente
--
-- La versión vigente lo escribía y Cuentas Corrientes lo muestra
-- (cuentas-corrientes.tsx:238). Al reescribir la función se perdió, así que los
-- movimientos nuevos aparecían sin forma de pago: auditoría que se borra sola.
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
    proveedor_id, sucursal_id, tipo, monto, estado, pago_id, forma_pago, descripcion, usuario_id
  ) VALUES (
    p_proveedor_id, p_sucursal_id, 'CREDITO', v_monto, 'CONFIRMADO', v_pago, p_forma_pago,
    'Pago a proveedor ' || v_numero, v_uid
  );

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
-- 3. Se cierra la puerta de la extracción con IA
--
-- La server fn que la llamaba se borró el 29/07/2026, así que la RPC quedó sin
-- llamador. Dejarla ejecutable es dejar una puerta abierta a un camino que ya no
-- existe en la app.
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.guardar_extraccion_ingreso(uuid, jsonb, jsonb, jsonb, text, date, text, text, text)
  FROM authenticated;

COMMENT ON FUNCTION public.guardar_extraccion_ingreso(uuid, jsonb, jsonb, jsonb, text, date, text, text, text) IS
  'HUÉRFANA desde el 29/07/2026: la extracción de remitos con IA se sacó de la app y los ingresos se cargan a mano. Se le quitó el GRANT. No la revivas sin leer docs/superpowers/specs/2026-07-29-compras-plata-ingresos-mano-design.md §5.3.';
