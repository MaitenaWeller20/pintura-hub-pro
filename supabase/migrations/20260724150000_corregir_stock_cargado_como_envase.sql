-- ============================================================
-- El stock no es el envase.
--
-- La importación de la lista de precios (/productos/importar) ofrecía destinos
-- "Stock O'Higgins" / "Stock General Paz" y hacía un upsert ABSOLUTO sobre
-- stock_sucursal, sin kardex. La lista de Quimexur no trae stock: sus columnas
-- son CÓDIGO, DESCRIPCIÓN, ENV. y PRECIO DE LISTA. La única columna numérica
-- libre es ENV. (el tamaño de envase), así que el inventario quedó cargado con
-- el envase: "SOL MEX SOLVENTE BLANCO" con ENV 20 figura con 20 de stock, el de
-- ENV 200 con 200. El stock real se carga aparte (Ingresos de mercadería,
-- Compras, o el ajuste de /stock).
--
-- Esta migración hace tres cosas:
--   (1) crea la tabla de respaldo/auditoría de la corrección;
--   (2) devuelve las filas contaminadas a su último valor auditado (0 si nunca
--       tuvieron uno);
--   (3) cierra la escritura directa de stock_sucursal, para que la única forma
--       de mover stock sea una RPC que deje kardex.
--
-- ES DESTRUCTIVA (baja cantidades de stock), pero REVERSIBLE fila por fila:
-- ver supabase/snippets/revertir-correccion-envase.sql. Antes del push conviene
-- correr supabase/snippets/diagnostico-stock-envase.sql contra producción para
-- ver exactamente qué filas va a tocar.
--
-- Diseño y decisiones: docs/superpowers/specs/2026-07-24-stock-no-es-envase-design.md
-- ============================================================

-- ------------------------------------------------------------
-- (1) Respaldo de la corrección.
--
-- Es a la vez el informe (qué se tocó y con qué contexto), la reversa
-- (supabase/snippets/revertir-correccion-envase.sql) y la guarda de
-- idempotencia (el UPDATE saltea todo par producto+sucursal que ya esté acá,
-- incluidos los revertidos a mano: por eso la reversa MARCA con revertido_at y
-- nunca borra la fila).
--
-- A propósito NO se escribe stock_movimientos: (a) eliminar_productos toma
-- "EXISTS stock_movimientos" como historial y archivaría en vez de borrar, y la
-- FK dejaría a esos productos imposibles de borrar para siempre por un dato que
-- nunca existió; (b) un AJUSTE -20 diría "salieron 20 unidades del depósito", y
-- no salió nada: nunca entraron. Esto es una reparación de dato, no un
-- movimiento de mercadería.
--
-- Las FK van ON DELETE SET NULL (no CASCADE) y el código/nombre se guardan
-- desnormalizados: si mañana se borra el producto, el registro de auditoría
-- tiene que sobrevivir, y a la vez no puede impedir ese borrado.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_correccion_envase (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id          uuid REFERENCES public.productos(id)  ON DELETE SET NULL,
  sucursal_id          uuid REFERENCES public.sucursales(id) ON DELETE SET NULL,
  producto_codigo      text NOT NULL,
  producto_nombre      text NOT NULL,
  sucursal_codigo      text,
  cantidad_anterior    numeric(14,2) NOT NULL,
  cantidad_nueva       numeric(14,2) NOT NULL,
  tamano_envase        numeric(10,2),
  stock_updated_at     timestamptz,
  ultimo_movimiento_at timestamptz,
  movimientos_count    integer NOT NULL DEFAULT 0,
  motivo               text NOT NULL,
  revertido_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (producto_id, sucursal_id)
);

COMMENT ON TABLE public.stock_correccion_envase IS
  'Respaldo de la corrección del 2026-07-24: filas de stock_sucursal que habían quedado cargadas con el tamaño de envase (columna ENV. de la lista de precios) por la importación de productos. Guarda el valor anterior para poder revertir fila por fila (supabase/snippets/revertir-correccion-envase.sql). NUNCA borrar filas de esta tabla: son la guarda de idempotencia de la migración.';
COMMENT ON COLUMN public.stock_correccion_envase.stock_updated_at IS
  'updated_at que tenía la fila de stock_sucursal antes de corregirla. Era POSTERIOR al último movimiento de kardex: esa es la firma de una escritura sin kardex (la importación).';
