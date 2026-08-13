-- ============================================================
-- Una nota de crédito puede ir SIN factura asociada.
--
-- EL PEDIDO
-- "Necesito que en las notas de crédito me deje guardar sin tener que
-- relacionarlo con alguna factura."
--
-- EL CASO REAL
-- Una devolución de mercadería cuya factura original NO está en Quimex, porque
-- se emitió en el sistema viejo (3C). Hoy la pantalla obliga a elegir una
-- factura del cliente, y si el cliente no tiene ninguna cargada directamente
-- avisa "una nota siempre rectifica una factura": no hay salida.
--
-- QUÉ QUEDA HABILITADO, Y QUÉ NO
-- Una NC sin comprobante asociado es un documento INTERNO: repone stock, mueve
-- caja y acredita cuenta corriente, pero NO se manda a AFIP. No es un estado
-- nuevo — es exactamente el que ya genera anular_venta cuando el original no
-- tenía CAE, el que define esNotaInterna() y el que el emisor ya rechaza con un
-- mensaje explicativo.
--
-- NO es una rectificación fiscal. Según la RG 4540/2019 una NC/ND electrónica
-- tiene que informar o el comprobante asociado (CbtesAsoc) o el período
-- asociado (PeriodoAsoc): el camino legal para rectificar una factura de 3C es
-- el período, que este cambio no implementa (arca.ts sólo serializa CbtesAsoc, y
-- la facturación está en MOCK porque el certificado no salió — un payload fiscal
-- que nunca vio homologación no se manda a producción). Queda en el backlog.
-- La pantalla lo dice con todas las letras antes de guardar.
--
-- LA NOTA DE DÉBITO SIGUE EXIGIENDO FACTURA
-- No tiene grilla de productos: es un recargo calculado como porcentaje del
-- total de la factura que rectifica. Sin factura no hay base.
--
-- LAS DOS TRAMPAS QUE SE CIERRAN DE PASO
-- Ninguna la inventa este cambio: las dos ya existían para las notas con
-- factura. Pero al habilitar la creación manual pasan de teóricas a probables.
--
--   1. Una NC al contado sin ningún pago no movía plata a ningún lado (ver la
--      regla nueva en crear_venta).
--   2. Una NC interna no se podía deshacer: anular_venta rechazaba toda nota
--      ("las notas se corrigen con otra nota"), y corregirla requeriría una ND,
--      que exige factura. Círculo cerrado, con el stock ya inflado. Ahora una NC
--      SIN CAE y SIN asociado se puede anular de verdad: nunca se declaró a
--      AFIP, así que no hace falta un documento compensatorio, alcanza con
--      revertirla.
-- ============================================================

