-- ============================================================
-- Al contado se cobra ALGO, no necesariamente todo.
--
-- Corrección de la regla que entró el 2026-07-29: exigir el total cerraba el
-- fiado del mostrador (paga una parte ahora y el resto después), que es una
-- forma de trabajar real y no un error. Lo que se bloquea es el caso en que la
-- mercadería sale sin que se cobre un solo peso: ahí la plata no está en la
-- caja ni como deuda de nadie. Eso es cuenta corriente.
--
-- Una venta parcial queda en PARCIAL y el saldo se ve en la pantalla.
--
-- Toca las dos RPC que cobran para que haya UNA sola regla en el sistema, las
-- dos escritas sobre su definición VIVA (verificadas con diff contra pg_proc).
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
  v_iva_libre      numeric(5,2);   -- R5: IVA de una línea de concepto libre (recargo)
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

  -- R2.a: la "Factura interna" ya NO es de cuenta corriente. Es un documento
  -- interno de CONTADO (impacta caja como cualquier venta). Forzamos la condición
  -- acá para que, aunque el front mande CTA_CTE, nunca vaya a cuenta corriente.
  IF p_tipo_comprobante = 'FAC_INTERNA_CTA_CTE' THEN
    p_condicion_venta := 'CONTADO';
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
  -- R6: además del flag GLOBAL, un perfil habilitado (o un admin) puede vender
  -- productos sin stock disponible. El permiso vive en profiles y lo resuelve
  -- puede_vender_sin_stock() (SECURITY DEFINER), server-authoritative.
  v_permite_neg := v_permite_neg OR public.puede_vender_sin_stock(v_uid);

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

  v_es_cta_cte := p_tipo_comprobante IN ('REMITO', 'REMITO_OBRA')
                  OR p_condicion_venta = 'CTA_CTE';

  IF v_es_cta_cte AND p_tipo_comprobante NOT IN ('NOTA_CREDITO', 'NOTA_DEBITO')
     AND NOT COALESCE(v_cliente.condicion_cta_cte, false) THEN
    RAISE EXCEPTION 'El cliente % no tiene cuenta corriente habilitada', v_cliente.razon_social;
  END IF;

  -- Todos los productos de la venta, lockeados EN ORDEN DE id antes del loop.
  -- El loop los toma en el orden en que vengan en p_items: dos ventas
  -- simultáneas con los mismos productos en distinto orden se pedían los locks
  -- cruzados y Postgres abortaba una por deadlock. Con el prelock el orden es
  -- siempre el mismo, venga de donde venga el array. Es aditivo: adentro del
  -- loop el FOR UPDATE de cada producto ya no espera a nadie.
  PERFORM 1 FROM public.productos p
    WHERE p.id IN (
      SELECT (value->>'producto_id')::uuid
        FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
       WHERE value->>'producto_id' IS NOT NULL)
    ORDER BY p.id FOR UPDATE;

  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    -- R5: línea de CONCEPTO LIBRE (recargo/interés), sin producto. Sólo NOTA_DEBITO.
    IF (it->>'producto_id') IS NULL THEN
      IF p_tipo_comprobante <> 'NOTA_DEBITO' THEN
        RAISE EXCEPTION 'Sólo la Nota de Débito admite líneas sin producto (recargo/interés)';
      END IF;

      v_cant := COALESCE((it->>'cantidad')::numeric, 1);
      IF v_cant <= 0 THEN
        RAISE EXCEPTION 'La línea de recargo necesita una cantidad mayor a cero';
      END IF;

      v_precio := (it->>'precio_unitario_sin_iva')::numeric;
      IF v_precio IS NULL OR v_precio < 0 THEN
        RAISE EXCEPTION 'La línea de recargo necesita un precio válido';
      END IF;

      v_iva_libre := COALESCE((it->>'iva_porcentaje')::numeric, 21);
      IF v_iva_libre < 0 OR v_iva_libre > 100 THEN
        RAISE EXCEPTION 'IVA inválido en la línea de recargo';
      END IF;

      v_qty_total := v_qty_total + v_cant;

      -- ND siempre suma (v_signo = 1); sin descuento.
      v_sub_item := ROUND(v_precio * v_cant, 2);
      v_iva_item := ROUND(v_sub_item * v_iva_libre / 100, 2);

      v_sub_sin_iva := v_sub_sin_iva + v_sub_item;
      v_iva_total   := v_iva_total   + v_iva_item;

      v_calc := v_calc || jsonb_build_object(
        'producto_id', NULL, 'codigo', 'RECARGO',
        'descripcion', COALESCE(NULLIF(it->>'descripcion', ''), 'Recargo'),
        'cantidad', v_cant, 'precio', v_precio, 'precio_lista', v_precio,
        'iva_porcentaje', v_iva_libre, 'descuento', 0,
        'sub_item', v_sub_item, 'iva_item', v_iva_item
      );

      CONTINUE;
    END IF;

    -- Rama normal: ítem con producto del catálogo.
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

    -- AL CONTADO SE COBRA ALGO.
    -- Una venta al contado sin NINGÚN pago quedaba PENDIENTE con
    -- total_pagado = 0 y el stock ya descontado: la mercadería salía, la plata
    -- no entraba a la caja y tampoco generaba deuda en la cuenta corriente. No
    -- estaba en ningún lado. Si el cliente no paga nada, eso es cuenta
    -- corriente, que para eso está: ahí la deuda queda a nombre de alguien.
    --
    -- El pago PARCIAL sí se permite: es el mostrador de verdad (paga una parte
    -- ahora y el resto después). La venta queda en PARCIAL y el saldo se ve.
    --
    -- Quedan afuera a propósito:
    --   · las notas de crédito y débito, que se acreditan o cargan a la cuenta y
    --     no se pagan en el momento;
    --   · los remitos, que ya entran por la rama de cuenta corriente;
    --   · los comprobantes en cero (la pantalla los permite).
    IF p_tipo_comprobante NOT IN ('NOTA_CREDITO', 'NOTA_DEBITO')
       AND ABS(v_total) >= 0.01
       AND v_pagos_suma < 0.01 THEN
      RAISE EXCEPTION 'Una venta al contado se cobra, aunque sea una parte. Si se lo lleva sin pagar nada, hacela por cuenta corriente.';
    END IF;
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

  -- (c) Al contado se cobra algo. Misma regla que crear_venta: el parcial se
  -- permite, el cero no. Si no paga nada, es cuenta corriente.
  IF p_condicion_venta <> 'CTA_CTE' AND v_p.total >= 0.01 THEN
    SELECT COALESCE(SUM((x->>'monto')::numeric), 0) INTO v_pagado
      FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb)) x;
    IF v_pagado < 0.01 THEN
      RAISE EXCEPTION 'Una venta al contado se cobra, aunque sea una parte. Si se lo lleva sin pagar nada, poné cuenta corriente.';
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
