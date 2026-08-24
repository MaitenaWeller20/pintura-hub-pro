-- El buscador de Nuevo ingreso elegía proveedor en pantalla, pero esa elección
-- no llegaba a PostgreSQL: se mezclaban catálogos y el LIMIT se consumía con
-- productos ajenos. La firma nueva conserva compatibles las llamadas viejas
-- (el parámetro es opcional) y aplica el proveedor antes de ordenar y limitar.
DROP FUNCTION IF EXISTS public.buscar_productos_similares(text, text, integer);

CREATE FUNCTION public.buscar_productos_similares(
  p_texto       text,
  p_codigo      text DEFAULT NULL::text,
  p_limite      integer DEFAULT 8,
  p_proveedor_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  id uuid,
  codigo text,
  nombre text,
  activo boolean,
  iva_porcentaje numeric,
  score real
)
LANGUAGE sql
STABLE
SECURITY INVOKER
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
    p.id,
    p.codigo,
    p.nombre,
    p.activo,
    p.iva_porcentaje,
    GREATEST(
      word_similarity(pat.texto, p.nombre),
      CASE WHEN pat.codigo IS NOT NULL THEN word_similarity(pat.codigo, p.codigo) ELSE 0 END
    )::real AS score
  FROM public.productos p, pat
  WHERE NOT p.archivado
    AND (p_proveedor_id IS NULL OR p.proveedor_id = p_proveedor_id)
    AND pat.texto IS NOT NULL
    AND (
      p.nombre ILIKE '%' || pat.texto_like || '%'
      OR (pat.codigo IS NOT NULL AND p.codigo ILIKE '%' || pat.codigo_like || '%')
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
  LIMIT GREATEST(1, LEAST(COALESCE(p_limite, 8), 500));
$$;

REVOKE ALL ON FUNCTION public.buscar_productos_similares(text, text, integer, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.buscar_productos_similares(text, text, integer, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.buscar_productos_similares(text, text, integer, uuid)
  TO service_role;
