-- ============================================================
-- Correcciones del review adversarial de presupuestos.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Dos presupuestos no pueden colgar de la misma venta
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_presupuestos_venta
  ON public.presupuestos (venta_id) WHERE venta_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Un producto presupuestado cuenta como historial
--
-- `eliminar_productos` decide borrar de verdad cuando el producto no tiene
-- historial, pero no miraba `presupuesto_items`, que tiene FK sin ON DELETE.
-- Resultado: el DELETE explota con el error crudo de Postgres y, como el RPC es
-- un solo loop transaccional, un borrado masivo de 50 productos no borra
-- NINGUNO. Con esta vista el producto se ARCHIVA, que es lo que corresponde:
-- un presupuesto viejo tiene que poder reimprimirse.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.producto_tiene_presupuesto(_producto_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.presupuesto_items WHERE producto_id = _producto_id);
$$;
GRANT EXECUTE ON FUNCTION public.producto_tiene_presupuesto(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. convertir_presupuesto_en_venta: los tres agujeros
--
--  a) La CLAVE DE IDEMPOTENCIA la elegía quien llama. `crear_venta` cortocircuita
--     si ya existe una venta con esa clave y devuelve LA VENTA VIEJA; la
--     conversión no distinguía "venta nueva" de "venta preexistente", así que
--     mandando la misma clave en dos presupuestos distintos el segundo quedaba
--     CONVERTIDO apuntando a la venta del primero: la mercadería nunca salía del
--     stock y nadie la cobraba. Ahora la clave la deriva la RPC del propio
--     presupuesto: reintentar la MISMA conversión sigue siendo idempotente, y
--     dos presupuestos no pueden compartirla.
--
--  b) El tipo de comprobante se limitaba sólo en el <Select> de la pantalla.
--     `crear_venta` FUERZA la condición de un remito (siempre cuenta corriente,
--     ignora los pagos) y de una factura interna (siempre contado). Por RPC
--     directa se llegaba a cobrar en efectivo sin que entrara a la caja, o a
--     sacar mercadería sin deuda ni plata en ningún lado. El guard va acá.
--
--  c) El guard del IVA leía sin lock: un cambio de alícuota que commiteara entre
--     el guard y `crear_venta` producía exactamente la venta con total distinto
--     que el guard quería evitar. Se bloquean los productos en el mismo orden en
--     que después los bloquea `crear_venta`.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convertir_presupuesto_en_venta(
  p_presupuesto_id   uuid,
  p_cliente_id       uuid,
  p_tipo_comprobante public.tipo_comprobante,
  p_condicion_venta  public.condicion_venta,
  p_pagos            jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key  uuid  DEFAULT NULL   -- se ignora, ver (a)
)
RETURNS TABLE (venta_id uuid, numero text, es_cta_cte boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_p      public.presupuestos%ROWTYPE;
  v_items  jsonb;
  v_res    record;
  v_cambio text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  -- (b) Sólo facturas. Los demás comprobantes tienen la condición forzada en
  -- crear_venta y desde acá se elegiría una que el servidor pisa.
  IF p_tipo_comprobante NOT IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C') THEN
    RAISE EXCEPTION 'Un presupuesto se convierte en factura. Para un % usá el flujo normal de Ventas.',
      p_tipo_comprobante;
  END IF;

  SELECT * INTO v_p FROM public.presupuestos WHERE id = p_presupuesto_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Presupuesto no encontrado'; END IF;
  IF NOT public.is_admin(v_uid) AND v_p.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés convertir un presupuesto de otra sucursal';
  END IF;
  IF v_p.estado <> 'ABIERTO' THEN
    RAISE EXCEPTION 'Este presupuesto ya está %', lower(v_p.estado);
  END IF;

  IF p_cliente_id IS NULL THEN
    RAISE EXCEPTION 'Para convertir un presupuesto hay que elegir el cliente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clientes WHERE id = p_cliente_id AND activo) THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  -- (c) Los productos se bloquean ACÁ, en el mismo orden en que los va a
  -- bloquear crear_venta, para que el guard del IVA no tenga ventana.
  PERFORM 1 FROM public.productos p
    WHERE p.id IN (SELECT producto_id FROM public.presupuesto_items
                    WHERE presupuesto_id = p_presupuesto_id)
    ORDER BY p.id
    FOR UPDATE;

  SELECT string_agg(i.codigo, ', ') INTO v_cambio
    FROM public.presupuesto_items i
    JOIN public.productos pr ON pr.id = i.producto_id
   WHERE i.presupuesto_id = p_presupuesto_id
     AND pr.iva_porcentaje IS DISTINCT FROM i.iva_porcentaje;
  IF v_cambio IS NOT NULL THEN
    RAISE EXCEPTION 'Cambió el IVA de: %. El total del presupuesto ya no es el que se cobraría: hacé un presupuesto nuevo.', v_cambio;
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'producto_id'), '[]'::jsonb) INTO v_items
    FROM (
      SELECT jsonb_build_object(
               'producto_id', i.producto_id,
               'cantidad', i.cantidad,
               -- El precio YA tiene el descuento aplicado, por eso el descuento
               -- no se manda de nuevo: se aplicaría dos veces.
               'precio_unitario_sin_iva', i.precio_sin_iva
             ) AS x
        FROM public.presupuesto_items i
       WHERE i.presupuesto_id = p_presupuesto_id
    ) t;

  IF jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'El presupuesto no tiene productos';
  END IF;

  SELECT * INTO v_res FROM public.crear_venta(
    v_p.sucursal_id, p_cliente_id, p_tipo_comprobante, p_condicion_venta,
    v_items, COALESCE(p_pagos, '[]'::jsonb), 0,
    'Presupuesto ' || v_p.numero, NULL, NULL, NULL,
    -- (a) La clave sale del presupuesto, no de quien llama.
    p_presupuesto_id);

  UPDATE public.presupuestos
     SET estado = 'CONVERTIDO', venta_id = v_res.venta_id, cliente_id = p_cliente_id
   WHERE id = p_presupuesto_id;

  RETURN QUERY SELECT v_res.venta_id, v_res.numero, v_res.es_cta_cte;