COMMENT ON COLUMN public.stock_correccion_envase.cantidad_nueva IS
  'Valor restaurado: la cantidad_nueva del último movimiento de kardex de ese producto+sucursal, o 0 si nunca hubo uno.';
COMMENT ON COLUMN public.stock_correccion_envase.revertido_at IS
  'Se completa a mano si la corrección se deshizo (ver supabase/snippets/revertir-correccion-envase.sql). La fila se conserva igual: es lo que impide que un rerun de la migración vuelva a "corregir" lo que ya se revirtió.';

GRANT SELECT ON public.stock_correccion_envase TO authenticated;
GRANT ALL    ON public.stock_correccion_envase TO service_role;
ALTER TABLE public.stock_correccion_envase ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read correccion envase" ON public.stock_correccion_envase;
CREATE POLICY "admin read correccion envase" ON public.stock_correccion_envase
  FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));

-- ------------------------------------------------------------
-- (2) La corrección.
--
-- Cómo se reconoce una fila contaminada: la importación escribía stock_sucursal
-- SIN dejar kardex. Una escritura hecha por una RPC deja updated_at (trigger
-- trg_stock_upd -> set_updated_at(), que usa now()) EXACTAMENTE igual al
-- created_at del movimiento (DEFAULT now()): misma transacción, mismo
-- timestamp, sin importar el orden ni cuántos statements haya. Entonces:
--
--   updated_at  =  max(mov.created_at)  -> la última escritura fue una RPC. Sana.
--   updated_at  >  max(mov.created_at)  -> la última escritura no dejó kardex.
--   sin movimientos                     -> nunca hubo kardex.
--
-- Esto es mejor que "no tiene movimientos": un upsert absoluto pisa igual una
-- fila con historial, y con el criterio ingenuo los productos más operados
-- quedaban sin corregir.
--
-- Se vuelve al ÚLTIMO VALOR AUDITADO, no a 0: una fila que tenía 7 reales, fue
-- pisada con 20 (el envase) y no se movió más, vuelve a 7.
--
-- AMBIGÜEDAD: el "último valor auditado" sale de los movimientos que traen
-- snapshot (cantidad_nueva NOT NULL). Si el created_at más reciente DE ESE
-- CONJUNTO tiene más de un movimiento —una venta con el mismo producto en dos
-- líneas escribe dos movimientos con el mismo timestamp de transacción— no hay
-- forma determinística de saber cuál fue el último: el id es un uuid aleatorio,
-- no un orden temporal, y elegir por id devuelve un valor INTERMEDIO de la
-- cadena la mitad de las veces. Lo mismo si la fila tiene kardex pero ninguna
-- cantidad_nueva: no hay valor al que volver.
--
-- Esas filas se SALTEAN y se informan por NOTICE. Es preferible dejar un valor
-- mal a escribir otro peor. Se corrigen con el ajuste de /stock.
--
-- Ojo con la sutileza: la ambigüedad se evalúa sobre el MISMO conjunto del que
-- sale el objetivo (los movimientos con snapshot), no sobre todos. Si se mirara
-- el max(created_at) de todos, un último movimiento sin snapshot lo haría pasar
-- como "no ambiguo" y el objetivo caería en un empate anterior que nadie miró.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_filas     integer;
  v_ambiguas  integer;
  v_retirado  numeric;
