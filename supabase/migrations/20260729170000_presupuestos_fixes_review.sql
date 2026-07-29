-- ============================================================
-- Correcciones del review del spec/código de presupuestos.
-- ============================================================

-- ------------------------------------------------------------
-- 1. El descuento fuera de rango se RECHAZA, no se clampa
--
-- `LEAST(GREATEST(x,0),100)` tapaba un payload inválido en silencio. Un
-- descuento de 150 es un error de quien llama, no un 100 disfrazado.
-- ------------------------------------------------------------
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
    IF v_cant <= 0 THEN
      RAISE EXCEPTION 'Cantidad inválida en el producto %', v_prod.codigo;
    END IF;

    v_desc := COALESCE((it->>'descuento_porcentaje')::numeric, 0);
    IF v_desc < 0 OR v_desc > 100 THEN
      RAISE EXCEPTION 'Descuento inválido (%) en el producto %', v_desc, v_prod.codigo;
    END IF;

    -- El precio sale del catálogo, NO del payload.
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

-- ------------------------------------------------------------
-- 2. El IVA también tiene que estar congelado
--
-- El presupuesto guarda el IVA de cada producto, pero `crear_venta` recalcula el
-- IVA con la alícuota ACTUAL del producto (no acepta un IVA por ítem). Si a un
-- producto le cambiaron la alícuota entre el presupuesto y la conversión, el
-- total de la venta NO es el del presupuesto — y la pantalla manda un pago por
-- el total presupuestado, así que la venta puede quedar PARCIAL o con vuelto sin
-- que nadie se entere.
--
-- Un cambio de alícuota es raro y significa que la cotización quedó vieja de
-- verdad: se rechaza la conversión con un mensaje que dice qué pasó, en vez de
-- producir una venta con un total que no es el que se prometió.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convertir_presupuesto_en_venta(
  p_presupuesto_id   uuid,
  p_cliente_id       uuid,
  p_tipo_comprobante public.tipo_comprobante,
  p_condicion_venta  public.condicion_venta,
  p_pagos            jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key  uuid  DEFAULT NULL
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

  -- El IVA no se puede congelar (crear_venta usa el del producto), así que si
  -- cambió, la conversión no puede prometer el total presupuestado.
  SELECT string_agg(i.codigo, ', ') INTO v_cambio
    FROM public.presupuesto_items i
    JOIN public.productos pr ON pr.id = i.producto_id
   WHERE i.presupuesto_id = p_presupuesto_id
     AND pr.iva_porcentaje IS DISTINCT FROM i.iva_porcentaje;
  IF v_cambio IS NOT NULL THEN
    RAISE EXCEPTION 'Cambió el IVA de: %. El total del presupuesto ya no es el que se cobraría: hacé un presupuesto nuevo.', v_cambio;
  END IF;

  -- Los ítems, CON LOS PRECIOS DEL PRESUPUESTO. Ordenados por producto_id: dos
  -- conversiones concurrentes que comparten productos piden los locks en el mismo
  -- orden, así que entre ellas no puede haber ciclo.
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
    'Presupuesto ' || v_p.numero, NULL, NULL, NULL, p_idempotency_key);

  UPDATE public.presupuestos
     SET estado = 'CONVERTIDO', venta_id = v_res.venta_id, cliente_id = p_cliente_id
   WHERE id = p_presupuesto_id;

  RETURN QUERY SELECT v_res.venta_id, v_res.numero, v_res.es_cta_cte;
END; $$;

REVOKE ALL ON FUNCTION public.convertir_presupuesto_en_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.convertir_presupuesto_en_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, uuid) TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.anular_presupuesto(uuid) TO service_role;
