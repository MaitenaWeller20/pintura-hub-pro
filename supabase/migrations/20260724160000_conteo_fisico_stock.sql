-- ============================================================
-- Conteo físico: cómo se carga el stock real.
--
-- Después de la corrección del envase (20260724150000) el inventario quedó casi
-- en cero a propósito, y la clienta no tenía cómo volver a llenarlo: /stock sólo
-- listaba filas de stock_sucursal, así que un producto sin fila NI SIQUIERA
-- APARECÍA, y el ajuste era de a un producto por vez.
--
-- Esta migración trae tres cosas:
--   (1) las tablas del conteo, que lo convierten en un documento (idempotencia,
--       auditoría, y saber qué se contó y cuándo);
--   (2) la vista stock_inventario: productos no archivados × sucursales, con la
--       cantidad y —lo importante— si ese par ya fue cargado, que es lo que
--       distingue "nunca lo conté" de "lo conté y no hay";
--   (3) la RPC ajustar_stock_masivo, el único camino nuevo que escribe stock —y,
--       como todos, deja kardex.
--
-- Diseño y decisiones: docs/superpowers/specs/2026-07-24-conteo-fisico-design.md
-- ============================================================

-- ------------------------------------------------------------
-- (1) El conteo como documento.
--
-- Resuelve tres cosas de una: idempotencia real (clave + short-circuit, igual
-- que crear_venta), auditoría de qué se contó y cuándo, y el registro por ítem
-- incluso cuando la cantidad no cambió (que igual es información: alguien lo
-- contó y coincidía).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_conteos (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id           uuid NOT NULL REFERENCES public.sucursales(id),
  usuario_id            uuid REFERENCES auth.users(id),
  motivo                text NOT NULL,
  contado_desde         timestamptz,
  idempotency_key       uuid,
  items_ajustados       integer NOT NULL DEFAULT 0,
  items_sin_cambio      integer NOT NULL DEFAULT 0,
  items_con_movimientos integer NOT NULL DEFAULT 0,
  items_conflicto       integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Mismo patrón que ventas (20260718121000): único parcial, para poder tener
-- conteos sin clave (por ejemplo desde un script) sin romper la unicidad.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_conteos_idem
  ON public.stock_conteos (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_conteos_suc_fecha
  ON public.stock_conteos (sucursal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.stock_conteo_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conteo_id               uuid NOT NULL REFERENCES public.stock_conteos(id) ON DELETE CASCADE,
  -- ON DELETE SET NULL, no restrictivo: un conteo es auditoría y tiene que
  -- sobrevivir a que se borre el producto, pero NO puede impedir ese borrado.
  -- Con la FK restrictiva por default, un producto contado en cero (que no deja
  -- kardex) quedaba imposible de borrar: eliminar_productos tiraba
  -- foreign_key_violation y la operación entera fallaba. El código/nombre van
  -- desnormalizados para que el registro siga siendo legible sin el producto.
  producto_id             uuid REFERENCES public.productos(id) ON DELETE SET NULL,
  producto_codigo         text NOT NULL,
  producto_nombre         text NOT NULL,
  cantidad_contada        numeric(14,2) NOT NULL,
  cantidad_anterior       numeric(14,2) NOT NULL,
  movimientos_posteriores numeric(14,2) NOT NULL DEFAULT 0,
  cantidad_final          numeric(14,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_conteo_items_conteo
  ON public.stock_conteo_items (conteo_id);
CREATE INDEX IF NOT EXISTS idx_stock_conteo_items_prod
  ON public.stock_conteo_items (producto_id);

COMMENT ON COLUMN public.stock_conteos.contado_desde IS
  'Momento en que se abrió el conteo en pantalla. Los movimientos de stock POSTERIORES a esta hora se suman a lo contado, para no borrar una venta hecha mientras se contaba. NULL = ajuste absoluto puro.';
COMMENT ON COLUMN public.stock_conteo_items.movimientos_posteriores IS
  'Delta de kardex acumulado entre contado_desde y el momento de guardar. cantidad_final = cantidad_contada + esto.';

GRANT SELECT ON public.stock_conteos, public.stock_conteo_items TO authenticated;
GRANT ALL    ON public.stock_conteos, public.stock_conteo_items TO service_role;

ALTER TABLE public.stock_conteos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_conteo_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conteos select" ON public.stock_conteos;
CREATE POLICY "conteos select" ON public.stock_conteos
  FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id());

DROP POLICY IF EXISTS "conteo_items select" ON public.stock_conteo_items;
CREATE POLICY "conteo_items select" ON public.stock_conteo_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.stock_conteos c
                  WHERE c.id = conteo_id
                    AND (public.is_admin(auth.uid())
                         OR c.sucursal_id = public.current_sucursal_id())));

-- ------------------------------------------------------------
-- (2) La vista del inventario.
--
-- "Sin contar" NO puede definirse como "no tiene fila en stock_sucursal": la
-- corrección del envase dejó 113 filas en 0 con un UPDATE y SIN kardex a
-- propósito. Esas filas existen y valen 0, pero nadie las contó — y son
-- justamente las que hay que contar. Con el criterio de la fila desaparecerían
-- del filtro.
--
-- El criterio es `cargado`: el par (producto, sucursal) tiene kardex O fue parte
-- de un conteo. Lo primero cubre todo lo que entra por una vía legítima —ajuste,
-- venta, compra, remito, ingreso—; lo segundo cubre el caso que no deja kardex
-- porque no hay nada que mover: contar CERO.
--
-- El CROSS JOIN con sucursales es a propósito: la grilla del conteo necesita la
-- fila aunque no exista stock. Son 2 sucursales × ~1200 productos.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_stock_mov_prod_suc
  ON public.stock_movimientos (producto_id, sucursal_id);

CREATE OR REPLACE VIEW public.stock_inventario
WITH (security_invoker = true) AS
SELECT
  p.id                        AS producto_id,
  p.codigo,
  p.nombre,
  p.stock_minimo,
  p.unidad_medida,
  p.tamano_envase,
  p.categoria_id,
  p.marca_id,
  su.id                       AS sucursal_id,
  su.nombre                   AS sucursal_nombre,
  su.codigo::text             AS sucursal_codigo,
  COALESCE(ss.cantidad, 0)    AS cantidad,
  (ss.producto_id IS NOT NULL)  AS tiene_fila,
  (mov.producto_id IS NOT NULL) AS tiene_movimientos,
  (cnt.producto_id IS NOT NULL) AS fue_contado,
  (mov.producto_id IS NOT NULL OR cnt.producto_id IS NOT NULL) AS cargado
FROM public.productos p
CROSS JOIN public.sucursales su
LEFT JOIN public.stock_sucursal ss
       ON ss.producto_id = p.id AND ss.sucursal_id = su.id
LEFT JOIN (
  SELECT DISTINCT m.producto_id, m.sucursal_id
    FROM public.stock_movimientos m
) mov ON mov.producto_id = p.id AND mov.sucursal_id = su.id
LEFT JOIN (
  -- Contar CERO no deja kardex (no hay nada que mover), pero es un dato: "lo
  -- conté y no hay". Sin esto, el producto que se contó en cero seguiría
  -- figurando como "sin contar" para siempre y ella lo contaría de nuevo.
  SELECT DISTINCT i.producto_id, c.sucursal_id
    FROM public.stock_conteo_items i
    JOIN public.stock_conteos c ON c.id = i.conteo_id
) cnt ON cnt.producto_id = p.id AND cnt.sucursal_id = su.id
WHERE p.archivado = false;

COMMENT ON VIEW public.stock_inventario IS
  'Inventario para /stock: todos los productos NO ARCHIVADOS por sucursal, tengan o no fila de stock. Incluye a propósito los productos inactivos (activo=false, p.ej. importados sin precio): pueden tener stock físico y hay que poder contarlos. `cargado` distingue "nunca se contó" de "se contó y no hay": es true si el par tiene kardex O fue parte de un conteo. Hace falta porque (a) la corrección del envase del 2026-07-24 dejó filas en 0 SIN kardex, y (b) contar cero tampoco deja kardex (no hay nada que mover).';

GRANT SELECT ON public.stock_inventario TO authenticated, service_role;

-- ------------------------------------------------------------
-- (3) iniciar_conteo_stock — devuelve la hora del SERVIDOR.
--
-- El conteo usa contado_desde para sumar los movimientos posteriores en vez de
-- pisarlos (ver (c) más abajo). Ese timestamp NO puede venir del reloj del
-- navegador: si está adelantado, la RPC sumaría movimientos que no ocurrieron;
-- si está atrasado, se los perdería. La pantalla llama a esto al abrir el modo
-- conteo y usa lo que devuelve el servidor.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.iniciar_conteo_stock()
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT now();
$$;
REVOKE ALL ON FUNCTION public.iniciar_conteo_stock() FROM public;
GRANT EXECUTE ON FUNCTION public.iniciar_conteo_stock() TO authenticated, service_role;

-- ------------------------------------------------------------
-- (4) ajustar_stock_masivo.
--
-- Es el hermano de a-muchos de ajustar_stock (20260714260000), con tres
-- diferencias que valen la pena explicar:
--
-- a) ANTI-DEADLOCK POR LOCK DE TABLA, no por orden de filas. Ordenar los ítems
--    por producto_id no serviría: crear_venta y aprobar_remito recorren sus
--    ítems en el orden del payload y confirmar_ingreso_mercaderia por número de
--    línea, así que un conteo que bloquea A y espera B, contra una venta que
--    bloqueó B y espera A, es un deadlock. Imponer un orden global en todas
--    esas RPC sería cirugía sobre el corazón transaccional del sistema.
--    El LOCK TABLE ... SHARE ROW EXCLUSIVE choca con el ROW EXCLUSIVE que toman
--    los INSERT/UPDATE de las demás: el conteo pide UN lock al principio, sin
--    tener nada tomado, así que no puede haber ciclo. El costo es que un conteo
--    bloquea las escrituras de stock mientras corre (medido: ~1200 ítems en
--    menos de un segundo).
--
-- b) SI EL DELTA ES CERO, NO ESCRIBE kardex (a diferencia de ajustar_stock, que
--    siempre inserta un movimiento). En un conteo de 1200 productos la mayoría
--    no cambia y el kardex quedaría inservible. El ítem igual queda registrado
--    en stock_conteo_items: se contó, coincidía.
--
-- c) LO CONTADO ES "LO QUE HABÍA AL ABRIR EL CONTEO". Si entre que se contó y
--    que se guardó hubo movimientos, se SUMAN a lo contado en vez de pisarlos:
--    contar 10 al abrir, vender 2 mientras se tipea, guardar, tiene que dejar 8,
--    no 10. Borrar esa venta sería exactamente la clase de mentira que la
--    corrección del envase vino a sacar del sistema. p_contado_desde viene de
--    iniciar_conteo_stock() (hora del servidor), no del reloj del cliente.
--    Si la suma diera negativo (se vendió más de lo contado: la cuenta quedó
--    inconsistente), se deja en 0 y se informa como CONFLICTO — no se silencia.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ajustar_stock_masivo(
  p_sucursal_id     uuid,
  p_items           jsonb,
  p_motivo          text,
  p_contado_desde   timestamptz DEFAULT NULL,
  p_idempotency_key uuid        DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_conteo_id  uuid;
  v_existente  public.stock_conteos%ROWTYPE;
  v_n          integer;
  v_ajustados  integer := 0;
  v_iguales    integer := 0;
  v_con_movs   integer := 0;
  v_conflictos integer := 0;
  it           jsonb;
  v_prod       uuid;
  v_cod        text;
  v_nom        text;
  v_contada    numeric(14,2);
  v_ant        numeric(14,2);
  v_post       numeric(14,2);
  v_final      numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo el administrador puede cargar un conteo de stock';
  END IF;
  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
    RAISE EXCEPTION 'El motivo del conteo es obligatorio';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sucursales WHERE id = p_sucursal_id) THEN
    RAISE EXCEPTION 'Sucursal inexistente';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Los ítems del conteo son inválidos';
  END IF;

  v_n := jsonb_array_length(p_items);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'El conteo no tiene ítems';
  END IF;
  -- Tope medido, no mágico: el catálogo real por sucursal es ~1200.
  IF v_n > 2000 THEN
    RAISE EXCEPTION 'El conteo tiene demasiados ítems (%). El máximo es 2000; cargalo por partes.', v_n;
  END IF;

  -- Idempotencia, mismo patrón que crear_venta: si el request se reintenta
  -- porque se perdió la respuesta, no se vuelve a tocar el stock.
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
    SELECT * INTO v_existente FROM public.stock_conteos WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'conteo_id',       v_existente.id,
        'ajustados',       v_existente.items_ajustados,
        'sin_cambio',      v_existente.items_sin_cambio,
        'con_movimientos', v_existente.items_con_movimientos,
        'conflictos',      v_existente.items_conflicto,
        'repetido',        true);
    END IF;
  END IF;

  -- Validación del payload ANTES de tocar nada: un conteo se acepta entero o no
  -- se acepta.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) x
     GROUP BY x->>'producto_id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Hay un producto repetido en el conteo';
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_prod := NULLIF(it->>'producto_id', '')::uuid;
    IF v_prod IS NULL THEN
      RAISE EXCEPTION 'Hay un ítem sin producto';
    END IF;
    IF (it->>'cantidad') IS NULL OR jsonb_typeof(it->'cantidad') <> 'number' THEN
      RAISE EXCEPTION 'La cantidad contada del producto % es inválida', v_prod;
    END IF;
    v_contada := (it->>'cantidad')::numeric;
    IF v_contada < 0 THEN
      RAISE EXCEPTION 'La cantidad contada no puede ser negativa (producto %)', v_prod;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.productos WHERE id = v_prod AND archivado = false) THEN
      RAISE EXCEPTION 'Producto inexistente o archivado: %', v_prod;
    END IF;
  END LOOP;

  -- Ver (a) del encabezado: esto es lo que hace imposible el deadlock.
  LOCK TABLE public.stock_sucursal IN SHARE ROW EXCLUSIVE MODE;

  INSERT INTO public.stock_conteos (
    sucursal_id, usuario_id, motivo, contado_desde, idempotency_key)
  VALUES (p_sucursal_id, v_uid, btrim(p_motivo), p_contado_desde, p_idempotency_key)
  RETURNING id INTO v_conteo_id;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_prod    := (it->>'producto_id')::uuid;
    v_contada := ROUND((it->>'cantidad')::numeric, 2);
    SELECT codigo, nombre INTO v_cod, v_nom FROM public.productos WHERE id = v_prod;

    -- Garantiza la fila sin pisar la cantidad si ya está (igual que ajustar_stock).
    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
    VALUES (v_prod, p_sucursal_id, 0)
    ON CONFLICT (producto_id, sucursal_id) DO NOTHING;

    SELECT cantidad INTO v_ant
      FROM public.stock_sucursal
     WHERE producto_id = v_prod AND sucursal_id = p_sucursal_id
     FOR UPDATE;

    -- Ver (c): lo que se movió DESPUÉS de que se abrió el conteo no se pisa.
    v_post := 0;
    IF p_contado_desde IS NOT NULL THEN
      SELECT COALESCE(sum(m.cantidad), 0) INTO v_post
        FROM public.stock_movimientos m
       WHERE m.producto_id = v_prod
         AND m.sucursal_id = p_sucursal_id
         AND m.created_at >= p_contado_desde;
    END IF;

    v_final := ROUND(v_contada + v_post, 2);
    IF v_final < 0 THEN
      -- Se vendió más de lo contado desde que se abrió el conteo: la cuenta es
      -- inconsistente con el kardex. Se deja en 0 (el stock no puede ser
      -- negativo) pero NO en silencio: se informa como conflicto para revisar.
      v_final := 0;
      v_conflictos := v_conflictos + 1;
    END IF;

    INSERT INTO public.stock_conteo_items (
      conteo_id, producto_id, producto_codigo, producto_nombre, cantidad_contada,
      cantidad_anterior, movimientos_posteriores, cantidad_final)
    VALUES (v_conteo_id, v_prod, v_cod, v_nom, v_contada, v_ant, v_post, v_final);

    IF v_post <> 0 THEN
      v_con_movs := v_con_movs + 1;
    END IF;

    IF v_final = v_ant THEN
      -- Ver (b): se contó y coincidía. Queda en stock_conteo_items, no en el kardex.
      v_iguales := v_iguales + 1;
    ELSE
      UPDATE public.stock_sucursal
         SET cantidad = v_final
       WHERE producto_id = v_prod AND sucursal_id = p_sucursal_id;

      INSERT INTO public.stock_movimientos (
        producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
        motivo, referencia_id, usuario_id
      ) VALUES (
        v_prod, p_sucursal_id, 'AJUSTE', v_final - v_ant, v_ant, v_final,
        btrim(p_motivo), v_conteo_id, v_uid
      );
      v_ajustados := v_ajustados + 1;
    END IF;
  END LOOP;

  UPDATE public.stock_conteos
     SET items_ajustados = v_ajustados,
         items_sin_cambio = v_iguales,
         items_con_movimientos = v_con_movs,
         items_conflicto = v_conflictos
   WHERE id = v_conteo_id;

  RETURN jsonb_build_object(
    'conteo_id',       v_conteo_id,
    'ajustados',       v_ajustados,
    'sin_cambio',      v_iguales,
    'con_movimientos', v_con_movs,
    'conflictos',      v_conflictos,
    'repetido',        false);
END; $$;

REVOKE ALL ON FUNCTION public.ajustar_stock_masivo(uuid, jsonb, text, timestamptz, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.ajustar_stock_masivo(uuid, jsonb, text, timestamptz, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ajustar_stock_masivo(uuid, jsonb, text, timestamptz, uuid) TO service_role;