BEGIN
  -- Si alguien está vendiendo mientras corre el deploy, que se serialice con la
  -- corrección en vez de pisarse.
  LOCK TABLE public.stock_sucursal IN SHARE ROW EXCLUSIVE MODE;

  -- Cuántas filas con pinta de contaminadas quedan afuera por ambigüedad.
  WITH ult AS (
    SELECT m.producto_id, m.sucursal_id, max(m.created_at) AS ultimo_at
      FROM public.stock_movimientos m
     GROUP BY m.producto_id, m.sucursal_id
  ),
  snap AS (                       -- sólo los movimientos con snapshot utilizable
    SELECT m.producto_id, m.sucursal_id, max(m.created_at) AS ultimo_snap_at
      FROM public.stock_movimientos m
     WHERE m.cantidad_nueva IS NOT NULL
     GROUP BY m.producto_id, m.sucursal_id
  ),
  ambiguos AS (
    -- (a) empate en el último movimiento CON snapshot…
    SELECT m.producto_id, m.sucursal_id
      FROM public.stock_movimientos m
      JOIN snap sn ON sn.producto_id = m.producto_id AND sn.sucursal_id = m.sucursal_id
     WHERE m.cantidad_nueva IS NOT NULL
       AND m.created_at = sn.ultimo_snap_at
     GROUP BY m.producto_id, m.sucursal_id
    HAVING count(*) > 1
    UNION
    -- (b) …o hay kardex pero ningún snapshot: no hay valor al que volver.
    SELECT u.producto_id, u.sucursal_id
      FROM ult u
      LEFT JOIN snap sn ON sn.producto_id = u.producto_id AND sn.sucursal_id = u.sucursal_id
     WHERE sn.producto_id IS NULL
  )
  SELECT count(*)::integer INTO v_ambiguas
    FROM public.stock_sucursal s
    JOIN public.productos p ON p.id = s.producto_id
    JOIN ult u      ON u.producto_id = s.producto_id AND u.sucursal_id = s.sucursal_id
    JOIN ambiguos a ON a.producto_id = s.producto_id AND a.sucursal_id = s.sucursal_id
   WHERE p.tamano_envase IS NOT NULL
     AND p.tamano_envase <> 0
     AND s.cantidad = p.tamano_envase
     AND s.updated_at > u.ultimo_at
     AND NOT EXISTS (
           SELECT 1 FROM public.stock_correccion_envase c
            WHERE c.producto_id = s.producto_id AND c.sucursal_id = s.sucursal_id);

  WITH ult AS (
    SELECT m.producto_id,
           m.sucursal_id,
           max(m.created_at) AS ultimo_at,
           count(*)::integer AS n
      FROM public.stock_movimientos m
     GROUP BY m.producto_id, m.sucursal_id
  ),
  snap AS (                       -- sólo los movimientos con snapshot utilizable
    SELECT m.producto_id, m.sucursal_id, max(m.created_at) AS ultimo_snap_at
      FROM public.stock_movimientos m
     WHERE m.cantidad_nueva IS NOT NULL
     GROUP BY m.producto_id, m.sucursal_id
  ),
  ambiguos AS (
    -- (a) empate en el último movimiento CON snapshot…
    SELECT m.producto_id, m.sucursal_id
      FROM public.stock_movimientos m
      JOIN snap sn ON sn.producto_id = m.producto_id AND sn.sucursal_id = m.sucursal_id
     WHERE m.cantidad_nueva IS NOT NULL
       AND m.created_at = sn.ultimo_snap_at
     GROUP BY m.producto_id, m.sucursal_id
    HAVING count(*) > 1
    UNION
    -- (b) …o hay kardex pero ningún snapshot: no hay valor al que volver.
    SELECT u.producto_id, u.sucursal_id
      FROM ult u
      LEFT JOIN snap sn ON sn.producto_id = u.producto_id AND sn.sucursal_id = u.sucursal_id
     WHERE sn.producto_id IS NULL
  ),
  cand AS (
    SELECT s.producto_id,
           s.sucursal_id,
           p.codigo     AS producto_codigo,
           p.nombre     AS producto_nombre,
           su.codigo::text AS sucursal_codigo,
           s.cantidad   AS anterior,
           s.updated_at AS stock_updated_at,
           p.tamano_envase,
           u.ultimo_at,
           COALESCE(u.n, 0) AS movimientos_count,
           COALESCE((
             SELECT m2.cantidad_nueva
               FROM public.stock_movimientos m2
              WHERE m2.producto_id = s.producto_id
                AND m2.sucursal_id = s.sucursal_id
                AND m2.cantidad_nueva IS NOT NULL
              ORDER BY m2.created_at DESC
              LIMIT 1
           ), 0) AS objetivo
      FROM public.stock_sucursal s
      JOIN public.productos  p  ON p.id  = s.producto_id
      JOIN public.sucursales su ON su.id = s.sucursal_id
      LEFT JOIN ult u
             ON u.producto_id = s.producto_id
            AND u.sucursal_id = s.sucursal_id
     WHERE p.tamano_envase IS NOT NULL
       AND p.tamano_envase <> 0
       AND s.cantidad = p.tamano_envase
       AND (u.ultimo_at IS NULL OR s.updated_at > u.ultimo_at)
       AND NOT EXISTS (
             SELECT 1 FROM ambiguos a
              WHERE a.producto_id = s.producto_id
                AND a.sucursal_id = s.sucursal_id)
       AND NOT EXISTS (
             SELECT 1 FROM public.stock_correccion_envase c
              WHERE c.producto_id = s.producto_id
                AND c.sucursal_id = s.sucursal_id)
  ),
  aplicables AS (
    SELECT * FROM cand WHERE anterior <> objetivo
  ),
  respaldo AS (
    INSERT INTO public.stock_correccion_envase (
      producto_id, sucursal_id, producto_codigo, producto_nombre, sucursal_codigo,
      cantidad_anterior, cantidad_nueva, tamano_envase,
      stock_updated_at, ultimo_movimiento_at, movimientos_count, motivo)
    SELECT a.producto_id, a.sucursal_id, a.producto_codigo, a.producto_nombre, a.sucursal_codigo,
           a.anterior, a.objetivo, a.tamano_envase,
           a.stock_updated_at, a.ultimo_at, a.movimientos_count,
           'El stock se había cargado con el tamaño de envase (ENV) de la lista de precios. El stock real se carga aparte.'
      FROM aplicables a
    RETURNING producto_id, sucursal_id, cantidad_nueva
  )
  UPDATE public.stock_sucursal s
     SET cantidad = r.cantidad_nueva
    FROM respaldo r
   WHERE s.producto_id = r.producto_id
     AND s.sucursal_id = r.sucursal_id;

  GET DIAGNOSTICS v_filas = ROW_COUNT;

  SELECT COALESCE(sum(cantidad_anterior - cantidad_nueva), 0)
    INTO v_retirado
    FROM public.stock_correccion_envase
   WHERE revertido_at IS NULL;

  RAISE NOTICE 'Corrección stock=envase: % fila(s) corregida(s) en esta corrida. Total acumulado retirado: % unidades. El detalle (y el valor anterior de cada fila) está en public.stock_correccion_envase.', v_filas, v_retirado;
  IF v_ambiguas > 0 THEN
    RAISE NOTICE 'ATENCIÓN: % fila(s) con pinta de contaminadas se saltearon por ambigüedad (su último movimiento de kardex empata en timestamp con otro, así que no se puede saber a qué valor volver). Corregilas a mano con el ajuste de /stock.', v_ambiguas;
  END IF;
  RAISE NOTICE 'Las filas cuyo último write SÍ tenía kardex quedaron intactas a propósito: su cantidad ya refleja movimientos reales. Si alguna sigue mal, se corrige con el ajuste de /stock (conteo físico).';
