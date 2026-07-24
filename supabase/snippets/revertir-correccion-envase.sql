-- ============================================================
-- REVERSA de la corrección "el stock no es el envase" (20260724150000).
--
-- Cuándo usar esto: si la clienta revisa el inventario y dice "che, estos sí
-- eran stock real, no eran el envase". Restaura cantidad_anterior fila por fila
-- desde public.stock_correccion_envase.
--
-- NO es una migración: se corre a mano en el SQL editor de Supabase (o por psql),
-- con criterio. Leer el SELECT del paso 1 ANTES de correr el UPDATE del paso 2.
--
-- REGLA QUE NO SE ROMPE: las filas de stock_correccion_envase NUNCA se borran.
-- Son la guarda de idempotencia de la migración: si se borra la fila y la
-- migración se vuelve a aplicar (base nueva, reset, replay), volvería a ver
-- cantidad = envase con updated_at posterior al último movimiento y la
-- "corregiría" de nuevo, deshaciendo esta reversa. Por eso el paso 3 MARCA
-- (revertido_at) en vez de borrar.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Qué se corrigió. Mirar esto primero.
-- ------------------------------------------------------------
SELECT c.created_at,
       c.producto_codigo,
       c.producto_nombre,
       c.sucursal_codigo,
       c.cantidad_anterior           AS tenia,
       c.cantidad_nueva              AS quedo_en,
       c.tamano_envase               AS env,
       c.movimientos_count           AS movs,
       s.cantidad                    AS cantidad_actual,
       (s.updated_at > c.created_at) AS se_movio_despues,
       c.revertido_at,
       CASE
         WHEN c.revertido_at IS NOT NULL          THEN 'ya revertida'
         WHEN s.producto_id IS NULL               THEN 'sin fila de stock (producto borrado?)'
         WHEN s.updated_at > c.created_at         THEN 'NO se puede revertir: se movió después → usar el ajuste de /stock'
         ELSE 'revertible'
       END AS estado
  FROM public.stock_correccion_envase c
  LEFT JOIN public.stock_sucursal s
         ON s.producto_id = c.producto_id AND s.sucursal_id = c.sucursal_id
 ORDER BY c.producto_codigo, c.sucursal_codigo;

-- ------------------------------------------------------------
-- 2) Revertir. Descomentar y ajustar el filtro de códigos.
--
-- Restaurar y marcar van en UN SOLO statement, encadenados por CTE, para que
-- `revertido_at` se complete SÓLO en las filas que efectivamente se
-- restauraron. Si fueran dos statements con filtros distintos, una fila que la
-- guarda saltea quedaría marcada como revertida sin haberlo sido — y como el
-- paso 2 exige `revertido_at IS NULL`, esa marca la dejaría fuera de la reversa
-- para siempre.
--
-- La guarda `s.updated_at <= c.created_at` evita pisar una fila que ya se movió
-- DESPUÉS de la corrección (una venta, un ingreso, un ajuste manual): en ese
-- caso el valor de hoy es más nuevo que el que estamos por restaurar y hay que
-- resolverlo con el ajuste de /stock, no con esta reversa. Sirve porque la
-- corrección dejó `stock_sucursal.updated_at` = `created_at` de la fila de
-- respaldo (misma transacción, mismo now()).
--
-- Ojo: este UPDATE es una escritura directa de stock_sucursal y NO deja kardex.
-- Es a propósito, por simetría con la corrección (ver §6.6 del spec). Corre como
-- postgres/service_role; desde `authenticated` está revocado.
--
-- El RETURNING final lista lo que se revirtió: si sale vacío, no se revirtió
-- nada (mirar la columna `estado` del paso 1 para saber por qué).
-- ------------------------------------------------------------
-- WITH revertidas AS (
--   UPDATE public.stock_sucursal s
--      SET cantidad = c.cantidad_anterior
--     FROM public.stock_correccion_envase c
--    WHERE s.producto_id = c.producto_id
--      AND s.sucursal_id = c.sucursal_id
--      AND c.revertido_at IS NULL
--      AND s.updated_at <= c.created_at          -- no pisar lo que se movió después
--      AND c.producto_codigo IN ('1000-02000')   -- ← acotar a los códigos a revertir
--   RETURNING c.id, c.producto_codigo, c.sucursal_codigo, c.cantidad_anterior
-- ),
-- marcadas AS (
--   UPDATE public.stock_correccion_envase
--      SET revertido_at = now()
--    WHERE id IN (SELECT id FROM revertidas)
--   RETURNING id
-- )
-- SELECT producto_codigo, sucursal_codigo, cantidad_anterior AS restaurado_a
--   FROM revertidas ORDER BY producto_codigo, sucursal_codigo;

-- ------------------------------------------------------------
-- 3) NO hay paso 3. Las filas de stock_correccion_envase NUNCA se borran
--    (ver el encabezado): el paso 2 ya dejó marcada la reversa.
-- ------------------------------------------------------------
