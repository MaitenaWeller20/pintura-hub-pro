-- ============================================================
-- Segunda pasada de revisión (Codex): dos ajustes finales.
--
-- #A anular_venta: la NC de una venta PARCIAL quedaba PAGADO. Ahora replica la
--    lógica de crear_venta: PAGADO si la devolución cubre el total, PARCIAL si
--    cubre algo, PENDIENTE si no se había cobrado nada.
--
-- #B GRANT EXECUTE a service_role en las RPC de venta y caja. El patrón
--    "REVOKE ALL FROM public; GRANT TO authenticated" dejaba a service_role sin
--    EXECUTE. Las RPC son SECURITY DEFINER, pero si un proceso backend las llama
--    con la service_role key, necesita el permiso. Se agrega por robustez.
-- ============================================================

-- #A: anular_venta con estado de NC correcto --
CREATE OR REPLACE FUNCTION public.anular_venta(p_venta_id uuid)
 RETURNS TABLE(nc_id uuid, nc_numero text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -v_v.total, -v_v.total_pagado,
    -- El estado de la NC replica cuánto se devolvió respecto de su total (misma
    -- lógica que crear_venta): si la venta original estaba totalmente cobrada, la
    -- devolución es total → PAGADO; si estaba PARCIAL, la NC queda PARCIAL; si era
    -- a cuenta (no se cobró), la NC sólo baja la deuda → PENDIENTE.
    CASE
      WHEN ABS(v_v.total_pagado) >= ABS(v_v.total) - 0.01 THEN 'PAGADO'::public.estado_pago
      WHEN ABS(v_v.total_pagado) > 0 THEN 'PARCIAL'::public.estado_pago
      ELSE 'PENDIENTE'::public.estado_pago
    END,
    'Nota de crédito por anulación de ' || v_v.numero_comprobante,
    v_v.id
  ) RETURNING id INTO v_nc_id;

  -- La plata que se le devuelve al cliente SALE de la caja. Copiamos los pagos
  -- originales con el signo invertido: el arqueo (caja_esperado) los resta de la
  -- sesión donde ocurre la anulación (la NC se estampa a la caja abierta por el
  -- trigger). Sin esto, anular una venta cobrada en efectivo dejaba la caja
  -- esperando plata que ya no estaba. Una venta a cuenta corriente no tiene
  -- pagos, así que este INSERT no copia nada (la reversión va por el libro).
  INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
  SELECT v_nc_id, forma_pago, -monto, detalle
    FROM public.venta_pagos WHERE venta_id = v_v.id;

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
END; $function$

;
REVOKE ALL ON FUNCTION public.anular_venta(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid) TO service_role;

-- #B: service_role puede ejecutar las RPC de venta y caja.
GRANT EXECUTE ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.abrir_caja(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.cerrar_caja(uuid, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.registrar_movimiento_caja(uuid, public.caja_mov_tipo, public.forma_pago, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.caja_esperado(uuid) TO service_role;
