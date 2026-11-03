-- La imputación documenta el destino de un cobro. El saldo, la caja y el stock
-- siguen saliendo de sus libros actuales; nunca se actualiza ventas.total_pagado.
CREATE TABLE public.cobranza_imputaciones (
  cobranza_id uuid NOT NULL REFERENCES public.cobranzas_cta_cte(id) ON DELETE RESTRICT,
  venta_id uuid NOT NULL REFERENCES public.ventas(id) ON DELETE RESTRICT,
  monto numeric(14,2) NOT NULL CHECK (monto > 0),
  usuario_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cobranza_id, venta_id)
);
CREATE INDEX cobranza_imputaciones_venta_idx ON public.cobranza_imputaciones(venta_id);
ALTER TABLE public.cobranza_imputaciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cobranza_imputaciones FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cobranza_imputaciones TO authenticated;
CREATE POLICY cobranza_imputaciones_lectura ON public.cobranza_imputaciones
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.cobranzas_cta_cte c
      WHERE c.id = cobranza_id
        AND ((SELECT public.is_admin((SELECT auth.uid())))
          OR c.sucursal_id = (SELECT public.current_sucursal_id()))
    )
  );

-- Las ventas anuladas y los cobros anulados conservan el rastro histórico,
-- pero dejan de ocupar cupo de imputación para un nuevo cobro.
CREATE FUNCTION public.cc_comprobantes_imputables(p_cliente_id uuid, p_sucursal_id uuid)
RETURNS TABLE(venta_id uuid, numero text, tipo text, fecha timestamptz,
              total numeric, disponible numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND activo
  ) THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(auth.uid())
     AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés consultar comprobantes de otra sucursal';
  END IF;
  RETURN QUERY
  SELECT v.id, v.numero_comprobante, v.tipo_comprobante::text, v.fecha,
         m.monto,
         m.monto - COALESCE(i.imputado, 0) - COALESCE(nc.credito, 0)
    FROM public.ventas v
    JOIN public.cuenta_corriente_movimientos m ON m.venta_id = v.id
      AND m.tipo = 'DEBITO' AND m.estado = 'CONFIRMADO'
    LEFT JOIN LATERAL (
      SELECT SUM(ci.monto) AS imputado
        FROM public.cobranza_imputaciones ci
        JOIN public.cuenta_corriente_movimientos cm
          ON cm.cobranza_id = ci.cobranza_id
          AND cm.tipo = 'CREDITO' AND cm.estado = 'CONFIRMADO'
       WHERE ci.venta_id = v.id
    ) i ON true
    LEFT JOIN LATERAL (
      SELECT SUM(cm.monto) AS credito
        FROM public.ventas n
        JOIN public.cuenta_corriente_movimientos cm ON cm.venta_id = n.id
          AND cm.tipo = 'CREDITO' AND cm.estado = 'CONFIRMADO'
       WHERE n.afip_cbte_asoc_id = v.id AND n.tipo_comprobante = 'NOTA_CREDITO'
    ) nc ON true
   WHERE v.cliente_id = p_cliente_id
     AND v.sucursal_id = p_sucursal_id
     AND v.condicion_venta = 'CTA_CTE' AND v.estado = 'ACTIVA'
     AND v.total > 0
     AND m.monto > COALESCE(i.imputado, 0) + COALESCE(nc.credito, 0)
   ORDER BY v.fecha, v.id;
