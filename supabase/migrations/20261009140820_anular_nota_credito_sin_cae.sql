-- Una NC manual sin CAE real se puede revertir aunque haya asociado una factura.
-- La reversión es atómica: stock, crédito y compensación de pagos en la caja
-- actual. Las NC con CAE real y las generadas por anular_venta siguen excluidas.

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
  -- Revertir una nota de crédito manual sin CAE real.
  -- ----------------------------------------------------------
  -- Sin CAE real (o con uno simulado sin validez fiscal) la nota nunca fue
  -- autorizada por AFIP: se puede revertir aunque tenga una factura asociada.
  -- Con CAE real requiere una corrección fiscal y no se anula por este camino.
  --
  -- La tercera condición permite sólo las notas CARGADAS A MANO. Anular un
  -- remito (o una factura sin CAE) genera una nota que cumple las dos primeras
  -- condiciones, pero esa nota NO es un
  -- documento independiente: es la mitad de una anulación que ya devolvió el
  -- stock y ya resolvió la plata. Revertirla dejaría la venta original en
  -- ANULADA con el stock descontado de nuevo y la caja cobrando dos veces.
  -- Se reconocen porque el original las apunta con venta_anulada_por.
  IF v_v.tipo_comprobante = 'NOTA_CREDITO'
     AND (v_v.cae IS NULL OR v_v.afip_simulado)
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

REVOKE ALL ON FUNCTION public.anular_venta(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid) TO authenticated, service_role;
