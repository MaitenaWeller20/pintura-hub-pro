-- ============================================================
-- La nota de crédito de una anulación sólo es FISCAL si el original se declaró.
--
-- EL PROBLEMA QUE RESUELVE
-- anular_venta siempre estampaba afip_cbte_asoc_id = <la venta anulada>, tuviera
-- o no CAE. Cuando el original NO llegó a emitirse (una factura recién hecha que
-- se anula al toque, o cualquier remito), quedaba una nota de crédito que:
--
--   * se ve en el listado como comprobante fiscal "Sin emitir",
--   * muestra el botón de emitir,
--   * y al apretarlo falla SIEMPRE, porque emitirComprobante exige que el
--     asociado tenga CAE — y el original quedó ANULADA, así que ya no puede
--     obtenerlo nunca.
--
-- O sea: un documento fiscal pendiente imposible de resolver, para siempre, por
-- cada anulación de algo no facturado. Con el panel de pendientes que viene
-- después, además, ensuciarían la lista de "lo que falta emitir".
--
-- LA DECISIÓN
-- Si el comprobante original nunca se declaró a AFIP, no hay nada que rectificar
-- ante AFIP: la nota de crédito es puramente interna (revierte stock, caja y
-- cuenta corriente) y no lleva comprobante asociado. Sin afip_cbte_asoc_id, el
-- servidor y la UI la tratan como documento interno y no ofrecen emitirla.
--
-- La fila de la NC se sigue creando siempre: es la que carga los venta_pagos en
-- negativo de los que depende el arqueo de caja.
--
-- Nota sobre por qué NO se agregó un tipo de comprobante nuevo: tipo_comprobante
-- se compara contra 'NOTA_CREDITO' en más de cien lugares (crear_venta, signos,
-- cuenta corriente, dashboard, reportes). Un valor nuevo del enum se colaría en
-- todos ellos en silencio — por ejemplo el dashboard, que excluye las NC del
-- facturado con un .neq('tipo_comprobante','NOTA_CREDITO'), empezaría a restar
-- las internas. La ausencia de asociado dice lo mismo sin tocar esa superficie.
-- ============================================================

CREATE OR REPLACE FUNCTION public.anular_venta(p_venta_id uuid)
 RETURNS TABLE(nc_id uuid, nc_numero text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- ACÁ ESTÁ EL CAMBIO. Sólo se asocia cuando hay algo declarado que rectificar.
    -- Un comprobante sin CAE nunca llegó a AFIP: su reversión es interna y no se
    -- emite. Si se asociara igual, quedaría un pendiente fiscal irresoluble.
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
END; $function$;

REVOKE ALL ON FUNCTION public.anular_venta(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid) TO service_role;


-- ------------------------------------------------------------
-- Limpieza de las que ya quedaron colgadas
-- ------------------------------------------------------------
-- Notas de crédito ya existentes cuyo comprobante asociado nunca obtuvo CAE:
-- hoy muestran el botón de emitir y fallan siempre. Se les saca la asociación
-- para que pasen a ser lo que realmente son, reversiones internas.
--
-- El WHERE es deliberadamente angosto. Sólo toca las NC que generó una ANULACIÓN,
-- reconocibles porque el original las apunta con venta_anulada_por. Una NC cargada
-- A MANO desde "Nueva venta" también puede estar asociada a una factura sin CAE
-- todavía (el selector no exige que esté emitida), y ésa NO hay que tocarla: es un
-- flujo válido, primero se emite la factura y después su nota. Desasociarla sería
-- romperle el CbtesAsoc.
--
-- Tampoco toca ninguna NC que ya tenga CAE propio: eso no se altera nunca.
DO $$
DECLARE v_n integer;
BEGIN
  UPDATE public.ventas nc
     SET afip_cbte_asoc_id = NULL,
         observaciones = COALESCE(nc.observaciones, '') ||
           ' [reversión interna: el comprobante original nunca se declaró a AFIP]'
    FROM public.ventas orig
   WHERE nc.afip_cbte_asoc_id = orig.id
     AND nc.tipo_comprobante = 'NOTA_CREDITO'
     AND nc.cae IS NULL
     AND orig.cae IS NULL
     AND orig.venta_anulada_por = nc.id;   -- la generó anular_venta, no un usuario
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Notas de crédito de anulación reclasificadas como internas: %', v_n;
END $$;
