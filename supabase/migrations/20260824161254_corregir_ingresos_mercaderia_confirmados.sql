-- Correcciones auditables sobre ingresos ya confirmados.
-- La cantidad vigente permanece en ingreso_mercaderia_items para que una
-- anulación posterior revierta exactamente lo que efectivamente ingresó.

ALTER TYPE public.tipo_movimiento_stock
  ADD VALUE IF NOT EXISTS 'CORRECCION_INGRESO_MERCADERIA';

CREATE TABLE public.ingreso_mercaderia_correcciones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingreso_id        uuid NOT NULL REFERENCES public.ingresos_mercaderia(id),
  usuario_id        uuid NOT NULL REFERENCES auth.users(id),
  usuario_nombre    text NOT NULL,
  motivo            text NOT NULL,
  idempotency_key   uuid NOT NULL,
  request_payload   jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingreso_correccion_motivo_valido
    CHECK (char_length(btrim(motivo)) BETWEEN 1 AND 500),
  CONSTRAINT ingreso_correccion_usuario_nombre_valido
    CHECK (btrim(usuario_nombre) <> '')
);

CREATE UNIQUE INDEX uq_ingreso_correcciones_idempotency
  ON public.ingreso_mercaderia_correcciones (idempotency_key);
CREATE INDEX idx_ingreso_correcciones_ingreso_fecha
  ON public.ingreso_mercaderia_correcciones (ingreso_id, created_at DESC);
CREATE INDEX idx_ingreso_correcciones_usuario
  ON public.ingreso_mercaderia_correcciones (usuario_id);

CREATE TABLE public.ingreso_mercaderia_correccion_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correccion_id       uuid NOT NULL
    REFERENCES public.ingreso_mercaderia_correcciones(id) ON DELETE CASCADE,
  ingreso_item_id     uuid NOT NULL REFERENCES public.ingreso_mercaderia_items(id),
  producto_id         uuid NOT NULL REFERENCES public.productos(id),
  codigo              text,
  descripcion         text NOT NULL,
  cantidad_anterior   numeric(14,2) NOT NULL,
  cantidad_nueva      numeric(14,2) NOT NULL,
  diferencia          numeric(14,2) NOT NULL,
  stock_movimiento_id uuid NOT NULL REFERENCES public.stock_movimientos(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingreso_correccion_item_unico UNIQUE (correccion_id, ingreso_item_id),
  CONSTRAINT ingreso_correccion_cantidades_validas CHECK (
    cantidad_anterior >= 0
    AND cantidad_nueva >= 0
    AND diferencia = cantidad_nueva - cantidad_anterior
    AND diferencia <> 0
  )
);

CREATE INDEX idx_ingreso_correccion_items_correccion
  ON public.ingreso_mercaderia_correccion_items (correccion_id);
CREATE INDEX idx_ingreso_correccion_items_ingreso_item
  ON public.ingreso_mercaderia_correccion_items (ingreso_item_id);
CREATE INDEX idx_ingreso_correccion_items_producto
  ON public.ingreso_mercaderia_correccion_items (producto_id);
CREATE UNIQUE INDEX uq_ingreso_correccion_items_movimiento
  ON public.ingreso_mercaderia_correccion_items (stock_movimiento_id);

REVOKE ALL ON public.ingreso_mercaderia_correcciones FROM PUBLIC, anon;
REVOKE ALL ON public.ingreso_mercaderia_correccion_items FROM PUBLIC, anon;
GRANT SELECT ON public.ingreso_mercaderia_correcciones TO authenticated;
GRANT SELECT ON public.ingreso_mercaderia_correccion_items TO authenticated;
GRANT ALL ON public.ingreso_mercaderia_correcciones TO service_role;
GRANT ALL ON public.ingreso_mercaderia_correccion_items TO service_role;

ALTER TABLE public.ingreso_mercaderia_correcciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingreso_mercaderia_correccion_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ingreso correcciones select"
  ON public.ingreso_mercaderia_correcciones
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.ingresos_mercaderia ingreso
      WHERE ingreso.id = ingreso_id
        AND (
          public.is_admin((SELECT auth.uid()))
          OR ingreso.sucursal_id = public.current_sucursal_id()
        )
    )
  );

