-- ============================================================
-- Seguridad + integridad transaccional
--
-- Arregla cuatro defectos del sistema actual:
--   1. comprobante_secuencias tenía una policy FOR ALL USING(true): cualquier
--      usuario autenticado podía reescribir la numeración de comprobantes.
--   2. clientes tenía FOR ALL USING(true): un empleado podía habilitarse a sí
--      mismo cuenta corriente / límite de crédito, o borrar clientes.
--   3. crearVenta insertaba venta -> items -> pagos -> stock en 4 llamadas
--      sueltas (sin transacción) y descontaba stock con un read-then-write en
--      JS, lo que permite lost-update entre dos cajas vendiendo a la vez.
--   4. El precio unitario venía del cliente y el servidor lo aceptaba sin
--      validar contra el catálogo.
-- ============================================================


-- ------------------------------------------------------------
-- 1. NUMERACIÓN DE COMPROBANTES: sólo mutable vía función
-- ------------------------------------------------------------
-- next_comprobante_numero() ya es SECURITY DEFINER, así que sigue pudiendo
-- escribir aunque le saquemos el permiso directo al rol `authenticated`.
DROP POLICY IF EXISTS "cs write" ON public.comprobante_secuencias;
REVOKE INSERT, UPDATE, DELETE ON public.comprobante_secuencias FROM authenticated;
-- La lectura se mantiene (la UI muestra el próximo número), pero nadie puede
-- alterar el contador salvo a través de la función.


-- ------------------------------------------------------------
-- 2. CLIENTES: escritura acotada
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "auth manage clientes" ON public.clientes;

CREATE POLICY "clientes select" ON public.clientes
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "clientes insert" ON public.clientes
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "clientes update" ON public.clientes
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Borrar clientes: sólo admin (un cliente borrado arrastra su historial de venta).
CREATE POLICY "clientes delete admin" ON public.clientes
  FOR DELETE TO authenticated USING (public.is_admin(auth.uid()));
REVOKE DELETE ON public.clientes FROM authenticated;
GRANT DELETE ON public.clientes TO authenticated; -- la policy de arriba lo restringe a admin

-- Otorgar crédito es una decisión económica: un empleado no puede habilitar
-- cuenta corriente ni fijar el límite de crédito. RLS no filtra por columna,
-- así que lo hacemos con un trigger.
CREATE OR REPLACE FUNCTION public.guard_clientes_credito()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- auth.uid() es NULL cuando la operación viene del servidor con la service_role
  -- key (seeds, importaciones, funciones administrativas). Ese camino ya es
  -- privilegiado —saltea RLS entero— así que no lo bloqueamos: si no, el propio
  -- backend no puede dar de alta un cliente con cuenta corriente.
  -- Un usuario del rol `authenticated` SIEMPRE tiene auth.uid(), así que esto no
  -- le abre la puerta a nadie desde el navegador.
  IF auth.uid() IS NULL OR public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Un empleado sólo puede dar de alta clientes de contado.
    IF COALESCE(NEW.condicion_cta_cte, false) IS TRUE OR NEW.limite_credito IS NOT NULL THEN
      RAISE EXCEPTION 'Sólo un administrador puede habilitar cuenta corriente o fijar límite de crédito';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.condicion_cta_cte IS DISTINCT FROM OLD.condicion_cta_cte
       OR NEW.limite_credito IS DISTINCT FROM OLD.limite_credito
       OR NEW.es_generico IS DISTINCT FROM OLD.es_generico THEN
      RAISE EXCEPTION 'Sólo un administrador puede cambiar cuenta corriente, límite de crédito o el flag de cliente genérico';
    END IF;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_clientes_guard_credito ON public.clientes;
CREATE TRIGGER trg_clientes_guard_credito
  BEFORE INSERT OR UPDATE ON public.clientes
  FOR EACH ROW EXECUTE FUNCTION public.guard_clientes_credito();


-- ------------------------------------------------------------
-- 3. POLÍTICA DE STOCK NEGATIVO (configurable, como en lubricentro)
-- ------------------------------------------------------------
-- Por defecto NO se permite vender sin stock. Una pinturería a veces necesita
-- el escape (mercadería física que todavía no se cargó), así que queda como
-- una opción explícita y auditable en vez de un agujero silencioso.
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS permitir_stock_negativo boolean NOT NULL DEFAULT false;


