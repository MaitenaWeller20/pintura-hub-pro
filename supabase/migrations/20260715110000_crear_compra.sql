-- ============================================================
-- crear_compra — registra la compra de mercadería a un proveedor.
--
-- Transaccional (patrón crear_venta): inserta la compra + ítems, SUMA stock con
-- kardex, y según la condición registra la deuda (CTA_CTE) o los pagos (CONTADO).
-- Una compra CONTADO exige caja abierta (la salida de plata tiene que caer en un
-- arqueo). Los totales y el usuario se calculan en el server, nunca vienen del
-- cliente. El comprobante es EXTERNO del proveedor (no se numera acá).
-- ============================================================

CREATE OR REPLACE FUNCTION public.crear_compra(
  p_proveedor_id      uuid,
  p_sucursal_id       uuid,
  p_tipo_comprobante  text,
  p_numero            text,
  p_fecha_comprobante date,
  p_fecha_vencimiento date,
  p_items             jsonb,
  p_pagos             jsonb,
  p_percepciones      numeric DEFAULT 0,
  p_condicion         text    DEFAULT 'CONTADO',
  p_observaciones     text    DEFAULT NULL
)
RETURNS TABLE (compra_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_prov         public.proveedores%ROWTYPE;
  v_compra_id    uuid;
  v_sub_sin_iva  numeric(14,2) := 0;
  v_iva_total    numeric(14,2) := 0;
  v_percepciones numeric(14,2);
  v_total        numeric(14,2);
  v_sesion       uuid;
  it             jsonb;
  pg             jsonb;
  v_prod         public.productos%ROWTYPE;
  v_cant         numeric(14,2);
  v_costo        numeric(14,2);
  v_iva_pct      numeric(5,2);
  v_sub_item     numeric(14,2);
  v_iva_item     numeric(14,2);
  v_stock_ant    numeric(14,2);
  v_stock_nue    numeric(14,2);
  v_calc         jsonb := '[]'::jsonb;
  v_monto        numeric(14,2);
  v_forma        text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés registrar una compra en una sucursal que no es la tuya';
  END IF;
  IF p_condicion NOT IN ('CONTADO', 'CTA_CTE') THEN
    RAISE EXCEPTION 'Condición inválida: %', p_condicion;
  END IF;
  -- Esta RPC registra COMPRA de mercadería (suma stock, genera deuda/pago positivo).
  -- Una nota de crédito/débito del proveedor tiene el signo contrario y es otro
  -- flujo (fuera de alcance): se rechaza para no aumentar stock/deuda al revés.
  IF p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') THEN
    RAISE EXCEPTION 'Las notas de crédito/débito del proveedor no se cargan como compra';
  END IF;

  SELECT * INTO v_prov FROM public.proveedores WHERE id = p_proveedor_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proveedor inexistente o inactivo';
  END IF;
  IF p_condicion = 'CTA_CTE' AND NOT COALESCE(v_prov.condicion_cta_cte, false) THEN
    RAISE EXCEPTION 'El proveedor % no tiene cuenta corriente habilitada', v_prov.razon_social;
  END IF;
  IF COALESCE(p_percepciones, 0) < 0 THEN
    RAISE EXCEPTION 'Las percepciones no pueden ser negativas';
  END IF;

  -- Totales por ítem (bloquea el producto, valida existencia).
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    SELECT * INTO v_prod FROM public.productos WHERE id = (it->>'producto_id')::uuid AND activo FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto % inexistente o inactivo', it->>'producto_id';
    END IF;
    v_cant  := COALESCE((it->>'cantidad')::numeric, 0);
    v_costo := COALESCE((it->>'costo_unitario_sin_iva')::numeric, 0);
    v_iva_pct := COALESCE((it->>'iva_porcentaje')::numeric, v_prod.iva_porcentaje);
    IF v_cant <= 0 THEN RAISE EXCEPTION 'Cantidad inválida en el producto %', v_prod.codigo; END IF;
    IF v_costo < 0 THEN RAISE EXCEPTION 'Costo negativo en el producto %', v_prod.codigo; END IF;
    IF v_iva_pct < 0 OR v_iva_pct > 100 THEN
      RAISE EXCEPTION 'IVA inválido (%) en el producto %', v_iva_pct, v_prod.codigo;
    END IF;

    v_sub_item := ROUND(v_costo * v_cant, 2);
    v_iva_item := ROUND(v_sub_item * v_iva_pct / 100, 2);
    v_sub_sin_iva := v_sub_sin_iva + v_sub_item;
    v_iva_total   := v_iva_total   + v_iva_item;

    v_calc := v_calc || jsonb_build_object(
      'producto_id', v_prod.id, 'codigo', v_prod.codigo, 'descripcion', v_prod.nombre,
      'cantidad', v_cant, 'costo', v_costo, 'iva_porcentaje', v_iva_pct,
      'sub_item', v_sub_item, 'iva_item', v_iva_item
    );
  END LOOP;

  v_percepciones := ROUND(COALESCE(p_percepciones, 0), 2);
  v_total := ROUND(v_sub_sin_iva + v_iva_total + v_percepciones, 2);

  INSERT INTO public.compras (
    proveedor_id, sucursal_id, usuario_id, tipo_comprobante, numero_comprobante,
    fecha_comprobante, fecha_vencimiento, subtotal_sin_iva, iva_total, percepciones,
    total, condicion, estado, observaciones
  ) VALUES (
    p_proveedor_id, p_sucursal_id, v_uid, p_tipo_comprobante, p_numero,
    p_fecha_comprobante, p_fecha_vencimiento, v_sub_sin_iva, v_iva_total, v_percepciones,
    v_total, p_condicion, 'ACTIVA', p_observaciones
  ) RETURNING id INTO v_compra_id;

  -- Ítems + suma de stock atómica (crea la fila si el producto nunca tuvo stock ahí).
  FOR it IN SELECT * FROM jsonb_array_elements(v_calc)
  LOOP
    v_cant := (it->>'cantidad')::numeric;
    INSERT INTO public.compra_items (
      compra_id, producto_id, codigo, descripcion, cantidad,
      costo_unitario_sin_iva, iva_porcentaje, subtotal_sin_iva, iva_monto, subtotal_con_iva
    ) VALUES (
      v_compra_id, (it->>'producto_id')::uuid, it->>'codigo', it->>'descripcion', v_cant,
      (it->>'costo')::numeric, (it->>'iva_porcentaje')::numeric,
      (it->>'sub_item')::numeric, (it->>'iva_item')::numeric,
      (it->>'sub_item')::numeric + (it->>'iva_item')::numeric
    );

    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
    VALUES ((it->>'producto_id')::uuid, p_sucursal_id, v_cant)
    ON CONFLICT (producto_id, sucursal_id)
    DO UPDATE SET cantidad = stock_sucursal.cantidad + EXCLUDED.cantidad
    RETURNING cantidad - v_cant, cantidad INTO v_stock_ant, v_stock_nue;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      (it->>'producto_id')::uuid, p_sucursal_id, 'COMPRA', v_cant, v_stock_ant, v_stock_nue,
      'Compra ' || p_tipo_comprobante || ' ' || p_numero, v_compra_id, v_uid
    );
  END LOOP;

  IF p_condicion = 'CTA_CTE' THEN
    -- No se admite mixto: una compra a cuenta no lleva pagos. Si llegan (estado
    -- viejo de UI o llamada directa), se rechaza en vez de ignorarlos en silencio.
    IF (SELECT COALESCE(SUM((x->>'monto')::numeric), 0)
          FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb)) x) > 0 THEN
      RAISE EXCEPTION 'Una compra a cuenta corriente no lleva pagos: quedan como deuda';
    END IF;
    -- Deuda con el proveedor: DEBITO por el total.
    INSERT INTO public.proveedor_cc_movimientos (
      proveedor_id, sucursal_id, tipo, monto, estado, compra_id, descripcion, usuario_id
    ) VALUES (
      p_proveedor_id, p_sucursal_id, 'DEBITO', v_total, 'CONFIRMADO', v_compra_id,
      'Compra ' || p_tipo_comprobante || ' ' || p_numero, v_uid
    );
  ELSE
    -- CONTADO: la plata sale de la caja → tiene que haber una abierta.
    SELECT id INTO v_sesion FROM public.caja_sesiones
      WHERE sucursal_id = p_sucursal_id AND estado = 'ABIERTA'
      ORDER BY abierta_en DESC LIMIT 1;
    IF v_sesion IS NULL THEN
      RAISE EXCEPTION 'Abrí la caja antes de registrar una compra al contado (la plata sale de la caja)';
    END IF;

    v_monto := 0;  -- reutilizado como acumulador de pagos
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_forma := pg->>'forma_pago';
      IF v_forma = 'CTA_CTE' THEN
        RAISE EXCEPTION 'CTA_CTE no es una forma de pago. Para comprar a cuenta usá la condición CTA_CTE.';
      END IF;
      v_monto := v_monto + ROUND(COALESCE((pg->>'monto')::numeric, 0), 2);
    END LOOP;
    -- Una compra contado se paga completa: la suma de pagos debe igualar el total.
    IF ABS(v_monto - v_total) > 0.01 THEN
      RAISE EXCEPTION 'Los pagos (%) no cubren el total de la compra (%). Una compra contado se paga completa.',
        v_monto, v_total;
    END IF;

    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := ROUND(COALESCE((pg->>'monto')::numeric, 0), 2);
      IF v_monto <= 0 THEN CONTINUE; END IF;
      INSERT INTO public.proveedor_pagos (
        proveedor_id, sucursal_id, usuario_id, monto, forma_pago, detalle
      ) VALUES (
        p_proveedor_id, p_sucursal_id, v_uid, v_monto, pg->>'forma_pago', COALESCE(pg->'detalle', '{}'::jsonb)
      );
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_compra_id;
END; $$;

REVOKE ALL ON FUNCTION public.crear_compra(uuid, uuid, text, text, date, date, jsonb, jsonb, numeric, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_compra(uuid, uuid, text, text, date, date, jsonb, jsonb, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crear_compra(uuid, uuid, text, text, date, date, jsonb, jsonb, numeric, text, text) TO service_role;

-- Estampar la compra y el pago a proveedor a la sesión de caja abierta (reutiliza
-- la función genérica del arqueo, que usa NEW.sucursal_id + NEW.caja_sesion_id).
DROP TRIGGER IF EXISTS trg_compras_estampar_caja ON public.compras;
CREATE TRIGGER trg_compras_estampar_caja
  BEFORE INSERT ON public.compras
  FOR EACH ROW EXECUTE FUNCTION public.estampar_caja_sesion();

DROP TRIGGER IF EXISTS trg_proveedor_pagos_estampar_caja ON public.proveedor_pagos;
CREATE TRIGGER trg_proveedor_pagos_estampar_caja
  BEFORE INSERT ON public.proveedor_pagos
  FOR EACH ROW EXECUTE FUNCTION public.estampar_caja_sesion();