CREATE OR REPLACE FUNCTION public.crear_venta(p_sucursal_id uuid, p_cliente_id uuid, p_tipo_comprobante tipo_comprobante, p_condicion_venta condicion_venta, p_items jsonb, p_pagos jsonb, p_percepciones numeric DEFAULT 0, p_observaciones text DEFAULT NULL::text, p_nombre_obra text DEFAULT NULL::text, p_fecha timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cbte_asoc_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS TABLE(venta_id uuid, numero text, es_cta_cte boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_permite_neg    boolean;
  v_numero         text;
  v_venta_id       uuid;
  v_es_cta_cte     boolean;
  v_sesion_caja    uuid;
  v_signo          integer;
  v_cliente        public.clientes%ROWTYPE;
  v_cliente_id     uuid;
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

  -- Remito de obra sin cliente: la obra ES el cliente. Se resuelve (o se crea)
  -- acá, en la misma transacción que la venta, para que no quede una ficha de
  -- obra fantasma si la venta falla más abajo. Ver la migración
  -- 20260812120000_remito_obra_sin_cliente.sql.
  IF p_cliente_id IS NULL AND p_tipo_comprobante = 'REMITO_OBRA' THEN
    v_cliente_id := public.resolver_cliente_obra(p_nombre_obra);
  ELSE
    v_cliente_id := p_cliente_id;
  END IF;

  IF v_cliente_id IS NULL THEN
    RAISE EXCEPTION 'Elegí el cliente';
  END IF;

  SELECT * INTO v_cliente FROM public.clientes WHERE id = v_cliente_id AND activo;
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
    -- La NOTA DE DÉBITO sigue exigiendo factura: no tiene grilla de productos, es
    -- un recargo calculado como porcentaje del total de la factura que rectifica.
    -- Sin factura no hay base sobre la cual calcular nada.
    IF p_tipo_comprobante = 'NOTA_DEBITO' AND p_cbte_asoc_id IS NULL THEN
      RAISE EXCEPTION 'Una nota de débito tiene que indicar la factura que recarga';
    END IF;
    -- La NOTA DE CRÉDITO sí puede ir sola. Es el caso de la devolución cuya
    -- factura original no está en Quimex porque se emitió en el sistema viejo.
    -- Sin comprobante asociado queda como documento INTERNO: mueve stock, caja y
    -- cuenta corriente, pero no se manda a AFIP. Es el mismo estado que ya
    -- generaba anular_venta y que reconoce esNotaInterna() en el front.
    --
    -- Si SÍ se informa una, se valida igual que siempre: tiene que ser una
    -- factura de ESTE cliente. Sin esto se podría acreditar contra la de otro.
    IF p_cbte_asoc_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.ventas
       WHERE id = p_cbte_asoc_id AND cliente_id = v_cliente_id
         AND tipo_comprobante IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C')
    ) THEN
      RAISE EXCEPTION 'El comprobante a rectificar no existe o no es una factura de este cliente';
    END IF;
  END IF;

  v_es_cta_cte := p_tipo_comprobante IN ('REMITO', 'REMITO_OBRA')
                  OR p_condicion_venta = 'CTA_CTE';

  -- Las fichas de obra no llevan `condicion_cta_cte`: el trigger
  -- guard_clientes_credito le prohíbe a un empleado crear clientes con crédito,
  -- y no hace falta, porque la vista de saldos incluye a cualquiera con saldo
  -- distinto de cero. Un remito de obra va a cuenta corriente por definición
  -- del documento, así que la exigencia no le aplica.
  IF v_es_cta_cte AND p_tipo_comprobante NOT IN ('NOTA_CREDITO', 'NOTA_DEBITO')
     AND NOT COALESCE(v_cliente.es_obra, false)
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

    -- ...Y UNA NOTA DE CRÉDITO AL CONTADO DEVUELVE ALGO.
    -- El espejo exacto de la regla de arriba. Una NC al contado sin ningún pago
    -- no le devolvía la plata al cliente (no hay venta_pagos, así que no sale de
    -- la caja) NI le acreditaba saldo (el movimiento de cuenta corriente sólo se
    -- registra si la condición es CTA_CTE). Reponía el stock y bajaba el total de
    -- ventas del reporte, y la plata no quedaba en ningún lado.
    --
    -- Era inalcanzable en la práctica mientras la NC exigía factura y la pantalla
    -- la armaba desde ahí. Al habilitar la NC suelta pasa a ser el camino más
    -- corto, así que se cierra acá y no sólo en la pantalla: crear_venta se puede
    -- llamar sin pasar por ella.
    --
    -- Se admite parcial, igual que en la venta: el saldo queda visible.
    IF p_tipo_comprobante = 'NOTA_CREDITO'
       AND ABS(v_total) >= 0.01
       AND v_pagos_suma < 0.01 THEN
      RAISE EXCEPTION 'Una nota de crédito al contado le devuelve la plata al cliente: indicá con qué se la devolvés. Si en vez de eso le queda como saldo a favor, hacela por cuenta corriente.';
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
    v_saldo_actual := public.cc_saldo(v_cliente_id);
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
    p_sucursal_id, v_cliente_id, v_uid, COALESCE(p_fecha, now()), v_numero, p_tipo_comprobante,
    CASE WHEN v_es_cta_cte THEN 'CTA_CTE'::public.condicion_venta ELSE p_condicion_venta END,
    v_sub_sin_iva, v_iva_total, v_percepciones, v_total, v_total_pagado,
    v_estado_pago, p_observaciones, p_nombre_obra, p_cbte_asoc_id, p_idempotency_key
  ) RETURNING id, caja_sesion_id INTO v_venta_id, v_sesion_caja;

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

      -- En una NOTA DE CRÉDITO el pago va con signo NEGATIVO: es plata que se le
      -- devuelve al cliente y sale de la caja. Se verifica igual que cualquier
      -- otra salida. (Una venta normal SUMA, así que no necesita el guard.)
      IF v_signo < 0 AND v_forma = 'EFECTIVO' THEN
        PERFORM public.exigir_efectivo(p_sucursal_id, v_sesion_caja, v_monto,
                                       'devolverle la plata al cliente');
      END IF;

      INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
      VALUES (v_venta_id, v_forma, v_monto * v_signo, COALESCE(pg->'detalle', '{}'::jsonb));
    END LOOP;
  END IF;

  IF v_es_cta_cte THEN
    PERFORM public.cc_registrar_por_venta(v_venta_id);
  END IF;

  RETURN QUERY SELECT v_venta_id, v_numero, v_es_cta_cte;
