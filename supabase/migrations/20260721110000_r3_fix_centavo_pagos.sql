-- ============================================================
-- R3 — Bug del centavo en pagos electrónicos.
--
-- Síntoma: una venta pagada 100% con un medio electrónico (ej. Mercado Pago)
-- por "el total" se rechazaba con "Los pagos electrónicos (X) superan el total
-- del comprobante (Y)" por una diferencia de 1 centavo.
--
-- Causa: el front sumaba el IVA sin redondear por línea (total .05) mientras el
-- server redondea el IVA por línea (total .04); el pago se precargaba con el
-- total del front y superaba el del server por 0,01. La comparación era estricta
-- (`>`), así que 0,01 alcanzaba para rechazar.
--
-- Fix front: unificar la fórmula (usa fiscal/iva.ts calcularTotales). Ver
-- src/lib/ventas-totales.ts.
--
-- Fix server (esta migración), defensa en profundidad:
--   (a) Tolerar hasta 1 centavo de desalineación de redondeo en la validación
--       de pagos no-efectivo (`> ABS(total) + 0.01`).
--   (b) IMPORTANTE (hallazgo de review Codex): si sólo se relaja la comparación,
--       el pago electrónico de `total + 0.01` se INSERTA completo en venta_pagos
--       y caja_esperado lo cuenta como caja real -> la caja queda esperando 1
--       centavo de más. Por eso capamos la suma de pagos NO EFECTIVO al total:
--       un electrónico no admite vuelto, así que el centavo sobrante no se
--       persiste. El efectivo sigue absorbiendo el vuelto físico como antes.
--
-- CREATE OR REPLACE completo partiendo de la versión vigente de 12 argumentos
-- (20260718121000). No cambia la firma.
-- ============================================================

