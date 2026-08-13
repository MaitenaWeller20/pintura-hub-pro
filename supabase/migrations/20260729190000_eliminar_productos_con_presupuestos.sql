-- ============================================================
-- eliminar_productos: un producto presupuestado se archiva, no revienta.
--
-- `presupuesto_items.producto_id` tiene FK a productos. Un producto sin ventas,
-- sin stock y sin kardex caía en la rama del DELETE real, la FK lo rechazaba y
-- la excepción abortaba TODA la transacción: un borrado masivo de 50 productos
-- no borraba ninguno, con un mensaje de Postgres que no dice cuál fue.
--
-- Un presupuesto es historial (el documento tiene que seguir mostrando qué se
-- cotizó), así que va a la misma rama que ventas y compras: archivar. Archivar
-- toca `archivado`, no `activo`, y `crear_venta` mira `activo` — o sea que un
-- presupuesto ABIERTO se puede seguir convirtiendo después de archivar el
-- producto. Por eso no hace falta bloquearlo como al ingreso en BORRADOR.
--
-- Base: 20260724130000_eliminar_productos.sql (verificado contra pg_proc: nadie
-- la redefinió después). El único cambio es el EXISTS de presupuesto_items.
-- ============================================================
CREATE OR REPLACE FUNCTION public.eliminar_productos(p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_id          uuid;
  v_prod        public.productos%ROWTYPE;
  v_en_borrador boolean;
  v_historial   boolean;
  v_con_stock   boolean;
  v_borrados    jsonb := '[]'::jsonb;
  v_archivados  jsonb := '[]'::jsonb;
  v_bloqueados  jsonb := '[]'::jsonb;
  v_ids         uuid[];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede eliminar productos';
  END IF;

  -- Dedupe + orden estable de los ids ANTES del loop: dos borrados masivos
  -- concurrentes con las mismas filas en distinto orden no se deadlockean (toman
  -- los FOR UPDATE siempre en el mismo orden).
  v_ids := ARRAY(SELECT DISTINCT u FROM unnest(COALESCE(p_ids, ARRAY[]::uuid[])) u ORDER BY u);

  FOREACH v_id IN ARRAY v_ids
  LOOP
    -- FOR UPDATE ANTES de los EXISTS: cierra la carrera con una venta/ingreso
    -- concurrente (su INSERT hijo necesita FOR KEY SHARE de esta fila).
    SELECT * INTO v_prod FROM public.productos WHERE id = v_id FOR UPDATE;
    CONTINUE WHEN NOT FOUND;  -- id inexistente/repetido → se ignora

    -- 1. ¿Enganchado en un ingreso en BORRADOR? (no es historial real, pero su FK
    --    impediría el DELETE; se pide resolver el borrador en vez de romperlo)
    SELECT EXISTS (
      SELECT 1 FROM public.ingreso_mercaderia_items i
      JOIN public.ingresos_mercaderia ing ON ing.id = i.ingreso_id
      WHERE i.producto_id = v_id AND ing.estado = 'BORRADOR'
    ) INTO v_en_borrador;

    IF v_en_borrador THEN
      v_bloqueados := v_bloqueados || jsonb_build_object(
        'id', v_id, 'codigo', v_prod.codigo, 'nombre', v_prod.nombre,
        'motivo', 'Está en un ingreso de mercadería en borrador; confirmalo o descartalo primero.');
      CONTINUE;
    END IF;

    -- 2. ¿Tiene historial real?
    SELECT
      EXISTS (SELECT 1 FROM public.venta_items   WHERE producto_id = v_id)
      OR EXISTS (SELECT 1 FROM public.compra_items  WHERE producto_id = v_id)
      OR EXISTS (SELECT 1 FROM public.remito_items  WHERE producto_id = v_id)
      OR EXISTS (SELECT 1 FROM public.stock_movimientos WHERE producto_id = v_id)
      OR public.producto_tiene_presupuesto(v_id)
      OR EXISTS (
        SELECT 1 FROM public.ingreso_mercaderia_items i
        JOIN public.ingresos_mercaderia ing ON ing.id = i.ingreso_id
        WHERE i.producto_id = v_id AND ing.estado <> 'BORRADOR')
    INTO v_historial;

    -- ¿Tiene stock? (Excel/seed cargan stock sin kardex → "sin historial" no implica
    --  "sin stock"; borrarlo tiraría inventario real.)
    SELECT EXISTS (
      SELECT 1 FROM public.stock_sucursal WHERE producto_id = v_id AND cantidad <> 0
    ) INTO v_con_stock;

    IF v_historial OR v_con_stock THEN
      UPDATE public.productos SET archivado = true WHERE id = v_id;
      v_archivados := v_archivados || jsonb_build_object(
        'id', v_id, 'codigo', v_prod.codigo, 'nombre', v_prod.nombre);
    ELSE
      -- Sin historial, sin stock, sin borrador → DELETE real (cascada limpia
      -- stock_sucursal en 0 y producto_codigos_proveedor).
      DELETE FROM public.productos WHERE id = v_id;
      v_borrados := v_borrados || jsonb_build_object(
        'id', v_id, 'codigo', v_prod.codigo, 'nombre', v_prod.nombre);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'borrados', v_borrados, 'archivados', v_archivados, 'bloqueados', v_bloqueados);
END; $$;
