-- ============================================================
-- Correcciones del code review de Codex sobre presupuestos.
-- ============================================================

-- ------------------------------------------------------------
-- 1. producto_tiene_presupuesto: adentro nomás
--
-- La usa sólo `eliminar_productos`, que es SECURITY DEFINER y corre como dueña,
-- así que no necesita el GRANT. Suelta era un oráculo: cualquier autenticado
-- podía preguntar si un producto figura en presupuestos que su RLS no lo deja
-- leer. En Postgres las funciones nacen ejecutables por PUBLIC, así que hay que
-- revocar explícitamente.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.producto_tiene_presupuesto(uuid) FROM PUBLIC, authenticated;

-- La FK no crea índice: el EXISTS por producto del borrado masivo hacía un seq
-- scan de presupuesto_items por cada producto.
CREATE INDEX IF NOT EXISTS idx_presupuesto_items_producto
  ON public.presupuesto_items (producto_id);

-- ------------------------------------------------------------
-- 2. convertir_presupuesto_en_venta: tres agujeros más
--
--  a) LA CLAVE DERIVADA CHOCABA CON LAS VENTAS NORMALES. Usar `p_presupuesto_id`
--     tal cual como idempotency_key lo mete en el mismo espacio que las claves
--     que manda la pantalla de ventas: si ya existía una venta con esa clave,
--     `crear_venta` la devolvía y el presupuesto quedaba CONVERTIDO apuntando a
--     una venta ajena, sin items propios, sin stock ni cobro. Ahora la clave se
--     deriva con un hash de un texto con prefijo (no es un uuid que ande dando
--     vueltas) y, además, si esa venta YA existe con el presupuesto todavía
--     abierto, se corta: eso no puede pasar por un reintento nuestro.
--
--  b) REINTENTAR UNA CONVERSIÓN QUE SÍ FUNCIONÓ DABA ERROR. Si se perdió la
--     respuesta, el segundo intento moría en 'ya está convertido' aunque la
--     venta existiera. Ahora devuelve esa misma venta — que es lo que promete
--     una operación idempotente. Sólo si le mandan OTRO cliente avisa, porque
--     ahí el pedido y lo que pasó no son lo mismo.
--
--  c) UNA CONVERSIÓN CONTADO SIN PAGOS SACABA LA MERCADERÍA GRATIS. La venta
--     quedaba CONTADO / PENDIENTE / total_pagado=0: no entra a la caja y
--     tampoco genera deuda en la cuenta corriente, así que la plata no aparece
--     en ningún lado. La pantalla siempre manda el total, la RPC ahora lo exige.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convertir_presupuesto_en_venta(
  p_presupuesto_id   uuid,
  p_cliente_id       uuid,
  p_tipo_comprobante public.tipo_comprobante,
  p_condicion_venta  public.condicion_venta,
  p_pagos            jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key  uuid  DEFAULT NULL   -- se ignora a propósito, ver (a)
)
RETURNS TABLE (venta_id uuid, numero text, es_cta_cte boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_p      public.presupuestos%ROWTYPE;
  v_items  jsonb;
  v_res    record;
  v_cambio text;
  v_clave  uuid;
  v_pagado numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  SELECT * INTO v_p FROM public.presupuestos WHERE id = p_presupuesto_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Presupuesto no encontrado'; END IF;
  IF NOT public.is_admin(v_uid) AND v_p.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés convertir un presupuesto de otra sucursal';
  END IF;

  -- (b) Reintento de algo que ya salió bien: devolvemos la misma venta.
  IF v_p.estado = 'CONVERTIDO' AND v_p.venta_id IS NOT NULL THEN
    IF v_p.cliente_id IS DISTINCT FROM p_cliente_id THEN
      RAISE EXCEPTION 'Este presupuesto ya se convirtió en una venta a nombre de otro cliente';
    END IF;
    RETURN QUERY
      SELECT v.id, v.numero_comprobante, (v.condicion_venta = 'CTA_CTE')
        FROM public.ventas v WHERE v.id = v_p.venta_id;
    RETURN;
  END IF;

  IF v_p.estado <> 'ABIERTO' THEN
    RAISE EXCEPTION 'Este presupuesto ya está %', lower(v_p.estado);
  END IF;

  -- Un presupuesto se convierte en factura. Los internos (REMITO,
  -- FAC_INTERNA_*) tienen su propio flujo y acá dejaban agujeros de plata.
  IF p_tipo_comprobante NOT IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C') THEN
    RAISE EXCEPTION 'Un presupuesto se convierte en factura. Para un % usá el flujo normal de Ventas.',
      p_tipo_comprobante;
  END IF;

  IF p_cliente_id IS NULL THEN
    RAISE EXCEPTION 'Para convertir un presupuesto hay que elegir el cliente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clientes WHERE id = p_cliente_id AND activo) THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  -- (c) Contado quiere decir cobrado.
  IF p_condicion_venta <> 'CTA_CTE' THEN
    SELECT COALESCE(SUM((x->>'monto')::numeric), 0) INTO v_pagado
      FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb)) x;
    IF v_pagado < v_p.total - 0.01 THEN
      RAISE EXCEPTION 'Una venta al contado se cobra entera: faltan $%. Si se lleva fiado, poné cuenta corriente.',
        to_char(v_p.total - v_pagado, 'FM999999990.00');
    END IF;
  END IF;

  -- Los productos, lockeados por id ANTES de mirarles el IVA: si no, entre el
  -- chequeo y el lock de crear_venta se cuela un cambio de alícuota.
  PERFORM 1 FROM public.productos p
    WHERE p.id IN (SELECT i.producto_id FROM public.presupuesto_items i
                    WHERE i.presupuesto_id = p_presupuesto_id)
    ORDER BY p.id FOR UPDATE;

  SELECT string_agg(i.codigo, ', ') INTO v_cambio
    FROM public.presupuesto_items i
    JOIN public.productos pr ON pr.id = i.producto_id
   WHERE i.presupuesto_id = p_presupuesto_id
     AND pr.iva_porcentaje IS DISTINCT FROM i.iva_porcentaje;
  IF v_cambio IS NOT NULL THEN
    RAISE EXCEPTION 'Cambió el IVA de: %. El total del presupuesto ya no es el que se cobraría: hacé un presupuesto nuevo.', v_cambio;
  END IF;

  -- Los ítems, CON LOS PRECIOS DEL PRESUPUESTO, ordenados por producto_id.
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

  -- (a) Clave propia del presupuesto, fuera del espacio de las claves que manda
  -- la pantalla de ventas.
  v_clave := md5('presupuesto:' || p_presupuesto_id::text)::uuid;
  IF EXISTS (SELECT 1 FROM public.ventas WHERE idempotency_key = v_clave) THEN
    -- El presupuesto sigue ABIERTO, así que esa venta no la hicimos nosotros:
    -- un reintento nuestro habría entrado por (b).
    RAISE EXCEPTION 'Ya hay una venta cargada con la clave de este presupuesto. Revisala antes de convertirlo.';
  END IF;

  SELECT * INTO v_res FROM public.crear_venta(
    v_p.sucursal_id, p_cliente_id, p_tipo_comprobante, p_condicion_venta,
    v_items, COALESCE(p_pagos, '[]'::jsonb), 0,
    'Presupuesto ' || v_p.numero, NULL, NULL, NULL, v_clave);

  UPDATE public.presupuestos
     SET estado = 'CONVERTIDO', venta_id = v_res.venta_id, cliente_id = p_cliente_id
   WHERE id = p_presupuesto_id;

  RETURN QUERY SELECT v_res.venta_id, v_res.numero, v_res.es_cta_cte;
END; $$;

REVOKE ALL ON FUNCTION public.convertir_presupuesto_en_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.convertir_presupuesto_en_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, uuid) TO authenticated, service_role;
