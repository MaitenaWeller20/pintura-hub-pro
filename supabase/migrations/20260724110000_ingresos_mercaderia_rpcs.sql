-- ============================================================
-- INGRESOS DE MERCADERÍA — RPCs transaccionales (SECURITY DEFINER)
--
-- Patrón crear_venta/crear_compra: validan auth.uid(), validan sucursal propia o
-- admin, y calculan en el servidor todo lo que no debe venir del cliente. Ninguna
-- toca caja ni cuenta corriente.
-- ============================================================

-- ------------------------------------------------------------
-- crear_borrador_ingreso — crea la cabecera ANTES de llamar al modelo.
-- Aplica el rate limit de extracciones por usuario/hora.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crear_borrador_ingreso(
  p_proveedor_id uuid,
  p_sucursal_id  uuid,
  p_archivo_path text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_id        uuid;
  v_recientes integer;
  RATE_LIMIT  constant integer := 30;  -- borradores por usuario en la última hora
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés cargar un ingreso en una sucursal que no es la tuya';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.proveedores WHERE id = p_proveedor_id AND activo) THEN
    RAISE EXCEPTION 'Proveedor inexistente o inactivo';
  END IF;

  -- La extracción gasta plata real por llamada; un tope holgado corta en seco un
  -- bucle accidental sin molestar el uso real (unos pocos remitos por día).
  SELECT count(*) INTO v_recientes
    FROM public.ingresos_mercaderia
   WHERE usuario_id = v_uid AND created_at > now() - interval '1 hour';
  IF v_recientes >= RATE_LIMIT THEN
    RAISE EXCEPTION 'Alcanzaste el límite de % extracciones por hora. Esperá un rato.', RATE_LIMIT;
  END IF;

  INSERT INTO public.ingresos_mercaderia (proveedor_id, sucursal_id, usuario_id, archivo_path)
  VALUES (p_proveedor_id, p_sucursal_id, v_uid, p_archivo_path)
  RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

-- ------------------------------------------------------------
-- guardar_extraccion_ingreso — vuelca el resultado del modelo al borrador.
-- p_items: [{linea, codigo_proveedor, descripcion_proveedor, cantidad, cantidad_raw,
--            descripcion_raw, pagina, producto_id, codigo, descripcion, origen_match,
--            confianza, advertencia}]
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guardar_extraccion_ingreso(
  p_ingreso_id   uuid,
  p_extraccion   jsonb DEFAULT NULL,
  p_items        jsonb DEFAULT '[]'::jsonb,
  p_uso_tokens   jsonb DEFAULT NULL,
  p_numero       text  DEFAULT NULL,
  p_fecha        date  DEFAULT NULL,
  p_error        text  DEFAULT NULL,
  p_bloqueo      text  DEFAULT NULL,
  p_archivo_path text  DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ing public.ingresos_mercaderia%ROWTYPE;
  it    jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  SELECT * INTO v_ing FROM public.ingresos_mercaderia WHERE id = p_ingreso_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingreso no encontrado'; END IF;
  IF NOT public.is_admin(v_uid) AND v_ing.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés modificar un ingreso de otra sucursal';
  END IF;
  IF v_ing.estado <> 'BORRADOR' THEN RAISE EXCEPTION 'El ingreso no está en borrador'; END IF;

  UPDATE public.ingresos_mercaderia SET
    extraccion              = p_extraccion,
    uso_tokens              = p_uso_tokens,
    numero_remito_proveedor = COALESCE(p_numero, numero_remito_proveedor),
    numero_normalizado      = COALESCE(public.normalizar_codigo(p_numero), numero_normalizado),
    fecha_remito            = COALESCE(p_fecha, fecha_remito),
    archivo_path            = COALESCE(p_archivo_path, archivo_path),
    bloqueo_confirmacion    = p_bloqueo,
    extraccion_estado       = CASE WHEN p_error IS NOT NULL THEN 'ERROR' ELSE 'OK' END,
    extraccion_error        = p_error
  WHERE id = p_ingreso_id;

  DELETE FROM public.ingreso_mercaderia_items WHERE ingreso_id = p_ingreso_id;
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    INSERT INTO public.ingreso_mercaderia_items (
      ingreso_id, linea, producto_id, codigo, descripcion, cantidad,
      codigo_proveedor, descripcion_proveedor, cantidad_raw, descripcion_raw,
      pagina, origen_match, confianza, advertencia
    ) VALUES (
      p_ingreso_id,
      COALESCE((it->>'linea')::integer, 0),
      NULLIF(it->>'producto_id', '')::uuid,
      it->>'codigo', it->>'descripcion',
      NULLIF(it->>'cantidad', '')::numeric,
      it->>'codigo_proveedor', it->>'descripcion_proveedor',
      it->>'cantidad_raw', it->>'descripcion_raw',
      NULLIF(it->>'pagina', '')::integer,
      COALESCE(it->>'origen_match', 'MANUAL'),
      it->>'confianza', it->>'advertencia'
    );
  END LOOP;
END; $$;

-- ------------------------------------------------------------
-- actualizar_items_borrador — persiste lo que la usuaria corrige en la grilla.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.actualizar_items_borrador(
  p_ingreso_id uuid,
  p_items      jsonb
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ing public.ingresos_mercaderia%ROWTYPE;
  it    jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  SELECT * INTO v_ing FROM public.ingresos_mercaderia WHERE id = p_ingreso_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingreso no encontrado'; END IF;
  IF NOT public.is_admin(v_uid) AND v_ing.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés modificar un ingreso de otra sucursal';
  END IF;
  IF v_ing.estado <> 'BORRADOR' THEN RAISE EXCEPTION 'El ingreso no está en borrador'; END IF;

  DELETE FROM public.ingreso_mercaderia_items WHERE ingreso_id = p_ingreso_id;
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    INSERT INTO public.ingreso_mercaderia_items (
      ingreso_id, linea, producto_id, codigo, descripcion, cantidad,
      codigo_proveedor, descripcion_proveedor, cantidad_raw, descripcion_raw,
      pagina, origen_match, confianza, aprender, pisar_equivalencia, advertencia
    ) VALUES (
      p_ingreso_id,
      COALESCE((it->>'linea')::integer, 0),
      NULLIF(it->>'producto_id', '')::uuid,
      it->>'codigo', it->>'descripcion',
      NULLIF(it->>'cantidad', '')::numeric,
      it->>'codigo_proveedor', it->>'descripcion_proveedor',
      it->>'cantidad_raw', it->>'descripcion_raw',
      NULLIF(it->>'pagina', '')::integer,
      COALESCE(it->>'origen_match', 'MANUAL'),
      it->>'confianza',
      COALESCE((it->>'aprender')::boolean, true),
      COALESCE((it->>'pisar_equivalencia')::boolean, false),
      it->>'advertencia'
    );
  END LOOP;
END; $$;

-- ------------------------------------------------------------
-- confirmar_ingreso_mercaderia — el único que mueve stock.
-- Idempotente (patrón ventas). Aprende las equivalencias nuevas.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirmar_ingreso_mercaderia(
  p_ingreso_id     uuid,
  p_numero         text  DEFAULT NULL,
  p_fecha          date  DEFAULT NULL,
  p_items          jsonb DEFAULT NULL,
  p_observaciones  text  DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_ing        public.ingresos_mercaderia%ROWTYPE;
  v_ex_id      uuid;
  v_num_norm   text := public.normalizar_codigo(p_numero);
  it           jsonb;
  v_prod       public.productos%ROWTYPE;
  v_cant       numeric(14,2);
  v_cod_prov   text;
  v_stock_ant  numeric(14,2);
  v_stock_nue  numeric(14,2);
  v_n_items    integer := 0;
  v_linea      integer := 0;
  -- para detectar el mismo código de proveedor apuntando a dos productos distintos
  v_dup        text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  -- IDEMPOTENCIA: mismo patrón que crear_venta. El advisory lock serializa dos
  -- llamadas con la misma key; la segunda encuentra el ingreso ya confirmado.
  -- Se exige que la key pertenezca a ESTE ingreso: una key filtrada/reusada no
  -- puede devolver un ingreso ajeno.
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
    SELECT id INTO v_ex_id FROM public.ingresos_mercaderia
      WHERE idempotency_key = p_idempotency_key AND id = p_ingreso_id;
    IF FOUND THEN RETURN v_ex_id; END IF;
  END IF;

  SELECT * INTO v_ing FROM public.ingresos_mercaderia WHERE id = p_ingreso_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingreso no encontrado'; END IF;
  IF NOT public.is_admin(v_uid) AND v_ing.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés confirmar un ingreso de otra sucursal';
  END IF;
  IF v_ing.estado <> 'BORRADOR' THEN
    RAISE EXCEPTION 'El ingreso ya fue % (sólo se confirma un borrador)', lower(v_ing.estado);
  END IF;

  -- Documento mezclado (dos remitos/fechas en un archivo): la extracción dejó el
  -- motivo en bloqueo_confirmacion y NO se confirma. Persistido, así que el bloqueo
  -- resiste refresh, retomar borrador y llamada directa a esta RPC.
  IF v_ing.bloqueo_confirmacion IS NOT NULL THEN
    RAISE EXCEPTION '%', v_ing.bloqueo_confirmacion;
  END IF;

  -- Si hay ítems nuevos en el payload, se persisten primero (la grilla pudo cambiar).
  IF p_items IS NOT NULL THEN
    PERFORM public.actualizar_items_borrador(p_ingreso_id, p_items);
  END IF;

  -- Un mismo codigo_proveedor no puede apuntar a dos productos distintos en el
  -- mismo remito: sería un match contradictorio que además envenenaría el aprendizaje.
  -- Se compara por código NORMALIZADO (mismo criterio que el aprendizaje).
  SELECT public.normalizar_codigo(codigo_proveedor) INTO v_dup
    FROM public.ingreso_mercaderia_items
   WHERE ingreso_id = p_ingreso_id AND origen_match <> 'IGNORADA'
     AND public.normalizar_codigo(codigo_proveedor) IS NOT NULL AND producto_id IS NOT NULL
   GROUP BY public.normalizar_codigo(codigo_proveedor)
  HAVING count(DISTINCT producto_id) > 1
   LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'El código % del proveedor apunta a dos productos distintos en el mismo remito', v_dup;
  END IF;

  -- NO se toma advisory lock de sucursal: este circuito no toca caja (a diferencia
  -- de crear_venta/anular_compra, que lo necesitan para serializar la apertura de
  -- caja). El INSERT ... ON CONFLICT DO UPDATE de stock ya es atómico por sí solo.
  -- Tomarlo, además, abriría un deadlock ABBA con una venta concurrente del mismo
  -- producto (venta: producto FOR UPDATE -> advisory sucursal; ingreso: advisory
  -- sucursal -> FK del producto al insertar stock).

  FOR it IN
    SELECT to_jsonb(t) FROM public.ingreso_mercaderia_items t
     WHERE t.ingreso_id = p_ingreso_id AND t.origen_match <> 'IGNORADA'
     ORDER BY t.linea
  LOOP
    v_linea    := COALESCE((it->>'linea')::integer, v_linea + 1);
    v_cant     := NULLIF(it->>'cantidad', '')::numeric;
    v_cod_prov := it->>'codigo_proveedor';

    IF (it->>'producto_id') IS NULL OR (it->>'producto_id') = '' THEN
      RAISE EXCEPTION 'La línea % no tiene producto asignado', v_linea;
    END IF;
    IF v_cant IS NULL OR v_cant <= 0 THEN
      RAISE EXCEPTION 'La línea % tiene una cantidad inválida (%)', v_linea, v_cant;
    END IF;

    -- NO se exige activo: un producto inactivo (ej. recién creado sin precio) SÍ
    -- puede RECIBIR mercadería; lo que no puede es venderse (eso lo bloquea ventas).
    -- Exigir activo acá rompería el alta inline (que nace inactiva a propósito).
    SELECT * INTO v_prod FROM public.productos WHERE id = (it->>'producto_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La línea % apunta a un producto inexistente', v_linea;
    END IF;

    -- Suma stock + kardex en una sola pasada, idéntico a crear_compra.
    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
    VALUES (v_prod.id, v_ing.sucursal_id, v_cant)
    ON CONFLICT (producto_id, sucursal_id)
    DO UPDATE SET cantidad = stock_sucursal.cantidad + EXCLUDED.cantidad
    RETURNING cantidad - v_cant, cantidad INTO v_stock_ant, v_stock_nue;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      v_prod.id, v_ing.sucursal_id, 'INGRESO_MERCADERIA', v_cant, v_stock_ant, v_stock_nue,
      'Ingreso remito ' || COALESCE(p_numero, v_ing.numero_remito_proveedor, ''), p_ingreso_id, v_uid
    );

    -- APRENDER la equivalencia. Sólo si el código NO está vacío tras normalizar
    -- (una línea sin código no se aprende — y además rompería el CHECK de la tabla).
    -- La IA nunca pisa una existente; sólo el usuario, marcando pisar_equivalencia
    -- a mano. Sin eso, ON CONFLICT DO NOTHING. La unicidad va por código normalizado.
    IF public.normalizar_codigo(v_cod_prov) IS NOT NULL AND COALESCE((it->>'aprender')::boolean, true) THEN
      IF COALESCE((it->>'pisar_equivalencia')::boolean, false) THEN
        INSERT INTO public.producto_codigos_proveedor (
          proveedor_id, codigo_proveedor, producto_id, descripcion_proveedor, usuario_id
        ) VALUES (
          v_ing.proveedor_id, v_cod_prov, v_prod.id, it->>'descripcion_proveedor', v_uid
        )
        ON CONFLICT (proveedor_id, codigo_proveedor_norm)
        DO UPDATE SET producto_id = EXCLUDED.producto_id,
                      codigo_proveedor = EXCLUDED.codigo_proveedor,
                      descripcion_proveedor = EXCLUDED.descripcion_proveedor,
                      usuario_id = EXCLUDED.usuario_id,
                      updated_at = now();
      ELSE
        INSERT INTO public.producto_codigos_proveedor (
          proveedor_id, codigo_proveedor, producto_id, descripcion_proveedor, usuario_id
        ) VALUES (
          v_ing.proveedor_id, v_cod_prov, v_prod.id, it->>'descripcion_proveedor', v_uid
        )
        ON CONFLICT (proveedor_id, codigo_proveedor_norm) DO NOTHING;
      END IF;
    END IF;

    v_n_items := v_n_items + 1;
  END LOOP;

  IF v_n_items = 0 THEN
    RAISE EXCEPTION 'El ingreso no tiene líneas para cargar';
  END IF;

  UPDATE public.ingresos_mercaderia SET
    estado                  = 'CONFIRMADO',
    numero_remito_proveedor = COALESCE(p_numero, numero_remito_proveedor),
    numero_normalizado      = COALESCE(v_num_norm, numero_normalizado),
    fecha_remito            = COALESCE(p_fecha, fecha_remito),
    observaciones           = COALESCE(p_observaciones, observaciones),
    fecha_confirmacion      = now(),
    idempotency_key         = p_idempotency_key
  WHERE id = p_ingreso_id;

  RETURN p_ingreso_id;
END; $$;

-- ------------------------------------------------------------
-- anular_ingreso_mercaderia — admin. Revierte stock con guarda de negativo.
-- No borra equivalencias (pueden estar bien aunque el ingreso esté mal).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anular_ingreso_mercaderia(
  p_ingreso_id uuid,
  p_motivo     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_ing         public.ingresos_mercaderia%ROWTYPE;
  v_permite_neg boolean;
  r             RECORD;
  v_stock_ant   numeric(14,2);
  v_stock_nue   numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede anular un ingreso de mercadería';
  END IF;

  SELECT * INTO v_ing FROM public.ingresos_mercaderia WHERE id = p_ingreso_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingreso no encontrado'; END IF;
  IF v_ing.estado = 'ANULADO' THEN RAISE EXCEPTION 'El ingreso ya fue anulado'; END IF;
  IF v_ing.estado <> 'CONFIRMADO' THEN
    RAISE EXCEPTION 'Sólo se anula un ingreso confirmado (este está en %)', lower(v_ing.estado);
  END IF;

  -- Sin advisory lock de sucursal: no se toca caja y el UPDATE de stock con guarda
  -- (cantidad >= a_revertir) ya es atómico. Tomarlo abriría el mismo deadlock ABBA
  -- con ventas que se evita en confirmar_ingreso_mercaderia.

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);

  FOR r IN
    SELECT producto_id, cantidad, codigo
      FROM public.ingreso_mercaderia_items
     WHERE ingreso_id = p_ingreso_id AND origen_match <> 'IGNORADA' AND producto_id IS NOT NULL
  LOOP
    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES (r.producto_id, v_ing.sucursal_id, 0)
      ON CONFLICT (producto_id, sucursal_id) DO NOTHING;
      UPDATE public.stock_sucursal SET cantidad = cantidad - r.cantidad
       WHERE producto_id = r.producto_id AND sucursal_id = v_ing.sucursal_id
      RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
    ELSE
      UPDATE public.stock_sucursal SET cantidad = cantidad - r.cantidad
       WHERE producto_id = r.producto_id AND sucursal_id = v_ing.sucursal_id AND cantidad >= r.cantidad
      RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No se puede anular: ya se movió parte de % (no alcanza el stock para revertir)', r.codigo;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      r.producto_id, v_ing.sucursal_id, 'ANULACION_INGRESO_MERCADERIA', -r.cantidad, v_stock_ant, v_stock_nue,
      'Anulación ingreso ' || COALESCE(v_ing.numero_remito_proveedor, ''), p_ingreso_id, v_uid
    );
  END LOOP;

  UPDATE public.ingresos_mercaderia
     SET estado = 'ANULADO', motivo_anulacion = p_motivo
   WHERE id = p_ingreso_id;
END; $$;

-- ------------------------------------------------------------
-- crear_producto_desde_ingreso — alta rápida desde la revisión.
-- productos tiene RLS de escritura solo-admin; esta RPC deja que un no-admin cree
-- el producto. El precio es OPCIONAL:
--   con precio (>0) -> nace ACTIVO y vendible, en la misma pantalla.
--   sin precio      -> nace INACTIVO: entra al stock pero no se ve ni se vende
--                      hasta que le carguen el precio en Productos (imposible
--                      venderlo a $0 por descuido).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crear_producto_desde_ingreso(
  p_codigo         text,
  p_nombre         text,
  p_iva            numeric DEFAULT 21,
  p_precio_sin_iva numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_id     uuid;
  v_precio numeric(14,2) := COALESCE(p_precio_sin_iva, 0);
  v_activo boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF btrim(COALESCE(p_codigo, '')) = '' THEN RAISE EXCEPTION 'El código es obligatorio'; END IF;
  IF btrim(COALESCE(p_nombre, '')) = '' THEN RAISE EXCEPTION 'El nombre es obligatorio'; END IF;
  IF v_precio < 0 THEN RAISE EXCEPTION 'El precio no puede ser negativo'; END IF;
  IF EXISTS (SELECT 1 FROM public.productos WHERE codigo = p_codigo) THEN
    RAISE EXCEPTION 'Ya existe un producto con el código %', p_codigo;
  END IF;

  -- Sólo con precio se activa: sin precio queda oculto hasta completarlo.
  v_activo := v_precio > 0;

  INSERT INTO public.productos (codigo, nombre, iva_porcentaje, precio_sin_iva, activo)
  VALUES (p_codigo, p_nombre, COALESCE(p_iva, 21), v_precio, v_activo)
  RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

-- ------------------------------------------------------------
-- buscar_productos_similares — shortlist de candidatos para el matching (pg_trgm).
-- Devuelve activos e inactivos: un producto recién creado sin precio (inactivo)
-- igual tiene que poder recibir mercadería.
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
   WHERE COALESCE(p_texto, '') <> '' AND (
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
    'crear_borrador_ingreso(uuid, uuid, text)',
    'guardar_extraccion_ingreso(uuid, jsonb, jsonb, jsonb, text, date, text, text, text)',
    'actualizar_items_borrador(uuid, jsonb)',
    'confirmar_ingreso_mercaderia(uuid, text, date, jsonb, text, uuid)',
    'anular_ingreso_mercaderia(uuid, text)',
    'crear_producto_desde_ingreso(text, text, numeric, numeric)',
    'buscar_productos_similares(text, text, integer)'
  ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM public', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
  END LOOP;
END $$;