END; $$;


-- ============================================================
-- anular_venta: una nota de crédito INTERNA sí se puede anular
-- ============================================================
-- El cuerpo va entre $$ y no entre $function$ (que es lo que emite
-- pg_get_functiondef): el editor SQL de Supabase no reconoce los tags con
-- nombre y parte la función en cada ';'.
CREATE OR REPLACE FUNCTION public.anular_venta(p_venta_id uuid)
 RETURNS TABLE(nc_id uuid, nc_numero text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_v              public.ventas%ROWTYPE;
  v_numero         text;
  v_nc_id          uuid;
  r                RECORD;
  v_stock_ant      numeric(14,2);
  v_stock_nue      numeric(14,2);
  v_permite_neg    boolean;
  v_sesion_abierta uuid;
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

  -- ----------------------------------------------------------
  -- CAMINO NUEVO: revertir una nota de crédito INTERNA.
  -- ----------------------------------------------------------
  -- Sin CAE y sin comprobante asociado, la nota nunca se declaró a AFIP. No hay
  -- nada que rectificar con un documento compensatorio: se revierte y listo.
  -- Con CAE, o con factura asociada, sigue sin poder anularse (cae en el RAISE
  -- de más abajo): eso sí es un documento fiscal y se corrige con otra nota.
  --
  -- La tercera condición es la que importa y no es obvia: sólo las notas
  -- CARGADAS A MANO. Anular un remito (o una factura sin CAE) genera una nota
  -- interna que cumple las dos primeras condiciones, pero esa nota NO es un
  -- documento independiente: es la mitad de una anulación que ya devolvió el
  -- stock y ya resolvió la plata. Revertirla dejaría la venta original en
  -- ANULADA con el stock descontado de nuevo y la caja cobrando dos veces.
  -- Se reconocen porque el original las apunta con venta_anulada_por.
  IF v_v.tipo_comprobante = 'NOTA_CREDITO'
     AND v_v.cae IS NULL
     AND v_v.afip_cbte_asoc_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.ventas o WHERE o.venta_anulada_por = v_v.id) THEN

    SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg
      FROM public.settings WHERE id = true;
    v_permite_neg := COALESCE(v_permite_neg, false)
                     OR public.puede_vender_sin_stock(v_uid);

    -- Prelock de los productos EN ORDEN DE id, igual que crear_venta: sin esto,
    -- una anulación y una venta simultáneas con los mismos productos en distinto
    -- orden se piden los locks cruzados y Postgres aborta una por deadlock.
    PERFORM 1 FROM public.productos p
      WHERE p.id IN (SELECT vi.producto_id FROM public.venta_items vi
                      WHERE vi.venta_id = v_v.id AND vi.producto_id IS NOT NULL)
      ORDER BY p.id FOR UPDATE;

    -- La nota REPUSO stock (entró mercadería devuelta). Revertirla lo saca.
    FOR r IN SELECT producto_id, cantidad, descripcion, codigo
               FROM public.venta_items
              WHERE venta_id = v_v.id AND producto_id IS NOT NULL AND cantidad > 0
    LOOP
      IF v_permite_neg THEN
        -- INSERT ... ON CONFLICT y no UPDATE pelado, igual que crear_venta: si
        -- no existe la fila de stock para ese producto en esa sucursal, un
        -- UPDATE no afecta nada y la reversión se perdería en silencio.
        INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
        VALUES (r.producto_id, v_v.sucursal_id, -r.cantidad)
        ON CONFLICT (producto_id, sucursal_id)
        DO UPDATE SET cantidad = stock_sucursal.cantidad - r.cantidad
        RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
      ELSE
        -- Misma regla que una venta: sin permiso de stock negativo no se puede
        -- sacar lo que no está. Si la mercadería devuelta ya se volvió a vender,
        -- el número no alcanza y hay que ajustarlo por el conteo físico.
        UPDATE public.stock_sucursal
           SET cantidad = cantidad - r.cantidad
         WHERE producto_id = r.producto_id AND sucursal_id = v_v.sucursal_id
           AND cantidad >= r.cantidad
        RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;

        IF NOT FOUND THEN
          SELECT COALESCE(cantidad, 0) INTO v_stock_ant
            FROM public.stock_sucursal
           WHERE producto_id = r.producto_id AND sucursal_id = v_v.sucursal_id;
          RAISE EXCEPTION 'No se puede anular: de % (%) hay % y la nota repuso %. Esa mercadería ya salió; ajustá el stock por conteo físico.',
            r.descripcion, r.codigo, COALESCE(v_stock_ant, 0), r.cantidad;
        END IF;
      END IF;

      INSERT INTO public.stock_movimientos (
        producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
        motivo, referencia_id, usuario_id
      ) VALUES (
        r.producto_id, v_v.sucursal_id, 'ANULACION_VENTA', -r.cantidad, v_stock_ant, v_stock_nue,
        'Anulación de nota de crédito interna ' || v_v.numero_comprobante, v_v.id, v_uid
      );
    END LOOP;

    -- El crédito que la nota le había dado al cliente deja de contar.
    UPDATE public.cuenta_corriente_movimientos
       SET estado = 'ANULADO'
     WHERE venta_id = v_v.id AND estado = 'CONFIRMADO';

    -- La plata que la nota le devolvió al cliente VUELVE a la caja.
    --
    -- Ojo con el detalle que hace toda la diferencia: venta_pagos NO tiene
    -- columna `estado` (a diferencia de proveedor_pagos), así que caja_esperado
    -- los sigue contando aunque la venta quede ANULADA. Por eso no se borran ni
    -- se editan los pagos viejos —su sesión puede estar cerrada desde ayer y el
    -- arqueo de ese día quedaría mal— sino que se compensa con un INGRESO nuevo
    -- en la caja de HOY. Es el mismo patrón que usa anular_compra.
    IF EXISTS (SELECT 1 FROM public.venta_pagos WHERE venta_id = v_v.id AND monto <> 0) THEN
      v_sesion_abierta := public.caja_sesion_actual(v_v.sucursal_id);

      FOR r IN SELECT forma_pago, ABS(monto) AS monto
                 FROM public.venta_pagos
                WHERE venta_id = v_v.id AND monto <> 0
      LOOP
        INSERT INTO public.caja_movimientos
          (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
        VALUES
          (v_sesion_abierta, 'INGRESO', r.forma_pago, r.monto,
           'Reversa de nota de crédito anulada ' || v_v.numero_comprobante, v_uid);
      END LOOP;
    END IF;

    UPDATE public.ventas SET estado = 'ANULADA' WHERE id = v_v.id;

    -- No se crea ningún comprobante compensatorio: se devuelve la nota misma,
    -- que es lo que el front muestra en el aviso.
    RETURN QUERY SELECT v_v.id, v_v.numero_comprobante;
    RETURN;
  END IF;

  IF v_v.tipo_comprobante NOT IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C',
                                  'REMITO', 'REMITO_OBRA', 'FAC_INTERNA_CTA_CTE') THEN
    RAISE EXCEPTION 'Una % no se anula (las notas se corrigen con otra nota)', v_v.tipo_comprobante;
  END IF;

  v_numero := public.next_comprobante_numero(v_v.sucursal_id, 'NOTA_CREDITO');

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, numero_comprobante, tipo_comprobante,
    condicion_venta, subtotal_sin_iva, iva_total, percepciones, total, total_pagado,
    estado_pago, observaciones, afip_cbte_asoc_id
  ) VALUES (
    v_v.sucursal_id, v_v.cliente_id, v_uid, v_numero, 'NOTA_CREDITO',
    'CONTADO', -v_v.subtotal_sin_iva, -v_v.iva_total, -v_v.percepciones,
    -v_v.total, -v_v.total_pagado,
    -- El estado de la NC replica cuánto se devolvió respecto de su total (misma
    -- lógica que crear_venta): si la venta original estaba totalmente cobrada, la
    -- devolución es total → PAGADO; si estaba PARCIAL, la NC queda PARCIAL; si era
    -- a cuenta (no se cobró), la NC sólo baja la deuda → PENDIENTE.
    CASE
      WHEN ABS(v_v.total_pagado) >= ABS(v_v.total) - 0.01 THEN 'PAGADO'::public.estado_pago
      WHEN ABS(v_v.total_pagado) > 0 THEN 'PARCIAL'::public.estado_pago
      ELSE 'PENDIENTE'::public.estado_pago
    END,
    CASE
      WHEN v_v.cae IS NOT NULL
        THEN 'Nota de crédito por anulación de ' || v_v.numero_comprobante
      ELSE 'Reversión interna de ' || v_v.numero_comprobante ||
           ' (no se había declarado a AFIP: no corresponde nota de crédito fiscal)'
    END,
    -- Sólo se asocia cuando hay algo declarado que rectificar. Un comprobante sin
    -- CAE nunca llegó a AFIP: su reversión es interna y no se emite. Si se
    -- asociara igual, quedaría un pendiente fiscal irresoluble.
    CASE WHEN v_v.cae IS NOT NULL THEN v_v.id ELSE NULL END
  ) RETURNING id INTO v_nc_id;

  -- La plata que se le devuelve al cliente SALE de la caja. Copiamos los pagos
  -- originales con el signo invertido: el arqueo (caja_esperado) los resta de la
  -- sesión donde ocurre la anulación (la NC se estampa a la caja abierta por el
  -- trigger). Sin esto, anular una venta cobrada en efectivo dejaba la caja
  -- esperando plata que ya no estaba. Una venta a cuenta corriente no tiene
  -- pagos, así que este INSERT no copia nada (la reversión va por el libro).
  INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
  SELECT v_nc_id, forma_pago, -monto, detalle
    FROM public.venta_pagos WHERE venta_id = v_v.id;

  INSERT INTO public.venta_items (
    venta_id, producto_id, codigo, descripcion, cantidad,
    precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
    subtotal_sin_iva, iva_monto, subtotal_con_iva
  )
  SELECT
    v_nc_id, producto_id, codigo, descripcion, cantidad,
    precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
    -subtotal_sin_iva, -iva_monto, -subtotal_con_iva
  FROM public.venta_items WHERE venta_id = v_v.id;

  UPDATE public.ventas
     SET estado = 'ANULADA', venta_anulada_por = v_nc_id
   WHERE id = v_v.id;

  -- Anula el movimiento de cuenta corriente que había generado la venta original.
  UPDATE public.cuenta_corriente_movimientos
     SET estado = 'ANULADO'
   WHERE venta_id = v_v.id AND estado = 'CONFIRMADO';

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
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid) TO service_role;
