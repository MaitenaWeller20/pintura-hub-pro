-- ============================================================
-- Dar de alta los productos que el depósito tiene y el sistema no.
--
-- EL PROBLEMA MEDIDO (04/08/2026): el catálogo salió de la lista de precios de
-- Quimex (1170 productos) y el inventario sale del sistema viejo 3C (~1614 por
-- sucursal). **647 códigos del depósito no existen como producto.** No es que
-- estén con otro código: se buscaron por nombre y sólo 3 coincidían. La familia
-- HIDROMEX entera —x1, x5, x10, x20, x200— está en el galpón y no en el sistema.
--
-- Sin esto, importar el conteo carga el 60% y el resto se pierde en silencio.
--
-- CÓMO QUEDAN CREADOS, Y POR QUÉ ASÍ:
--
--   activo    = false  → NO se pueden vender. La búsqueda de /ventas/nueva
--                        filtra por `activo`, así que un producto sin precio no
--                        puede salir facturado en $0 por una distracción.
--   archivado = false  → SÍ aparecen en el inventario y se pueden contar: la
--                        vista `stock_inventario` filtra por `archivado`, no por
--                        `activo`. Esa asimetría es justo lo que hace falta.
--
-- O sea: entran para que el stock cuadre, y quedan trabados para vender hasta
-- que alguien les ponga precio y los active. El inventario es un hecho físico
-- —la mercadería está en el galpón— y negarlo por no saber el precio deja al
-- sistema mintiendo sobre lo que hay.
-- ============================================================

CREATE OR REPLACE FUNCTION public.crear_productos_faltantes(p_items jsonb)
RETURNS TABLE (creados integer, ya_estaban integer, rechazados integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_creados    integer := 0;
  v_existian   integer := 0;
  v_rechazados integer := 0;
  it      jsonb;
  v_cod   text;
  v_nom   text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  -- Alta masiva de catálogo: es una decisión de dueño, no de mostrador.
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede dar de alta productos en lote';
  END IF;

  IF COALESCE(jsonb_array_length(p_items), 0) = 0 THEN
    RAISE EXCEPTION 'No hay ningún producto para crear';
  END IF;
  -- Mismo tope que el conteo: si un archivo trae más que esto, algo se leyó mal
  -- y conviene mirarlo antes de escribir 3000 productos en el catálogo.
  IF jsonb_array_length(p_items) > 2000 THEN
    RAISE EXCEPTION 'Son % productos y el máximo por vez es 2000. Revisá el archivo.',
      jsonb_array_length(p_items);
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_cod := NULLIF(TRIM(COALESCE(it->>'codigo', '')), '');
    v_nom := NULLIF(TRIM(COALESCE(it->>'nombre', '')), '');

    -- Un código tiene que tener al menos un dígito o letra. El reporte de 3C
    -- trae una fila fantasma con código literal "-", y un producto llamado "-"
    -- ensucia el catálogo para siempre.
    IF v_cod IS NULL OR v_nom IS NULL OR v_cod !~ '[A-Za-z0-9]' THEN
      v_rechazados := v_rechazados + 1;
      CONTINUE;
    END IF;

    -- ON CONFLICT y no un chequeo previo: entre el "no está" que vio la pantalla
    -- y este INSERT puede haber pasado otra importación. Idempotente a propósito
    -- —volver a apretar el botón no duplica ni rompe— y NO pisa lo que ya está:
    -- un producto existente puede tener precio puesto a mano.
    INSERT INTO public.productos (codigo, nombre, activo, archivado)
    VALUES (v_cod, v_nom, false, false)
    ON CONFLICT (codigo) DO NOTHING;

    IF FOUND THEN v_creados := v_creados + 1;
    ELSE v_existian := v_existian + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_creados, v_existian, v_rechazados;
END; $$;

REVOKE ALL ON FUNCTION public.crear_productos_faltantes(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_productos_faltantes(jsonb) TO authenticated, service_role;
