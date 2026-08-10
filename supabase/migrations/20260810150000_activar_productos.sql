-- ============================================================
-- activar_productos(p_ids) — prender productos apagados (admin).
--
-- El agujero que cierra: un producto se da de alta APAGADO cuando entra sin
-- precio, a propósito, para que nadie lo venda a $0. Lo hacen las dos altas
-- automáticas: crear_productos_faltantes (importación de stock,
-- 20260804200000) y crear_producto_desde_ingreso (20260724110000, v_activo :=
-- v_precio > 0). Lo que NO existía era la puerta de vuelta: la única cosa en todo
-- el sistema que prendía un producto era la importación de listas de precios, y
-- sólo si el precio guardado todavía era 0 (seDestraba, importar-productos.ts).
--
-- La clienta les cargó el precio con "Cambiar precios" —cambiar_precios_masivo NO
-- toca `activo`, no es su tema— y quedaron con precio y apagados. O sea:
-- invendibles (crear_venta exige `activo`) y sin forma de arreglarlo.
-- Ver docs/superpowers/specs/2026-08-10-activar-productos-design.md
--
-- Por qué una RPC y no un UPDATE desde el cliente: son ~650 productos. Un
-- .update().in("id", ids) de PostgREST manda los uuid EN LA URL (~24 KB, el
-- gateway puede cortarlo con 414) y la respuesta del select() la trunca PostgREST
-- en 1000 filas, así que el número que se le muestra a la clienta podría ser
-- mentira. Por POST con el array en el body no pasa ninguna de las dos cosas.
-- Mismo patrón que eliminar_productos / restaurar_productos.
-- ============================================================

CREATE OR REPLACE FUNCTION public.activar_productos(p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[] := COALESCE(p_ids, ARRAY[]::uuid[]);
  v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  -- La RLS de productos ya exige admin para escribir, pero esta función es
  -- SECURITY DEFINER: corre como su dueño y se la SALTEA. El chequeo va acá.
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede activar productos';
  END IF;

  -- Las filas se bloquean ANTES de leerlas, y en ORDEN ASCENDENTE DE id.
  --
  -- El orden no es decorativo: es el patrón que ya usan crear_venta
  -- (20260729210000_crear_venta_prelock_productos.sql:162) y eliminar_productos
  -- (20260724130000_eliminar_productos.sql:53) sobre esta misma tabla, y está ahí
  -- porque el problema ya pasó — dos transacciones que bloquean el mismo par de
  -- productos en orden distinto se traban cruzadas y Postgres mata una con
  -- "deadlock detected". Una activación masiva son ~650 filas de una: es justo el
  -- caso para el que existe ese patrón. Un UPDATE masivo sin prelock las bloquea
  -- en el orden que le dé el plan (físico, que con uuid no tiene nada que ver con
  -- el id), o sea a veces al revés que una venta concurrente.
  --
  -- De paso el prelock hace exactos los tres números: con las filas bloqueadas,
  -- nadie las puede cambiar entre que se cuentan y se actualizan.
  PERFORM 1
     FROM public.productos p
    WHERE p.id = ANY(v_ids)
      AND NOT p.activo
    ORDER BY p.id
      FOR UPDATE;

  -- UNA sola sentencia a propósito. Contar en una consulta y actualizar en otra
  -- son dos snapshots distintos: entre las dos alguien puede archivar un producto
  -- o cargarle un precio, y los números del cartel dejarían de corresponder a lo
  -- que pasó. Y los saltados hay que contarlos ANTES del UPDATE, porque después
  -- no se distinguen de los que ya estaban activos.
  WITH cand AS MATERIALIZED (
    -- Los candidatos son los APAGADOS de la selección. Los que ya están activos
    -- no cuentan para nada: tildar los 1104 productos tiene que decir
    -- "3 activados", no "1104 activados".
    SELECT p.id, p.archivado, p.precio_sin_iva
      FROM public.productos p
     WHERE p.id = ANY(v_ids)
       AND NOT p.activo
  ),
  upd AS (
    UPDATE public.productos p
       SET activo = true
      FROM cand
     WHERE p.id = cand.id
       -- OJO: las tres condiciones se preguntan sobre `p` (la fila viva) y NO
       -- sobre `cand` (el snapshot), aunque acá tengan los mismos valores. Con el
       -- prelock de arriba ya no pueden diferir, pero preguntar por `cand` es un
       -- error que se paga caro si el prelock se toca algún día: `cand` no lo
       -- cubre la reevaluación de Postgres (EvalPlanQual sólo relee la tabla que
       -- se está actualizando), así que una fila archivada por otra sesión pasaría
       -- el filtro con el valor viejo y quedaría activa Y archivada, o activa a
       -- $0. Es exactamente lo que esta función existe para evitar, y sin el `p.`
       -- lo fabricaba: ver scripts/test-activar-concurrencia.sh.
       AND NOT p.activo
       -- Un archivado se restaura, no se prende. Y prenderlo fabricaría una fila
       -- que dice "Archivado" y está viva a la vez, que es peor que las dos
       -- cosas por separado: crear_venta mira `activo` y NO `archivado`.
       AND NOT p.archivado
       -- El invariante de todo esto: sin precio no se prende, se vendería a $0.
       AND p.precio_sin_iva > 0
    RETURNING p.id
  )
  SELECT jsonb_build_object(
           'activados',  (SELECT count(*) FROM upd),
           -- Números y no listas, al revés que eliminar_productos (que devuelve
           -- los bloqueados con nombre porque son pocos): acá los saltados pueden
           -- ser 500 y no caben en un cartel. Para encontrarlos está el filtro
           -- "Sin precio o apagados" de la pantalla.
           'sin_precio', (SELECT count(*) FROM cand WHERE NOT archivado AND precio_sin_iva <= 0),
           'archivados', (SELECT count(*) FROM cand WHERE archivado)
         )
    INTO v_res;

  RETURN v_res;
END; $$;

COMMENT ON FUNCTION public.activar_productos(uuid[]) IS
  'Prende los productos apagados de p_ids que tengan precio y no estén archivados (admin). Devuelve {activados, sin_precio, archivados} contados en la misma sentencia que el UPDATE. Es la única forma de reactivar un producto: las altas automáticas lo dejan apagado sin precio y la importación de listas sólo lo destraba si el precio guardado es 0.';

-- Sin esto la función queda ejecutable por `public` (y el authenticated no la ve
-- si se revoca de más). Mismo bloque que 20260724130000_eliminar_productos.sql.
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.activar_productos(uuid[]) FROM public;
  GRANT EXECUTE ON FUNCTION public.activar_productos(uuid[]) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.activar_productos(uuid[]) TO service_role;
END $$;