CREATE POLICY "ingreso correccion items select"
  ON public.ingreso_mercaderia_correccion_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.ingreso_mercaderia_correcciones correccion
      JOIN public.ingresos_mercaderia ingreso
        ON ingreso.id = correccion.ingreso_id
      WHERE correccion.id = correccion_id
        AND (
          public.is_admin((SELECT auth.uid()))
          OR ingreso.sucursal_id = public.current_sucursal_id()
        )
    )
  );

COMMENT ON TABLE public.ingreso_mercaderia_correcciones IS
  'Cabecera inmutable de cada corrección administrativa aplicada a un ingreso confirmado.';
COMMENT ON TABLE public.ingreso_mercaderia_correccion_items IS
  'Antes, después y movimiento de stock de cada línea corregida.';

CREATE OR REPLACE FUNCTION public.corregir_ingreso_mercaderia(
  p_ingreso_id      uuid,
  p_items           jsonb,
  p_motivo          text,
  p_idempotency_key uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_ingreso          public.ingresos_mercaderia%ROWTYPE;
  v_motivo           text := btrim(COALESCE(p_motivo, ''));
  v_items_normalized jsonb;
  v_request_payload  jsonb;
  v_existing_id      uuid;
  v_existing_payload jsonb;
  v_correccion_id    uuid;
  v_usuario_nombre   text;
  v_item              jsonb;
  v_cantidad_nueva   numeric;
  v_cantidad_anterior numeric(14,2);
  v_diferencia       numeric(14,2);
  v_stock_anterior   numeric(14,2);
  v_stock_nuevo      numeric(14,2);
  v_movimiento_id    uuid;
  r                   record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede corregir un ingreso confirmado';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'La clave de idempotencia es obligatoria';
  END IF;
  IF p_ingreso_id IS NULL THEN
    RAISE EXCEPTION 'El ingreso es obligatorio';
  END IF;
  IF char_length(v_motivo) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'El motivo es obligatorio y admite hasta 500 caracteres';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'La corrección debe incluir al menos un cambio';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR NOT (v_item ? 'item_id')
       OR NOT (v_item ? 'cantidad_nueva')
       OR (SELECT count(*) FROM jsonb_object_keys(v_item)) <> 2 THEN
      RAISE EXCEPTION 'Cada cambio debe contener sólo item_id y cantidad_nueva';
    END IF;
    IF jsonb_typeof(v_item -> 'item_id') <> 'string'
       OR jsonb_typeof(v_item -> 'cantidad_nueva') <> 'number' THEN
      RAISE EXCEPTION 'El item_id o la cantidad tienen un formato inválido';
    END IF;

    BEGIN
      PERFORM (v_item ->> 'item_id')::uuid;
      v_cantidad_nueva := (v_item ->> 'cantidad_nueva')::numeric;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'El item_id o la cantidad tienen un formato inválido';
    END;

    IF v_cantidad_nueva < 0
       OR v_cantidad_nueva >= 1000000000000
       OR scale(v_cantidad_nueva) > 2 THEN
      RAISE EXCEPTION 'La cantidad debe ser mayor o igual a cero y tener hasta dos decimales';
    END IF;
  END LOOP;

  IF (
    SELECT count(*) <> count(DISTINCT (value ->> 'item_id')::uuid)
    FROM jsonb_array_elements(p_items)
  ) THEN
    RAISE EXCEPTION 'No se puede repetir un item dentro de la corrección';
  END IF;

  SELECT jsonb_agg(
           jsonb_build_object(
             'item_id', (value ->> 'item_id')::uuid,
             'cantidad_nueva', (value ->> 'cantidad_nueva')::numeric
           )
           ORDER BY (value ->> 'item_id')::uuid
         )
    INTO v_items_normalized
    FROM jsonb_array_elements(p_items);

  v_request_payload := jsonb_build_object(
    'ingreso_id', p_ingreso_id,
    'motivo', v_motivo,
    'items', v_items_normalized
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_idempotency_key::text, 0)
  );
  SELECT id, request_payload
    INTO v_existing_id, v_existing_payload
    FROM public.ingreso_mercaderia_correcciones
   WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_payload = v_request_payload THEN
      RETURN v_existing_id;
    END IF;
    RAISE EXCEPTION 'Conflicto de idempotencia: la clave ya fue usada para otra corrección';
  END IF;

  SELECT *
    INTO v_ingreso
    FROM public.ingresos_mercaderia
   WHERE id = p_ingreso_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ingreso no encontrado';
  END IF;
  IF v_ingreso.estado <> 'CONFIRMADO' THEN
    RAISE EXCEPTION 'Sólo se puede corregir un ingreso confirmado';
  END IF;

  IF (
    SELECT count(*)
    FROM public.ingreso_mercaderia_items item_ingreso
    JOIN jsonb_array_elements(v_items_normalized) solicitado
      ON item_ingreso.id = (solicitado ->> 'item_id')::uuid
    WHERE item_ingreso.ingreso_id = p_ingreso_id
      AND item_ingreso.producto_id IS NOT NULL
      AND item_ingreso.origen_match <> 'IGNORADA'
      AND item_ingreso.cantidad IS NOT NULL
  ) <> jsonb_array_length(v_items_normalized) THEN
    RAISE EXCEPTION 'Uno o más items no pertenecen al ingreso o no son corregibles';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.ingreso_mercaderia_items item_ingreso
    JOIN jsonb_array_elements(v_items_normalized) solicitado
      ON item_ingreso.id = (solicitado ->> 'item_id')::uuid
    WHERE item_ingreso.cantidad = (solicitado ->> 'cantidad_nueva')::numeric
  ) THEN
    RAISE EXCEPTION 'El payload sólo debe incluir líneas cuya cantidad cambió';
  END IF;

  -- Mismo orden que las ventas: primero se cercan los productos y después el
  -- stock. KEY SHARE alcanza para impedir que una venta tome FOR UPDATE, pero
  -- sigue siendo compatible con las validaciones de FK de otros ingresos.
  PERFORM 1
    FROM public.productos producto
   WHERE producto.id IN (
     SELECT DISTINCT item_ingreso.producto_id
       FROM public.ingreso_mercaderia_items item_ingreso
       JOIN jsonb_array_elements(v_items_normalized) solicitado
         ON item_ingreso.id = (solicitado ->> 'item_id')::uuid
   )
   ORDER BY producto.id
   FOR KEY SHARE;

  -- Toma todas las filas existentes en un orden total. NOWAIT evita formar un
  -- ciclo con una confirmación/venta que ya esté moviendo esos productos: el
  -- administrador recibe un error reintentable en vez de un deadlock.
  BEGIN
    PERFORM 1
      FROM public.stock_sucursal stock
     WHERE stock.sucursal_id = v_ingreso.sucursal_id
       AND stock.producto_id IN (
         SELECT DISTINCT item_ingreso.producto_id
           FROM public.ingreso_mercaderia_items item_ingreso
           JOIN jsonb_array_elements(v_items_normalized) solicitado
             ON item_ingreso.id = (solicitado ->> 'item_id')::uuid
       )
     ORDER BY stock.producto_id
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'Hay otra operación de stock en curso; esperá un instante y reintentá la corrección'
      USING ERRCODE = '55P03';
  END;

  SELECT COALESCE(
           NULLIF(btrim(nombre_completo), ''),
           NULLIF(btrim(username), ''),
           'Administrador'
         )
    INTO v_usuario_nombre
    FROM public.profiles
   WHERE id = v_uid;
  v_usuario_nombre := COALESCE(v_usuario_nombre, 'Administrador');

  INSERT INTO public.ingreso_mercaderia_correcciones (
    ingreso_id, usuario_id, usuario_nombre, motivo, idempotency_key, request_payload
  ) VALUES (
    p_ingreso_id, v_uid, v_usuario_nombre, v_motivo, p_idempotency_key, v_request_payload
  )
  RETURNING id INTO v_correccion_id;

  FOR r IN
    SELECT
      item_ingreso.id AS ingreso_item_id,
      item_ingreso.producto_id,
      item_ingreso.codigo,
      COALESCE(NULLIF(item_ingreso.descripcion, ''), producto.nombre) AS descripcion,
      item_ingreso.cantidad::numeric(14,2) AS cantidad_anterior,
      (solicitado ->> 'cantidad_nueva')::numeric(14,2) AS cantidad_nueva
    FROM public.ingreso_mercaderia_items item_ingreso
    JOIN jsonb_array_elements(v_items_normalized) solicitado
      ON item_ingreso.id = (solicitado ->> 'item_id')::uuid
    JOIN public.productos producto ON producto.id = item_ingreso.producto_id
    -- Para dos líneas del mismo producto se aplican primero las subas. Así
    -- una redistribución con saldo neto válido no falla por el orden de UUID.
    ORDER BY
      item_ingreso.producto_id,
      (
        (solicitado ->> 'cantidad_nueva')::numeric
        - item_ingreso.cantidad::numeric
      ) DESC,
      item_ingreso.id
    FOR UPDATE OF item_ingreso
  LOOP
    v_cantidad_anterior := r.cantidad_anterior;
    v_cantidad_nueva := r.cantidad_nueva;
    v_diferencia := v_cantidad_nueva - v_cantidad_anterior;

    IF v_diferencia < 0 THEN
      UPDATE public.stock_sucursal
         SET cantidad = cantidad + v_diferencia
       WHERE producto_id = r.producto_id
         AND sucursal_id = v_ingreso.sucursal_id
         AND cantidad >= -v_diferencia
      RETURNING cantidad - v_diferencia, cantidad
        INTO v_stock_anterior, v_stock_nuevo;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'No alcanza el stock actual para reducir % de % a %',
          COALESCE(r.codigo, r.descripcion), v_cantidad_anterior, v_cantidad_nueva;
      END IF;
    ELSE
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES (r.producto_id, v_ingreso.sucursal_id, 0)
      ON CONFLICT (producto_id, sucursal_id) DO NOTHING;

      UPDATE public.stock_sucursal
         SET cantidad = cantidad + v_diferencia
       WHERE producto_id = r.producto_id
         AND sucursal_id = v_ingreso.sucursal_id
      RETURNING cantidad - v_diferencia, cantidad
        INTO v_stock_anterior, v_stock_nuevo;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      r.producto_id,
      v_ingreso.sucursal_id,
      'CORRECCION_INGRESO_MERCADERIA',
      v_diferencia,
      v_stock_anterior,
      v_stock_nuevo,
      'Corrección de ingreso: ' || v_motivo,
      v_correccion_id,
      v_uid
    )
    RETURNING id INTO v_movimiento_id;

    INSERT INTO public.ingreso_mercaderia_correccion_items (
      correccion_id, ingreso_item_id, producto_id, codigo, descripcion,
      cantidad_anterior, cantidad_nueva, diferencia, stock_movimiento_id
    ) VALUES (
      v_correccion_id, r.ingreso_item_id, r.producto_id, r.codigo, r.descripcion,
      v_cantidad_anterior, v_cantidad_nueva, v_diferencia, v_movimiento_id
    );

    UPDATE public.ingreso_mercaderia_items
       SET cantidad = v_cantidad_nueva
     WHERE id = r.ingreso_item_id;
  END LOOP;

  RETURN v_correccion_id;