CREATE OR REPLACE FUNCTION public.crear_venta(
  p_sucursal_id uuid,
  p_cliente_id uuid,
  p_tipo_comprobante tipo_comprobante,
  p_condicion_venta condicion_venta,
  p_items jsonb,
  p_pagos jsonb,
  p_percepciones numeric DEFAULT 0,
  p_observaciones text DEFAULT NULL::text,
  p_nombre_obra text DEFAULT NULL::text,
  p_fecha timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_cbte_asoc_id uuid DEFAULT NULL::uuid,
  p_idempotency_key uuid DEFAULT NULL::uuid
)
 RETURNS TABLE(venta_id uuid, numero text, es_cta_cte boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid := auth.uid();
  v_permite_neg    boolean;
  v_numero         text;
  v_venta_id       uuid;
  v_es_cta_cte     boolean;
  v_signo          integer;
  v_cliente        public.clientes%ROWTYPE;
  v_sub_sin_iva    numeric(14,2) := 0;
  v_iva_total      numeric(14,2) := 0;
  v_total          numeric(14,2);
  v_percepciones   numeric(14,2);
  v_total_pagado   numeric(14,2) := 0;
  v_pagos_suma     numeric(14,2) := 0;
  v_pagos_no_efec  numeric(14,2) := 0;
  v_vuelto         numeric(14,2) := 0;
  v_no_efec_ins    numeric(14,2) := 0;   -- R3: acumulador de pagos no-efectivo ya insertados
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
  v_calc           jsonb := '[]'::jsonb;
  v_saldo_actual   numeric(14,2);
  v_monto          numeric(14,2);
  v_forma          public.forma_pago;
  v_qty_total      numeric(14,2) := 0;
  v_es_fiscal      boolean;
  v_ex_id          uuid;
  v_ex_num         text;
  v_ex_cta         boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
    SELECT id, numero_comprobante, (condicion_venta = 'CTA_CTE')
      INTO v_ex_id, v_ex_num, v_ex_cta
      FROM public.ventas
     WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN QUERY SELECT v_ex_id, v_ex_num, v_ex_cta;
      RETURN;
    END IF;
  END IF;

  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés facturar en una sucursal que no es la tuya';
  END IF;

  SELECT * INTO v_cliente FROM public.clientes WHERE id = p_cliente_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  IF p_tipo_comprobante = 'FACTURA_A' AND v_cliente.tipo <> 'RESPONSABLE_INSCRIPTO' THEN
    RAISE EXCEPTION 'No se puede emitir Factura A a % (condición %): la Factura A es sólo para Responsables Inscriptos',
      v_cliente.razon_social, v_cliente.tipo;
  END IF;

  IF p_fecha IS NOT NULL THEN
    IF p_fecha > now() + interval '1 day' THEN
      RAISE EXCEPTION 'La fecha del comprobante no puede ser futura';
    END IF;
    IF p_fecha < now() - interval '5 years' THEN
      RAISE EXCEPTION 'La fecha del comprobante es demasiado antigua';
    END IF;
  END IF;

  IF COALESCE(p_percepciones, 0) < 0 THEN
    RAISE EXCEPTION 'Las percepciones no pueden ser negativas';
  END IF;

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg
    FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);

  v_signo := CASE WHEN p_tipo_comprobante = 'NOTA_CREDITO' THEN -1 ELSE 1 END;

  IF p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') THEN
    IF p_cbte_asoc_id IS NULL THEN
      RAISE EXCEPTION 'Una nota de crédito/débito tiene que indicar el comprobante que rectifica';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.ventas
       WHERE id = p_cbte_asoc_id AND cliente_id = p_cliente_id
         AND tipo_comprobante IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C')
    ) THEN
      RAISE EXCEPTION 'El comprobante a rectificar no existe o no es una factura de este cliente';
    END IF;
  END IF;

  v_es_cta_cte := p_tipo_comprobante IN ('REMITO', 'REMITO_OBRA', 'FAC_INTERNA_CTA_CTE')
                  OR p_condicion_venta = 'CTA_CTE';

  IF v_es_cta_cte AND p_tipo_comprobante NOT IN ('NOTA_CREDITO', 'NOTA_DEBITO')
     AND NOT COALESCE(v_cliente.condicion_cta_cte, false) THEN
    RAISE EXCEPTION 'El cliente % no tiene cuenta corriente habilitada', v_cliente.razon_social;
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    SELECT * INTO v_prod FROM public.productos
      WHERE id = (it->>'producto_id')::uuid AND activo
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto % inexistente o inactivo', it->>'producto_id';
    END IF;

    v_cant := COALESCE((it->>'cantidad')::numeric, 0);
    v_desc := LEAST(GREATEST(COALESCE((it->>'descuento_porcentaje')::numeric, 0), 0), 100);
    IF v_cant < 0 THEN
      RAISE EXCEPTION 'Cantidad negativa en el producto %', v_prod.codigo;
    END IF;

    v_qty_total := v_qty_total + v_cant;

    v_precio_lista := v_prod.precio_sin_iva;
    v_precio := COALESCE((it->>'precio_unitario_sin_iva')::numeric, v_precio_lista);
    IF v_precio < 0 THEN
      RAISE EXCEPTION 'Precio negativo en el producto %', v_prod.codigo;
    END IF;

    v_sub_item := ROUND(v_precio * (1 - v_desc / 100) * v_cant, 2) * v_signo;
    v_iva_item := ROUND(v_sub_item * v_prod.iva_porcentaje / 100, 2);

    v_sub_sin_iva := v_sub_sin_iva + v_sub_item;
    v_iva_total   := v_iva_total   + v_iva_item;

    v_calc := v_calc || jsonb_build_object(
      'producto_id', v_prod.id, 'codigo', v_prod.codigo, 'descripcion', v_prod.nombre,
      'cantidad', v_cant, 'precio', v_precio, 'precio_lista', v_precio_lista,
      'iva_porcentaje', v_prod.iva_porcentaje, 'descuento', v_desc,
      'sub_item', v_sub_item, 'iva_item', v_iva_item
    );
  END LOOP;

  v_percepciones := ROUND(COALESCE(p_percepciones, 0), 2) * v_signo;
  v_total := ROUND(v_sub_sin_iva + v_iva_total + v_percepciones, 2);

  v_es_fiscal := p_tipo_comprobante IN ('FACTURA_A','FACTURA_B','FACTURA_C','NOTA_CREDITO','NOTA_DEBITO');
  IF v_qty_total <= 0 THEN
    RAISE EXCEPTION 'El comprobante necesita al menos un ítem con cantidad mayor a cero';
  END IF;
  IF v_es_fiscal AND ABS(v_total) < 0.01 THEN
    RAISE EXCEPTION 'El total de un comprobante fiscal debe ser distinto de cero';
  END IF;

  IF NOT v_es_cta_cte THEN
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := COALESCE((pg->>'monto')::numeric, 0);
      IF v_monto < 0 THEN
        RAISE EXCEPTION 'Un pago no puede ser negativo';
      END IF;
      IF (pg->>'forma_pago')::public.forma_pago = 'CTA_CTE' THEN
        RAISE EXCEPTION 'CTA_CTE no es una forma de pago. Para vender a cuenta corriente usá la condición de venta CTA_CTE.';
      END IF;
      v_pagos_suma := v_pagos_suma + v_monto;
      IF (pg->>'forma_pago')::public.forma_pago <> 'EFECTIVO' THEN
        v_pagos_no_efec := v_pagos_no_efec + v_monto;
      END IF;
    END LOOP;

    -- R3: tolerancia de 1 centavo. Un electrónico que supera el total por una
    -- desalineación de redondeo (<= 0,01) no se rechaza; el excedente NO se
    -- persiste (se capa abajo, en el loop de inserción).
    IF v_pagos_no_efec > ABS(v_total) + 0.01 THEN
      RAISE EXCEPTION 'Los pagos electrónicos (%) superan el total del comprobante (%). Sólo el efectivo admite vuelto.',
        v_pagos_no_efec, ABS(v_total);
    END IF;

    IF v_pagos_suma > ABS(v_total) THEN
      v_vuelto := ROUND(v_pagos_suma - ABS(v_total), 2);
    END IF;
    v_total_pagado := ROUND(LEAST(v_pagos_suma, ABS(v_total)), 2) * v_signo;
  END IF;

  v_estado_pago := CASE
    WHEN v_es_cta_cte THEN 'PENDIENTE'::public.estado_pago
    WHEN ABS(v_total_pagado) >= ABS(v_total) - 0.01 THEN 'PAGADO'::public.estado_pago
    WHEN ABS(v_total_pagado) > 0 THEN 'PARCIAL'::public.estado_pago
    ELSE 'PENDIENTE'::public.estado_pago
  END;

  IF v_es_cta_cte AND v_cliente.limite_credito IS NOT NULL AND v_signo > 0
     AND p_tipo_comprobante <> 'NOTA_CREDITO' THEN
    v_saldo_actual := public.cc_saldo(p_cliente_id);
    IF v_saldo_actual + ABS(v_total) > v_cliente.limite_credito THEN
      RAISE EXCEPTION 'Supera el límite de crédito del cliente (límite %, saldo actual %, esta venta %)',
        v_cliente.limite_credito, v_saldo_actual, ABS(v_total);
    END IF;
  END IF;

  v_numero := public.next_comprobante_numero(p_sucursal_id, p_tipo_comprobante);

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, fecha, numero_comprobante, tipo_comprobante,
    condicion_venta, subtotal_sin_iva, iva_total, percepciones, total, total_pagado,
    estado_pago, observaciones, nombre_obra, afip_cbte_asoc_id, idempotency_key
  ) VALUES (
    p_sucursal_id, p_cliente_id, v_uid, COALESCE(p_fecha, now()), v_numero, p_tipo_comprobante,
    CASE WHEN v_es_cta_cte THEN 'CTA_CTE'::public.condicion_venta ELSE p_condicion_venta END,
    v_sub_sin_iva, v_iva_total, v_percepciones, v_total, v_total_pagado,
    v_estado_pago, p_observaciones, p_nombre_obra, p_cbte_asoc_id, p_idempotency_key
  ) RETURNING id INTO v_venta_id;

  FOR it IN SELECT * FROM jsonb_array_elements(v_calc)
  LOOP
    v_cant := (it->>'cantidad')::numeric;

    INSERT INTO public.venta_items (
      venta_id, producto_id, codigo, descripcion, cantidad,
      precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
      subtotal_sin_iva, iva_monto, subtotal_con_iva
    ) VALUES (
      v_venta_id, (it->>'producto_id')::uuid, it->>'codigo', it->>'descripcion', v_cant,
      (it->>'precio')::numeric, (it->>'precio_lista')::numeric,
      (it->>'iva_porcentaje')::numeric, (it->>'descuento')::numeric,
      (it->>'sub_item')::numeric, (it->>'iva_item')::numeric,
      (it->>'sub_item')::numeric + (it->>'iva_item')::numeric
    );

    CONTINUE WHEN v_cant = 0;
    CONTINUE WHEN p_tipo_comprobante = 'NOTA_DEBITO';

    IF p_tipo_comprobante = 'NOTA_CREDITO' THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES ((it->>'producto_id')::uuid, p_sucursal_id, v_cant)
      ON CONFLICT (producto_id, sucursal_id)
      DO UPDATE SET cantidad = stock_sucursal.cantidad + v_cant
      RETURNING cantidad - v_cant, cantidad INTO v_stock_ant, v_stock_nue;

      INSERT INTO public.stock_movimientos (
        producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
        motivo, referencia_id, usuario_id
      ) VALUES (
        (it->>'producto_id')::uuid, p_sucursal_id, 'DEVOLUCION', v_cant, v_stock_ant, v_stock_nue,
        p_tipo_comprobante::text || ' ' || v_numero, v_venta_id, v_uid
      );
      CONTINUE;
    END IF;

    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES ((it->>'producto_id')::uuid, p_sucursal_id, -v_cant)
      ON CONFLICT (producto_id, sucursal_id)
      DO UPDATE SET cantidad = stock_sucursal.cantidad - v_cant
      RETURNING cantidad + v_cant, cantidad INTO v_stock_ant, v_stock_nue;
    ELSE
      UPDATE public.stock_sucursal
         SET cantidad = cantidad - v_cant
       WHERE producto_id = (it->>'producto_id')::uuid
         AND sucursal_id = p_sucursal_id
         AND cantidad >= v_cant
      RETURNING cantidad + v_cant, cantidad INTO v_stock_ant, v_stock_nue;

      IF NOT FOUND THEN
        SELECT COALESCE(cantidad, 0) INTO v_stock_ant
          FROM public.stock_sucursal
         WHERE producto_id = (it->>'producto_id')::uuid AND sucursal_id = p_sucursal_id;
        RAISE EXCEPTION 'Stock insuficiente de % (%): hay %, se piden %',
          it->>'descripcion', it->>'codigo', COALESCE(v_stock_ant, 0), v_cant;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      (it->>'producto_id')::uuid, p_sucursal_id, 'VENTA', -v_cant, v_stock_ant, v_stock_nue,
      p_tipo_comprobante::text || ' ' || v_numero, v_venta_id, v_uid
    );
  END LOOP;

  IF NOT v_es_cta_cte THEN
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := ROUND(ABS(COALESCE((pg->>'monto')::numeric, 0)), 2);
      v_forma := (pg->>'forma_pago')::public.forma_pago;

      IF v_forma = 'EFECTIVO' THEN
        -- El vuelto físico (efectivo pagado de más) sale del efectivo, como siempre.
        IF v_vuelto > 0 THEN
          IF v_monto >= v_vuelto THEN
            v_monto := v_monto - v_vuelto;
            v_vuelto := 0;
          ELSE
            v_vuelto := v_vuelto - v_monto;
            v_monto := 0;
          END IF;
        END IF;
      ELSE
        -- R3: un pago electrónico no admite vuelto. Capamos la suma de pagos no
        -- efectivo al total del comprobante: así una desalineación de redondeo de
        -- hasta 1 centavo (tolerada arriba) no queda persistida inflando la caja.
        v_monto := GREATEST(LEAST(v_monto, ABS(v_total) - v_no_efec_ins), 0);
        v_no_efec_ins := v_no_efec_ins + v_monto;
      END IF;

      CONTINUE WHEN v_monto = 0;

      INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
      VALUES (v_venta_id, v_forma, v_monto * v_signo, COALESCE(pg->'detalle', '{}'::jsonb));
    END LOOP;
  END IF;

  IF v_es_cta_cte THEN
    PERFORM public.cc_registrar_por_venta(v_venta_id);
  END IF;

  RETURN QUERY SELECT v_venta_id, v_numero, v_es_cta_cte;
END; $function$;

REVOKE ALL ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid, uuid) TO service_role;
