-- Las notas de crédito manuales sin factura son documentos internos: conservan
-- sus efectos comerciales, pero no se asocian ni se envían a ARCA. Las notas
-- fiscales asociadas de v2 siguen naciendo exclusivamente por anular_venta.
--
-- Se parte del último core vigente (20260830151434) para preservar también las
-- descripciones personalizadas de cada renglón.

CREATE OR REPLACE FUNCTION public._crear_venta_core_20260823(
  p_sucursal_id uuid,
  p_cliente_id uuid,
  p_tipo_comprobante public.tipo_comprobante,
  p_condicion_venta public.condicion_venta,
  p_items jsonb,
  p_pagos jsonb,
  p_percepciones numeric DEFAULT 0,
  p_observaciones text DEFAULT NULL::text,
  p_nombre_obra text DEFAULT NULL::text,
  p_fecha timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_cbte_asoc_id uuid DEFAULT NULL::uuid,
  p_idempotency_key uuid DEFAULT NULL::uuid
)
RETURNS TABLE(venta_id uuid,numero text,es_cta_cte boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
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
  v_no_efec_ins    numeric(14,2) := 0;
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
  v_descripcion     text;
  v_fallback_descripcion text;
  v_saldo_actual   numeric(14,2);
  v_monto          numeric(14,2);
  v_forma          public.forma_pago;
  v_iva_libre      numeric(5,2);
  v_qty_total      numeric(14,2) := 0;
  v_es_fiscal      boolean;
  v_ex             public.ventas%ROWTYPE;
  v_v2_enabled     boolean;
  v_legacy_enabled boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- El cerco vive antes del replay idempotente y de cualquier mutación. Una NC
  -- sin asociación es interna y no depende de un writer fiscal. Una NC
  -- asociada sí es fiscal: en v2 sólo puede generarla anular_venta.
  SELECT s.facturacion_receptor_v2_enabled,s.facturacion_legacy_writer_enabled
    INTO v_v2_enabled,v_legacy_enabled
    FROM public.settings AS s
   WHERE s.id=true;
  IF p_tipo_comprobante='NOTA_CREDITO' THEN
    IF p_cbte_asoc_id IS NOT NULL THEN
      IF COALESCE(v_v2_enabled,false) THEN
        RAISE EXCEPTION 'La nota de crédito v2 se crea exclusivamente mediante anular_venta';
      END IF;
      IF NOT COALESCE(v_legacy_enabled,false) THEN
        RAISE EXCEPTION 'El escritor fiscal legacy está deshabilitado';
      END IF;
    END IF;
  ELSIF p_tipo_comprobante='NOTA_DEBITO' THEN
    IF COALESCE(v_v2_enabled,false) THEN
      RAISE EXCEPTION 'La nota de débito nueva queda fuera de alcance fiscal';
    END IF;
    IF NOT COALESCE(v_legacy_enabled,false) THEN
      RAISE EXCEPTION 'El escritor fiscal legacy está deshabilitado';
    END IF;
  END IF;

  -- T4: el replay toma lock sobre la fila real. Sólo repara una VENTA versión
  -- 0 totalmente virgen; cualquier evidencia o estado durable se preserva.
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_idempotency_key::text,0)
    );
    SELECT v.* INTO v_ex
      FROM public.ventas AS v
     WHERE v.idempotency_key=p_idempotency_key
     FOR UPDATE;
    IF FOUND THEN
      IF v_ex.tipo_comprobante='VENTA'
         AND v_ex.estado='ACTIVA'
         AND v_ex.afip_estado IN ('PENDIENTE','NO_APLICA')
         AND v_ex.afip_version=0
         AND v_ex.afip_intentos=0
         AND v_ex.afip_cbte_asoc_id IS NULL
         AND v_ex.venta_anulada_por IS NULL
         AND NOT v_ex.afip_legacy_incompleto
         AND NOT v_ex.afip_simulado
         AND v_ex.cae IS NULL
         AND v_ex.cae_vencimiento IS NULL
         AND v_ex.afip_numero IS NULL
         AND v_ex.afip_claim_token IS NULL
         AND v_ex.afip_claimed_at IS NULL
         AND v_ex.afip_fase IS NULL
         AND v_ex.afip_snapshot IS NULL
         AND v_ex.afip_snapshot_hash IS NULL
         AND v_ex.afip_emisor_cuit IS NULL
         AND v_ex.afip_punto_venta IS NULL
         AND v_ex.afip_cbte_tipo IS NULL
         AND v_ex.afip_modo IS NULL
         AND v_ex.afip_validez IS NULL
         AND v_ex.afip_fecha_comprobante IS NULL
         AND v_ex.afip_imp_total IS NULL
         AND v_ex.afip_emitido_at IS NULL
         AND v_ex.afip_error IS NULL
         AND v_ex.afip_error_clase IS NULL
         AND v_ex.afip_error_codigo IS NULL
         AND v_ex.afip_error_fase IS NULL
         AND v_ex.afip_ultimo_error_at IS NULL THEN
        UPDATE public.ventas
           SET afip_estado='SIN_FACTURAR'
         WHERE id=v_ex.id;
      END IF;
      RETURN QUERY
      SELECT v_ex.id,v_ex.numero_comprobante,
             (v_ex.condicion_venta='CTA_CTE');
      RETURN;
    END IF;
  END IF;

  -- T4: para VENTA y facturas, el fast path anterior sigue siendo
  -- idempotente durante un cambio de flags porque no crea una operación nueva.
  IF p_tipo_comprobante='VENTA' AND NOT COALESCE(v_v2_enabled,false) THEN
    RAISE EXCEPTION 'El flujo de receptor fiscal v2 está deshabilitado';
  END IF;
  IF p_tipo_comprobante IN ('FACTURA_A','FACTURA_B','FACTURA_C')
     AND NOT COALESCE(v_legacy_enabled,false) THEN
    RAISE EXCEPTION 'El escritor fiscal legacy está deshabilitado';
  END IF;

  IF NOT public.is_admin(v_uid)
     AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés facturar en una sucursal que no es la tuya';
  END IF;

  IF p_cliente_id IS NULL AND p_tipo_comprobante='REMITO_OBRA' THEN
    v_cliente_id := public.resolver_cliente_obra(p_nombre_obra);
  ELSE
    v_cliente_id := p_cliente_id;
  END IF;

  IF v_cliente_id IS NULL THEN
    RAISE EXCEPTION 'Elegí el cliente';
  END IF;

  SELECT c.* INTO v_cliente
    FROM public.clientes AS c
   WHERE c.id=v_cliente_id AND c.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  IF p_tipo_comprobante='FAC_INTERNA_CTA_CTE' THEN
    p_condicion_venta := 'CONTADO';
  END IF;

  IF p_tipo_comprobante='FACTURA_A'
     AND v_cliente.tipo<>'RESPONSABLE_INSCRIPTO' THEN
    RAISE EXCEPTION 'No se puede emitir Factura A a % (condición %): la Factura A es sólo para Responsables Inscriptos',
      v_cliente.razon_social,v_cliente.tipo;
  END IF;

  IF p_fecha IS NOT NULL THEN
    IF p_fecha>pg_catalog.now()+interval '1 day' THEN
      RAISE EXCEPTION 'La fecha del comprobante no puede ser futura';
    END IF;
    IF p_fecha<pg_catalog.now()-interval '5 years' THEN
      RAISE EXCEPTION 'La fecha del comprobante es demasiado antigua';
    END IF;
  END IF;

  IF COALESCE(p_percepciones,0)<0 THEN
    RAISE EXCEPTION 'Las percepciones no pueden ser negativas';
  END IF;

  SELECT COALESCE(s.permitir_stock_negativo,false) INTO v_permite_neg
    FROM public.settings AS s WHERE s.id=true;
  v_permite_neg := COALESCE(v_permite_neg,false)
                   OR public.puede_vender_sin_stock(v_uid);

  v_signo := CASE WHEN p_tipo_comprobante='NOTA_CREDITO' THEN -1 ELSE 1 END;

  IF p_tipo_comprobante IN ('NOTA_CREDITO','NOTA_DEBITO') THEN
    IF p_tipo_comprobante='NOTA_DEBITO' AND p_cbte_asoc_id IS NULL THEN
      RAISE EXCEPTION 'Una nota de débito tiene que indicar la factura que recarga';
    END IF;
    IF p_cbte_asoc_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.ventas AS v
       WHERE v.id=p_cbte_asoc_id
         AND v.cliente_id=v_cliente_id
         AND v.tipo_comprobante IN ('FACTURA_A','FACTURA_B','FACTURA_C')
    ) THEN
      RAISE EXCEPTION 'El comprobante a rectificar no existe o no es una factura de este cliente';
    END IF;
  END IF;

  v_es_cta_cte := p_tipo_comprobante IN ('REMITO','REMITO_OBRA')
                  OR p_condicion_venta='CTA_CTE';

  IF v_es_cta_cte
     AND p_tipo_comprobante NOT IN ('NOTA_CREDITO','NOTA_DEBITO')
     AND NOT COALESCE(v_cliente.es_obra,false)
     AND NOT COALESCE(v_cliente.condicion_cta_cte,false) THEN
    RAISE EXCEPTION 'El cliente % no tiene cuenta corriente habilitada',
      v_cliente.razon_social;
  END IF;

  PERFORM 1 FROM public.productos AS p
   WHERE p.id IN (
     SELECT (value->>'producto_id')::uuid
       FROM pg_catalog.jsonb_array_elements(COALESCE(p_items,'[]'::jsonb))
      WHERE value->>'producto_id' IS NOT NULL
   )
   ORDER BY p.id
   FOR UPDATE;

  FOR it IN
    SELECT * FROM pg_catalog.jsonb_array_elements(COALESCE(p_items,'[]'::jsonb))
  LOOP
    IF (it->>'producto_id') IS NULL THEN
      IF p_tipo_comprobante<>'NOTA_DEBITO' THEN
        RAISE EXCEPTION 'Sólo la Nota de Débito admite líneas sin producto (recargo/interés)';
      END IF;

      v_cant := COALESCE((it->>'cantidad')::numeric,1);
      IF v_cant<=0 THEN
        RAISE EXCEPTION 'La línea de recargo necesita una cantidad mayor a cero';
      END IF;
      v_precio := (it->>'precio_unitario_sin_iva')::numeric;
      IF v_precio IS NULL OR v_precio<0 THEN
        RAISE EXCEPTION 'La línea de recargo necesita un precio válido';
      END IF;
      v_iva_libre := COALESCE((it->>'iva_porcentaje')::numeric,21);
      IF v_iva_libre<0 OR v_iva_libre>100 THEN
        RAISE EXCEPTION 'IVA inválido en la línea de recargo';
      END IF;

      v_qty_total := v_qty_total+v_cant;
      v_sub_item := pg_catalog.round(v_precio*v_cant,2);
      v_iva_item := pg_catalog.round(v_sub_item*v_iva_libre/100,2);
      v_sub_sin_iva := v_sub_sin_iva+v_sub_item;
      v_iva_total := v_iva_total+v_iva_item;
      v_calc := v_calc||pg_catalog.jsonb_build_object(
        'producto_id',NULL,'codigo','RECARGO',
        'descripcion',COALESCE(NULLIF(it->>'descripcion',''),'Recargo'),
        'cantidad',v_cant,'precio',v_precio,'precio_lista',v_precio,
        'iva_porcentaje',v_iva_libre,'descuento',0,
        'sub_item',v_sub_item,'iva_item',v_iva_item
      );
      CONTINUE;
    END IF;

    SELECT p.* INTO v_prod
      FROM public.productos AS p
     WHERE p.id=(it->>'producto_id')::uuid AND p.activo
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto % inexistente o inactivo',it->>'producto_id';
    END IF;

    v_fallback_descripcion := v_prod.nombre;
    v_descripcion := public._normalizar_descripcion_item_20260830(
      it->>'descripcion',
      v_fallback_descripcion,
      it ? 'descripcion'
    );

    v_cant := COALESCE((it->>'cantidad')::numeric,0);
    v_desc := LEAST(GREATEST(COALESCE((it->>'descuento_porcentaje')::numeric,0),0),100);
    IF v_cant<0 THEN
      RAISE EXCEPTION 'Cantidad negativa en el producto %',v_prod.codigo;
    END IF;

    v_qty_total := v_qty_total+v_cant;
    v_precio_lista := v_prod.precio_sin_iva;
    v_precio := COALESCE((it->>'precio_unitario_sin_iva')::numeric,v_precio_lista);
    IF v_precio<0 THEN
      RAISE EXCEPTION 'Precio negativo en el producto %',v_prod.codigo;
    END IF;

    v_sub_item := pg_catalog.round(v_precio*(1-v_desc/100)*v_cant,2)*v_signo;
    v_iva_item := pg_catalog.round(v_sub_item*v_prod.iva_porcentaje/100,2);
    v_sub_sin_iva := v_sub_sin_iva+v_sub_item;
    v_iva_total := v_iva_total+v_iva_item;
    v_calc := v_calc||pg_catalog.jsonb_build_object(
      'producto_id',v_prod.id,'codigo',v_prod.codigo,
      'descripcion',v_descripcion,'cantidad',v_cant,'precio',v_precio,
      'precio_lista',v_precio_lista,'iva_porcentaje',v_prod.iva_porcentaje,
      'descuento',v_desc,'sub_item',v_sub_item,'iva_item',v_iva_item
    );
  END LOOP;

  v_percepciones := pg_catalog.round(COALESCE(p_percepciones,0),2)*v_signo;
  v_total := pg_catalog.round(v_sub_sin_iva+v_iva_total+v_percepciones,2);

  -- T4: VENTA usa las mismas validaciones positivas que una factura.
  v_es_fiscal := p_tipo_comprobante IN (
    'VENTA','FACTURA_A','FACTURA_B','FACTURA_C','NOTA_CREDITO','NOTA_DEBITO'
  );
  IF v_qty_total<=0 THEN
    RAISE EXCEPTION 'El comprobante necesita al menos un ítem con cantidad mayor a cero';
  END IF;
  IF v_es_fiscal AND ABS(v_total)<0.01 THEN
    RAISE EXCEPTION 'El total de un comprobante fiscal debe ser distinto de cero';
  END IF;

  IF NOT v_es_cta_cte THEN
    FOR pg IN
      SELECT * FROM pg_catalog.jsonb_array_elements(COALESCE(p_pagos,'[]'::jsonb))
    LOOP
      v_monto := COALESCE((pg->>'monto')::numeric,0);
      IF v_monto<0 THEN
        RAISE EXCEPTION 'Un pago no puede ser negativo';
      END IF;
      IF (pg->>'forma_pago')::public.forma_pago='CTA_CTE' THEN
        RAISE EXCEPTION 'CTA_CTE no es una forma de pago. Para vender a cuenta corriente usá la condición de venta CTA_CTE.';
      END IF;
      v_pagos_suma := v_pagos_suma+v_monto;
      IF (pg->>'forma_pago')::public.forma_pago<>'EFECTIVO' THEN
        v_pagos_no_efec := v_pagos_no_efec+v_monto;
      END IF;
    END LOOP;

    IF v_pagos_no_efec>ABS(v_total)+0.01 THEN
      RAISE EXCEPTION 'Los pagos electrónicos (%) superan el total del comprobante (%). Sólo el efectivo admite vuelto.',
        v_pagos_no_efec,ABS(v_total);
    END IF;
    IF v_pagos_suma>ABS(v_total) THEN
      v_vuelto := pg_catalog.round(v_pagos_suma-ABS(v_total),2);
    END IF;
    v_total_pagado := pg_catalog.round(LEAST(v_pagos_suma,ABS(v_total)),2)*v_signo;

    IF p_tipo_comprobante NOT IN ('NOTA_CREDITO','NOTA_DEBITO')
       AND ABS(v_total)>=0.01
       AND v_pagos_suma<0.01 THEN
      RAISE EXCEPTION 'Una venta al contado se cobra, aunque sea una parte. Si se lo lleva sin pagar nada, hacela por cuenta corriente.';
    END IF;
    IF p_tipo_comprobante='NOTA_CREDITO'
       AND ABS(v_total)>=0.01
       AND v_pagos_suma<0.01 THEN
      RAISE EXCEPTION 'Una nota de crédito al contado le devuelve la plata al cliente: indicá con qué se la devolvés. Si en vez de eso le queda como saldo a favor, hacela por cuenta corriente.';
    END IF;
  END IF;

  v_estado_pago := CASE
    WHEN v_es_cta_cte THEN 'PENDIENTE'::public.estado_pago
    WHEN ABS(v_total_pagado)>=ABS(v_total)-0.01 THEN 'PAGADO'::public.estado_pago
    WHEN ABS(v_total_pagado)>0 THEN 'PARCIAL'::public.estado_pago
    ELSE 'PENDIENTE'::public.estado_pago
  END;

  IF v_es_cta_cte
     AND v_cliente.limite_credito IS NOT NULL
     AND v_signo>0
     AND p_tipo_comprobante<>'NOTA_CREDITO' THEN
    v_saldo_actual := public.cc_saldo(v_cliente_id);
    IF v_saldo_actual+ABS(v_total)>v_cliente.limite_credito THEN
      RAISE EXCEPTION 'Supera el límite de crédito del cliente (límite %, saldo actual %, esta venta %)',
        v_cliente.limite_credito,v_saldo_actual,ABS(v_total);
    END IF;
  END IF;

  v_numero := public.next_comprobante_numero(p_sucursal_id,p_tipo_comprobante);

  INSERT INTO public.ventas(
    sucursal_id,cliente_id,usuario_id,fecha,numero_comprobante,tipo_comprobante,
    condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
    estado_pago,observaciones,nombre_obra,afip_cbte_asoc_id,idempotency_key,
    afip_estado
  ) VALUES (
    p_sucursal_id,v_cliente_id,v_uid,COALESCE(p_fecha,pg_catalog.now()),
    v_numero,p_tipo_comprobante,
    CASE WHEN v_es_cta_cte THEN 'CTA_CTE'::public.condicion_venta ELSE p_condicion_venta END,
    v_sub_sin_iva,v_iva_total,v_percepciones,v_total,v_total_pagado,
    v_estado_pago,p_observaciones,p_nombre_obra,p_cbte_asoc_id,p_idempotency_key,
    CASE
      WHEN p_tipo_comprobante='VENTA' THEN 'SIN_FACTURAR'
      WHEN p_tipo_comprobante IN ('REMITO','REMITO_OBRA','FAC_INTERNA_CTA_CTE')
        OR (p_tipo_comprobante='NOTA_CREDITO' AND p_cbte_asoc_id IS NULL)
        THEN 'NO_APLICA'
      ELSE 'PENDIENTE'
    END
  ) RETURNING id,caja_sesion_id INTO v_venta_id,v_sesion_caja;

  FOR it IN SELECT * FROM pg_catalog.jsonb_array_elements(v_calc)
  LOOP
    v_cant := (it->>'cantidad')::numeric;
    INSERT INTO public.venta_items(
      venta_id,producto_id,codigo,descripcion,cantidad,
      precio_unitario_sin_iva,precio_lista_sin_iva,iva_porcentaje,
      descuento_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
    ) VALUES (
      v_venta_id,(it->>'producto_id')::uuid,it->>'codigo',it->>'descripcion',v_cant,
      (it->>'precio')::numeric,(it->>'precio_lista')::numeric,
      (it->>'iva_porcentaje')::numeric,(it->>'descuento')::numeric,
      (it->>'sub_item')::numeric,(it->>'iva_item')::numeric,
      (it->>'sub_item')::numeric+(it->>'iva_item')::numeric
    );

    CONTINUE WHEN v_cant=0;
    CONTINUE WHEN p_tipo_comprobante='NOTA_DEBITO';

    IF p_tipo_comprobante='NOTA_CREDITO' THEN
      INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
      VALUES ((it->>'producto_id')::uuid,p_sucursal_id,v_cant)
      ON CONFLICT (producto_id,sucursal_id)
      DO UPDATE SET cantidad=public.stock_sucursal.cantidad+v_cant
      RETURNING cantidad-v_cant,cantidad INTO v_stock_ant,v_stock_nue;

      INSERT INTO public.stock_movimientos(
        producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,
        motivo,referencia_id,usuario_id
      ) VALUES (
        (it->>'producto_id')::uuid,p_sucursal_id,'DEVOLUCION',v_cant,
        v_stock_ant,v_stock_nue,p_tipo_comprobante::text||' '||v_numero,
        v_venta_id,v_uid
      );
      CONTINUE;
    END IF;

    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
      VALUES ((it->>'producto_id')::uuid,p_sucursal_id,-v_cant)
      ON CONFLICT (producto_id,sucursal_id)
      DO UPDATE SET cantidad=public.stock_sucursal.cantidad-v_cant
      RETURNING cantidad+v_cant,cantidad INTO v_stock_ant,v_stock_nue;
    ELSE
      UPDATE public.stock_sucursal
         SET cantidad=cantidad-v_cant
       WHERE producto_id=(it->>'producto_id')::uuid
         AND sucursal_id=p_sucursal_id
         AND cantidad>=v_cant
      RETURNING cantidad+v_cant,cantidad INTO v_stock_ant,v_stock_nue;
      IF NOT FOUND THEN
        SELECT COALESCE(s.cantidad,0) INTO v_stock_ant
          FROM public.stock_sucursal AS s
         WHERE s.producto_id=(it->>'producto_id')::uuid
           AND s.sucursal_id=p_sucursal_id;
        RAISE EXCEPTION 'Stock insuficiente de % (%): hay %, se piden %',
          it->>'descripcion',it->>'codigo',COALESCE(v_stock_ant,0),v_cant;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos(
      producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,
      motivo,referencia_id,usuario_id
    ) VALUES (
      (it->>'producto_id')::uuid,p_sucursal_id,'VENTA',-v_cant,
      v_stock_ant,v_stock_nue,p_tipo_comprobante::text||' '||v_numero,
      v_venta_id,v_uid
    );
  END LOOP;

  IF NOT v_es_cta_cte THEN
    FOR pg IN
      SELECT * FROM pg_catalog.jsonb_array_elements(COALESCE(p_pagos,'[]'::jsonb))
    LOOP
      v_monto := pg_catalog.round(ABS(COALESCE((pg->>'monto')::numeric,0)),2);
      v_forma := (pg->>'forma_pago')::public.forma_pago;
      IF v_forma='EFECTIVO' THEN
        IF v_vuelto>0 THEN
          IF v_monto>=v_vuelto THEN
            v_monto := v_monto-v_vuelto;
            v_vuelto := 0;
          ELSE
            v_vuelto := v_vuelto-v_monto;
            v_monto := 0;
          END IF;
        END IF;
      ELSE
        v_monto := GREATEST(LEAST(v_monto,ABS(v_total)-v_no_efec_ins),0);
        v_no_efec_ins := v_no_efec_ins+v_monto;
      END IF;

      CONTINUE WHEN v_monto=0;
      IF v_signo<0 AND v_forma='EFECTIVO' THEN
        PERFORM public.exigir_efectivo(
          p_sucursal_id,v_sesion_caja,v_monto,'devolverle la plata al cliente'
        );
      END IF;
      INSERT INTO public.venta_pagos(venta_id,forma_pago,monto,detalle)
      VALUES (
        v_venta_id,v_forma,v_monto*v_signo,COALESCE(pg->'detalle','{}'::jsonb)
      );
    END LOOP;
  END IF;

  IF v_es_cta_cte THEN
    PERFORM public.cc_registrar_por_venta(v_venta_id);
  END IF;

  RETURN QUERY SELECT v_venta_id,v_numero,v_es_cta_cte;
END;
$$;

REVOKE ALL ON FUNCTION public._crear_venta_core_20260823(
  uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,
  numeric,text,text,timestamptz,uuid,uuid
) FROM PUBLIC,anon,authenticated,service_role;

COMMENT ON FUNCTION public._crear_venta_core_20260823(
  uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,
  numeric,text,text,timestamptz,uuid,uuid
) IS 'Core comercial owner-only. Admite NC internas sin factura; las NC fiscales v2 sólo se crean mediante anular_venta.';
