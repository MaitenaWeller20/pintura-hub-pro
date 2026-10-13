-- Producción tiene anular_venta(uuid, uuid) con idempotencia. La función de
-- notas va por separado para conservar intacta la anulación de ventas.
CREATE OR REPLACE FUNCTION public.anular_nota_credito(p_venta_id uuid)
RETURNS TABLE(nc_id uuid, nc_numero text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_nc public.ventas%ROWTYPE;
  v_permite_neg boolean;
  v_stock_ant numeric(14,2);
  v_stock_nue numeric(14,2);
  v_sesion_abierta uuid;
  r record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_nc FROM public.ventas WHERE id = p_venta_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nota de crédito no encontrada';
  END IF;
  IF NOT public.is_admin(v_uid)
     AND v_nc.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés anular una nota de otra sucursal';
  END IF;
  IF v_nc.tipo_comprobante <> 'NOTA_CREDITO' THEN
    RAISE EXCEPTION 'El comprobante no es una nota de crédito';
  END IF;
  IF v_nc.estado = 'ANULADA' THEN
    RETURN QUERY SELECT v_nc.id, v_nc.numero_comprobante;
    RETURN;
  END IF;
  IF v_nc.cae IS NOT NULL AND NOT COALESCE(v_nc.afip_simulado, false) THEN
    RAISE EXCEPTION 'Una nota autorizada por AFIP no se puede anular desde esta pantalla';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ventas o WHERE o.venta_anulada_por = v_nc.id) THEN
    RAISE EXCEPTION 'No se puede anular la nota generada al anular otra venta';
  END IF;

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg
    FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false)
                   OR public.puede_vender_sin_stock(v_uid);

  PERFORM 1 FROM public.productos p
   WHERE p.id IN (SELECT vi.producto_id FROM public.venta_items vi
                   WHERE vi.venta_id = v_nc.id AND vi.producto_id IS NOT NULL)
   ORDER BY p.id FOR UPDATE;

  FOR r IN SELECT producto_id, cantidad, descripcion, codigo
             FROM public.venta_items
            WHERE venta_id = v_nc.id AND producto_id IS NOT NULL AND cantidad > 0
  LOOP
    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES (r.producto_id, v_nc.sucursal_id, -r.cantidad)
      ON CONFLICT (producto_id, sucursal_id)
      DO UPDATE SET cantidad = stock_sucursal.cantidad - r.cantidad
      RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
    ELSE
      UPDATE public.stock_sucursal
         SET cantidad = cantidad - r.cantidad
       WHERE producto_id = r.producto_id AND sucursal_id = v_nc.sucursal_id
         AND cantidad >= r.cantidad
      RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
      IF NOT FOUND THEN
        SELECT COALESCE(cantidad, 0) INTO v_stock_ant
          FROM public.stock_sucursal
         WHERE producto_id = r.producto_id AND sucursal_id = v_nc.sucursal_id;
        RAISE EXCEPTION 'No se puede anular: de % (%) hay % y la nota repuso %. Esa mercadería ya salió; ajustá el stock por conteo físico.',
          r.descripcion, r.codigo, COALESCE(v_stock_ant, 0), r.cantidad;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      r.producto_id, v_nc.sucursal_id, 'ANULACION_VENTA', -r.cantidad,
      v_stock_ant, v_stock_nue,
      'Anulación de nota de crédito ' || v_nc.numero_comprobante, v_nc.id, v_uid
    );
  END LOOP;

  UPDATE public.cuenta_corriente_movimientos SET estado = 'ANULADO'
   WHERE venta_id = v_nc.id AND estado = 'CONFIRMADO';

  IF EXISTS (SELECT 1 FROM public.venta_pagos WHERE venta_id = v_nc.id AND monto <> 0) THEN
    v_sesion_abierta := public.caja_sesion_actual(v_nc.sucursal_id);
    FOR r IN SELECT forma_pago, ABS(monto) AS monto
               FROM public.venta_pagos
              WHERE venta_id = v_nc.id AND monto <> 0
    LOOP
      INSERT INTO public.caja_movimientos
        (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
      VALUES
        (v_sesion_abierta, 'INGRESO', r.forma_pago, r.monto,
         'Reversa de nota de crédito anulada ' || v_nc.numero_comprobante, v_uid);
    END LOOP;
  END IF;

  UPDATE public.ventas SET estado = 'ANULADA' WHERE id = v_nc.id;
  RETURN QUERY SELECT v_nc.id, v_nc.numero_comprobante;
END; $$;

REVOKE ALL ON FUNCTION public.anular_nota_credito(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.anular_nota_credito(uuid) TO authenticated, service_role;

-- Si existe la firma de producción con idempotencia, la firma de un argumento
-- introducida por la migración anterior sería un overload ambiguo en PostgREST.
-- En bases que sólo tienen la firma de un argumento, se conserva para ventas.
DO $$ BEGIN
  IF to_regprocedure('public.anular_venta(uuid, uuid)') IS NOT NULL THEN
    DROP FUNCTION IF EXISTS public.anular_venta(uuid);
  END IF;
END $$;
