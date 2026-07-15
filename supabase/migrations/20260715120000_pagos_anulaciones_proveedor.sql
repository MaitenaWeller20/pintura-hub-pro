-- ============================================================
-- Pagos a proveedor, anulaciones y saldo.
--
-- Para poder ANULAR una compra contado hay que reencontrar y revertir sus pagos:
-- se agrega proveedor_pagos.compra_id (de qué compra salió, null si es un pago de
-- cuenta corriente) y proveedor_pagos.estado (para anular sin borrar). El arqueo
-- (caja_esperado v3, migración siguiente) sólo cuenta los pagos CONFIRMADO.
-- ============================================================

ALTER TABLE public.proveedor_pagos
  ADD COLUMN IF NOT EXISTS compra_id uuid REFERENCES public.compras(id),
  ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'CONFIRMADO'
    CHECK (estado IN ('CONFIRMADO','ANULADO'));
CREATE INDEX IF NOT EXISTS idx_proveedor_pagos_compra ON public.proveedor_pagos (compra_id);

-- crear_compra: ahora estampa compra_id en los pagos de una compra contado.
CREATE OR REPLACE FUNCTION public.crear_compra(p_proveedor_id uuid, p_sucursal_id uuid, p_tipo_comprobante text, p_numero text, p_fecha_comprobante date, p_fecha_vencimiento date, p_items jsonb, p_pagos jsonb, p_percepciones numeric DEFAULT 0, p_condicion text DEFAULT 'CONTADO'::text, p_observaciones text DEFAULT NULL::text)
 RETURNS TABLE(compra_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- CONTADO: la plata sale de la caja → tiene que haber una abierta. FOR SHARE
    -- serializa contra cerrar_caja: si la caja se cierra en el medio, esta compra
    -- se rechaza en vez de quedar con un pago huérfano fuera de todo arqueo.
    SELECT id INTO v_sesion FROM public.caja_sesiones
      WHERE sucursal_id = p_sucursal_id AND estado = 'ABIERTA'
      ORDER BY abierta_en DESC LIMIT 1
      FOR SHARE;
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
      IF COALESCE((pg->>'monto')::numeric, 0) < 0 THEN
        RAISE EXCEPTION 'Un pago no puede ser negativo';
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
        proveedor_id, sucursal_id, usuario_id, monto, forma_pago, detalle, compra_id, caja_sesion_id
      ) VALUES (
        p_proveedor_id, p_sucursal_id, v_uid, v_monto, pg->>'forma_pago', COALESCE(pg->'detalle', '{}'::jsonb), v_compra_id, v_sesion
      );
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_compra_id;
END; $function$

