-- ============================================================
-- G3 — Fixes de caja / anulaciones / cobranza
--
-- (1) anular_pago_proveedor: exigir admin en el server (antes sólo la UI gateaba).
-- (2) anular_compra / anular_pago_proveedor: reinyectar en la caja ABIERTA actual
--     la plata que vuelve (igual que anular_venta con los pagos negados). Si el pago
--     salió de una sesión ya CERRADA, marcar 'ANULADO' no alcanza (su arqueo está
--     congelado): se registra un INGRESO compensatorio en la caja abierta. Si el
--     pago es de la MISMA sesión abierta, con 'ANULADO' alcanza y NO se compensa
--     (evita doble conteo).
-- (3) registrar_cobranza: exigir sesión ABIERTA (el cobro entra a la caja),
--     coherente con registrar_pago_proveedor. Se estampa caja_sesion_id explícito.
-- (4) registrar_cobranza: validar que el cliente exista, esté activo y tenga
--     cuenta corriente habilitada (mismo criterio que crear_venta).
--
-- NOTA: se redefinen sólo funciones de compras/cobranza. NO se toca crear_venta
-- ni anular_venta (los toca G4). Firmas idénticas => CREATE OR REPLACE sin DROP.
-- ============================================================

-- ------------------------------------------------------------
-- (1)+(2) anular_pago_proveedor
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anular_pago_proveedor(p_pago_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_p              public.proveedor_pagos%ROWTYPE;
  v_sesion_abierta uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  -- (1) Sólo un administrador puede anular un pago (coherente con anular_compra).
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede anular un pago';
  END IF;

  SELECT * INTO v_p FROM public.proveedor_pagos WHERE id = p_pago_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pago no encontrado'; END IF;
  IF v_p.estado = 'ANULADO' THEN RAISE EXCEPTION 'El pago ya fue anulado'; END IF;
  IF v_p.compra_id IS NOT NULL THEN
    RAISE EXCEPTION 'Este pago es de una compra contado: anulá la compra, no el pago';
  END IF;

  -- (2) La plata pagada al proveedor VUELVE a la caja. Se exige una sesión abierta
  -- de la sucursal del pago (FOR SHARE serializa contra cerrar_caja).
  SELECT id INTO v_sesion_abierta FROM public.caja_sesiones
    WHERE sucursal_id = v_p.sucursal_id AND estado = 'ABIERTA'
    ORDER BY abierta_en DESC LIMIT 1
    FOR SHARE;
  IF v_sesion_abierta IS NULL THEN
    RAISE EXCEPTION 'Abrí la caja antes de anular un pago (la plata vuelve a la caja)';
  END IF;

  -- Sólo compensar si el pago NO es de la sesión abierta actual (si lo es, el
  -- 'ANULADO' de abajo ya lo saca del esperado en vivo => compensar sería doble).
  IF v_p.caja_sesion_id IS DISTINCT FROM v_sesion_abierta THEN
    INSERT INTO public.caja_movimientos
      (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
    VALUES
      (v_sesion_abierta, 'INGRESO', v_p.forma_pago::public.forma_pago, v_p.monto,
       'Reversa de pago a proveedor anulado', v_uid);
  END IF;

  UPDATE public.proveedor_pagos SET estado = 'ANULADO' WHERE id = p_pago_id;
  UPDATE public.proveedor_cc_movimientos SET estado = 'ANULADO'
    WHERE pago_id = p_pago_id AND estado = 'CONFIRMADO';
END; $$;
REVOKE ALL ON FUNCTION public.anular_pago_proveedor(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_pago_proveedor(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- (2) anular_compra (cuerpo vigente + reversa a caja)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anular_compra(p_compra_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_c              public.compras%ROWTYPE;
  v_permite_neg    boolean;
  r                RECORD;
  v_pago           RECORD;
  v_sesion_abierta uuid;
  v_stock_ant      numeric(14,2);
  v_stock_nue      numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) THEN RAISE EXCEPTION 'Sólo un administrador puede anular una compra'; END IF;

  SELECT * INTO v_c FROM public.compras WHERE id = p_compra_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compra no encontrada'; END IF;
  IF v_c.estado = 'ANULADA' THEN RAISE EXCEPTION 'La compra ya fue anulada'; END IF;

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);

  -- Revierte stock por ítem. Si ya se vendió parte de esa mercadería y quedaría
  -- negativo, no deja anular (salvo que la política de stock negativo lo permita).
  FOR r IN SELECT producto_id, cantidad, codigo FROM public.compra_items WHERE compra_id = p_compra_id
  LOOP
    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES (r.producto_id, v_c.sucursal_id, 0)
      ON CONFLICT (producto_id, sucursal_id) DO NOTHING;
      UPDATE public.stock_sucursal SET cantidad = cantidad - r.cantidad
       WHERE producto_id = r.producto_id AND sucursal_id = v_c.sucursal_id
      RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
    ELSE
      UPDATE public.stock_sucursal SET cantidad = cantidad - r.cantidad
       WHERE producto_id = r.producto_id AND sucursal_id = v_c.sucursal_id AND cantidad >= r.cantidad
      RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No se puede anular: ya se vendió parte de % (no alcanza el stock para revertir)', r.codigo;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      r.producto_id, v_c.sucursal_id, 'ANULACION_COMPRA', -r.cantidad, v_stock_ant, v_stock_nue,
      'Anulación compra ' || v_c.numero_comprobante, p_compra_id, v_uid
    );
  END LOOP;

  UPDATE public.compras SET estado = 'ANULADA' WHERE id = p_compra_id;

  -- Deuda (CTA_CTE): anula el DEBITO.
  UPDATE public.proveedor_cc_movimientos SET estado = 'ANULADO'
    WHERE compra_id = p_compra_id AND estado = 'CONFIRMADO';

  -- CONTADO: la plata pagada VUELVE a la caja. Igual que anular_venta reinyecta los
  -- pagos negados a la sesión abierta. Se exige caja abierta y se compensa sólo los
  -- pagos que NO son de esa misma sesión (los que sí, se revierten con el 'ANULADO').
  IF v_c.condicion = 'CONTADO'
     AND EXISTS (SELECT 1 FROM public.proveedor_pagos
                  WHERE compra_id = p_compra_id AND estado = 'CONFIRMADO') THEN
    SELECT id INTO v_sesion_abierta FROM public.caja_sesiones
      WHERE sucursal_id = v_c.sucursal_id AND estado = 'ABIERTA'
      ORDER BY abierta_en DESC LIMIT 1
      FOR SHARE;
    IF v_sesion_abierta IS NULL THEN
      RAISE EXCEPTION 'Abrí la caja antes de anular una compra al contado (la plata vuelve a la caja)';
    END IF;

    FOR v_pago IN
      SELECT caja_sesion_id, forma_pago, monto
        FROM public.proveedor_pagos
       WHERE compra_id = p_compra_id AND estado = 'CONFIRMADO'
    LOOP
      IF v_pago.caja_sesion_id IS DISTINCT FROM v_sesion_abierta THEN
        INSERT INTO public.caja_movimientos
          (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
        VALUES
          (v_sesion_abierta, 'INGRESO', v_pago.forma_pago::public.forma_pago, v_pago.monto,
           'Reversa de compra anulada ' || v_c.numero_comprobante, v_uid);
      END IF;
    END LOOP;
  END IF;

  -- Contado: los pagos dejan de restar del esperado en vivo de su propia sesión.
  UPDATE public.proveedor_pagos SET estado = 'ANULADO'
    WHERE compra_id = p_compra_id AND estado = 'CONFIRMADO';
END; $$;
REVOKE ALL ON FUNCTION public.anular_compra(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_compra(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- (3)+(4) registrar_cobranza (firma idéntica a 20260713140000)
-- ------------------------------------------------------------
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
  v_sesion      uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés cobrar en una sucursal que no es la tuya';
  END IF;

  IF COALESCE(p_monto, 0) <= 0 THEN
    RAISE EXCEPTION 'El monto del cobro debe ser mayor a cero';
  END IF;

  IF p_forma_pago = 'CTA_CTE' THEN
    RAISE EXCEPTION 'CTA_CTE no es una forma de pago';
  END IF;

  -- (4) El cliente tiene que existir, estar activo y tener cuenta corriente
  -- habilitada (mismo criterio que crear_venta; no se cobra cta cte a quien no la tiene).
  IF NOT EXISTS (
    SELECT 1 FROM public.clientes
     WHERE id = p_cliente_id AND activo AND COALESCE(condicion_cta_cte, false)
  ) THEN
    RAISE EXCEPTION 'Cliente inexistente, inactivo o sin cuenta corriente habilitada';
  END IF;

  -- (3) El cobro entra a la caja => exigí una sesión ABIERTA de la sucursal (coherente
  -- con registrar_pago_proveedor). FOR SHARE serializa contra cerrar_caja: si no,
  -- una cobranza con la caja recién cerrada quedaría fuera del arqueo (caja_sesion_id NULL).
  SELECT id INTO v_sesion FROM public.caja_sesiones
    WHERE sucursal_id = p_sucursal_id AND estado = 'ABIERTA'
    ORDER BY abierta_en DESC LIMIT 1
    FOR SHARE;
  IF v_sesion IS NULL THEN
    RAISE EXCEPTION 'Abrí la caja antes de registrar una cobranza (el cobro entra a la caja)';
  END IF;

  INSERT INTO public.cobranzas_cta_cte (
    cliente_id, sucursal_id, usuario_id, monto, forma_pago, detalle, observaciones, caja_sesion_id
  ) VALUES (
    p_cliente_id, p_sucursal_id, v_uid, p_monto, p_forma_pago,
    COALESCE(p_detalle, '{}'::jsonb), p_observaciones, v_sesion
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
