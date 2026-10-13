-- Un código de catálogo identifica al producto dentro de un proveedor, no en
-- todo el universo. COP y QUIMEX pueden usar el mismo código para artículos
-- diferentes; lo que no puede repetirse es proveedor + código.
--
-- NULLS NOT DISTINCT conserva una identidad segura para los productos
-- históricos que todavía no tienen proveedor: entre ellos el código sigue
-- siendo único hasta que se les asigne uno.
ALTER TABLE public.productos
  DROP CONSTRAINT IF EXISTS productos_codigo_key;

ALTER TABLE public.productos
  ADD CONSTRAINT productos_proveedor_codigo_key
  UNIQUE NULLS NOT DISTINCT (proveedor_id, codigo);

COMMENT ON CONSTRAINT productos_proveedor_codigo_key ON public.productos IS
  'El código de producto es único dentro de cada proveedor. Los productos históricos sin proveedor también conservan códigos únicos entre sí.';

-- El alta masiva del inventario crea productos históricos sin proveedor. Debe
-- seguir siendo idempotente después de reemplazar la restricción global.
CREATE OR REPLACE FUNCTION public.crear_productos_faltantes(p_items jsonb)
RETURNS TABLE (creados integer, ya_estaban integer, rechazados integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_creados    integer := 0;
  v_existian   integer := 0;
  v_rechazados integer := 0;
  it            jsonb;
  v_cod         text;
  v_nom         text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede dar de alta productos en lote';
  END IF;

  IF COALESCE(jsonb_array_length(p_items), 0) = 0 THEN
    RAISE EXCEPTION 'No hay ningún producto para crear';
  END IF;
  IF jsonb_array_length(p_items) > 2000 THEN
    RAISE EXCEPTION 'Son % productos y el máximo por vez es 2000. Revisá el archivo.',
      jsonb_array_length(p_items);
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_cod := NULLIF(TRIM(COALESCE(it->>'codigo', '')), '');
    v_nom := NULLIF(TRIM(COALESCE(it->>'nombre', '')), '');

    IF v_cod IS NULL OR v_nom IS NULL OR v_cod !~ '[A-Za-z0-9]' THEN
      v_rechazados := v_rechazados + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.productos (codigo, nombre, activo, archivado)
    VALUES (v_cod, v_nom, false, false)
    ON CONFLICT (proveedor_id, codigo) DO NOTHING;

    IF FOUND THEN v_creados := v_creados + 1;
    ELSE v_existian := v_existian + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_creados, v_existian, v_rechazados;
END; $$;

REVOKE ALL ON FUNCTION public.crear_productos_faltantes(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_productos_faltantes(jsonb) TO authenticated, service_role;
