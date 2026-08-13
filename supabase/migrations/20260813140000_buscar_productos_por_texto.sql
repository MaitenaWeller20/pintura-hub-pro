-- ============================================================
-- El buscador de productos de Ingresos no encontraba por el principio del nombre
--
-- EL SÍNTOMA
-- Agustina escribe "ESPUMA DE" en Nuevo ingreso de mercadería y el sistema le
-- dice "No hay productos que coincidan", con tres productos activos que empiezan
-- exactamente con eso: ESPUMA DE POLIURETANO KUWAIT X300 / X500 / X750 ML.
--
-- LA CAUSA
-- buscar_productos_similares filtraba SÓLO por similitud de trigramas
-- (`p.nombre % p_texto`), que compara las dos cadenas ENTERAS contra un umbral
-- de 0,3. Medido en producción:
--
--   similarity('ESPUMA DE POLIURETANO KUWAIT X300 ML', 'ESPUMA DE') = 0,270
--   similarity('ESPUMA DE POLIURETANO KUWAIT X300 ML', 'ESPUMA')    = 0,189
--
-- O sea que cuanto MÁS largo es el nombre del producto, más difícil es
-- encontrarlo escribiendo su principio — y escribir menos empeora las cosas. Es
-- al revés de lo que espera cualquiera que usa un buscador. Por eso "a veces
-- andaba": funcionaba con los productos de nombre corto y fallaba con los largos.
--
-- Y el rescate por tipeo que se suponía que daban tampoco funcionaba, por lo
-- mismo: similarity(nombre, 'POLIURETANI') = 0,256, también por debajo de 0,3.
-- El operador que sirve para esto es `<%` (word_similarity), que compara lo
-- escrito contra la MEJOR PARTE del nombre en vez de contra el nombre entero:
-- word_similarity('POLIURETANI', 'ESPUMA DE POLIURETANO KUWAIT X300 ML') = 0,833,
-- cómodamente por encima de su umbral de 0,6. Es la semántica que se quería
-- desde el principio: "encontrá esta palabra adentro del nombre".
--
-- LA CURA
-- Primero se busca como busca la gente: que el nombre CONTENGA lo escrito. La
-- similitud queda como red de seguridad para los errores de tipeo, y además
-- ordena. El orden es el que uno espera:
--
--   0. el código empieza con lo escrito
--   1. el nombre empieza con lo escrito        ← el caso de "ESPUMA DE"
--   2. una palabra del nombre empieza con eso  ← "blanco" encuentra "LATEX BLANCO"
--   3. el nombre lo contiene en el medio
--   4. sólo se parece (el rescate por trigramas)
--
-- y dentro de cada grupo, primero los activos y después por parecido.
--
-- Ojo con los comodines: %, _ y \ dentro de lo tipeado son comodines de LIKE. Un
-- código como "116.01.085" no tiene, pero "50%" o "A_B" sí, y sin escaparlos
-- traerían de más. Se escapan antes de armar el patrón.
-- ============================================================

CREATE OR REPLACE FUNCTION public.buscar_productos_similares(
  p_texto  text,
  p_codigo text DEFAULT NULL::text,
  p_limite integer DEFAULT 8
)
 RETURNS TABLE(id uuid, codigo text, nombre text, activo boolean, iva_porcentaje numeric, score real)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  WITH pat AS (
    SELECT
      NULLIF(btrim(COALESCE(p_texto, '')), '')  AS texto,
      NULLIF(btrim(COALESCE(p_codigo, '')), '') AS codigo,
      replace(replace(replace(btrim(COALESCE(p_texto, '')),  '\', '\\'), '%', '\%'), '_', '\_') AS texto_like,
      replace(replace(replace(btrim(COALESCE(p_codigo, '')), '\', '\\'), '%', '\%'), '_', '\_') AS codigo_like
  )
  SELECT
    p.id, p.codigo, p.nombre, p.activo, p.iva_porcentaje,
    -- word_similarity y no similarity: contra un nombre largo, comparar las
    -- cadenas enteras da un puntaje bajo aunque la palabra esté ahí entera.
    GREATEST(
      word_similarity(pat.texto, p.nombre),
      CASE WHEN pat.codigo IS NOT NULL THEN word_similarity(pat.codigo, p.codigo) ELSE 0 END
    )::real AS score
  FROM public.productos p, pat
  WHERE NOT p.archivado
    AND pat.texto IS NOT NULL
    AND (
      -- Como busca la gente.
      p.nombre ILIKE '%' || pat.texto_like || '%'
      OR (pat.codigo IS NOT NULL AND p.codigo ILIKE '%' || pat.codigo_like || '%')
      -- Red de seguridad para el tipeo.
      OR pat.texto <% p.nombre
      OR (pat.codigo IS NOT NULL AND pat.codigo <% p.codigo)
    )
  ORDER BY
    CASE
      WHEN pat.codigo IS NOT NULL AND p.codigo ILIKE pat.codigo_like || '%' THEN 0
      WHEN p.nombre ILIKE pat.texto_like || '%'                            THEN 1
      WHEN p.nombre ILIKE '% ' || pat.texto_like || '%'                    THEN 2
      WHEN p.nombre ILIKE '%' || pat.texto_like || '%'                     THEN 3
      ELSE 4
    END,
    p.activo DESC,
    score DESC,
    p.nombre
  LIMIT GREATEST(1, LEAST(COALESCE(p_limite, 8), 25));
$$;

REVOKE ALL ON FUNCTION public.buscar_productos_similares(text, text, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.buscar_productos_similares(text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buscar_productos_similares(text, text, integer) TO service_role;
