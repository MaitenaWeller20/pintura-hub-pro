-- ============================================================
-- DIAGNÓSTICO PREVIO al db push de la migración 20260724150000
-- ("el stock no es el envase").
--
-- SÓLO LECTURA. Correr esto contra PRODUCCIÓN antes de aplicar la migración
-- muestra exactamente qué filas va a tocar y a qué valor las va a dejar, para
-- poder revisarlo con la clienta antes (o después: la corrección es reversible,
-- ver revertir-correccion-envase.sql).
--
-- Las consultas 1 y 2 replican el predicado EXACTO de la migración, incluidas
-- la exclusión por ambigüedad y el descarte de los no-ops (`anterior = objetivo`).
-- La 4 muestra lo que la migración NO puede arreglar.
--
-- Cómo: SQL Editor de Supabase (proyecto pintureria / cuenta "poldo"), o psql.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Resumen: cuántas filas se tocan y cuántas quedan afuera, y por qué.
-- ------------------------------------------------------------
WITH ult AS (
  SELECT m.producto_id, m.sucursal_id,
         max(m.created_at) AS ultimo_at,
         count(*)::integer AS n
    FROM public.stock_movimientos m
   GROUP BY m.producto_id, m.sucursal_id
),
snap AS (
  SELECT m.producto_id, m.sucursal_id, max(m.created_at) AS ultimo_snap_at
    FROM public.stock_movimientos m
   WHERE m.cantidad_nueva IS NOT NULL
   GROUP BY m.producto_id, m.sucursal_id
),
ambiguos AS (
  SELECT m.producto_id, m.sucursal_id
    FROM public.stock_movimientos m
    JOIN snap sn ON sn.producto_id = m.producto_id AND sn.sucursal_id = m.sucursal_id
   WHERE m.cantidad_nueva IS NOT NULL
     AND m.created_at = sn.ultimo_snap_at
   GROUP BY m.producto_id, m.sucursal_id
  HAVING count(*) > 1
  UNION
  SELECT u.producto_id, u.sucursal_id
    FROM ult u
    LEFT JOIN snap sn ON sn.producto_id = u.producto_id AND sn.sucursal_id = u.sucursal_id
   WHERE sn.producto_id IS NULL
),
firma AS (
  SELECT s.cantidad,
         s.updated_at,
         u.ultimo_at,
         (a.producto_id IS NOT NULL) AS ambiguo,
         COALESCE((
           SELECT m2.cantidad_nueva
             FROM public.stock_movimientos m2
            WHERE m2.producto_id = s.producto_id
              AND m2.sucursal_id = s.sucursal_id
              AND m2.cantidad_nueva IS NOT NULL
            ORDER BY m2.created_at DESC
            LIMIT 1), 0) AS objetivo
    FROM public.stock_sucursal s
    JOIN public.productos p ON p.id = s.producto_id
    LEFT JOIN ult u      ON u.producto_id = s.producto_id AND u.sucursal_id = s.sucursal_id
    LEFT JOIN ambiguos a ON a.producto_id = s.producto_id AND a.sucursal_id = s.sucursal_id
   WHERE p.tamano_envase IS NOT NULL
     AND p.tamano_envase <> 0
     AND s.cantidad = p.tamano_envase
)
SELECT
  count(*) FILTER (WHERE (ultimo_at IS NULL OR updated_at > ultimo_at)
                     AND NOT ambiguo AND cantidad <> objetivo)              AS se_corrigen,
  count(*) FILTER (WHERE (ultimo_at IS NULL OR updated_at > ultimo_at)
                     AND NOT ambiguo AND cantidad =  objetivo)              AS ya_estaban_en_el_valor_correcto,
  count(*) FILTER (WHERE (ultimo_at IS NULL OR updated_at > ultimo_at)
                     AND ambiguo)                                           AS se_saltean_por_ambiguas,
  count(*) FILTER (WHERE ultimo_at IS NOT NULL AND updated_at = ultimo_at)  AS intactas_ultimo_write_con_kardex,
  count(*)                                                                  AS total_con_cantidad_igual_al_envase
  FROM firma;

