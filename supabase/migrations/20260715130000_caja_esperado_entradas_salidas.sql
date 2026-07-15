-- ============================================================
-- caja_esperado v3 — entradas, salidas y neto por forma de pago.
--
-- Hasta ahora la caja sólo tenía entradas (ventas, cobranzas). Con compras y
-- pagos a proveedor aparecen SALIDAS. La función pasa a devolver, por forma de
-- pago, { entra, sale, neto } (antes: { forma: monto }). El neto es lo que se
-- arquea contra el conteo físico; entra/sale son para mostrar el desglose.
--
-- Fuentes:
--   ENTRADAS: venta_pagos (montos > 0), cobranzas (> 0), movimientos INICIAL/INGRESO.
--   SALIDAS:  pagos a proveedor CONFIRMADO, movimientos GASTO/RETIRO, y los montos
--             NEGATIVOS de venta_pagos/cobranzas (NC de anulación = plata que sale).
-- ============================================================

CREATE OR REPLACE FUNCTION public.caja_esperado(_sesion_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH mov AS (
    -- Pagos de ventas de la sesión (monto firmado: NC de anulación viene negativo).
    SELECT vp.forma_pago::text AS forma,
           GREATEST(vp.monto, 0) AS entra, GREATEST(-vp.monto, 0) AS sale
      FROM public.venta_pagos vp
      JOIN public.ventas v ON v.id = vp.venta_id
     WHERE v.caja_sesion_id = _sesion_id
    UNION ALL
    -- Cobranzas de cuenta corriente (idem signo).
    SELECT c.forma_pago::text,
           GREATEST(c.monto, 0), GREATEST(-c.monto, 0)
      FROM public.cobranzas_cta_cte c
     WHERE c.caja_sesion_id = _sesion_id
    UNION ALL
    -- Movimientos manuales de caja.
    SELECT cm.forma_pago::text,
           CASE WHEN cm.tipo IN ('INICIAL', 'INGRESO') THEN cm.monto ELSE 0 END,
           CASE WHEN cm.tipo IN ('GASTO', 'RETIRO')    THEN cm.monto ELSE 0 END
      FROM public.caja_movimientos cm
     WHERE cm.caja_sesion_id = _sesion_id
    UNION ALL
    -- Pagos a proveedor: salida pura (los anulados no cuentan).
    SELECT pp.forma_pago, 0, pp.monto
      FROM public.proveedor_pagos pp
     WHERE pp.caja_sesion_id = _sesion_id AND pp.estado = 'CONFIRMADO'
  )
  SELECT COALESCE(
           jsonb_object_agg(forma, jsonb_build_object('entra', e, 'sale', s, 'neto', e - s)),
           '{}'::jsonb
         )
    FROM (
      SELECT forma, ROUND(SUM(entra), 2) AS e, ROUND(SUM(sale), 2) AS s
        FROM mov GROUP BY forma
    ) t;
$$;
REVOKE ALL ON FUNCTION public.caja_esperado(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.caja_esperado(uuid) TO authenticated, service_role;

-- cerrar_caja: lee el 'neto' del nuevo shape de caja_esperado.
CREATE OR REPLACE FUNCTION public.cerrar_caja(p_sesion_id uuid, p_contado jsonb DEFAULT '{}'::jsonb, p_notas text DEFAULT NULL::text)
 RETURNS TABLE(total_esperado numeric, total_contado numeric, total_diferencia numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_ses       public.caja_sesiones%ROWTYPE;
  v_esperado  jsonb;
  v_contado   jsonb := COALESCE(p_contado, '{}'::jsonb);
  v_diferencia jsonb := '{}'::jsonb;
  v_tot_esp   numeric(14,2) := 0;
  v_tot_cont  numeric(14,2) := 0;
  k           text;
  v_formas    text[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_ses FROM public.caja_sesiones WHERE id = p_sesion_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sesión de caja no existe';
  END IF;
  IF v_ses.estado <> 'ABIERTA' THEN
    RAISE EXCEPTION 'La caja ya fue cerrada';
  END IF;
  IF NOT public.is_admin(v_uid) AND v_ses.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'Esa caja es de otra sucursal';
  END IF;

  v_esperado := public.caja_esperado(p_sesion_id);

  -- Validar que las claves de `contado` sean formas de pago reales.
  FOR k IN SELECT jsonb_object_keys(v_contado) LOOP
    BEGIN
      PERFORM k::public.forma_pago;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Forma de pago desconocida en el conteo: %', k;
    END;
  END LOOP;

  -- diferencia = contado − esperado, sobre la UNIÓN de las formas presentes en
  -- cualquiera de los dos (una forma sólo esperada cuenta como faltante total;
  -- una sólo contada, como sobrante).
  SELECT array_agg(DISTINCT f) INTO v_formas FROM (
    SELECT jsonb_object_keys(v_esperado) AS f
    UNION
    SELECT jsonb_object_keys(v_contado) AS f
  ) u;

  IF v_formas IS NOT NULL THEN
    FOREACH k IN ARRAY v_formas LOOP
      v_diferencia := v_diferencia || jsonb_build_object(
        k,
        ROUND(COALESCE((v_contado->>k)::numeric, 0) - COALESCE((v_esperado->k->>'neto')::numeric, 0), 2)
      );
    END LOOP;
  END IF;

  SELECT COALESCE(SUM((value->>'neto')::numeric), 0) INTO v_tot_esp FROM jsonb_each(v_esperado);
  SELECT COALESCE(SUM((value)::numeric), 0) INTO v_tot_cont  FROM jsonb_each_text(v_contado);

  UPDATE public.caja_sesiones SET
    estado           = 'CERRADA',
    cerrada_por      = v_uid,
    cerrada_en       = now(),
    esperado         = v_esperado,
    contado          = v_contado,
    diferencia       = v_diferencia,
    total_esperado   = v_tot_esp,
    total_contado    = v_tot_cont,
    total_diferencia = ROUND(v_tot_cont - v_tot_esp, 2),
    notas            = p_notas
  WHERE id = p_sesion_id;

  RETURN QUERY SELECT v_tot_esp, v_tot_cont, ROUND(v_tot_cont - v_tot_esp, 2);
END; $function$

;
REVOKE ALL ON FUNCTION public.cerrar_caja(uuid, jsonb, text) FROM public;
GRANT EXECUTE ON FUNCTION public.cerrar_caja(uuid, jsonb, text) TO authenticated, service_role;