END;
$$;

REVOKE ALL ON FUNCTION public.corregir_ingreso_mercaderia(uuid, jsonb, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.corregir_ingreso_mercaderia(uuid, jsonb, text, uuid)
  TO authenticated, service_role;

-- La anulación conserva su contrato, pero bloquea el conjunto multiproducto y
-- omite las líneas que una corrección dejó explícitamente en cero.
CREATE OR REPLACE FUNCTION public.anular_ingreso_mercaderia(
  p_ingreso_id uuid,
  p_motivo     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_ingreso     public.ingresos_mercaderia%ROWTYPE;
  v_permite_neg boolean;
  r             record;
  v_stock_ant   numeric(14,2);
  v_stock_nue   numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede anular un ingreso de mercadería';
  END IF;

  SELECT * INTO v_ingreso
    FROM public.ingresos_mercaderia
   WHERE id = p_ingreso_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingreso no encontrado'; END IF;
  IF v_ingreso.estado = 'ANULADO' THEN RAISE EXCEPTION 'El ingreso ya fue anulado'; END IF;
  IF v_ingreso.estado <> 'CONFIRMADO' THEN
    RAISE EXCEPTION 'Sólo se anula un ingreso confirmado (este está en %)', lower(v_ingreso.estado);
  END IF;

  SELECT COALESCE(permitir_stock_negativo, false)
    INTO v_permite_neg
    FROM public.settings
   WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);

  PERFORM 1
    FROM public.productos producto
   WHERE producto.id IN (
     SELECT DISTINCT item_ingreso.producto_id
       FROM public.ingreso_mercaderia_items item_ingreso
      WHERE item_ingreso.ingreso_id = p_ingreso_id
        AND item_ingreso.origen_match <> 'IGNORADA'
        AND item_ingreso.producto_id IS NOT NULL
        AND item_ingreso.cantidad > 0
   )
   ORDER BY producto.id
   FOR KEY SHARE;

  BEGIN
    PERFORM 1
      FROM public.stock_sucursal stock
     WHERE stock.sucursal_id = v_ingreso.sucursal_id
       AND stock.producto_id IN (
         SELECT DISTINCT item_ingreso.producto_id
           FROM public.ingreso_mercaderia_items item_ingreso
          WHERE item_ingreso.ingreso_id = p_ingreso_id
            AND item_ingreso.origen_match <> 'IGNORADA'
            AND item_ingreso.producto_id IS NOT NULL
            AND item_ingreso.cantidad > 0
       )
     ORDER BY stock.producto_id
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'Hay otra operación de stock en curso; esperá un instante y reintentá la anulación'
      USING ERRCODE = '55P03';
  END;

  FOR r IN
    SELECT id, producto_id, cantidad, codigo
      FROM public.ingreso_mercaderia_items
     WHERE ingreso_id = p_ingreso_id
       AND origen_match <> 'IGNORADA'
       AND producto_id IS NOT NULL
       AND cantidad > 0
     ORDER BY producto_id, id
  LOOP
    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES (r.producto_id, v_ingreso.sucursal_id, 0)
      ON CONFLICT (producto_id, sucursal_id) DO NOTHING;

      UPDATE public.stock_sucursal
         SET cantidad = cantidad - r.cantidad
       WHERE producto_id = r.producto_id
         AND sucursal_id = v_ingreso.sucursal_id
      RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
    ELSE
      UPDATE public.stock_sucursal
         SET cantidad = cantidad - r.cantidad
       WHERE producto_id = r.producto_id
         AND sucursal_id = v_ingreso.sucursal_id
         AND cantidad >= r.cantidad
      RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'No se puede anular: ya se movió parte de % (no alcanza el stock para revertir)',
          r.codigo;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      r.producto_id,
      v_ingreso.sucursal_id,
      'ANULACION_INGRESO_MERCADERIA',
      -r.cantidad,
      v_stock_ant,
      v_stock_nue,
      'Anulación ingreso ' || COALESCE(v_ingreso.numero_remito_proveedor, ''),
      p_ingreso_id,
      v_uid
    );
  END LOOP;

  UPDATE public.ingresos_mercaderia
     SET estado = 'ANULADO', motivo_anulacion = p_motivo
   WHERE id = p_ingreso_id;
