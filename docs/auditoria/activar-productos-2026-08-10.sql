-- ============================================================
-- REVISIÓN antes de prender productos en producción — 10/08/2026
--
-- Contexto: la clienta cargó los precios de los KUM con "Cambiar precios" y
-- siguieron apareciendo "Inactivo", o sea invendibles. El deploy de hoy agrega el
-- switch en el editor y el botón "Activar" masivo (RPC activar_productos).
-- Ver docs/superpowers/specs/2026-08-10-activar-productos-design.md
--
-- Esto NO ES una migración: son consultas de LECTURA para mirar la base de prod
-- antes de apretar el botón. La primera versión del spec traía un
-- `UPDATE productos SET activo=true WHERE ...` de una, y se descartó: no hay
-- auditoría de `activo`, así que por SQL no se puede distinguir un producto que
-- las altas automáticas dejaron apagado de uno que alguien discontinuó a mano.
-- Y prender a ciegas contradecía la decisión de que una reimportación de listas
-- NO reactive productos (seDestraba). Lo prende una persona, mirando esto.
--
-- Correr contra prod (gagrdirwlcunygtztiuk, cuenta "poldo") en el SQL editor.
-- ============================================================

-- ------------------------------------------------------------
-- 1. El tamaño del problema: cuántos hay de cada cosa.
--
-- "apagados_con_precio" es lo que el botón Activar va a prender.
-- "apagados_sin_precio" es lo que le falta precio (esos no se tocan).
-- "activos_sin_precio" tiene que ser 0: es un producto que se vende a $0. Si hay
-- alguno, mirar el punto 5 antes de agregar el CHECK del invariante.
-- ------------------------------------------------------------
SELECT
  count(*)                                                              AS total,
  count(*) FILTER (WHERE archivado)                                     AS archivados,
  count(*) FILTER (WHERE NOT archivado AND NOT activo AND precio_sin_iva > 0)  AS apagados_con_precio,
  count(*) FILTER (WHERE NOT archivado AND NOT activo AND precio_sin_iva <= 0) AS apagados_sin_precio,
  count(*) FILTER (WHERE NOT archivado AND activo AND precio_sin_iva <= 0)     AS activos_sin_precio
FROM public.productos;

-- ------------------------------------------------------------
-- 2. ¿De dónde salieron? Por fecha de alta.
--
-- Lo que se espera: casi todos creados el mismo día, el de la importación de
-- stock / el conteo. Un producto apagado creado hace meses es sospechoso: puede
-- ser una baja intencional, y ésos NO hay que prenderlos.
-- ------------------------------------------------------------
SELECT date_trunc('day', created_at)::date AS dia_de_alta, count(*)
  FROM public.productos
 WHERE NOT archivado AND NOT activo AND precio_sin_iva > 0
 GROUP BY 1
 ORDER BY 1;

-- ------------------------------------------------------------
-- 3. El discriminador que sí sirve: ¿alguno tiene ventas?
--
-- Un producto que entró por la importación de stock nunca se vendió (no existía
-- en el sistema). Uno que se vendió y hoy está apagado es una baja de verdad:
-- alguien lo discontinuó. Si esta consulta devuelve filas, hay que decidir uno
-- por uno y NO tildar todo.
-- ------------------------------------------------------------
SELECT p.codigo, p.nombre, p.precio_sin_iva, p.created_at::date AS alta,
       count(vi.id) AS veces_vendido, max(v.fecha)::date AS ultima_venta
  FROM public.productos p
  JOIN public.venta_items vi ON vi.producto_id = p.id
  JOIN public.ventas      v  ON v.id = vi.venta_id
 WHERE NOT p.archivado AND NOT p.activo AND p.precio_sin_iva > 0
 GROUP BY p.id, p.codigo, p.nombre, p.precio_sin_iva, p.created_at
 ORDER BY ultima_venta DESC NULLS LAST;

-- ------------------------------------------------------------
-- 4. La lista completa, para pasarle el ojo. Los primeros 50.
-- ------------------------------------------------------------
SELECT p.codigo, p.nombre, p.precio_sin_iva, pr.razon_social AS proveedor,
       p.created_at::date AS alta, p.updated_at::date AS ultimo_cambio
  FROM public.productos p
  LEFT JOIN public.proveedores pr ON pr.id = p.proveedor_id
 WHERE NOT p.archivado AND NOT p.activo AND p.precio_sin_iva > 0
 ORDER BY p.codigo
 LIMIT 50;

-- ------------------------------------------------------------
-- 5. Los activos a $0, si hubiera. Ésos se venden gratis HOY.
--
-- El editor ya no los va a poder guardar así (fuerza activo = precio > 0), pero
-- los que ya están quedan como están hasta que alguien los abra. Si la lista es
-- corta, se arregla a mano; si es larga, hace falta decidir.
-- ------------------------------------------------------------
SELECT codigo, nombre, created_at::date AS alta
  FROM public.productos
 WHERE NOT archivado AND activo AND precio_sin_iva <= 0
 ORDER BY codigo;