-- ------------------------------------------------------------
-- 4. VENTA ATÓMICA
-- ------------------------------------------------------------
-- Toda la venta ocurre dentro de una única función => una única transacción.
-- Si algo falla (stock insuficiente, cliente inexistente), no queda NADA a
-- medio escribir.
--
-- Los precios se resuelven contra el catálogo. El cajero PUEDE pisar el precio
-- (es una necesidad real del mostrador), pero entonces se guardan las dos cosas:
-- el precio de lista vigente y el precio efectivamente cobrado, de modo que la
-- diferencia queda auditada en vez de ser invisible.

ALTER TABLE public.venta_items
  ADD COLUMN IF NOT EXISTS precio_lista_sin_iva NUMERIC(14,2);

COMMENT ON COLUMN public.venta_items.precio_lista_sin_iva IS
  'Precio de catálogo al momento de la venta. Si difiere de precio_unitario_sin_iva, hubo un override manual del cajero.';

CREATE OR REPLACE FUNCTION public.crear_venta(
  p_sucursal_id      uuid,
  p_cliente_id       uuid,
  p_tipo_comprobante public.tipo_comprobante,
  p_condicion_venta  public.condicion_venta,
  p_items            jsonb,   -- [{producto_id, cantidad, descuento_porcentaje, precio_unitario_sin_iva?}]
  p_pagos            jsonb,   -- [{forma_pago, monto, detalle}]
  p_percepciones     numeric DEFAULT 0,
  p_observaciones    text    DEFAULT NULL,
  p_nombre_obra      text    DEFAULT NULL,
  p_fecha            timestamptz DEFAULT NULL
)
RETURNS TABLE (venta_id uuid, numero text, es_cta_cte boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_is_admin       boolean;
  v_permite_neg    boolean;
  v_numero         text;
  v_venta_id       uuid;
  v_es_cta_cte     boolean;
  v_sub_sin_iva    numeric(14,2) := 0;
  v_iva_total      numeric(14,2) := 0;
  v_total          numeric(14,2);
  v_total_pagado   numeric(14,2) := 0;
  v_estado_pago    public.estado_pago;
  it               jsonb;
  pg               jsonb;
  v_prod           public.productos%ROWTYPE;
  v_cant           numeric(14,2);
  v_desc           numeric(5,2);
  v_precio         numeric(14,2);
  v_precio_lista   numeric(14,2);
  v_sub_item       numeric(14,2);
  v_iva_item       numeric(14,2);
  v_stock_ant      numeric(14,2);
  v_stock_nue      numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  v_is_admin := public.is_admin(v_uid);

  -- AUTORIZACIÓN: la función es SECURITY DEFINER, así que salteamos RLS y
  -- tenemos que reimplementar acá la regla que RLS daba gratis.
  IF NOT v_is_admin AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés facturar en una sucursal que no es la tuya';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.clientes WHERE id = p_cliente_id AND activo) THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg
    FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);

  -- Los remitos y la factura interna van SIEMPRE a cuenta corriente: sale
  -- mercadería pero no entra plata a la caja.
  v_es_cta_cte := p_tipo_comprobante IN ('REMITO', 'REMITO_OBRA', 'FAC_INTERNA_CTA_CTE')
                  OR p_condicion_venta = 'CTA_CTE';

  ------------------------------------------------------------------
  -- Totales, con precios resueltos contra el catálogo
  ------------------------------------------------------------------
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    SELECT * INTO v_prod FROM public.productos
      WHERE id = (it->>'producto_id')::uuid AND activo;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto % inexistente o inactivo', it->>'producto_id';
    END IF;

    v_cant := COALESCE((it->>'cantidad')::numeric, 0);
    v_desc := LEAST(GREATEST(COALESCE((it->>'descuento_porcentaje')::numeric, 0), 0), 100);
    IF v_cant < 0 THEN
      RAISE EXCEPTION 'Cantidad negativa en el producto %', v_prod.codigo;
    END IF;

    v_precio_lista := v_prod.precio_sin_iva;
    -- Override manual del cajero (permitido, pero nunca negativo y siempre auditado).
    v_precio := COALESCE((it->>'precio_unitario_sin_iva')::numeric, v_precio_lista);
    IF v_precio < 0 THEN
      RAISE EXCEPTION 'Precio negativo en el producto %', v_prod.codigo;
    END IF;

    v_sub_item := ROUND(v_precio * (1 - v_desc / 100) * v_cant, 2);
    v_iva_item := ROUND(v_sub_item * v_prod.iva_porcentaje / 100, 2);

    v_sub_sin_iva := v_sub_sin_iva + v_sub_item;
    v_iva_total   := v_iva_total   + v_iva_item;
  END LOOP;

  v_total := ROUND(v_sub_sin_iva + v_iva_total + COALESCE(p_percepciones, 0), 2);

  -- A cuenta corriente no se cobra al emitir: el pago se registra después.
  IF NOT v_es_cta_cte THEN
    SELECT COALESCE(SUM((p->>'monto')::numeric), 0) INTO v_total_pagado
      FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb)) p;
    v_total_pagado := ROUND(v_total_pagado, 2);
  END IF;

  v_estado_pago := CASE
    WHEN v_es_cta_cte THEN 'PENDIENTE'::public.estado_pago
    WHEN v_total_pagado >= v_total - 0.01 THEN 'PAGADO'::public.estado_pago
    WHEN v_total_pagado > 0 THEN 'PARCIAL'::public.estado_pago
    ELSE 'PENDIENTE'::public.estado_pago
  END;

  ------------------------------------------------------------------
  -- Cabecera
  ------------------------------------------------------------------
  v_numero := public.next_comprobante_numero(p_sucursal_id, p_tipo_comprobante);

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, fecha, numero_comprobante, tipo_comprobante,
    condicion_venta, subtotal_sin_iva, iva_total, percepciones, total, total_pagado,
    estado_pago, observaciones, nombre_obra
  ) VALUES (
    p_sucursal_id, p_cliente_id, v_uid, COALESCE(p_fecha, now()), v_numero, p_tipo_comprobante,
    CASE WHEN v_es_cta_cte THEN 'CTA_CTE'::public.condicion_venta ELSE p_condicion_venta END,
    v_sub_sin_iva, v_iva_total, COALESCE(p_percepciones, 0), v_total, v_total_pagado,
    v_estado_pago, p_observaciones, p_nombre_obra
  ) RETURNING id INTO v_venta_id;

  ------------------------------------------------------------------
  -- Items + stock (mismo bloque = misma transacción)
  ------------------------------------------------------------------
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    SELECT * INTO v_prod FROM public.productos WHERE id = (it->>'producto_id')::uuid;

    v_cant := COALESCE((it->>'cantidad')::numeric, 0);
    v_desc := LEAST(GREATEST(COALESCE((it->>'descuento_porcentaje')::numeric, 0), 0), 100);
    v_precio_lista := v_prod.precio_sin_iva;
    v_precio := COALESCE((it->>'precio_unitario_sin_iva')::numeric, v_precio_lista);
    v_sub_item := ROUND(v_precio * (1 - v_desc / 100) * v_cant, 2);
    v_iva_item := ROUND(v_sub_item * v_prod.iva_porcentaje / 100, 2);

    INSERT INTO public.venta_items (
      venta_id, producto_id, codigo, descripcion, cantidad,
      precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
      subtotal_sin_iva, iva_monto, subtotal_con_iva
    ) VALUES (
      v_venta_id, v_prod.id, v_prod.codigo, v_prod.nombre, v_cant,
      v_precio, v_precio_lista, v_prod.iva_porcentaje, v_desc,
      v_sub_item, v_iva_item, v_sub_item + v_iva_item
    );

    -- Las notas de crédito/débito no mueven mercadería.
    CONTINUE WHEN p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') OR v_cant = 0;

    -- Descuento ATÓMICO. El WHERE con la guarda de cantidad es lo que elimina
    -- el lost-update: si dos cajas venden la última lata a la vez, una de las
    -- dos no encuentra fila y falla, en vez de dejar el stock en -1.
    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES (v_prod.id, p_sucursal_id, -v_cant)
      ON CONFLICT (producto_id, sucursal_id)
      DO UPDATE SET cantidad = stock_sucursal.cantidad - v_cant
      RETURNING cantidad + v_cant, cantidad INTO v_stock_ant, v_stock_nue;
    ELSE
      UPDATE public.stock_sucursal
         SET cantidad = cantidad - v_cant
       WHERE producto_id = v_prod.id
         AND sucursal_id = p_sucursal_id
         AND cantidad >= v_cant
      RETURNING cantidad + v_cant, cantidad INTO v_stock_ant, v_stock_nue;

      IF NOT FOUND THEN
        SELECT COALESCE(cantidad, 0) INTO v_stock_ant
          FROM public.stock_sucursal
         WHERE producto_id = v_prod.id AND sucursal_id = p_sucursal_id;
        RAISE EXCEPTION 'Stock insuficiente de % (%): hay %, se piden %',
          v_prod.nombre, v_prod.codigo, COALESCE(v_stock_ant, 0), v_cant;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      v_prod.id, p_sucursal_id, 'VENTA', -v_cant, v_stock_ant, v_stock_nue,
      p_tipo_comprobante::text || ' ' || v_numero, v_venta_id, v_uid
    );
  END LOOP;

  ------------------------------------------------------------------
  -- Pagos
  ------------------------------------------------------------------
  IF NOT v_es_cta_cte THEN
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      CONTINUE WHEN COALESCE((pg->>'monto')::numeric, 0) <= 0;
      INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
      VALUES (
        v_venta_id,
        (pg->>'forma_pago')::public.forma_pago,
        (pg->>'monto')::numeric,
        COALESCE(pg->'detalle', '{}'::jsonb)
      );
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_venta_id, v_numero, v_es_cta_cte;
END; $$;

