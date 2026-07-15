-- ============================================================
-- FIX de seguridad (security review): IDOR en caja_esperado.
--
-- caja_esperado es SECURITY DEFINER y no validaba acceso: cualquier usuario
-- autenticado podía pasar el id de una sesión de OTRA sucursal y obtener sus
-- totales de caja (ventas, compras, pagos). Se agrega el guard de sucursal, igual
-- que ya hace cerrar_caja: sólo admin o la sucursal dueña de la sesión.
--
-- Mismo criterio para proveedor_saldo: la deuda con proveedores es global de la
-- empresa (legible por cualquier empleado, como la cta cte de clientes), así que
-- ahí no hay restricción por sucursal; sólo se exige estar autenticado.
-- ============================================================

CREATE OR REPLACE FUNCTION public.caja_esperado(_sesion_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.caja_sesiones s
     WHERE s.id = _sesion_id
       AND (public.is_admin(v_uid) OR s.sucursal_id = public.current_sucursal_id())
  ) THEN
    RAISE EXCEPTION 'Sin acceso a esa sesión de caja';
  END IF;

  RETURN (
    WITH mov AS (
      SELECT vp.forma_pago::text AS forma,
             GREATEST(vp.monto, 0) AS entra, GREATEST(-vp.monto, 0) AS sale
        FROM public.venta_pagos vp
        JOIN public.ventas v ON v.id = vp.venta_id
       WHERE v.caja_sesion_id = _sesion_id
      UNION ALL
      SELECT c.forma_pago::text, GREATEST(c.monto, 0), GREATEST(-c.monto, 0)
        FROM public.cobranzas_cta_cte c
       WHERE c.caja_sesion_id = _sesion_id
      UNION ALL
      SELECT cm.forma_pago::text,
             CASE WHEN cm.tipo IN ('INICIAL', 'INGRESO') THEN cm.monto ELSE 0 END,
             CASE WHEN cm.tipo IN ('GASTO', 'RETIRO')    THEN cm.monto ELSE 0 END
        FROM public.caja_movimientos cm
       WHERE cm.caja_sesion_id = _sesion_id
      UNION ALL
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
      ) t
  );
END; $$;
REVOKE ALL ON FUNCTION public.caja_esperado(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.caja_esperado(uuid) TO authenticated, service_role;