END;
$$;

-- La vista de seguimiento resuelve las correcciones a través de su cabecera,
-- porque referencia_id apunta a la corrección y no directamente al ingreso.
DROP VIEW IF EXISTS public.seguimiento_producto;
CREATE VIEW public.seguimiento_producto WITH (security_invoker = true) AS
SELECT
  movimiento.id,
  movimiento.producto_id,
  movimiento.sucursal_id,
  movimiento.created_at,
  movimiento.tipo,
  movimiento.cantidad,
  movimiento.cantidad_anterior,
  movimiento.cantidad_nueva,
  movimiento.motivo,
  movimiento.usuario_id,
  CASE movimiento.tipo::text
    WHEN 'VENTA'                         THEN cliente.razon_social
    WHEN 'ANULACION_VENTA'               THEN cliente.razon_social
    WHEN 'DEVOLUCION'                    THEN cliente.razon_social
    WHEN 'COMPRA'                        THEN proveedor_compra.razon_social
    WHEN 'ANULACION_COMPRA'              THEN proveedor_compra.razon_social
    WHEN 'INGRESO_MERCADERIA'            THEN proveedor_ingreso.razon_social
    WHEN 'ANULACION_INGRESO_MERCADERIA'  THEN proveedor_ingreso.razon_social
    WHEN 'CORRECCION_INGRESO_MERCADERIA' THEN proveedor_ingreso.razon_social
    WHEN 'TRANSFERENCIA_OUT'             THEN 'Transferencia a otra sucursal'
    WHEN 'TRANSFERENCIA_IN'              THEN 'Transferencia desde otra sucursal'
    ELSE NULL
  END AS con_quien,
  CASE movimiento.tipo::text
    WHEN 'VENTA'                         THEN venta.numero_comprobante
    WHEN 'ANULACION_VENTA'               THEN venta.numero_comprobante
    WHEN 'DEVOLUCION'                    THEN venta.numero_comprobante
    WHEN 'COMPRA'                        THEN compra.numero_comprobante
    WHEN 'ANULACION_COMPRA'              THEN compra.numero_comprobante
    WHEN 'INGRESO_MERCADERIA'            THEN ingreso.numero_remito_proveedor
    WHEN 'ANULACION_INGRESO_MERCADERIA'  THEN ingreso.numero_remito_proveedor
    WHEN 'CORRECCION_INGRESO_MERCADERIA' THEN ingreso.numero_remito_proveedor
    WHEN 'TRANSFERENCIA_OUT'             THEN remito.numero
    WHEN 'TRANSFERENCIA_IN'              THEN remito.numero
    ELSE NULL
  END AS comprobante,
  CASE
    WHEN movimiento.tipo::text IN ('VENTA', 'ANULACION_VENTA', 'DEVOLUCION')
      THEN venta.condicion_venta::text
    ELSE NULL
  END AS condicion_venta
