-- ============================================================
-- G5 (2): el saldo de cuenta corriente de CLIENTES debe ser GLOBAL.
--
-- Problema: cuenta_corriente_saldos es security_invoker=true y
-- cuenta_corriente_movimientos tiene RLS por-sucursal (ccmov select =
-- is_admin OR sucursal_id = current_sucursal_id()). Un cajero NO-admin veía
-- solo los movimientos de SU sucursal -> saldo PARCIAL en la lista y en el
-- detalle -> riesgo de no cobrar. La deuda del cliente es global de la empresa
-- (mismo criterio que proveedor_saldo: legible por cualquier empleado).
--
-- Fix sin fugar filas de otras sucursales:
--  (a) La VISTA de saldos pasa a definer (security_invoker=false). Como la vista
--      es propiedad de postgres (owner de las tablas, sin FORCE RLS), lee las
--      tablas base bypassando RLS y AGREGA global. Solo expone los TOTALES
--      (debe/pagado/saldo), nunca las filas individuales de movimientos.
--  (b) Nueva RPC cc_resumen (SECURITY DEFINER) para el detalle: da debe/pagado/
--      saldo GLOBAL sin que el front recompute a partir de filas RLS-filtradas.
--
-- La LISTA de movimientos del detalle (cuenta_corriente_movimientos) queda como
-- está: sigue RLS-filtrada por sucursal, así un cajero no ve qué compró el
-- cliente en OTRA sucursal. Solo el saldo (agregado) es global.
--
-- Proveedores NO se toca: prov_cc select ya es 'true' (global) y proveedor_cc_
-- saldos ya agrega global.
-- ============================================================

-- (a) Vista de saldos de clientes: agregación GLOBAL (definer).
ALTER VIEW public.cuenta_corriente_saldos SET (security_invoker = false);

-- (b) Resumen global de un cliente para el detalle (espeja cc_saldo, con las 3
--     cifras). SECURITY DEFINER: agrega sobre TODAS las sucursales.
CREATE OR REPLACE FUNCTION public.cc_resumen(_cliente_id uuid)
RETURNS TABLE (total_debe numeric, total_pagado numeric, saldo numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    COALESCE(SUM(CASE WHEN tipo = 'DEBITO'  THEN monto ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN tipo = 'CREDITO' THEN monto ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN tipo = 'DEBITO'  THEN monto ELSE -monto END), 0)
    FROM public.cuenta_corriente_movimientos
   WHERE cliente_id = _cliente_id AND estado = 'CONFIRMADO';
$$;
REVOKE ALL ON FUNCTION public.cc_resumen(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.cc_resumen(uuid) TO authenticated, service_role;