END; $$;

REVOKE ALL ON FUNCTION public.convertir_presupuesto_en_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.convertir_presupuesto_en_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. NaN no es una cantidad
--
-- `v_cant <= 0` es FALSO para NaN, y el `CHECK (cantidad > 0)` tampoco lo agarra
-- porque en Postgres `NaN > 0` es true. Un presupuesto con cantidad NaN llegaba
-- a dejar `total = NaN`, y con stock negativo permitido, `stock_sucursal` en NaN.
-- Un NaN en el stock es corrupción que no se arregla sola.
-- ------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE public.presupuesto_items
    ADD CONSTRAINT presupuesto_items_cantidad_real
    CHECK (cantidad > 0 AND cantidad < 'NaN'::numeric);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.crear_presupuesto(
  p_sucursal_id    uuid,
  p_items          jsonb,
  p_cliente_id     uuid DEFAULT NULL,
  p_nombre_cliente text DEFAULT NULL,
  p_validez_hasta  date DEFAULT NULL,
  p_observaciones  text DEFAULT NULL
)
RETURNS TABLE (presupuesto_id uuid, numero text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_id     uuid;
  v_numero text;
  v_sub    numeric(14,2) := 0;
  v_iva    numeric(14,2) := 0;
  it       jsonb;
  v_prod   public.productos%ROWTYPE;
  v_cant   numeric(14,2);
  v_desc   numeric(5,2);
  v_precio numeric(14,2);
  v_si     numeric(14,2);
  v_ii     numeric(14,2);
  v_calc   jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés hacer un presupuesto en una sucursal que no es la tuya';
  END IF;
  IF COALESCE(jsonb_array_length(p_items), 0) = 0 THEN
    RAISE EXCEPTION 'El presupuesto necesita al menos un producto';
  END IF;
  IF p_cliente_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.clientes WHERE id = p_cliente_id AND activo) THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_prod FROM public.productos
      WHERE id = (it->>'producto_id')::uuid AND activo AND NOT archivado;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto % inexistente, inactivo o archivado', it->>'producto_id';
    END IF;

    v_cant := COALESCE((it->>'cantidad')::numeric, 0);
    -- NaN se chequea explícito: `NaN <= 0` es false y `NaN > 0` es true, así que
    -- ninguna comparación normal lo atrapa.
    IF v_cant IS NULL OR v_cant = 'NaN'::numeric OR v_cant <= 0 THEN
      RAISE EXCEPTION 'Cantidad inválida en el producto %', v_prod.codigo;
    END IF;

    v_desc := COALESCE((it->>'descuento_porcentaje')::numeric, 0);
    IF v_desc = 'NaN'::numeric OR v_desc < 0 OR v_desc > 100 THEN
      RAISE EXCEPTION 'Descuento inválido (%) en el producto %', v_desc, v_prod.codigo;
    END IF;

    v_precio := ROUND(v_prod.precio_sin_iva * (1 - v_desc / 100), 2);
    v_si := ROUND(v_precio * v_cant, 2);
    v_ii := ROUND(v_si * v_prod.iva_porcentaje / 100, 2);
    v_sub := v_sub + v_si;
    v_iva := v_iva + v_ii;

    v_calc := v_calc || jsonb_build_object(
      'producto_id', v_prod.id, 'codigo', v_prod.codigo, 'descripcion', v_prod.nombre,
      'cantidad', v_cant, 'lista', v_prod.precio_sin_iva, 'descuento', v_desc,
      'precio', v_precio, 'iva_pct', v_prod.iva_porcentaje, 'si', v_si, 'ii', v_ii);
  END LOOP;

  v_numero := public.next_documento_numero(p_sucursal_id, 'PRESUPUESTO', 'PRES');

  INSERT INTO public.presupuestos (
    sucursal_id, usuario_id, numero, validez_hasta, cliente_id, nombre_cliente,
    subtotal_sin_iva, iva_total, total, observaciones
  ) VALUES (
    p_sucursal_id, v_uid, v_numero, p_validez_hasta, p_cliente_id, p_nombre_cliente,
    v_sub, v_iva, ROUND(v_sub + v_iva, 2), p_observaciones
  ) RETURNING id INTO v_id;

  FOR it IN SELECT * FROM jsonb_array_elements(v_calc)
  LOOP
    INSERT INTO public.presupuesto_items (
      presupuesto_id, producto_id, codigo, descripcion, cantidad,
      precio_lista_sin_iva, descuento_porcentaje, precio_sin_iva,
      iva_porcentaje, subtotal_sin_iva, iva_monto, subtotal_con_iva
    ) VALUES (
      v_id, (it->>'producto_id')::uuid, it->>'codigo', it->>'descripcion',
      (it->>'cantidad')::numeric, (it->>'lista')::numeric, (it->>'descuento')::numeric,
      (it->>'precio')::numeric, (it->>'iva_pct')::numeric,
      (it->>'si')::numeric, (it->>'ii')::numeric,
      ROUND((it->>'si')::numeric + (it->>'ii')::numeric, 2));
  END LOOP;

  RETURN QUERY SELECT v_id, v_numero;
END; $$;

REVOKE ALL ON FUNCTION public.crear_presupuesto(uuid, jsonb, uuid, text, date, text) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_presupuesto(uuid, jsonb, uuid, text, date, text) TO authenticated, service_role;