;
REVOKE ALL ON FUNCTION public.crear_compra(uuid, uuid, text, text, date, date, jsonb, jsonb, numeric, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_compra(uuid, uuid, text, text, date, date, jsonb, jsonb, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crear_compra(uuid, uuid, text, text, date, date, jsonb, jsonb, numeric, text, text) TO service_role;

-- ------------------------------------------------------------
-- proveedor_saldo(proveedor) -> lo que le debemos (Σ DEBITO − Σ CREDITO, CONFIRMADOS)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.proveedor_saldo(_proveedor_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(CASE tipo WHEN 'DEBITO' THEN monto ELSE -monto END), 0)
    FROM public.proveedor_cc_movimientos
   WHERE proveedor_id = _proveedor_id AND estado = 'CONFIRMADO';
$$;
REVOKE ALL ON FUNCTION public.proveedor_saldo(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.proveedor_saldo(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- registrar_pago_proveedor -> paga deuda; exige caja abierta (sale de caja)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_pago_proveedor(
  p_proveedor_id uuid,
  p_sucursal_id  uuid,
  p_monto        numeric,
  p_forma_pago   text,
  p_detalle      jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_monto  numeric(14,2) := ROUND(COALESCE(p_monto, 0), 2);
  v_pago   uuid;
  v_sesion uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés pagar desde una sucursal que no es la tuya';
  END IF;
  IF v_monto <= 0 THEN RAISE EXCEPTION 'El monto tiene que ser mayor a cero'; END IF;
  IF p_forma_pago = 'CTA_CTE' THEN RAISE EXCEPTION 'CTA_CTE no es una forma de pago'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.proveedores WHERE id = p_proveedor_id AND activo) THEN
    RAISE EXCEPTION 'Proveedor inexistente o inactivo';
  END IF;
  -- FOR SHARE: serializa contra cerrar_caja (la salida no puede quedar huérfana).
  SELECT id INTO v_sesion FROM public.caja_sesiones
    WHERE sucursal_id = p_sucursal_id AND estado = 'ABIERTA'
    ORDER BY abierta_en DESC LIMIT 1
    FOR SHARE;
  IF v_sesion IS NULL THEN
    RAISE EXCEPTION 'Abrí la caja antes de pagar a un proveedor (la plata sale de la caja)';
  END IF;

  INSERT INTO public.proveedor_pagos (proveedor_id, sucursal_id, usuario_id, monto, forma_pago, detalle, caja_sesion_id)
  VALUES (p_proveedor_id, p_sucursal_id, v_uid, v_monto, p_forma_pago, COALESCE(p_detalle, '{}'::jsonb), v_sesion)
  RETURNING id INTO v_pago;

  INSERT INTO public.proveedor_cc_movimientos (
    proveedor_id, sucursal_id, tipo, monto, estado, pago_id, forma_pago, descripcion, usuario_id
  ) VALUES (
    p_proveedor_id, p_sucursal_id, 'CREDITO', v_monto, 'CONFIRMADO', v_pago, p_forma_pago,
    'Pago a proveedor', v_uid
  );

  RETURN v_pago;
END; $$;
REVOKE ALL ON FUNCTION public.registrar_pago_proveedor(uuid, uuid, numeric, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.registrar_pago_proveedor(uuid, uuid, numeric, text, jsonb) TO authenticated, service_role;

-- ------------------------------------------------------------
-- anular_pago_proveedor -> revierte un pago cargado por error
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anular_pago_proveedor(p_pago_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p   public.proveedor_pagos%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  SELECT * INTO v_p FROM public.proveedor_pagos WHERE id = p_pago_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pago no encontrado'; END IF;
  IF NOT public.is_admin(v_uid) AND v_p.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'Ese pago es de otra sucursal';
  END IF;
  IF v_p.estado = 'ANULADO' THEN RAISE EXCEPTION 'El pago ya fue anulado'; END IF;
  IF v_p.compra_id IS NOT NULL THEN
    RAISE EXCEPTION 'Este pago es de una compra contado: anulá la compra, no el pago';
  END IF;

  UPDATE public.proveedor_pagos SET estado = 'ANULADO' WHERE id = p_pago_id;
  UPDATE public.proveedor_cc_movimientos SET estado = 'ANULADO' WHERE pago_id = p_pago_id AND estado = 'CONFIRMADO';
END; $$;
REVOKE ALL ON FUNCTION public.anular_pago_proveedor(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_pago_proveedor(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- anular_compra -> corrección interna (admin). Revierte stock (valida suficiente),
-- deuda o pagos según la condición.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anular_compra(p_compra_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_c          public.compras%ROWTYPE;
  v_permite_neg boolean;
  r            RECORD;
  v_stock_ant  numeric(14,2);
  v_stock_nue  numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) THEN RAISE EXCEPTION 'Sólo un administrador puede anular una compra'; END IF;

  SELECT * INTO v_c FROM public.compras WHERE id = p_compra_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compra no encontrada'; END IF;
  IF v_c.estado = 'ANULADA' THEN RAISE EXCEPTION 'La compra ya fue anulada'; END IF;

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);

  -- Revierte stock por ítem. Si ya se vendió parte de esa mercadería y quedaría
  -- negativo, no deja anular (salvo que la política de stock negativo lo permita).
  FOR r IN SELECT producto_id, cantidad, codigo FROM public.compra_items WHERE compra_id = p_compra_id
  LOOP
    IF v_permite_neg THEN
      -- Garantiza la fila antes de descontar (por si no existiera, con stock negativo
      -- permitido); si no, el UPDATE no afectaría filas y el stock no se revertiría.
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES (r.producto_id, v_c.sucursal_id, 0)
      ON CONFLICT (producto_id, sucursal_id) DO NOTHING;
      UPDATE public.stock_sucursal SET cantidad = cantidad - r.cantidad
       WHERE producto_id = r.producto_id AND sucursal_id = v_c.sucursal_id
      RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
    ELSE
      UPDATE public.stock_sucursal SET cantidad = cantidad - r.cantidad
       WHERE producto_id = r.producto_id AND sucursal_id = v_c.sucursal_id AND cantidad >= r.cantidad
      RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No se puede anular: ya se vendió parte de % (no alcanza el stock para revertir)', r.codigo;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      r.producto_id, v_c.sucursal_id, 'ANULACION_COMPRA', -r.cantidad, v_stock_ant, v_stock_nue,
      'Anulación compra ' || v_c.numero_comprobante, p_compra_id, v_uid
    );
  END LOOP;

  UPDATE public.compras SET estado = 'ANULADA' WHERE id = p_compra_id;

  -- Deuda (CTA_CTE): anula el DEBITO. Contado: anula los pagos (dejan de restar de la caja).
  UPDATE public.proveedor_cc_movimientos SET estado = 'ANULADO'
    WHERE compra_id = p_compra_id AND estado = 'CONFIRMADO';
  UPDATE public.proveedor_pagos SET estado = 'ANULADO'
    WHERE compra_id = p_compra_id AND estado = 'CONFIRMADO';
END; $$;
REVOKE ALL ON FUNCTION public.anular_compra(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_compra(uuid) TO authenticated, service_role;