FROM public.stock_movimientos movimiento
LEFT JOIN public.ventas venta ON venta.id = movimiento.referencia_id
LEFT JOIN public.clientes cliente ON cliente.id = venta.cliente_id
LEFT JOIN public.compras compra ON compra.id = movimiento.referencia_id
LEFT JOIN public.proveedores proveedor_compra
  ON proveedor_compra.id = compra.proveedor_id
LEFT JOIN public.ingreso_mercaderia_correcciones correccion
  ON correccion.id = movimiento.referencia_id
 AND movimiento.tipo::text = 'CORRECCION_INGRESO_MERCADERIA'
LEFT JOIN public.ingresos_mercaderia ingreso
  ON ingreso.id = CASE
    WHEN movimiento.tipo::text = 'CORRECCION_INGRESO_MERCADERIA'
      THEN correccion.ingreso_id
    ELSE movimiento.referencia_id
  END
LEFT JOIN public.proveedores proveedor_ingreso
  ON proveedor_ingreso.id = ingreso.proveedor_id
LEFT JOIN public.remitos remito ON remito.id = movimiento.referencia_id;

GRANT SELECT ON public.seguimiento_producto TO authenticated;
COMMENT ON VIEW public.seguimiento_producto IS
  'Historia de producto con referencia a ventas, compras, remitos, ingresos y correcciones de ingresos; usa security_invoker para respetar RLS.';
