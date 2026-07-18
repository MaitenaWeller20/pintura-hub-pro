-- ============================================================
-- G6 — BAJAS DE SEGURIDAD
--
-- (1) stock_movimientos: cerrar el INSERT directo de `authenticated`. Hoy
--     cualquier autenticado podía escribir kardex arbitrario por PostgREST
--     (policy WITH CHECK (true)). Las RPC que escriben kardex son SECURITY
--     DEFINER (owner postgres) y NO se ven afectadas. La única escritura directa
--     que quedaba era aprobarRemito; ya se movió a la RPC aprobar_remito
--     (migración 20260718100000), así que ahora se puede cerrar el INSERT.
-- (2) proveedor_cc_movimientos: se DOCUMENTA que la lectura global es intencional
--     (la deuda con el proveedor es de la empresa; la vista de saldos la agrega
--     global). No se restringe por sucursal para no romper el saldo global.
-- (3) proveedor_cc_saldos y cuenta_corriente_saldos: incluir también a entidades
--     con saldo != 0 aunque tengan cta cte deshabilitada o estén inactivas
--     (si no, se oculta deuda real -> deuda invisible). Fix con HAVING.
--
-- NOTA de coordinación: esta migración NO recrea aprobar_remito (ya existe, con
-- guarda de stock negativo, en 20260718100000). Y cuenta_corriente_saldos se
-- recrea CONSERVANDO security_invoker=false (fijado en 20260718130000 para que el
-- saldo sea GLOBAL para no-admin); acá sólo se le agrega el HAVING.
-- ============================================================

-- ------------------------------------------------------------
-- (1) Cerrar el INSERT directo. Las RPC (definer/owner postgres) siguen
--     escribiendo; el frontend sólo hace SELECT sobre esta tabla (reportes.tsx).
-- ------------------------------------------------------------
REVOKE INSERT ON public.stock_movimientos FROM authenticated;
DROP POLICY IF EXISTS "auth insert movs" ON public.stock_movimientos;
-- (se conserva "auth read movs" FOR SELECT: reportes.tsx la usa)

-- ------------------------------------------------------------
-- (2) proveedor_cc_movimientos: lectura global INTENCIONAL (deuda de la empresa,
--     no de la sucursal). Se documenta; la policy USING (true) se mantiene.
-- ------------------------------------------------------------
COMMENT ON POLICY "prov_cc select" ON public.proveedor_cc_movimientos IS
  'Lectura global intencional: la deuda con el proveedor es de la empresa (compras y pagos de cualquier sucursal netean contra el mismo saldo). La vista proveedor_cc_saldos depende de esta visibilidad global.';

-- ------------------------------------------------------------
-- (3a) proveedor_cc_saldos: incluir proveedores con saldo != 0 aunque no tengan
--      cta cte o estén inactivos (deuda no debe quedar invisible). Mismas columnas
--      y misma propiedad security_invoker=true que la vista original.
-- ------------------------------------------------------------
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
GROUP BY p.id, p.razon_social, p.cuit_dni
HAVING (p.condicion_cta_cte AND p.activo)
    OR COALESCE(SUM(CASE m.tipo WHEN 'DEBITO' THEN m.monto ELSE -m.monto END), 0) <> 0;
GRANT SELECT ON public.proveedor_cc_saldos TO authenticated, service_role;

-- ------------------------------------------------------------
-- (3b) cuenta_corriente_saldos (clientes): mismo criterio de HAVING. Columnas
--      idénticas. IMPORTANTE: security_invoker=FALSE (definer) para conservar el
--      saldo GLOBAL de la migración 20260718130000 (G5).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.cuenta_corriente_saldos
WITH (security_invoker = false) AS
SELECT
  c.id AS cliente_id,
  c.razon_social,
  c.cuit_dni,
  c.telefono,
  c.limite_credito,
  COALESCE(SUM(CASE WHEN m.tipo = 'DEBITO' THEN m.monto ELSE 0 END), 0) AS total_debe,
  COALESCE(SUM(CASE WHEN m.tipo = 'CREDITO' THEN m.monto ELSE 0 END), 0) AS total_pagado,
  COALESCE(SUM(CASE WHEN m.tipo = 'DEBITO' THEN m.monto ELSE -m.monto END), 0) AS saldo
FROM public.clientes c
LEFT JOIN public.cuenta_corriente_movimientos m
  ON m.cliente_id = c.id AND m.estado = 'CONFIRMADO'
GROUP BY c.id, c.razon_social, c.cuit_dni, c.telefono, c.limite_credito
HAVING (c.condicion_cta_cte AND c.activo)
    OR COALESCE(SUM(CASE WHEN m.tipo = 'DEBITO' THEN m.monto ELSE -m.monto END), 0) <> 0;
GRANT SELECT ON public.cuenta_corriente_saldos TO authenticated, service_role;
