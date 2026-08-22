-- ============================================================
-- Venta neutral atómica, conversión de presupuesto y anulación fiscal-aware.
--
-- El escritor comercial sigue siendo uno solo. VENTA agrega únicamente el
-- estado inicial de cola; emitir/reintentar/cobrar nunca vuelve a crear sus
-- items, pagos, deuda, caja ni movimientos de stock.
-- ============================================================

CREATE OR REPLACE FUNCTION public.next_comprobante_numero(
  _sucursal_id uuid,
  _tipo public.tipo_comprobante
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  _next integer;
  _prefix_suc text;
  _prefix_tipo text;
BEGIN
  INSERT INTO public.comprobante_secuencias AS cs(sucursal_id,tipo,ultimo_numero)
  VALUES (_sucursal_id,_tipo,1)
  ON CONFLICT (sucursal_id,tipo)
  DO UPDATE SET ultimo_numero=cs.ultimo_numero+1
  RETURNING ultimo_numero INTO _next;

  SELECT CASE codigo
           WHEN 'OHIGGINS' THEN 'OHI'
           WHEN 'GENERALPAZ' THEN 'GPZ'
         END
    INTO _prefix_suc
    FROM public.sucursales
   WHERE id=_sucursal_id;

  _prefix_tipo := CASE _tipo
    WHEN 'VENTA' THEN 'VTA'
    WHEN 'FACTURA_A' THEN 'FAIV'
    WHEN 'FACTURA_B' THEN 'FVTA'
    WHEN 'FACTURA_C' THEN 'FCIV'
    WHEN 'NOTA_CREDITO' THEN 'NCIV'
    WHEN 'NOTA_DEBITO' THEN 'NDIV'
    WHEN 'REMITO' THEN 'REM'
    WHEN 'REMITO_OBRA' THEN 'ROBR'
    WHEN 'FAC_INTERNA_CTA_CTE' THEN 'FICC'
  END;

  IF _prefix_suc IS NULL OR _prefix_tipo IS NULL THEN
    RAISE EXCEPTION 'No hay prefijo de numeración para (sucursal %, tipo %)',
      _sucursal_id,_tipo;
  END IF;

  RETURN _prefix_suc||'-'||_prefix_tipo||'-'||pg_catalog.lpad(_next::text,4,'0');
END;
$$;

-- Es un helper owner-only: no valida usuario/sucursal y sólo se invoca desde
-- RPC SECURITY DEFINER que sí hacen esas validaciones.
REVOKE ALL ON FUNCTION public.next_comprobante_numero(uuid,public.tipo_comprobante)
  FROM PUBLIC,anon,authenticated,service_role;


-- Copia completa de 20260813130000_nota_credito_sin_factura.sql.
-- Las únicas diferencias de dominio están marcadas como T4.
CREATE OR REPLACE FUNCTION public.crear_venta(
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

  -- T4: ambos gates se evalúan antes de numeración, productos o cualquier
  -- efecto comercial. El fast path anterior sigue siendo idempotente durante
  -- un cambio de flags porque no crea una operación nueva.
  SELECT s.facturacion_receptor_v2_enabled,s.facturacion_legacy_writer_enabled
    INTO v_v2_enabled,v_legacy_enabled
    FROM public.settings AS s
   WHERE s.id=true;
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
      'descripcion',v_prod.nombre,'cantidad',v_cant,'precio',v_precio,
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

REVOKE ALL ON FUNCTION public.crear_venta(
  uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,
  numeric,text,text,timestamptz,uuid,uuid
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.crear_venta(
  uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,
  numeric,text,text,timestamptz,uuid,uuid
) TO authenticated,service_role;


-- Nombre distinto durante la ventana de compatibilidad: PostgREST no tiene que
-- resolver un overload con defaults junto al conversor legacy.
CREATE OR REPLACE FUNCTION public.convertir_presupuesto_en_venta_neutral(
  p_presupuesto_id uuid,
  p_cliente_id uuid,
  p_condicion_venta public.condicion_venta,
  p_pagos jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS TABLE(venta_id uuid,numero text,es_cta_cte boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p public.presupuestos%ROWTYPE;
  v_items jsonb;
  v_res record;
  v_cambio text;
  v_clave uuid;
  v_pagado numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT p.* INTO v_p
    FROM public.presupuestos AS p
   WHERE p.id=p_presupuesto_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Presupuesto no encontrado';
  END IF;
  IF NOT public.is_admin(v_uid)
     AND v_p.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés convertir un presupuesto de otra sucursal';
  END IF;

  IF v_p.estado='CONVERTIDO' AND v_p.venta_id IS NOT NULL THEN
    IF v_p.cliente_id IS DISTINCT FROM p_cliente_id THEN
      RAISE EXCEPTION 'Este presupuesto ya se convirtió en una venta a nombre de otro cliente';
    END IF;
    RETURN QUERY
    SELECT v.id,v.numero_comprobante,(v.condicion_venta='CTA_CTE')
      FROM public.ventas AS v
     WHERE v.id=v_p.venta_id;
    RETURN;
  END IF;

  IF v_p.estado<>'ABIERTO' THEN
    RAISE EXCEPTION 'Este presupuesto ya está %',pg_catalog.lower(v_p.estado);
  END IF;
  IF p_cliente_id IS NULL THEN
    RAISE EXCEPTION 'Para convertir un presupuesto hay que elegir el cliente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.clientes AS c
     WHERE c.id=p_cliente_id AND c.activo
  ) THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  IF p_condicion_venta<>'CTA_CTE' AND v_p.total>=0.01 THEN
    SELECT COALESCE(pg_catalog.sum((x->>'monto')::numeric),0)
      INTO v_pagado
      FROM pg_catalog.jsonb_array_elements(COALESCE(p_pagos,'[]'::jsonb)) AS x;
    IF v_pagado<0.01 THEN
      RAISE EXCEPTION 'Una venta al contado se cobra, aunque sea una parte. Si se lo lleva sin pagar nada, poné cuenta corriente.';
    END IF;
  END IF;

  PERFORM 1 FROM public.productos AS p
   WHERE p.id IN (
     SELECT i.producto_id
       FROM public.presupuesto_items AS i
      WHERE i.presupuesto_id=p_presupuesto_id
   )
   ORDER BY p.id
   FOR UPDATE;

  SELECT pg_catalog.string_agg(i.codigo,', ')
    INTO v_cambio
    FROM public.presupuesto_items AS i
    JOIN public.productos AS p ON p.id=i.producto_id
   WHERE i.presupuesto_id=p_presupuesto_id
     AND p.iva_porcentaje IS DISTINCT FROM i.iva_porcentaje;
  IF v_cambio IS NOT NULL THEN
    RAISE EXCEPTION 'Cambió el IVA de: %. El total del presupuesto ya no es el que se cobraría: hacé un presupuesto nuevo.',
      v_cambio;
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(t.x ORDER BY t.x->>'producto_id'),'[]'::jsonb)
    INTO v_items
    FROM (
      SELECT pg_catalog.jsonb_build_object(
               'producto_id',i.producto_id,
               'cantidad',i.cantidad,
               'precio_unitario_sin_iva',i.precio_sin_iva
             ) AS x
        FROM public.presupuesto_items AS i
       WHERE i.presupuesto_id=p_presupuesto_id
    ) AS t;
  IF pg_catalog.jsonb_array_length(v_items)=0 THEN
    RAISE EXCEPTION 'El presupuesto no tiene productos';
  END IF;

  -- Se conserva la clave determinista vigente. El parámetro sigue en la firma
  -- por compatibilidad, pero no puede cambiar la identidad del presupuesto.
  -- La lectura explícita documenta ese contrato también para el analizador SQL.
  PERFORM p_idempotency_key;
  v_clave := pg_catalog.md5('presupuesto:'||p_presupuesto_id::text)::uuid;
  IF EXISTS (
    SELECT 1 FROM public.ventas AS v WHERE v.idempotency_key=v_clave
  ) THEN
    RAISE EXCEPTION 'Ya hay una venta cargada con la clave de este presupuesto. Revisala antes de convertirlo.';
  END IF;

  SELECT * INTO v_res
    FROM public.crear_venta(
      v_p.sucursal_id,p_cliente_id,'VENTA',p_condicion_venta,
      v_items,COALESCE(p_pagos,'[]'::jsonb),0,
      'Presupuesto '||v_p.numero,NULL,NULL,NULL,v_clave
    );

  UPDATE public.presupuestos
     SET estado='CONVERTIDO',venta_id=v_res.venta_id,cliente_id=p_cliente_id
   WHERE id=p_presupuesto_id;

  RETURN QUERY SELECT v_res.venta_id,v_res.numero,v_res.es_cta_cte;
END;
$$;

REVOKE ALL ON FUNCTION public.convertir_presupuesto_en_venta_neutral(
  uuid,uuid,public.condicion_venta,jsonb,uuid
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.convertir_presupuesto_en_venta_neutral(
  uuid,uuid,public.condicion_venta,jsonb,uuid
) TO authenticated,service_role;


CREATE OR REPLACE FUNCTION public.anular_venta(p_venta_id uuid)
RETURNS TABLE(nc_id uuid,nc_numero text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_v public.ventas%ROWTYPE;
  v_numero text;
  v_nc_id uuid;
  r record;
  v_stock_ant numeric(14,2);
  v_stock_nue numeric(14,2);
  v_permite_neg boolean;
  v_sesion_abierta uuid;
  v_nc_en_curso numeric(14,2);
  v_nc_pendientes integer;
  v_es_nc_fiscal boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- El lock precede toda decisión fiscal o comercial. Dos anulaciones del mismo
  -- original se serializan también con las NC asociadas que cuentan al límite.
  SELECT v.* INTO v_v
    FROM public.ventas AS v
   WHERE v.id=p_venta_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  IF NOT public.is_admin(v_uid)
     AND v_v.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés anular una venta de otra sucursal';
  END IF;
  IF v_v.estado='ANULADA' THEN
    RAISE EXCEPTION 'La venta ya fue anulada';
  END IF;
  IF v_v.afip_estado IN ('EMITIENDO','RECONCILIAR') THEN
    RAISE EXCEPTION 'No se puede anular mientras la emisión fiscal está %',
      v_v.afip_estado;
  END IF;

  -- Copia completa del caso vigente: una NC manual interna puede revertirse sin
  -- documento compensatorio. Las NC generadas por una anulación siguen
  -- protegidas por la referencia inversa del original.
  IF v_v.tipo_comprobante='NOTA_CREDITO'
     AND v_v.cae IS NULL
     AND v_v.afip_cbte_asoc_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.ventas AS o WHERE o.venta_anulada_por=v_v.id
     ) THEN
    SELECT COALESCE(s.permitir_stock_negativo,false) INTO v_permite_neg
      FROM public.settings AS s WHERE s.id=true;
    v_permite_neg := COALESCE(v_permite_neg,false)
                     OR public.puede_vender_sin_stock(v_uid);

    PERFORM 1 FROM public.productos AS p
     WHERE p.id IN (
       SELECT vi.producto_id FROM public.venta_items AS vi
        WHERE vi.venta_id=v_v.id AND vi.producto_id IS NOT NULL
     )
     ORDER BY p.id
     FOR UPDATE;

    FOR r IN
      SELECT vi.producto_id,vi.cantidad,vi.descripcion,vi.codigo
        FROM public.venta_items AS vi
       WHERE vi.venta_id=v_v.id
         AND vi.producto_id IS NOT NULL
         AND vi.cantidad>0
    LOOP
      IF v_permite_neg THEN
        INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
        VALUES (r.producto_id,v_v.sucursal_id,-r.cantidad)
        ON CONFLICT (producto_id,sucursal_id)
        DO UPDATE SET cantidad=public.stock_sucursal.cantidad-r.cantidad
        RETURNING cantidad+r.cantidad,cantidad INTO v_stock_ant,v_stock_nue;
      ELSE
        UPDATE public.stock_sucursal
           SET cantidad=cantidad-r.cantidad
         WHERE producto_id=r.producto_id
           AND sucursal_id=v_v.sucursal_id
           AND cantidad>=r.cantidad
        RETURNING cantidad+r.cantidad,cantidad INTO v_stock_ant,v_stock_nue;
        IF NOT FOUND THEN
          SELECT COALESCE(s.cantidad,0) INTO v_stock_ant
            FROM public.stock_sucursal AS s
           WHERE s.producto_id=r.producto_id
             AND s.sucursal_id=v_v.sucursal_id;
          RAISE EXCEPTION 'No se puede anular: de % (%) hay % y la nota repuso %. Esa mercadería ya salió; ajustá el stock por conteo físico.',
            r.descripcion,r.codigo,COALESCE(v_stock_ant,0),r.cantidad;
        END IF;
      END IF;

      INSERT INTO public.stock_movimientos(
        producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,
        motivo,referencia_id,usuario_id
      ) VALUES (
        r.producto_id,v_v.sucursal_id,'ANULACION_VENTA',-r.cantidad,
        v_stock_ant,v_stock_nue,
        'Anulación de nota de crédito interna '||v_v.numero_comprobante,
        v_v.id,v_uid
      );
    END LOOP;

    UPDATE public.cuenta_corriente_movimientos
       SET estado='ANULADO'
     WHERE venta_id=v_v.id AND estado='CONFIRMADO';

    IF EXISTS (
      SELECT 1 FROM public.venta_pagos AS vp
       WHERE vp.venta_id=v_v.id AND vp.monto<>0
    ) THEN
      v_sesion_abierta := public.caja_sesion_actual(v_v.sucursal_id);
      FOR r IN
        SELECT vp.forma_pago,ABS(vp.monto) AS monto
          FROM public.venta_pagos AS vp
         WHERE vp.venta_id=v_v.id AND vp.monto<>0
      LOOP
        INSERT INTO public.caja_movimientos(
          caja_sesion_id,tipo,forma_pago,monto,descripcion,usuario_id
        ) VALUES (
          v_sesion_abierta,'INGRESO',r.forma_pago,r.monto,
          'Reversa de nota de crédito anulada '||v_v.numero_comprobante,v_uid
        );
      END LOOP;
    END IF;

    UPDATE public.ventas SET estado='ANULADA' WHERE id=v_v.id;
    RETURN QUERY SELECT v_v.id,v_v.numero_comprobante;
    RETURN;
  END IF;

  -- Una VENTA neutral sin identidad ni incertidumbre no necesita otra venta-NC.
  -- La transición owner-only cambia el estado fiscal y esta misma transacción
  -- revierte stock/deuda/caja; cualquier fallo revierte ambas mitades.
  IF v_v.tipo_comprobante='VENTA' AND v_v.cae IS NULL THEN
    IF v_v.afip_estado NOT IN ('SIN_FACTURAR','ERROR_CORREGIBLE')
       OR v_v.afip_claim_token IS NOT NULL
       OR v_v.afip_claimed_at IS NOT NULL
       OR v_v.afip_fase IS NOT NULL
       OR v_v.afip_numero IS NOT NULL
       OR v_v.afip_snapshot IS NOT NULL
       OR v_v.afip_snapshot_hash IS NOT NULL THEN
      RAISE EXCEPTION 'La venta tiene evidencia fiscal o incertidumbre y no se puede anular automáticamente';
    END IF;

    PERFORM 1 FROM public.transicionar_emision_fiscal(
      v_v.id,'CANCELAR',NULL,
      pg_catalog.jsonb_build_object('expected_version',v_v.afip_version)
    );

    PERFORM 1 FROM public.productos AS p
     WHERE p.id IN (
       SELECT vi.producto_id FROM public.venta_items AS vi
        WHERE vi.venta_id=v_v.id AND vi.producto_id IS NOT NULL
     )
     ORDER BY p.id
     FOR UPDATE;

    FOR r IN
      SELECT vi.producto_id,vi.cantidad
        FROM public.venta_items AS vi
       WHERE vi.venta_id=v_v.id
         AND vi.producto_id IS NOT NULL
         AND vi.cantidad>0
    LOOP
      INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
      VALUES (r.producto_id,v_v.sucursal_id,r.cantidad)
      ON CONFLICT (producto_id,sucursal_id)
      DO UPDATE SET cantidad=public.stock_sucursal.cantidad+r.cantidad
      RETURNING cantidad-r.cantidad,cantidad INTO v_stock_ant,v_stock_nue;

      INSERT INTO public.stock_movimientos(
        producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,
        motivo,referencia_id,usuario_id
      ) VALUES (
        r.producto_id,v_v.sucursal_id,'ANULACION_VENTA',r.cantidad,
        v_stock_ant,v_stock_nue,'Anulación '||v_v.numero_comprobante,v_v.id,v_uid
      );
    END LOOP;

    UPDATE public.cuenta_corriente_movimientos
       SET estado='ANULADO'
     WHERE venta_id=v_v.id AND estado='CONFIRMADO';

    IF EXISTS (
      SELECT 1 FROM public.venta_pagos AS vp
       WHERE vp.venta_id=v_v.id AND vp.monto>0
    ) THEN
      v_sesion_abierta := public.caja_sesion_actual(v_v.sucursal_id);
      FOR r IN
        SELECT vp.forma_pago,vp.monto
          FROM public.venta_pagos AS vp
         WHERE vp.venta_id=v_v.id AND vp.monto>0
      LOOP
        INSERT INTO public.caja_movimientos(
          caja_sesion_id,tipo,forma_pago,monto,descripcion,usuario_id
        ) VALUES (
          v_sesion_abierta,'RETIRO',r.forma_pago,r.monto,
          'Devolución por anulación '||v_v.numero_comprobante,v_uid
        );
      END LOOP;
    END IF;

    UPDATE public.ventas
       SET estado='ANULADA',venta_anulada_por=NULL
     WHERE id=v_v.id;
    RETURN QUERY SELECT v_v.id,v_v.numero_comprobante;
    RETURN;
  END IF;

  IF v_v.tipo_comprobante NOT IN (
    'VENTA','FACTURA_A','FACTURA_B','FACTURA_C',
    'REMITO','REMITO_OBRA','FAC_INTERNA_CTA_CTE'
  ) THEN
    RAISE EXCEPTION 'Una % no se anula (las notas se corrigen con otra nota)',
      v_v.tipo_comprobante;
  END IF;

  IF v_v.cae IS NOT NULL THEN
    -- Sólo un aprobado de producción completo puede originar una NC automática.
    -- El receptor y toda la identidad se heredan por afip_cbte_asoc_id; nunca se
    -- releen del cliente ni se duplican en una fila pendiente mutable.
    IF v_v.afip_estado<>'APROBADO'
       OR v_v.afip_fase<>'PERSISTIDO'
       OR v_v.afip_version<2
       OR v_v.afip_legacy_incompleto
       OR v_v.afip_validez<>'PRODUCCION'
       OR v_v.afip_modo<>'PRODUCCION'
       OR v_v.afip_simulado
       OR v_v.afip_numero IS NULL
       OR v_v.afip_emisor_cuit IS NULL
       OR v_v.afip_punto_venta IS NULL
       OR v_v.afip_cbte_tipo NOT IN (1,6,11)
       OR v_v.afip_fecha_comprobante IS NULL
       OR v_v.afip_imp_total IS NULL
       OR pg_catalog.jsonb_typeof(v_v.afip_snapshot) IS DISTINCT FROM 'object'
       OR v_v.afip_snapshot->>'version' IS DISTINCT FROM '2'
       OR v_v.afip_snapshot_hash IS NULL
       OR v_v.afip_snapshot->>'hash' IS DISTINCT FROM v_v.afip_snapshot_hash
       OR pg_catalog.jsonb_typeof(v_v.afip_snapshot->'receptor') IS DISTINCT FROM 'object'
       OR v_v.afip_snapshot#>>'{identidad,numero}' IS DISTINCT FROM v_v.afip_numero::text
       OR v_v.afip_snapshot#>>'{identidad,emisorCuit}' IS DISTINCT FROM v_v.afip_emisor_cuit
       OR v_v.afip_snapshot#>>'{identidad,puntoVenta}' IS DISTINCT FROM v_v.afip_punto_venta::text
       OR v_v.afip_snapshot#>>'{identidad,cbteTipo}' IS DISTINCT FROM v_v.afip_cbte_tipo::text
       OR v_v.afip_snapshot#>>'{identidad,modo}' IS DISTINCT FROM v_v.afip_modo
       OR v_v.afip_snapshot#>'{identidad,simulado}' IS DISTINCT FROM 'false'::jsonb
       OR v_v.afip_snapshot->>'fechaComprobante'
            IS DISTINCT FROM v_v.afip_fecha_comprobante::text
       OR v_v.afip_snapshot->>'importeTotal' !~ '^(0|[1-9][0-9]*)\.[0-9]{2}$'
       OR (v_v.afip_snapshot->>'importeTotal')::numeric
            IS DISTINCT FROM ABS(v_v.afip_imp_total)
       OR ABS(v_v.afip_imp_total) IS DISTINCT FROM ABS(v_v.total) THEN
      IF v_v.afip_validez IS DISTINCT FROM 'PRODUCCION'
         OR v_v.afip_modo IS DISTINCT FROM 'PRODUCCION'
         OR v_v.afip_simulado THEN
        RAISE EXCEPTION 'Una NC de producción no puede asociarse a homologación o simulación';
      END IF;
      IF v_v.afip_legacy_incompleto OR v_v.afip_version<2 THEN
        RAISE EXCEPTION 'El comprobante original es legado incompleto y requiere conciliación manual antes de una NC';
      END IF;
      RAISE EXCEPTION 'El comprobante original no tiene identidad fiscal v2 completa y compatible';
    END IF;
    v_es_nc_fiscal := true;

    SELECT COALESCE(pg_catalog.sum(ABS(n.total)),0)
      INTO v_nc_en_curso
      FROM public.ventas AS n
     WHERE n.afip_cbte_asoc_id=v_v.id
       AND n.tipo_comprobante='NOTA_CREDITO'
       AND n.estado='ACTIVA'
       AND n.afip_estado IN ('EMITIENDO','RECONCILIAR','APROBADO');
    IF v_nc_en_curso+ABS(v_v.total)>ABS(v_v.total)+0.01 THEN
      RAISE EXCEPTION 'Las notas de crédito en curso/aprobadas superarían el total del comprobante original';
    END IF;

    SELECT count(*) INTO v_nc_pendientes
      FROM public.ventas AS n
     WHERE n.afip_cbte_asoc_id=v_v.id
       AND n.tipo_comprobante='NOTA_CREDITO'
       AND n.estado='ACTIVA'
       AND n.afip_estado IN ('SIN_FACTURAR','ERROR_CORREGIBLE');
    IF v_nc_pendientes>0 THEN
      RAISE EXCEPTION 'Ya existe una nota de crédito pendiente para este comprobante';
    END IF;
  END IF;

  v_numero := public.next_comprobante_numero(v_v.sucursal_id,'NOTA_CREDITO');
  INSERT INTO public.ventas(
    sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
    condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
    estado_pago,observaciones,afip_cbte_asoc_id,afip_estado
  ) VALUES (
    v_v.sucursal_id,v_v.cliente_id,v_uid,v_numero,'NOTA_CREDITO','CONTADO',
    -ABS(v_v.subtotal_sin_iva),-ABS(v_v.iva_total),-ABS(v_v.percepciones),
    -ABS(v_v.total),-ABS(v_v.total_pagado),
    CASE
      WHEN ABS(v_v.total_pagado)>=ABS(v_v.total)-0.01 THEN 'PAGADO'::public.estado_pago
      WHEN ABS(v_v.total_pagado)>0 THEN 'PARCIAL'::public.estado_pago
      ELSE 'PENDIENTE'::public.estado_pago
    END,
    CASE
      WHEN v_es_nc_fiscal
        THEN 'Nota de crédito por anulación de '||v_v.numero_comprobante||
             ' (receptor e identidad: COMPROBANTE_ORIGINAL)'
      ELSE 'Reversión interna de '||v_v.numero_comprobante||
           ' (no se había declarado a AFIP: no corresponde nota de crédito fiscal)'
    END,
    CASE WHEN v_es_nc_fiscal THEN v_v.id ELSE NULL END,
    CASE WHEN v_es_nc_fiscal THEN 'SIN_FACTURAR' ELSE 'NO_APLICA' END
  ) RETURNING id INTO v_nc_id;

  INSERT INTO public.venta_pagos(venta_id,forma_pago,monto,detalle)
  SELECT v_nc_id,vp.forma_pago,-vp.monto,vp.detalle
    FROM public.venta_pagos AS vp
   WHERE vp.venta_id=v_v.id;

  INSERT INTO public.venta_items(
    venta_id,producto_id,codigo,descripcion,cantidad,
    precio_unitario_sin_iva,precio_lista_sin_iva,iva_porcentaje,
    descuento_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
  )
  SELECT
    v_nc_id,vi.producto_id,vi.codigo,vi.descripcion,vi.cantidad,
    vi.precio_unitario_sin_iva,vi.precio_lista_sin_iva,vi.iva_porcentaje,
    vi.descuento_porcentaje,-ABS(vi.subtotal_sin_iva),-ABS(vi.iva_monto),
    -ABS(vi.subtotal_con_iva)
  FROM public.venta_items AS vi
  WHERE vi.venta_id=v_v.id;

  UPDATE public.ventas
     SET estado='ANULADA',venta_anulada_por=v_nc_id
   WHERE id=v_v.id;
  UPDATE public.cuenta_corriente_movimientos
     SET estado='ANULADO'
   WHERE venta_id=v_v.id AND estado='CONFIRMADO';

  PERFORM 1 FROM public.productos AS p
   WHERE p.id IN (
     SELECT vi.producto_id FROM public.venta_items AS vi
      WHERE vi.venta_id=v_v.id AND vi.producto_id IS NOT NULL
   )
   ORDER BY p.id
   FOR UPDATE;

  FOR r IN
    SELECT vi.producto_id,vi.cantidad
      FROM public.venta_items AS vi
     WHERE vi.venta_id=v_v.id AND vi.producto_id IS NOT NULL
  LOOP
    INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
    VALUES (r.producto_id,v_v.sucursal_id,r.cantidad)
    ON CONFLICT (producto_id,sucursal_id)
    DO UPDATE SET cantidad=public.stock_sucursal.cantidad+r.cantidad
    RETURNING cantidad-r.cantidad,cantidad INTO v_stock_ant,v_stock_nue;

    INSERT INTO public.stock_movimientos(
      producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,
      motivo,referencia_id,usuario_id
    ) VALUES (
      r.producto_id,v_v.sucursal_id,'ANULACION_VENTA',r.cantidad,
      v_stock_ant,v_stock_nue,'Anulación '||v_v.numero_comprobante,v_v.id,v_uid
    );
  END LOOP;

  RETURN QUERY SELECT v_nc_id,v_numero;
END;
$$;

REVOKE ALL ON FUNCTION public.anular_venta(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid)
  TO authenticated,service_role;
