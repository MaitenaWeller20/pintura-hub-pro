-- ============================================================
-- La nota de crédito tiene que apuntar al comprobante que rectifica
--
-- BUG: emitirComprobante() exige ventas.afip_cbte_asoc_id para armar el CbtesAsoc
-- que AFIP pide en toda nota de crédito/débito... pero nadie llenaba ese campo.
-- Ni anular_venta(), ni la pantalla de nueva venta.
--
-- Resultado: NINGUNA nota de crédito podía emitirse en AFIP. Siempre fallaba con
-- "la nota de crédito tiene que estar asociada a un comprobante que ya tenga CAE".
--
-- lubricentro sí lo hace (nota-credito.ts arma el CbtesAsoc desde el comprobante
-- original), y AFIP rechaza una NC sin comprobante asociado.
-- ============================================================

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

  IF v_v.tipo_comprobante = 'NOTA_CREDITO' THEN
    RAISE EXCEPTION 'Una nota de crédito no se anula';
  END IF;

  v_numero := public.next_comprobante_numero(v_v.sucursal_id, 'NOTA_CREDITO');

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, numero_comprobante, tipo_comprobante,
    condicion_venta, subtotal_sin_iva, iva_total, percepciones, total, total_pagado,
    estado_pago, observaciones,
    -- ESTO es lo que faltaba: sin la referencia al comprobante original, AFIP
    -- rechaza la nota de crédito (necesita el CbtesAsoc).
    afip_cbte_asoc_id
  ) VALUES (
    v_v.sucursal_id, v_v.cliente_id, v_uid, v_numero, 'NOTA_CREDITO',
    v_v.condicion_venta, -v_v.subtotal_sin_iva, -v_v.iva_total, -v_v.percepciones,
    -v_v.total, 0, 'PENDIENTE',
    'Nota de crédito por anulación de ' || v_v.numero_comprobante,
    v_v.id
  ) RETURNING id INTO v_nc_id;

  -- Copiamos los ítems a la nota de crédito (con la plata en negativo). Sin ítems,
  -- el módulo fiscal no puede armar el desglose de IVA que AFIP exige.
  INSERT INTO public.venta_items (
    venta_id, producto_id, codigo, descripcion, cantidad,
    precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
    subtotal_sin_iva, iva_monto, subtotal_con_iva
  )
  SELECT
    v_nc_id, producto_id, codigo, descripcion, cantidad,
    precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
    -subtotal_sin_iva, -iva_monto, -subtotal_con_iva
  FROM public.venta_items
  WHERE venta_id = v_v.id;

  UPDATE public.ventas
     SET estado = 'ANULADA', venta_anulada_por = v_nc_id
   WHERE id = v_v.id;

  -- Devolver el stock
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