-- ------------------------------------------------------------
-- 2) El detalle, fila por fila: qué tiene hoy y a qué va a quedar.
--    Esta es la lista para mirar con la clienta.
-- ------------------------------------------------------------
WITH ult AS (
  SELECT m.producto_id, m.sucursal_id,
         max(m.created_at) AS ultimo_at,
         count(*)::integer AS n
    FROM public.stock_movimientos m
   GROUP BY m.producto_id, m.sucursal_id
),
snap AS (
  SELECT m.producto_id, m.sucursal_id, max(m.created_at) AS ultimo_snap_at
    FROM public.stock_movimientos m
   WHERE m.cantidad_nueva IS NOT NULL
   GROUP BY m.producto_id, m.sucursal_id
),
ambiguos AS (
  SELECT m.producto_id, m.sucursal_id
    FROM public.stock_movimientos m
    JOIN snap sn ON sn.producto_id = m.producto_id AND sn.sucursal_id = m.sucursal_id
   WHERE m.cantidad_nueva IS NOT NULL
     AND m.created_at = sn.ultimo_snap_at
   GROUP BY m.producto_id, m.sucursal_id
  HAVING count(*) > 1
  UNION
  SELECT u.producto_id, u.sucursal_id
    FROM ult u
    LEFT JOIN snap sn ON sn.producto_id = u.producto_id AND sn.sucursal_id = u.sucursal_id
   WHERE sn.producto_id IS NULL
)
SELECT p.codigo,
       p.nombre,
       su.nombre                AS sucursal,
       s.cantidad               AS stock_hoy,
       p.tamano_envase          AS env,
       COALESCE(u.n, 0)         AS movimientos,
       s.updated_at             AS stock_escrito_el,
       u.ultimo_at              AS ultimo_kardex_el,
       obj.objetivo             AS quedaria_en,
       CASE
         WHEN a.producto_id IS NOT NULL  THEN 'SE SALTEA (ambigua)'
         WHEN s.cantidad = obj.objetivo  THEN 'SIN CAMBIO'
         ELSE 'SE CORRIGE'
       END AS accion
  FROM public.stock_sucursal s
  JOIN public.productos  p  ON p.id  = s.producto_id
  JOIN public.sucursales su ON su.id = s.sucursal_id
  LEFT JOIN ult u      ON u.producto_id = s.producto_id AND u.sucursal_id = s.sucursal_id
  LEFT JOIN ambiguos a ON a.producto_id = s.producto_id AND a.sucursal_id = s.sucursal_id
  CROSS JOIN LATERAL (
    SELECT COALESCE((
      SELECT m2.cantidad_nueva
        FROM public.stock_movimientos m2
       WHERE m2.producto_id = s.producto_id
         AND m2.sucursal_id = s.sucursal_id
         AND m2.cantidad_nueva IS NOT NULL
       ORDER BY m2.created_at DESC
       LIMIT 1), 0) AS objetivo
  ) obj
 WHERE p.tamano_envase IS NOT NULL
   AND p.tamano_envase <> 0
   AND s.cantidad = p.tamano_envase
   AND (u.ultimo_at IS NULL OR s.updated_at > u.ultimo_at)
 ORDER BY accion, p.codigo, su.nombre;

-- ------------------------------------------------------------
-- 3) Control de sanidad: ¿hay filas de stock que NO son el envase?
--    Si el resultado es 0, TODO el inventario vino de la importación y la
--    corrección lo va a dejar en cero: esperable, pero conviene saberlo antes.
-- ------------------------------------------------------------
SELECT count(*) AS filas_con_stock_que_no_es_el_envase
  FROM public.stock_sucursal s
  JOIN public.productos p ON p.id = s.producto_id
 WHERE s.cantidad <> 0
   AND (p.tamano_envase IS NULL OR s.cantidad <> p.tamano_envase);

-- ------------------------------------------------------------
-- 4) Lo que la migración NO va a corregir: filas contaminadas sobre las que ya
--    se operó. Una venta/ingreso/ajuste posterior a la importación rota cambió
--    la cantidad (ya no es igual al envase) y dejó kardex, así que la fila deja
--    de cumplir el predicado — pero su base seguía siendo el stock fantasma.
--
--    La firma dura es un movimiento cuyo `cantidad_anterior` es EXACTAMENTE el
--    tamaño de envase del producto: leyó una base contaminada.
--    Estas se arreglan con el ajuste de /stock (conteo físico).
-- ------------------------------------------------------------
SELECT p.codigo,
       p.nombre,
       su.nombre          AS sucursal,
       s.cantidad         AS stock_hoy,
       p.tamano_envase    AS env,
       m.tipo,
       m.created_at       AS movimiento_sobre_base_contaminada,
       m.cantidad_anterior,
       m.cantidad_nueva
  FROM public.stock_movimientos m
  JOIN public.productos  p  ON p.id  = m.producto_id
  JOIN public.sucursales su ON su.id = m.sucursal_id
  JOIN public.stock_sucursal s
       ON s.producto_id = m.producto_id AND s.sucursal_id = m.sucursal_id
 WHERE p.tamano_envase IS NOT NULL
   AND p.tamano_envase <> 0
   AND m.cantidad_anterior = p.tamano_envase
   AND s.cantidad <> p.tamano_envase      -- las que siguen iguales ya salen en (2)
 ORDER BY p.codigo, su.nombre, m.created_at;

-- ------------------------------------------------------------
-- 5) ¿Hay movimientos sin snapshot? (cierra empíricamente el riesgo de que el
--    "último valor auditado" caiga en un empate escondido detrás de un NULL).
--    Si da 0, ese camino no existe en estos datos.
-- ------------------------------------------------------------
SELECT count(*) AS movimientos_sin_snapshot
  FROM public.stock_movimientos
 WHERE cantidad_nueva IS NULL;