REVOKE ALL ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz) TO authenticated;


-- ------------------------------------------------------------
-- 5. ANULACIÓN ATÓMICA
-- ------------------------------------------------------------
-- Mismo problema que crearVenta: hoy son 4 llamadas sueltas. Si falla a mitad
-- de camino, la venta queda anulada pero el stock no vuelve (o al revés).
CREATE OR REPLACE FUNCTION public.anular_venta(p_venta_id uuid)
RETURNS TABLE (nc_id uuid, nc_numero text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_v         public.ventas%ROWTYPE;
  v_numero    text;
  v_nc_id     uuid;
  r           RECORD;
  v_stock_ant numeric(14,2);
  v_stock_nue numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_v FROM public.ventas WHERE id = p_venta_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  IF NOT public.is_admin(v_uid) AND v_v.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés anular una venta de otra sucursal';
  END IF;

  IF v_v.estado = 'ANULADA' THEN
    RAISE EXCEPTION 'La venta ya fue anulada';
  END IF;

  IF v_v.tipo_comprobante = 'NOTA_CREDITO' THEN
    RAISE EXCEPTION 'Una nota de crédito no se anula';
  END IF;

  v_numero := public.next_comprobante_numero(v_v.sucursal_id, 'NOTA_CREDITO');

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, numero_comprobante, tipo_comprobante,
    condicion_venta, subtotal_sin_iva, iva_total, percepciones, total, total_pagado,
    estado_pago, observaciones
  ) VALUES (
    v_v.sucursal_id, v_v.cliente_id, v_uid, v_numero, 'NOTA_CREDITO',
    v_v.condicion_venta, -v_v.subtotal_sin_iva, -v_v.iva_total, -v_v.percepciones,
    -v_v.total, 0, 'PENDIENTE',
    'Nota de crédito por anulación de ' || v_v.numero_comprobante
  ) RETURNING id INTO v_nc_id;

  UPDATE public.ventas
     SET estado = 'ANULADA', venta_anulada_por = v_nc_id
   WHERE id = v_v.id;

  -- Devolver el stock
  FOR r IN SELECT producto_id, cantidad FROM public.venta_items WHERE venta_id = v_v.id
  LOOP
    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
    VALUES (r.producto_id, v_v.sucursal_id, r.cantidad)
    ON CONFLICT (producto_id, sucursal_id)
    DO UPDATE SET cantidad = stock_sucursal.cantidad + r.cantidad
    RETURNING cantidad - r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      r.producto_id, v_v.sucursal_id, 'ANULACION_VENTA', r.cantidad, v_stock_ant, v_stock_nue,
      'Anulación ' || v_v.numero_comprobante, v_v.id, v_uid
    );
  END LOOP;

  RETURN QUERY SELECT v_nc_id, v_numero;
END; $$;

REVOKE ALL ON FUNCTION public.anular_venta(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid) TO authenticated;