END;
$$;
REVOKE ALL ON FUNCTION public.cc_comprobantes_imputables(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cc_comprobantes_imputables(uuid,uuid)
  TO authenticated;

CREATE FUNCTION public.cc_imputaciones_cliente(p_cliente_id uuid)
RETURNS TABLE(cobranza_id uuid, venta_id uuid, monto numeric,
              numero text, tipo text, activa boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND activo
  ) THEN RAISE EXCEPTION 'No autenticado'; END IF;
  RETURN QUERY
  SELECT i.cobranza_id, i.venta_id, i.monto, v.numero_comprobante,
         v.tipo_comprobante::text,
         cm.estado = 'CONFIRMADO' AND vm.estado = 'CONFIRMADO'
    FROM public.cobranza_imputaciones i
    JOIN public.cobranzas_cta_cte c ON c.id = i.cobranza_id
    JOIN public.ventas v ON v.id = i.venta_id
    JOIN public.cuenta_corriente_movimientos cm ON cm.cobranza_id = c.id
    JOIN public.cuenta_corriente_movimientos vm ON vm.venta_id = v.id
   WHERE c.cliente_id = p_cliente_id
     AND (public.is_admin(auth.uid()) OR c.sucursal_id = public.current_sucursal_id())
   ORDER BY i.created_at, i.venta_id;
END;
$$;
REVOKE ALL ON FUNCTION public.cc_imputaciones_cliente(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cc_imputaciones_cliente(uuid) TO authenticated;

CREATE FUNCTION public._imputar_cobranza(p_cobranza_id uuid, p_imputaciones jsonb)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cobro public.cobranzas_cta_cte%ROWTYPE;
  v_mov public.cuenta_corriente_movimientos%ROWTYPE;
  v_venta public.ventas%ROWTYPE;
  v_venta_mov public.cuenta_corriente_movimientos%ROWTYPE;
  v_item jsonb;
  v_id uuid;
  v_monto numeric;
  v_disponible numeric;
  v_total numeric := 0;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = v_uid AND activo
  ) THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF jsonb_typeof(p_imputaciones) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'La imputación debe ser una lista';
  END IF;
  IF jsonb_array_length(p_imputaciones) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Seleccioná entre 1 y 100 comprobantes';
  END IF;

  SELECT * INTO v_cobro FROM public.cobranzas_cta_cte
   WHERE id = p_cobranza_id FOR UPDATE;
  IF NOT FOUND OR v_cobro.monto <= 0 THEN RAISE EXCEPTION 'Cobro no disponible'; END IF;
  IF NOT public.is_admin(v_uid)
     AND v_cobro.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés imputar cobros de otra sucursal';
  END IF;
  SELECT * INTO v_mov FROM public.cuenta_corriente_movimientos
   WHERE cobranza_id = p_cobranza_id FOR UPDATE;
  IF NOT FOUND OR v_mov.estado <> 'CONFIRMADO' OR v_mov.tipo <> 'CREDITO'
     OR v_mov.cliente_id IS DISTINCT FROM v_cobro.cliente_id
     OR v_mov.sucursal_id IS DISTINCT FROM v_cobro.sucursal_id
     OR v_mov.monto IS DISTINCT FROM v_cobro.monto THEN
    RAISE EXCEPTION 'El cobro no está confirmado en cuenta corriente';
  END IF;
  IF EXISTS (SELECT 1 FROM public.recibos_cobranza WHERE cobranza_id = p_cobranza_id)
     OR EXISTS (SELECT 1 FROM public.cobranza_imputaciones WHERE cobranza_id = p_cobranza_id) THEN
    RAISE EXCEPTION 'El cobro ya tiene recibo o imputaciones; no se puede modificar';
  END IF;

  -- Todos los cobros sobre un cliente se serializan; las ventas se bloquean
  -- en orden estable antes de consultar lo ya imputado.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cc-imputacion:' || v_cobro.cliente_id::text, 0));
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_imputaciones)
                 ORDER BY value->>'venta_id'
  LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR jsonb_typeof(v_item->'venta_id') <> 'string'
       OR jsonb_typeof(v_item->'monto') <> 'number' THEN
      RAISE EXCEPTION 'Imputación inválida';
    END IF;
    v_id := (v_item->>'venta_id')::uuid;
    v_monto := (v_item->>'monto')::numeric;
    IF EXISTS (SELECT 1 FROM public.cobranza_imputaciones
               WHERE cobranza_id = p_cobranza_id AND venta_id = v_id) THEN
      RAISE EXCEPTION 'El comprobante está repetido en la imputación';
    END IF;
    IF v_monto <= 0 OR v_monto <> round(v_monto, 2) THEN
      RAISE EXCEPTION 'El importe imputado debe ser positivo y tener dos decimales';
    END IF;
    SELECT * INTO v_venta FROM public.ventas WHERE id = v_id FOR UPDATE;
    IF NOT FOUND OR v_venta.cliente_id IS DISTINCT FROM v_cobro.cliente_id
       OR v_venta.sucursal_id IS DISTINCT FROM v_cobro.sucursal_id
       OR v_venta.condicion_venta <> 'CTA_CTE' OR v_venta.estado <> 'ACTIVA'
       OR v_venta.total <= 0 THEN
      RAISE EXCEPTION 'El comprobante no corresponde al cliente y sucursal del cobro';
    END IF;
    SELECT * INTO v_venta_mov FROM public.cuenta_corriente_movimientos
     WHERE venta_id = v_id FOR UPDATE;
    IF NOT FOUND OR v_venta_mov.tipo <> 'DEBITO'
       OR v_venta_mov.estado <> 'CONFIRMADO'
       OR v_venta_mov.monto IS DISTINCT FROM v_venta.total THEN
      RAISE EXCEPTION 'El comprobante no tiene una deuda activa';
    END IF;
    SELECT v_venta_mov.monto
      - COALESCE((
          SELECT SUM(ci.monto) FROM public.cobranza_imputaciones ci
          JOIN public.cuenta_corriente_movimientos cm
            ON cm.cobranza_id = ci.cobranza_id
            AND cm.tipo = 'CREDITO' AND cm.estado = 'CONFIRMADO'
          WHERE ci.venta_id = v_id
        ), 0)
      - COALESCE((
          SELECT SUM(cm.monto) FROM public.ventas n
          JOIN public.cuenta_corriente_movimientos cm
            ON cm.venta_id = n.id
            AND cm.tipo = 'CREDITO' AND cm.estado = 'CONFIRMADO'
          WHERE n.afip_cbte_asoc_id = v_id AND n.tipo_comprobante = 'NOTA_CREDITO'
        ), 0)
      INTO v_disponible;
    IF COALESCE(v_disponible, 0) < v_monto THEN
      RAISE EXCEPTION 'La imputación supera el importe disponible del comprobante';
    END IF;
    v_total := v_total + v_monto;
    IF v_total > v_cobro.monto THEN
      RAISE EXCEPTION 'La imputación supera el monto del cobro';
    END IF;
    INSERT INTO public.cobranza_imputaciones(cobranza_id, venta_id, monto, usuario_id)
    VALUES (p_cobranza_id, v_id, v_monto, v_uid);
  END LOOP;
  RETURN v_total;