END $$;

-- ------------------------------------------------------------
-- (3) Cerrar la escritura directa de stock_sucursal.
--
-- Sacar el código de la importación no alcanza: la tabla tenía
-- GRANT INSERT,UPDATE a authenticated y la policy "admin write stock" FOR ALL,
-- así que un admin podía seguir escribiendo stock por PostgREST (una pestaña
-- vieja con el bundle anterior, un curl, el próximo atajo). Mismo criterio que
-- G6 con stock_movimientos (20260718140000).
--
-- No rompe nada: TODAS las funciones que escriben stock son SECURITY DEFINER con
-- owner postgres (crear_venta, anular_venta, crear_compra, anular_compra,
-- aprobar_remito, ajustar_stock, confirmar_ingreso_mercaderia,
-- anular_ingreso_mercaderia), así que ignoran grants y RLS. service_role
-- conserva GRANT ALL. Se conserva la lectura: /stock, dashboard y ventas leen
-- esta tabla.
-- ------------------------------------------------------------
REVOKE INSERT, UPDATE ON public.stock_sucursal FROM authenticated;
DROP POLICY IF EXISTS "admin write stock" ON public.stock_sucursal;

COMMENT ON TABLE public.stock_sucursal IS
  'Stock por producto y sucursal. Sólo se escribe desde RPCs SECURITY DEFINER, que además dejan kardex en stock_movimientos. La escritura directa por PostgREST se cerró el 2026-07-24 (antes la importación de la lista de precios cargaba el tamaño de envase acá, sin kardex).';
