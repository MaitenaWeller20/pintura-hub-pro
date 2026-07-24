-- ============================================================
-- ELIMINACIÓN DE PRODUCTOS (individual y masiva)
--
-- Un producto con historial (venta/compra/transferencia/ingreso confirmado/kardex)
-- o con stock NO se puede borrar de la base sin romper el pasado o tirar inventario,
-- así que se ARCHIVA. Sólo se borra de verdad el que nunca se usó y no tiene stock.
--
-- `archivado` es un flag NUEVO y separado de `activo`: `activo` = vendible (un
-- producto inline sin precio nace inactivo pero NO archivado, y debe poder recibir
-- mercadería); `archivado` = sacado de las pantallas de trabajo.
-- Ver docs/superpowers/specs/2026-07-24-eliminar-productos-design.md
-- ============================================================

ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS archivado boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.productos.archivado IS
  'true = eliminado lógicamente: se oculta de ventas, stock, transferencias y match de ingresos, pero sigue en el historial. Distinto de activo (vendible).';

-- Índices para que el chequeo de historial en lote no escanee tablas grandes.
CREATE INDEX IF NOT EXISTS idx_venta_items_producto  ON public.venta_items (producto_id);
CREATE INDEX IF NOT EXISTS idx_stock_mov_producto    ON public.stock_movimientos (producto_id);
CREATE INDEX IF NOT EXISTS idx_remito_items_producto ON public.remito_items (producto_id);

-- ------------------------------------------------------------
-- eliminar_productos(p_ids) — individual (array de 1) o masivo (array de N).
-- Por cada producto: BLOQUEA si está en un ingreso borrador; ARCHIVA si tiene
-- historial o stock; BORRA si no tiene nada. Devuelve el resumen.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- restaurar_productos(p_ids) — deshace el archivado (admin).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restaurar_productos(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_n   integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede restaurar productos';
  END IF;
  UPDATE public.productos SET archivado = false
   WHERE id = ANY(COALESCE(p_ids, ARRAY[]::uuid[])) AND archivado;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;

-- ------------------------------------------------------------
-- buscar_productos_similares: excluir archivados. Sigue devolviendo inactivos
-- NO archivados (un producto inline sin precio tiene que poder recibir mercadería).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.buscar_productos_similares(
  p_texto  text,
  p_codigo text DEFAULT NULL,
  p_limite integer DEFAULT 8
)
RETURNS TABLE (
  id            uuid,
  codigo        text,
  nombre        text,
  activo        boolean,
  iva_porcentaje numeric,
  score         real
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.codigo, p.nombre, p.activo, p.iva_porcentaje,
         GREATEST(
           similarity(p.nombre, COALESCE(p_texto, '')),
           CASE WHEN p_codigo IS NOT NULL THEN similarity(p.codigo, p_codigo) ELSE 0 END
         ) AS score
    FROM public.productos p
   WHERE NOT p.archivado
     AND COALESCE(p_texto, '') <> '' AND (
           p.nombre % p_texto
           OR (p_codigo IS NOT NULL AND p.codigo % p_codigo)
         )
   ORDER BY score DESC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limite, 8), 25));
$$;

-- ------------------------------------------------------------
-- GRANTS
-- ------------------------------------------------------------
DO $$
DECLARE fn text;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'eliminar_productos(uuid[])',
    'restaurar_productos(uuid[])',
    'buscar_productos_similares(text, text, integer)'
  ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM public', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
  END LOOP;
END $$;
