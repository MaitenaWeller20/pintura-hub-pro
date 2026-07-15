-- ============================================================
-- Vista de saldos de cuenta corriente de proveedores.
--
-- El frontend sumaba los movimientos en el cliente, lo que (a) podía truncarse
-- por el límite de filas de PostgREST con muchos movimientos, y (b) omitía a los
-- proveedores con cuenta corriente habilitada pero todavía sin movimientos.
-- La vista resuelve ambos: parte de los proveedores con cta cte y agrega su libro
-- en SQL. Espeja cuenta_corriente_saldos (clientes). security_invoker para que
-- respete la RLS de las tablas base.
-- ============================================================

CREATE OR REPLACE VIEW public.proveedor_cc_saldos
WITH (security_invoker = true) AS
SELECT
  p.id                                                             AS proveedor_id,
  p.razon_social,
  p.cuit_dni,
  COALESCE(SUM(m.monto) FILTER (WHERE m.tipo = 'DEBITO'),  0)      AS total_debe,
  COALESCE(SUM(m.monto) FILTER (WHERE m.tipo = 'CREDITO'), 0)      AS total_pagado,
  COALESCE(SUM(CASE m.tipo WHEN 'DEBITO' THEN m.monto ELSE -m.monto END), 0) AS saldo
FROM public.proveedores p
LEFT JOIN public.proveedor_cc_movimientos m
       ON m.proveedor_id = p.id AND m.estado = 'CONFIRMADO'
WHERE p.condicion_cta_cte AND p.activo
GROUP BY p.id, p.razon_social, p.cuit_dni;

GRANT SELECT ON public.proveedor_cc_saldos TO authenticated, service_role;