END;
$$;
REVOKE ALL ON FUNCTION public._imputar_cobranza(uuid,jsonb)
  FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.imputar_cobranza(p_cobranza_id uuid, p_imputaciones jsonb)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Solo un administrador puede imputar cobros anteriores';
  END IF;
  RETURN public._imputar_cobranza(p_cobranza_id, p_imputaciones);
END;
$$;
REVOKE ALL ON FUNCTION public.imputar_cobranza(uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.imputar_cobranza(uuid,jsonb) TO authenticated;

-- Firma nueva y distinta: clientes que todavía usan registrar_cobranza siguen
-- funcionando mientras se publica el frontend.
CREATE FUNCTION public.registrar_cobranza_imputada(
  p_cliente_id uuid, p_sucursal_id uuid, p_monto numeric, p_forma_pago text,
  p_detalle jsonb, p_observaciones text, p_imputaciones jsonb
)
RETURNS TABLE(cobranza_id uuid, saldo numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_saldo numeric;
BEGIN
  SELECT r.cobranza_id, r.saldo INTO v_id, v_saldo
    FROM public.registrar_cobranza(p_cliente_id, p_sucursal_id, p_monto,
      p_forma_pago, p_detalle, p_observaciones) r;
  IF v_id IS NULL THEN RAISE EXCEPTION 'No se registró el cobro'; END IF;
  PERFORM public._imputar_cobranza(v_id, p_imputaciones);
  RETURN QUERY SELECT v_id, v_saldo;
END;
$$;
REVOKE ALL ON FUNCTION public.registrar_cobranza_imputada(uuid,uuid,numeric,text,jsonb,text,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_cobranza_imputada(uuid,uuid,numeric,text,jsonb,text,jsonb)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.emitir_recibo_cobranza(p_cobranza_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cobro public.cobranzas_cta_cte%ROWTYPE;
  v_movimiento public.cuenta_corriente_movimientos%ROWTYPE;
  v_recibo public.recibos_cobranza%ROWTYPE;
  v_sucursal public.sucursales%ROWTYPE;
  v_cliente public.clientes%ROWTYPE;
  v_emisor public.emisores%ROWTYPE;
  v_datos jsonb;
  v_imputaciones jsonb;
  v_imputado numeric;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  SELECT * INTO v_cobro FROM public.cobranzas_cta_cte
   WHERE id = p_cobranza_id FOR UPDATE;
  IF NOT FOUND OR v_cobro.monto <= 0 THEN RAISE EXCEPTION 'Cobro no disponible'; END IF;
  IF NOT public.is_admin(v_uid)
     AND v_cobro.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés emitir recibos de otra sucursal';
  END IF;
  IF v_cobro.monto > 999999999 THEN
    RAISE EXCEPTION 'El importe supera el máximo imprimible del Recibo X';
  END IF;
  SELECT * INTO v_movimiento FROM public.cuenta_corriente_movimientos
   WHERE cobranza_id = p_cobranza_id AND tipo = 'CREDITO';
  IF NOT FOUND OR v_movimiento.cliente_id IS DISTINCT FROM v_cobro.cliente_id
     OR v_movimiento.sucursal_id IS DISTINCT FROM v_cobro.sucursal_id
     OR v_movimiento.monto IS DISTINCT FROM v_cobro.monto THEN
    RAISE EXCEPTION 'El cobro no coincide con la cuenta corriente';
  END IF;
  SELECT * INTO v_recibo FROM public.recibos_cobranza
   WHERE cobranza_id = p_cobranza_id;
  IF FOUND THEN
    RETURN jsonb_build_object('numero', v_recibo.numero, 'emitido_at', v_recibo.emitido_at,
      'datos', v_recibo.datos, 'anulado', v_movimiento.estado = 'ANULADO');
  END IF;
  IF v_movimiento.estado <> 'CONFIRMADO' THEN
    RAISE EXCEPTION 'No se emite un recibo nuevo para un cobro anulado';
  END IF;
  SELECT * INTO v_sucursal FROM public.sucursales WHERE id = v_cobro.sucursal_id;
  SELECT * INTO v_cliente FROM public.clientes WHERE id = v_cobro.cliente_id;
  SELECT * INTO v_emisor FROM public.emisores WHERE id = v_sucursal.emisor_id;
  IF v_sucursal.id IS NULL OR v_cliente.id IS NULL
     OR v_emisor.id IS NULL OR NULLIF(trim(v_emisor.razon_social), '') IS NULL
     OR NULLIF(trim(v_emisor.cuit), '') IS NULL THEN
    RAISE EXCEPTION 'Completá la razón social y el CUIT del emisor antes de emitir recibos';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'venta_id', i.venta_id, 'monto', i.monto, 'fecha', v.fecha,
      'numero', v.numero_comprobante, 'tipo', v.tipo_comprobante::text,
      'total', v.total, 'afip_numero', v.afip_numero,
      'afip_punto_venta', v.afip_punto_venta, 'afip_cbte_tipo', v.afip_cbte_tipo,
      'afip_estado', v.afip_estado, 'afip_modo', v.afip_modo,
      'afip_simulado', v.afip_simulado
    ) ORDER BY v.fecha, v.id), '[]'::jsonb), COALESCE(sum(i.monto), 0)
    INTO v_imputaciones, v_imputado
    FROM public.cobranza_imputaciones i
    JOIN public.ventas v ON v.id = i.venta_id
    JOIN public.cuenta_corriente_movimientos vm ON vm.venta_id = v.id
      AND vm.tipo = 'DEBITO' AND vm.estado = 'CONFIRMADO'
   WHERE i.cobranza_id = p_cobranza_id;
  IF v_imputado > v_cobro.monto THEN
    RAISE EXCEPTION 'Las imputaciones superan el cobro';
  END IF;
  v_datos := jsonb_build_object(
    'version', 2, 'imputaciones', v_imputaciones,
    'a_cuenta', v_cobro.monto - v_imputado,
    'cobranza_id', v_cobro.id, 'fecha_cobro', v_cobro.fecha,
    'monto', v_cobro.monto, 'forma_pago', v_cobro.forma_pago,
    'detalle', v_cobro.detalle, 'observaciones', v_cobro.observaciones,
    'cliente', jsonb_build_object('razon_social', v_cliente.razon_social,
      'cuit_dni', v_cliente.cuit_dni, 'direccion', v_cliente.direccion,
      'tipo', v_cliente.tipo),
    'sucursal', jsonb_build_object('nombre', v_sucursal.nombre,
      'numero', v_sucursal.numero, 'direccion', v_sucursal.direccion,
      'telefono', v_sucursal.telefono),
    'emisor', jsonb_build_object('razon_social', v_emisor.razon_social,
      'cuit', v_emisor.cuit, 'domicilio_fiscal', v_emisor.domicilio_fiscal,
      'condicion_iva', v_emisor.condicion_iva,
      'ingresos_brutos', v_emisor.ingresos_brutos,
      'inicio_actividades', v_emisor.inicio_actividades, 'logo', v_emisor.logo)
  );
  INSERT INTO public.recibos_cobranza(cobranza_id, sucursal_id, numero, datos)
  VALUES (p_cobranza_id, v_cobro.sucursal_id,
    public.next_documento_numero(v_cobro.sucursal_id, 'RECIBO_CLIENTE', 'RX'), v_datos)
  RETURNING * INTO v_recibo;
  RETURN jsonb_build_object('numero', v_recibo.numero, 'emitido_at', v_recibo.emitido_at,
    'datos', v_recibo.datos, 'anulado', false);
END;
$$;
REVOKE ALL ON FUNCTION public.emitir_recibo_cobranza(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.emitir_recibo_cobranza(uuid)
  TO authenticated,service_role;

NOTIFY pgrst, 'reload schema';
