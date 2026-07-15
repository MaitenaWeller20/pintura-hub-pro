-- ============================================================
-- Unicidad de CUIT/DNI en clientes.
--
-- Hasta ahora cuit_dni era texto libre sin unicidad: se podían cargar N clientes
-- con el mismo CUIT. Se agrega un índice único parcial sobre la forma normalizada
-- (sólo dígitos), para que "30-71234567-8" y "30712345678" colisionen. Se excluyen
-- NULL/vacíos (consumidor final sin identificar) y los inactivos (baja lógica), de
-- modo que dar de baja un cliente no bloquee reusar su documento en un alta nueva.
--
-- La validación del dígito verificador (módulo 11) es de UI (src/lib/fiscal/codigos.ts);
-- la unicidad la garantiza atómicamente este índice en Postgres.
--
-- IMPORTANTE: si ya existieran dos clientes activos con el mismo documento, este
-- CREATE INDEX falla. En local no hay duplicados; en producción hay que verificar
-- antes con:
--   SELECT regexp_replace(cuit_dni,'\D','','g') d, count(*)
--     FROM public.clientes WHERE cuit_dni IS NOT NULL AND btrim(cuit_dni)<>'' AND activo
--    GROUP BY d HAVING count(*) > 1;
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_cuit_dni_activo
  ON public.clientes ((regexp_replace(cuit_dni, '\D', '', 'g')))
  WHERE cuit_dni IS NOT NULL
    AND activo
    -- Excluye no sólo NULL/vacío sino también placeholders legacy que quedan
    -- vacíos al normalizar ("-", "S/D", "sin doc"): no deben colisionar entre sí.
    AND regexp_replace(cuit_dni, '\D', '', 'g') <> '';
