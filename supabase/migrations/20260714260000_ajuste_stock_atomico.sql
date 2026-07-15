-- ============================================================
-- Ajuste de stock atómico (RPC transaccional).
--
-- ajusteStock (src/lib/stock.functions.ts) hacía read-modify-write en 3 statements
-- sueltos, sin transacción ni chequeo de error: leía la cantidad, escribía la nueva
-- (absoluta) e insertaba el movimiento por separado. Dos problemas:
--   (a) lost-update: una venta concurrente que descuenta stock entre el read y el
--       write quedaba pisada por el ajuste.
--   (b) si fallaba el insert del movimiento, el stock ya había cambiado sin kardex.
--
-- Ahora todo pasa por esta RPC SECURITY DEFINER: bloquea la fila (FOR UPDATE),
-- calcula la diferencia real contra la cantidad bloqueada, y escribe stock_sucursal
-- + stock_movimientos en una sola transacción. Mismo patrón que crear_venta.
-- ============================================================

CREATE OR REPLACE FUNCTION public.ajustar_stock(
  p_producto_id     uuid,
  p_sucursal_id     uuid,
  p_nueva_cantidad  numeric,
  p_motivo          text
)
RETURNS TABLE (cantidad_anterior numeric, cantidad_nueva numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ant numeric(14,2);
  v_nue numeric(14,2) := ROUND(p_nueva_cantidad, 2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo el administrador puede ajustar stock';
  END IF;
  IF p_nueva_cantidad IS NULL OR p_nueva_cantidad < 0 THEN
    RAISE EXCEPTION 'La cantidad no puede ser negativa';
  END IF;
  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
    RAISE EXCEPTION 'El motivo del ajuste es obligatorio';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.productos WHERE id = p_producto_id) THEN
    RAISE EXCEPTION 'Producto inexistente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sucursales WHERE id = p_sucursal_id) THEN
    RAISE EXCEPTION 'Sucursal inexistente';
  END IF;

  -- Garantiza que la fila exista sin pisar la cantidad si ya está.
  INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
  VALUES (p_producto_id, p_sucursal_id, 0)
  ON CONFLICT (producto_id, sucursal_id) DO NOTHING;

  -- Lock exclusivo de la fila: una venta concurrente sobre este (producto,
  -- sucursal) espera hasta el COMMIT → se elimina el lost-update.
  SELECT cantidad INTO v_ant
    FROM public.stock_sucursal
   WHERE producto_id = p_producto_id AND sucursal_id = p_sucursal_id
   FOR UPDATE;

  UPDATE public.stock_sucursal
     SET cantidad = v_nue
   WHERE producto_id = p_producto_id AND sucursal_id = p_sucursal_id;

  INSERT INTO public.stock_movimientos (
    producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
    motivo, usuario_id
  ) VALUES (
    p_producto_id, p_sucursal_id, 'AJUSTE', v_nue - v_ant, v_ant, v_nue,
    btrim(p_motivo), v_uid
  );

  RETURN QUERY SELECT v_ant, v_nue;
END; $$;

REVOKE ALL ON FUNCTION public.ajustar_stock(uuid, uuid, numeric, text) FROM public;
GRANT EXECUTE ON FUNCTION public.ajustar_stock(uuid, uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ajustar_stock(uuid, uuid, numeric, text) TO service_role;
