-- ============================================================
-- Gastos varios / diarios.
--
-- Un gasto cotidiano (papel higiénico, café, un flete, etc.) es plata que SALE de
-- la caja. Se modela como un caja_movimientos tipo GASTO, igual que los gastos que
-- ya se cargaban en el arqueo, pero desde una pantalla simple y dedicada.
--
-- registrar_gasto AUTO-ABRE la caja (coherente con el rediseño: la caja se abre
-- sola con la primera operación del día), así se puede cargar un gasto aunque
-- todavía no haya habido ventas. El gasto aparece como salida en el arqueo/rendición.
-- ============================================================

CREATE OR REPLACE FUNCTION public.registrar_gasto(
  p_sucursal_id uuid,
  p_monto       numeric,
  p_forma_pago  text,
  p_descripcion text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_sesion uuid;
  v_mov    uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés cargar un gasto en una sucursal que no es la tuya';
  END IF;
  IF COALESCE(p_monto, 0) <= 0 THEN
    RAISE EXCEPTION 'El monto del gasto debe ser mayor a cero';
  END IF;
  IF COALESCE(TRIM(p_descripcion), '') = '' THEN
    RAISE EXCEPTION 'Poné una descripción (para qué fue el gasto)';
  END IF;
  IF p_forma_pago = 'CTA_CTE' THEN
    RAISE EXCEPTION 'CTA_CTE no es una forma de pago';
  END IF;

  -- La plata sale de la caja: APERTURA AUTOMÁTICA (auto-abre en la primera
  -- operación del día de la sucursal).
  v_sesion := public.caja_sesion_actual(p_sucursal_id);
  IF v_sesion IS NULL THEN
    RAISE EXCEPTION 'No se pudo abrir la caja para registrar el gasto';
  END IF;

  INSERT INTO public.caja_movimientos (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
  VALUES (v_sesion, 'GASTO', p_forma_pago::public.forma_pago, ROUND(p_monto, 2), TRIM(p_descripcion), v_uid)
  RETURNING id INTO v_mov;

  RETURN v_mov;
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_gasto(uuid, numeric, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.registrar_gasto(uuid, numeric, text, text) TO authenticated;
