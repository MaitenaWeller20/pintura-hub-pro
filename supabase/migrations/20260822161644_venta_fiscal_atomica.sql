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


-- Copia forward de la única máquina de estados de Task 3. T4 agrega
-- herencia fail-closed para NC, serialización con el original y CANCELAR legacy.
CREATE OR REPLACE FUNCTION public.transicionar_emision_fiscal(
  p_venta_id uuid,
  p_accion text,
  p_claim_token uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  venta_id uuid,
  afip_estado text,
  afip_fase text,
  afip_claim_token uuid,
  afip_numero integer,
  afip_version integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_venta public.ventas%ROWTYPE;
  v_original public.ventas%ROWTYPE;
  v_intento public.emision_fiscal_intentos%ROWTYPE;
  v_tipo_pre public.tipo_comprobante;
  v_asoc_pre uuid;
  v_acciones constant text[] := ARRAY[
    'RECLAMAR','RESERVAR','REQUEST_INICIADO','RESPUESTA_RECIBIDA','APROBAR',
    'ERROR_CORREGIBLE','RECONCILIAR','REENVIO_VERIFICADO','LIBERAR',
    'CANCELAR','BLOQUEAR'
  ];
  v_permitidas text[];
  v_requeridas text[];
  v_desconocidas text[];
  v_faltantes text[];
  v_expected integer;
  v_rows integer;
  v_lease integer;
  v_snapshot jsonb;
  v_snapshot_hash text;
  v_hash_recalculado text;
  v_numero integer;
  v_emisor_cuit text;
  v_punto_venta integer;
  v_cbte_tipo integer;
  v_modo text;
  v_simulado boolean;
  v_validez text;
  v_fecha date;
  v_ultimo_remoto integer;
  v_ultimo_local_observado integer;
  v_max_local integer;
  v_imp_total numeric(14,2);
  v_resumen jsonb;
  v_resumen_claves text[];
  v_observacion jsonb;
  v_nuevo_claim uuid;
  v_liberar_identidad boolean;
  v_cancel_legacy boolean;
  v_cbte_asoc jsonb;
  v_cbte_nc_esperado integer;
  v_original_hash text;
BEGIN
  -- Una NC asociada comparte frontera de lock con su original. El pre-read no
  -- autoriza nada: sólo permite tomar los locks siempre en orden original→NC;
  -- la relación se vuelve a validar después de bloquear ambas filas.
  SELECT v.tipo_comprobante,v.afip_cbte_asoc_id
    INTO v_tipo_pre,v_asoc_pre
    FROM public.ventas AS v
   WHERE v.id=p_venta_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta fiscal inexistente: %',p_venta_id;
  END IF;
  IF v_tipo_pre='NOTA_CREDITO' AND v_asoc_pre IS NOT NULL THEN
    SELECT o.* INTO v_original
      FROM public.ventas AS o
     WHERE o.id=v_asoc_pre
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'NC asociada: el comprobante original no existe';
    END IF;
  END IF;

  SELECT v.* INTO v_venta
    FROM public.ventas AS v
   WHERE v.id=p_venta_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta fiscal inexistente: %',p_venta_id;
  END IF;
  IF v_venta.tipo_comprobante='NOTA_CREDITO'
     AND v_venta.afip_cbte_asoc_id IS NOT NULL
     AND (
       v_original.id IS NULL
       OR v_venta.afip_cbte_asoc_id IS DISTINCT FROM v_original.id
     ) THEN
    RAISE EXCEPTION 'NC asociada: la asociación cambió durante la toma de locks; reintentar';
  END IF;

  IF p_accion IS NULL OR NOT (p_accion=ANY(v_acciones)) THEN
    RAISE EXCEPTION 'Acción fiscal no válida: %',COALESCE(p_accion,'NULL');
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload)<>'object' THEN
    RAISE EXCEPTION 'El payload fiscal debe ser un objeto JSON';
  END IF;

  CASE p_accion
    WHEN 'RECLAMAR' THEN
      v_permitidas := ARRAY['expected_version','lease_segundos'];
      v_requeridas := v_permitidas;
    WHEN 'RESERVAR' THEN
      v_permitidas := ARRAY[
        'expected_version','snapshot','snapshot_hash','numero_propuesto',
        'fecha_comprobante','emisor_cuit','punto_venta','cbte_tipo','modo',
        'simulado','validez','ultimo_remoto','ultimo_local_observado'
      ];
      v_requeridas := v_permitidas;
    WHEN 'REQUEST_INICIADO' THEN
      v_permitidas := ARRAY['expected_version'];
      v_requeridas := v_permitidas;
    WHEN 'RESPUESTA_RECIBIDA' THEN
      v_permitidas := ARRAY['expected_version','respuesta_resumen'];
      v_requeridas := v_permitidas;
    WHEN 'APROBAR' THEN
      v_permitidas := ARRAY['expected_version','cae','cae_vencimiento','emitido_at'];
      v_requeridas := v_permitidas;
    WHEN 'ERROR_CORREGIBLE' THEN
      v_permitidas := ARRAY[
        'expected_version','error_clase','error_codigo','error_fase',
        'mensaje_mascarado','liberar_identidad'
      ];
      v_requeridas := v_permitidas;
    WHEN 'RECONCILIAR' THEN
      v_permitidas := ARRAY[
        'expected_version','error_clase','error_codigo','error_fase',
        'mensaje_mascarado'
      ];
      v_requeridas := v_permitidas;
    WHEN 'REENVIO_VERIFICADO' THEN
      v_permitidas := ARRAY[
        'expected_version','nuevo_claim_token','ultimo_remoto',
        'respuesta_resumen','payload_hash'
      ];
      v_requeridas := v_permitidas;
    WHEN 'LIBERAR' THEN
      v_permitidas := ARRAY['expected_version','verificacion'];
      v_requeridas := v_permitidas;
    WHEN 'CANCELAR' THEN
      v_permitidas := ARRAY['expected_version'];
      v_requeridas := v_permitidas;
    WHEN 'BLOQUEAR' THEN
      v_permitidas := ARRAY[
        'expected_version','error_clase','error_codigo','error_fase',
        'mensaje_mascarado','diferencias'
      ];
      v_requeridas := v_permitidas;
  END CASE;

  SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_desconocidas
    FROM pg_catalog.jsonb_object_keys(p_payload) AS k
   WHERE NOT (k=ANY(v_permitidas));
  IF v_desconocidas IS NOT NULL THEN
    RAISE EXCEPTION 'Clave(s) no permitida(s) para %: %',
      p_accion,pg_catalog.array_to_string(v_desconocidas,',');
  END IF;

  SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_faltantes
    FROM pg_catalog.unnest(v_requeridas) AS k
   WHERE NOT (p_payload ? k);
  IF v_faltantes IS NOT NULL THEN
    RAISE EXCEPTION 'Faltan claves requeridas para %: %',
      p_accion,pg_catalog.array_to_string(v_faltantes,',');
  END IF;

  IF pg_catalog.jsonb_typeof(p_payload->'expected_version') IS DISTINCT FROM 'number'
     OR p_payload->>'expected_version' !~ '^(0|[1-9][0-9]*)$' THEN
    RAISE EXCEPTION 'expected_version debe ser un entero no negativo';
  END IF;
  IF (p_payload->>'expected_version')::numeric>2147483647 THEN
    RAISE EXCEPTION 'expected_version excede el rango integer';
  END IF;
  v_expected := (p_payload->>'expected_version')::integer;
  IF v_expected <> v_venta.afip_version THEN
    RAISE EXCEPTION 'Versión esperada % no coincide con versión fiscal %',
      v_expected,v_venta.afip_version USING ERRCODE='40001';
  END IF;

  IF p_accion='RECLAMAR' THEN
    IF p_claim_token IS NULL THEN
      RAISE EXCEPTION 'RECLAMAR exige un claim token nuevo no nulo';
    END IF;
    IF v_venta.afip_estado NOT IN ('SIN_FACTURAR','ERROR_CORREGIBLE')
       OR v_venta.afip_claim_token IS NOT NULL
       OR v_venta.afip_numero IS NOT NULL
       OR v_venta.cae IS NOT NULL THEN
      RAISE EXCEPTION 'RECLAMAR no es válido desde estado %, fase %',
        v_venta.afip_estado,COALESCE(v_venta.afip_fase,'NULL');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.emision_fiscal_intentos AS i
       WHERE i.venta_id=p_venta_id AND i.claim_token=p_claim_token
    ) THEN
      RAISE EXCEPTION 'El claim token ya fue usado para esta venta';
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload->'lease_segundos') IS DISTINCT FROM 'number'
       OR p_payload->>'lease_segundos' !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'lease_segundos debe ser un entero positivo';
    END IF;
    IF (p_payload->>'lease_segundos')::numeric > 86400 THEN
      RAISE EXCEPTION 'lease_segundos excede el máximo de 86400';
    END IF;
    v_lease := (p_payload->>'lease_segundos')::integer;

    UPDATE public.ventas AS v
       SET afip_estado='EMITIENDO',
           afip_fase='PREFLIGHT',
           afip_claim_token=p_claim_token,
           afip_claimed_at=pg_catalog.clock_timestamp(),
           afip_error=NULL,
           afip_error_clase=NULL,
           afip_error_codigo=NULL,
           afip_error_fase=NULL,
           afip_ultimo_error_at=NULL,
           afip_intentos=v.afip_intentos+1,
           afip_version=v.afip_version+1
     WHERE v.id=p_venta_id AND v.afip_version=v_expected;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'RECLAMAR no actualizó exactamente una venta';
    END IF;

    INSERT INTO public.emision_fiscal_intentos (
      venta_id,claim_token,snapshot_version,payload_hash,fase,resultado,
      respuesta_resumen
    ) VALUES (
      p_venta_id,p_claim_token,2,pg_catalog.repeat('0',64),'PREFLIGHT','RECLAMADO',
      pg_catalog.jsonb_build_object(
        'control',pg_catalog.jsonb_build_object('lease_segundos',v_lease)
      )
    );

    RETURN QUERY
    SELECT v.id,v.afip_estado,v.afip_fase,v.afip_claim_token,v.afip_numero,v.afip_version
      FROM public.ventas AS v WHERE v.id=p_venta_id;
    RETURN;
  END IF;

  IF p_accion='CANCELAR' THEN
    IF p_claim_token IS NOT NULL THEN
      RAISE EXCEPTION 'CANCELAR es la única acción con token nulo';
    END IF;
    v_cancel_legacy :=
      v_venta.tipo_comprobante IN ('FACTURA_A','FACTURA_B','FACTURA_C')
      AND v_venta.afip_estado='PENDIENTE'
      AND v_venta.afip_version=0
      AND v_venta.afip_intentos=0
      AND NOT v_venta.afip_legacy_incompleto
      AND NOT v_venta.afip_simulado
      AND v_venta.afip_cbte_asoc_id IS NULL
      AND v_venta.afip_error IS NULL
      AND v_venta.afip_error_clase IS NULL
      AND v_venta.afip_error_codigo IS NULL
      AND v_venta.afip_error_fase IS NULL
      AND v_venta.afip_ultimo_error_at IS NULL;
    IF NOT (
         v_venta.afip_estado IN ('SIN_FACTURAR','ERROR_CORREGIBLE')
         OR v_cancel_legacy
       )
       OR v_venta.afip_claim_token IS NOT NULL
       OR v_venta.afip_claimed_at IS NOT NULL
       OR v_venta.afip_legacy_incompleto
       OR v_venta.afip_simulado
       OR v_venta.afip_cbte_asoc_id IS NOT NULL
       OR v_venta.afip_fase IS NOT NULL
       OR v_venta.afip_numero IS NOT NULL
       OR v_venta.cae IS NOT NULL
       OR v_venta.cae_vencimiento IS NOT NULL
       OR v_venta.afip_snapshot IS NOT NULL
       OR v_venta.afip_snapshot_hash IS NOT NULL
       OR v_venta.afip_emisor_cuit IS NOT NULL
       OR v_venta.afip_punto_venta IS NOT NULL
       OR v_venta.afip_cbte_tipo IS NOT NULL
       OR v_venta.afip_modo IS NOT NULL
       OR v_venta.afip_validez IS NOT NULL
       OR v_venta.afip_fecha_comprobante IS NOT NULL
       OR v_venta.afip_imp_total IS NOT NULL
       OR v_venta.afip_emitido_at IS NOT NULL THEN
      RAISE EXCEPTION 'CANCELAR está prohibido con claim, request, número, CAE o incertidumbre';
    END IF;
    UPDATE public.ventas AS v
       SET afip_estado='CANCELADO',afip_version=v.afip_version+1
     WHERE v.id=p_venta_id AND v.afip_version=v_expected;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'CANCELAR no actualizó exactamente una venta';
    END IF;
    RETURN QUERY
    SELECT v.id,v.afip_estado,v.afip_fase,v.afip_claim_token,v.afip_numero,v.afip_version
      FROM public.ventas AS v WHERE v.id=p_venta_id;
    RETURN;
  END IF;

  IF p_claim_token IS NULL OR v_venta.afip_claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'El token fiscal no coincide con el claim vigente';
  END IF;
  SELECT i.* INTO v_intento
    FROM public.emision_fiscal_intentos AS i
   WHERE i.venta_id=p_venta_id AND i.claim_token=p_claim_token
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe el intento auditado del claim vigente';
  END IF;
  v_lease := COALESCE(
    (v_intento.respuesta_resumen#>>'{control,lease_segundos}')::integer,0
  );

  IF p_accion IN ('RESERVAR','REQUEST_INICIADO')
     AND v_venta.afip_claimed_at + pg_catalog.make_interval(secs=>v_lease)
         <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'El lease fiscal venció antes de %',p_accion;
  END IF;

  IF p_accion='RESERVAR' THEN
    IF v_venta.afip_estado<>'EMITIENDO' OR v_venta.afip_fase<>'PREFLIGHT'
       OR v_venta.afip_numero IS NOT NULL THEN
      RAISE EXCEPTION 'RESERVAR no es válido desde estado %, fase %',
        v_venta.afip_estado,COALESCE(v_venta.afip_fase,'NULL');
    END IF;

    v_snapshot := p_payload->'snapshot';
    v_snapshot_hash := p_payload->>'snapshot_hash';

    -- Se validan presencia real, tipo JSON, dominio y rango antes de cualquier
    -- cast o de construir la clave del advisory lock. JSON null nunca equivale
    -- a un valor ausente aceptable.
    IF pg_catalog.jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_snapshot->'version') IS DISTINCT FROM 'number'
       OR v_snapshot->>'version' IS DISTINCT FROM '2'
       OR pg_catalog.jsonb_typeof(v_snapshot->'hash') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_snapshot->'identidad') IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_snapshot->'fechaComprobante') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_snapshot->'importeTotal') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_snapshot->'receptor') IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_snapshot->'items') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'RESERVAR: snapshot v2 completo requiere objeto, identidad, fecha, monto, receptor e items';
    END IF;
    SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_desconocidas
      FROM pg_catalog.jsonb_object_keys(v_snapshot->'identidad') AS k
     WHERE NOT (k=ANY(ARRAY[
       'numero','emisorCuit','puntoVenta','cbteTipo','modo','simulado'
     ]));
    IF v_desconocidas IS NOT NULL
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,numero}') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,emisorCuit}') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,puntoVenta}') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,cbteTipo}') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,modo}') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,simulado}') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'RESERVAR: identidad del snapshot incompleta o con tipos/claves inválidos';
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload->'snapshot_hash') IS DISTINCT FROM 'string'
       OR v_snapshot_hash !~ '^[0-9a-f]{64}$'
       OR v_snapshot->>'hash' IS DISTINCT FROM v_snapshot_hash THEN
      RAISE EXCEPTION 'RESERVAR: snapshot_hash debe ser SHA-256 hex y coincidir con snapshot.hash';
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload->'numero_propuesto') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(p_payload->'punto_venta') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(p_payload->'cbte_tipo') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(p_payload->'ultimo_remoto') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(p_payload->'ultimo_local_observado') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'RESERVAR: número, PV, tipo y observados deben ser números JSON no nulos';
    END IF;
    IF p_payload->>'numero_propuesto' !~ '^[1-9][0-9]*$'
       OR p_payload->>'punto_venta' !~ '^[1-9][0-9]*$'
       OR p_payload->>'cbte_tipo' !~ '^[1-9][0-9]*$'
       OR p_payload->>'ultimo_remoto' !~ '^(0|[1-9][0-9]*)$'
       OR p_payload->>'ultimo_local_observado' !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'RESERVAR: número, PV, tipo y observados deben ser enteros canónicos';
    END IF;
    IF (p_payload->>'numero_propuesto')::numeric > 2147483647
       OR (p_payload->>'punto_venta')::numeric NOT BETWEEN 1 AND 99999
       OR (p_payload->>'cbte_tipo')::numeric NOT BETWEEN 1 AND 9999
       OR (p_payload->>'ultimo_remoto')::numeric > 2147483647
       OR (p_payload->>'ultimo_local_observado')::numeric > 2147483647 THEN
      RAISE EXCEPTION 'RESERVAR: número, PV, tipo u observados fuera de rango';
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload->'emisor_cuit') IS DISTINCT FROM 'string'
       OR p_payload->>'emisor_cuit' !~ '^[0-9]{11}$'
       OR pg_catalog.jsonb_typeof(p_payload->'modo') IS DISTINCT FROM 'string'
       OR p_payload->>'modo' NOT IN ('PRODUCCION','HOMOLOGACION')
       OR pg_catalog.jsonb_typeof(p_payload->'simulado') IS DISTINCT FROM 'boolean'
       OR pg_catalog.jsonb_typeof(p_payload->'validez') IS DISTINCT FROM 'string'
       OR p_payload->>'validez' NOT IN ('PRODUCCION','HOMOLOGACION','SIMULADA') THEN
      RAISE EXCEPTION 'RESERVAR: CUIT, modo, simulado y validez tienen tipo o dominio inválido';
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload->'fecha_comprobante') IS DISTINCT FROM 'string'
       OR p_payload->>'fecha_comprobante' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'RESERVAR: fecha_comprobante debe ser string YYYY-MM-DD';
    END IF;

    v_numero := (p_payload->>'numero_propuesto')::integer;
    v_emisor_cuit := p_payload->>'emisor_cuit';
    v_punto_venta := (p_payload->>'punto_venta')::integer;
    v_cbte_tipo := (p_payload->>'cbte_tipo')::integer;
    v_modo := p_payload->>'modo';
    v_simulado := (p_payload->>'simulado')::boolean;
    v_validez := p_payload->>'validez';
    v_ultimo_remoto := (p_payload->>'ultimo_remoto')::integer;
    v_ultimo_local_observado := (p_payload->>'ultimo_local_observado')::integer;
    IF (v_simulado AND v_validez<>'SIMULADA')
       OR (NOT v_simulado AND v_validez<>v_modo) THEN
      RAISE EXCEPTION 'RESERVAR: modo/simulación/validez no son coherentes';
    END IF;
    BEGIN
      v_fecha := (p_payload->>'fecha_comprobante')::date;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RAISE EXCEPTION 'RESERVAR: fecha_comprobante no es una fecha válida';
    END;
    IF p_payload->>'fecha_comprobante' <> pg_catalog.to_char(v_fecha,'YYYY-MM-DD') THEN
      RAISE EXCEPTION 'RESERVAR: fecha_comprobante debe usar YYYY-MM-DD';
    END IF;
    IF v_snapshot#>>'{identidad,numero}' IS DISTINCT FROM v_numero::text
       OR v_snapshot#>>'{identidad,emisorCuit}' IS DISTINCT FROM v_emisor_cuit
       OR v_snapshot#>>'{identidad,puntoVenta}' IS DISTINCT FROM v_punto_venta::text
       OR v_snapshot#>>'{identidad,cbteTipo}' IS DISTINCT FROM v_cbte_tipo::text
       OR v_snapshot#>>'{identidad,modo}' IS DISTINCT FROM v_modo
       OR (v_snapshot#>'{identidad,simulado}') IS DISTINCT FROM pg_catalog.to_jsonb(v_simulado)
       OR v_snapshot->>'fechaComprobante' IS DISTINCT FROM p_payload->>'fecha_comprobante' THEN
      RAISE EXCEPTION 'RESERVAR: identidad/fecha del snapshot no coincide con la reserva';
    END IF;
    IF v_snapshot->>'importeTotal' IS NULL
       OR NOT (v_snapshot->>'importeTotal' ~ '^(0|[1-9][0-9]*)\.[0-9]{2}$') THEN
      RAISE EXCEPTION 'RESERVAR: importeTotal debe ser decimal canónico con dos posiciones';
    END IF;
    IF (v_snapshot->>'importeTotal')::numeric > 999999999999.99 THEN
      RAISE EXCEPTION 'RESERVAR: importeTotal excede el rango fiscal';
    END IF;
    v_imp_total := (v_snapshot->>'importeTotal')::numeric(14,2);

    IF v_venta.tipo_comprobante='NOTA_CREDITO'
       AND v_venta.afip_cbte_asoc_id IS NOT NULL THEN
      -- Shape canónico que consumen Tasks 7/9:
      -- {
      --   ..., "origen":"COMPROBANTE_ORIGINAL",
      --   "comprobanteOriginalId":"<ventas.id>",
      --   "cbtesAsoc":[{"tipo":6,"puntoVenta":997,
      --                  "numero":997001,"fecha":"YYYY-MM-DD"}]
      -- }
      -- receptor es copia JSON exacta del snapshot aprobado original; la
      -- identidad superior corresponde a la NC y deriva emisor/PV/modo del
      -- original, con cbteTipo 1→3, 6→8 o 11→13.
      IF v_original.afip_estado<>'APROBADO'
         OR v_original.afip_fase<>'PERSISTIDO'
         OR v_original.afip_version<2
         OR v_original.afip_legacy_incompleto
         OR v_original.estado<>'ANULADA'
         OR v_original.venta_anulada_por IS DISTINCT FROM v_venta.id
         OR v_original.cae IS NULL
         OR v_original.afip_validez<>'PRODUCCION'
         OR v_original.afip_modo<>'PRODUCCION'
         OR v_original.afip_simulado
         OR v_original.afip_emisor_cuit IS NULL
         OR v_original.afip_punto_venta IS NULL
         OR v_original.afip_cbte_tipo NOT IN (1,6,11)
         OR v_original.afip_numero IS NULL
         OR v_original.afip_fecha_comprobante IS NULL
         OR v_original.afip_imp_total IS NULL
         OR pg_catalog.jsonb_typeof(v_original.afip_snapshot) IS DISTINCT FROM 'object'
         OR v_original.afip_snapshot->>'version' IS DISTINCT FROM '2'
         OR pg_catalog.jsonb_typeof(v_original.afip_snapshot->'receptor') IS DISTINCT FROM 'object'
         OR v_original.afip_snapshot_hash !~ '^[0-9a-f]{64}$'
         OR v_original.afip_snapshot->>'hash' IS DISTINCT FROM v_original.afip_snapshot_hash
         OR v_original.afip_snapshot#>>'{identidad,numero}' IS DISTINCT FROM v_original.afip_numero::text
         OR v_original.afip_snapshot#>>'{identidad,emisorCuit}' IS DISTINCT FROM v_original.afip_emisor_cuit
         OR v_original.afip_snapshot#>>'{identidad,puntoVenta}' IS DISTINCT FROM v_original.afip_punto_venta::text
         OR v_original.afip_snapshot#>>'{identidad,cbteTipo}' IS DISTINCT FROM v_original.afip_cbte_tipo::text
         OR v_original.afip_snapshot#>>'{identidad,modo}' IS DISTINCT FROM v_original.afip_modo
         OR v_original.afip_snapshot#>'{identidad,simulado}' IS DISTINCT FROM 'false'::jsonb
         OR v_original.afip_snapshot->>'fechaComprobante'
              IS DISTINCT FROM v_original.afip_fecha_comprobante::text
         OR v_original.afip_snapshot->>'importeTotal'
              !~ '^(0|[1-9][0-9]*)\.[0-9]{2}$'
         OR (v_original.afip_snapshot->>'importeTotal')::numeric
              IS DISTINCT FROM ABS(v_original.afip_imp_total)
         OR ABS(v_original.afip_imp_total) IS DISTINCT FROM ABS(v_original.total)
         OR ABS(v_original.total) IS DISTINCT FROM ABS(v_venta.total) THEN
        RAISE EXCEPTION 'NC asociada: el original no es un APROBADO v2 de producción completo para anulación total';
      END IF;

      v_original_hash := pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(
            public.fiscal_json_canonico(v_original.afip_snapshot-'hash'),'UTF8'
          ),
          'sha256'
        ),
        'hex'
      );
      IF v_original_hash IS DISTINCT FROM v_original.afip_snapshot_hash THEN
        RAISE EXCEPTION 'NC asociada: el hash del original no coincide con su snapshot';
      END IF;

      v_cbte_nc_esperado := CASE v_original.afip_cbte_tipo
        WHEN 1 THEN 3
        WHEN 6 THEN 8
        WHEN 11 THEN 13
      END;
      IF v_emisor_cuit IS DISTINCT FROM v_original.afip_emisor_cuit
         OR v_punto_venta IS DISTINCT FROM v_original.afip_punto_venta
         OR v_cbte_tipo IS DISTINCT FROM v_cbte_nc_esperado
         OR v_modo IS DISTINCT FROM v_original.afip_modo
         OR v_validez IS DISTINCT FROM v_original.afip_validez
         OR v_simulado IS DISTINCT FROM v_original.afip_simulado THEN
        RAISE EXCEPTION 'NC asociada: emisor, PV, cbteTipo, modo, validez y simulación deben derivar del original';
      END IF;
      IF v_imp_total<=0
         OR v_imp_total IS DISTINCT FROM ABS(v_venta.total)
         OR v_imp_total IS DISTINCT FROM ABS(v_original.total) THEN
        RAISE EXCEPTION 'NC asociada: importeTotal debe ser la magnitud completa de la NC y del original';
      END IF;
      IF v_snapshot->'receptor' IS DISTINCT FROM v_original.afip_snapshot->'receptor' THEN
        RAISE EXCEPTION 'NC asociada: receptor debe ser idéntico al snapshot original';
      END IF;

      SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_desconocidas
        FROM pg_catalog.jsonb_object_keys(v_snapshot) AS k
       WHERE NOT (k=ANY(ARRAY[
         'version','hash','fechaComprobante','importeTotal','receptor','items',
         'identidad','origen','comprobanteOriginalId','cbtesAsoc'
       ]));
      IF v_desconocidas IS NOT NULL
         OR pg_catalog.jsonb_typeof(v_snapshot->'origen') IS DISTINCT FROM 'string'
         OR v_snapshot->>'origen' IS DISTINCT FROM 'COMPROBANTE_ORIGINAL'
         OR pg_catalog.jsonb_typeof(v_snapshot->'comprobanteOriginalId') IS DISTINCT FROM 'string'
         OR v_snapshot->>'comprobanteOriginalId' IS DISTINCT FROM v_original.id::text
         OR pg_catalog.jsonb_typeof(v_snapshot->'cbtesAsoc') IS DISTINCT FROM 'array'
         OR pg_catalog.jsonb_array_length(v_snapshot->'cbtesAsoc')<>1 THEN
        RAISE EXCEPTION 'NC asociada: origen, comprobanteOriginalId y cbtesAsoc deben identificar inequívocamente al original';
      END IF;

      v_cbte_asoc := v_snapshot->'cbtesAsoc'->0;
      SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_desconocidas
        FROM pg_catalog.jsonb_object_keys(v_cbte_asoc) AS k
       WHERE NOT (k=ANY(ARRAY['tipo','puntoVenta','numero','fecha']));
      IF v_desconocidas IS NOT NULL
         OR NOT (v_cbte_asoc ?& ARRAY['tipo','puntoVenta','numero','fecha'])
         OR pg_catalog.jsonb_typeof(v_cbte_asoc->'tipo') IS DISTINCT FROM 'number'
         OR pg_catalog.jsonb_typeof(v_cbte_asoc->'puntoVenta') IS DISTINCT FROM 'number'
         OR pg_catalog.jsonb_typeof(v_cbte_asoc->'numero') IS DISTINCT FROM 'number'
         OR pg_catalog.jsonb_typeof(v_cbte_asoc->'fecha') IS DISTINCT FROM 'string'
         OR v_cbte_asoc->>'tipo' IS DISTINCT FROM v_original.afip_cbte_tipo::text
         OR v_cbte_asoc->>'puntoVenta' IS DISTINCT FROM v_original.afip_punto_venta::text
         OR v_cbte_asoc->>'numero' IS DISTINCT FROM v_original.afip_numero::text
         OR v_cbte_asoc->>'fecha' IS DISTINCT FROM v_original.afip_fecha_comprobante::text THEN
        RAISE EXCEPTION 'NC asociada: CbtesAsoc debe copiar tipo, PV, número y fecha del original';
      END IF;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_emisor_cuit||'|'||v_punto_venta::text||'|'||v_cbte_tipo::text||'|'||
        v_modo||'|'||v_simulado::text,
        0
      )
    );

    SELECT COALESCE(pg_catalog.max(v.afip_numero),0) INTO v_max_local
      FROM public.ventas AS v
     WHERE v.afip_emisor_cuit=v_emisor_cuit
       AND v.afip_punto_venta=v_punto_venta
       AND v.afip_cbte_tipo=v_cbte_tipo
       AND v.afip_modo=v_modo
       AND v.afip_simulado=v_simulado
       AND v.afip_numero IS NOT NULL;
    IF v_ultimo_local_observado<>v_max_local THEN
      RAISE EXCEPTION 'ultimo_local_observado % quedó obsoleto; máximo local %',
        v_ultimo_local_observado,v_max_local USING ERRCODE='40001';
    END IF;
    IF v_simulado THEN
      IF v_max_local=2147483647 THEN
        RAISE EXCEPTION 'RESERVAR: secuencia simulada agotada';
      END IF;
      IF v_numero<>v_max_local+1 THEN
        RAISE EXCEPTION 'numero_propuesto simulado debe ser max_local + 1';
      END IF;
    ELSE
      IF v_max_local>v_ultimo_remoto THEN
        UPDATE public.ventas AS v
           SET afip_estado='BLOQUEADO',
               afip_error='La secuencia local está adelantada a ARCA',
               afip_error_clase='SECUENCIA',
               afip_error_codigo='LOCAL_ADELANTADO',
               afip_error_fase='PREFLIGHT',
               afip_ultimo_error_at=pg_catalog.clock_timestamp(),
               afip_version=v.afip_version+1
         WHERE v.id=p_venta_id AND v.afip_version=v_expected;
        GET DIAGNOSTICS v_rows=ROW_COUNT;
        IF v_rows<>1 THEN
          RAISE EXCEPTION 'RESERVAR no persistió el bloqueo de secuencia';
        END IF;
        UPDATE public.emision_fiscal_intentos AS i
           SET resultado='RECONCILIACION_SECUENCIA_REQUERIDA',
               error_clase='SECUENCIA',error_codigo='LOCAL_ADELANTADO',
               respuesta_resumen=pg_catalog.jsonb_set(
                 i.respuesta_resumen,'{diagnostico}',
                 pg_catalog.jsonb_build_object(
                   'requiere_conciliacion_secuencia',true,
                   'maximo_local',v_max_local,
                   'ultimo_remoto',v_ultimo_remoto,
                   'identidad',pg_catalog.jsonb_build_object(
                     'emisor_cuit',v_emisor_cuit,'punto_venta',v_punto_venta,
                     'cbte_tipo',v_cbte_tipo,'modo',v_modo,
                     'simulado',v_simulado
                   )
                 ),true
               )
         WHERE i.id=v_intento.id;
        RETURN QUERY
        SELECT v.id,v.afip_estado,v.afip_fase,v.afip_claim_token,
               v.afip_numero,v.afip_version
          FROM public.ventas AS v WHERE v.id=p_venta_id;
        RETURN;
      END IF;
      IF v_ultimo_remoto=2147483647 THEN
        RAISE EXCEPTION 'RESERVAR: secuencia real agotada';
      END IF;
      IF v_numero<>v_ultimo_remoto+1 THEN
        RAISE EXCEPTION 'numero_propuesto debe ser ultimo_remoto + 1';
      END IF;
    END IF;

    v_hash_recalculado := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(public.fiscal_json_canonico(v_snapshot-'hash'),'UTF8'),
        'sha256'
      ),'hex'
    );
    IF v_hash_recalculado IS DISTINCT FROM v_snapshot_hash THEN
      RAISE EXCEPTION 'El hash recalculado no coincide con snapshot_hash';
    END IF;

    UPDATE public.ventas AS v
       SET afip_estado='EMITIENDO',
           afip_fase='RESERVADO',
           afip_emisor_cuit=v_emisor_cuit,
           afip_punto_venta=v_punto_venta,
           afip_cbte_tipo=v_cbte_tipo,
           afip_numero=v_numero,
           afip_modo=v_modo,
           afip_simulado=v_simulado,
           afip_validez=v_validez,
           afip_fecha_comprobante=v_fecha,
           afip_snapshot=v_snapshot,
           afip_snapshot_hash=v_snapshot_hash,
           afip_imp_total=v_imp_total,
           afip_version=v.afip_version+1
     WHERE v.id=p_venta_id AND v.afip_version=v_expected;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'RESERVAR no actualizó exactamente una venta';
    END IF;
    UPDATE public.emision_fiscal_intentos AS i
       SET snapshot_version=2,payload_hash=v_snapshot_hash,
           fase='RESERVADO',resultado='RESERVADO',numero_reservado=v_numero
     WHERE i.id=v_intento.id;

  ELSIF p_accion='REQUEST_INICIADO' THEN
    IF v_venta.afip_estado<>'EMITIENDO' OR v_venta.afip_fase<>'RESERVADO'
       OR v_venta.afip_numero IS NULL THEN
      RAISE EXCEPTION 'REQUEST_INICIADO sólo es válido desde RESERVADO';
    END IF;
    UPDATE public.ventas AS v
       SET afip_fase='REQUEST_INICIADO',afip_version=v.afip_version+1
     WHERE v.id=p_venta_id AND v.afip_version=v_expected;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'REQUEST_INICIADO no actualizó exactamente una venta';
    END IF;
    UPDATE public.emision_fiscal_intentos AS i
       SET fase='REQUEST_INICIADO',resultado='REQUEST_INICIADO'
     WHERE i.id=v_intento.id;

  ELSIF p_accion='RESPUESTA_RECIBIDA' THEN
    IF v_venta.afip_estado<>'EMITIENDO' OR v_venta.afip_fase<>'REQUEST_INICIADO' THEN
      RAISE EXCEPTION 'RESPUESTA_RECIBIDA sólo es válida desde REQUEST_INICIADO';
    END IF;
    v_resumen := p_payload->'respuesta_resumen';
    IF pg_catalog.jsonb_typeof(v_resumen) IS DISTINCT FROM 'object'
       OR pg_catalog.octet_length(v_resumen::text)>2048 THEN
      RAISE EXCEPTION 'respuesta_resumen: esquema enmascarado inválido o demasiado grande';
    END IF;
    SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_resumen_claves
      FROM pg_catalog.jsonb_object_keys(v_resumen) AS k
     WHERE NOT (k=ANY(ARRAY[
       'tipo','resultado','fuente','codigo','mensaje',
       'rechazo_confirmado','observaciones'
     ]));
    IF v_resumen_claves IS NOT NULL
       OR NOT (v_resumen ?& ARRAY[
         'tipo','resultado','fuente','rechazo_confirmado','observaciones'
       ])
       OR pg_catalog.jsonb_typeof(v_resumen->'tipo') IS DISTINCT FROM 'string'
       OR v_resumen->>'tipo' IS DISTINCT FROM 'EMISION'
       OR pg_catalog.jsonb_typeof(v_resumen->'resultado') IS DISTINCT FROM 'string'
       OR v_resumen->>'resultado' NOT IN ('A','R')
       OR pg_catalog.jsonb_typeof(v_resumen->'fuente') IS DISTINCT FROM 'string'
       OR v_resumen->>'fuente' IS DISTINCT FROM 'FECAESolicitar'
       OR pg_catalog.jsonb_typeof(v_resumen->'rechazo_confirmado') IS DISTINCT FROM 'boolean'
       OR (v_resumen->>'resultado'='A'
           AND (v_resumen->'rechazo_confirmado') IS DISTINCT FROM 'false'::jsonb)
       OR pg_catalog.jsonb_typeof(v_resumen->'observaciones') IS DISTINCT FROM 'array'
       OR (v_resumen ? 'codigo'
           AND pg_catalog.jsonb_typeof(v_resumen->'codigo') IS DISTINCT FROM 'string')
       OR (v_resumen ? 'mensaje'
           AND pg_catalog.jsonb_typeof(v_resumen->'mensaje') IS DISTINCT FROM 'string') THEN
      RAISE EXCEPTION 'respuesta_resumen: esquema, clave, tipo o tamaño no permitido';
    END IF;
    IF pg_catalog.jsonb_array_length(v_resumen->'observaciones')>10
       OR (v_resumen ? 'codigo'
           AND pg_catalog.char_length(v_resumen->>'codigo') NOT BETWEEN 1 AND 64)
       OR (v_resumen ? 'mensaje'
           AND pg_catalog.char_length(v_resumen->>'mensaje') NOT BETWEEN 1 AND 512) THEN
      RAISE EXCEPTION 'respuesta_resumen: escalar o array supera el tamaño permitido';
    END IF;
    FOR v_observacion IN
      SELECT value FROM pg_catalog.jsonb_array_elements(v_resumen->'observaciones')
    LOOP
      IF pg_catalog.jsonb_typeof(v_observacion) IS DISTINCT FROM 'string'
         OR pg_catalog.char_length(v_observacion#>>'{}') NOT BETWEEN 1 AND 256 THEN
        RAISE EXCEPTION 'respuesta_resumen: observación con tipo o tamaño no permitido';
      END IF;
    END LOOP;
    IF v_resumen::text ~* '(<[^>]*>|soap|xml|raw|authorization|bearer|token|secret|private.?key|certificate|certificado|clave|password|wsaa|ticket)' THEN
      RAISE EXCEPTION 'respuesta_resumen: contenido raw, XML o secreto no permitido';
    END IF;
    IF v_intento.respuesta_resumen ? 'evidencia_externa' THEN
      RAISE EXCEPTION 'respuesta_resumen: la evidencia externa del intento es inmutable';
    END IF;
    UPDATE public.ventas AS v
       SET afip_fase='RESPUESTA_RECIBIDA',afip_version=v.afip_version+1
     WHERE v.id=p_venta_id AND v.afip_version=v_expected;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'RESPUESTA_RECIBIDA no actualizó exactamente una venta';
    END IF;
    UPDATE public.emision_fiscal_intentos AS i
       SET fase='RESPUESTA_RECIBIDA',resultado='RESPUESTA_RECIBIDA',
           respuesta_resumen=pg_catalog.jsonb_set(
             i.respuesta_resumen,'{evidencia_externa}',
             pg_catalog.jsonb_build_object('respuesta_emision',v_resumen),true
           )
     WHERE i.id=v_intento.id;

  ELSIF p_accion='APROBAR' THEN
    IF v_venta.afip_estado<>'EMITIENDO'
       OR v_venta.afip_fase<>'RESPUESTA_RECIBIDA'
       OR v_venta.afip_numero IS NULL
       OR v_venta.afip_snapshot IS NULL
       OR v_venta.afip_snapshot->>'version' IS DISTINCT FROM '2'
       OR v_venta.afip_snapshot_hash IS NULL
       OR v_venta.afip_fecha_comprobante IS NULL THEN
      RAISE EXCEPTION 'APROBAR exige respuesta, número, fecha y snapshot v2/hash';
    END IF;
    IF COALESCE(pg_catalog.btrim(p_payload->>'cae'),'')=''
       OR COALESCE(pg_catalog.btrim(p_payload->>'cae_vencimiento'),'')=''
       OR COALESCE(pg_catalog.btrim(p_payload->>'emitido_at'),'')='' THEN
      RAISE EXCEPTION 'APROBAR exige CAE, vencimiento y emitido_at';
    END IF;
    UPDATE public.ventas AS v
       SET afip_estado='APROBADO',afip_fase='PERSISTIDO',
           cae=p_payload->>'cae',
           cae_vencimiento=(p_payload->>'cae_vencimiento')::date,
           afip_emitido_at=(p_payload->>'emitido_at')::timestamptz,
           afip_claim_token=NULL,afip_claimed_at=NULL,
           afip_error=NULL,afip_error_clase=NULL,afip_error_codigo=NULL,
           afip_error_fase=NULL,afip_ultimo_error_at=NULL,
           afip_version=v.afip_version+1
     WHERE v.id=p_venta_id AND v.afip_version=v_expected;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'APROBAR no actualizó exactamente una venta';
    END IF;
    UPDATE public.emision_fiscal_intentos AS i
       SET fase='PERSISTIDO',resultado='APROBADO'
     WHERE i.id=v_intento.id;

  ELSIF p_accion='RECONCILIAR' THEN
    IF v_venta.afip_estado<>'EMITIENDO'
       OR v_venta.afip_fase NOT IN ('REQUEST_INICIADO','RESPUESTA_RECIBIDA')
       OR v_venta.afip_numero IS NULL THEN
      RAISE EXCEPTION 'RECONCILIAR exige una identidad enviada o respondida';
    END IF;
    IF COALESCE(pg_catalog.btrim(p_payload->>'error_clase'),'')=''
       OR COALESCE(pg_catalog.btrim(p_payload->>'error_codigo'),'')=''
       OR COALESCE(pg_catalog.btrim(p_payload->>'error_fase'),'')=''
       OR COALESCE(pg_catalog.btrim(p_payload->>'mensaje_mascarado'),'')='' THEN
      RAISE EXCEPTION 'RECONCILIAR exige evidencia de error enmascarada';
    END IF;
    UPDATE public.ventas AS v
       SET afip_estado='RECONCILIAR',afip_error=p_payload->>'mensaje_mascarado',
           afip_error_clase=p_payload->>'error_clase',
           afip_error_codigo=p_payload->>'error_codigo',
           afip_error_fase=p_payload->>'error_fase',
           afip_ultimo_error_at=pg_catalog.clock_timestamp(),
           afip_version=v.afip_version+1
     WHERE v.id=p_venta_id AND v.afip_version=v_expected;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'RECONCILIAR no actualizó exactamente una venta';
    END IF;
    UPDATE public.emision_fiscal_intentos AS i
       SET resultado='RECONCILIAR',error_clase=p_payload->>'error_clase',
           error_codigo=p_payload->>'error_codigo',
           respuesta_resumen=pg_catalog.jsonb_set(
             i.respuesta_resumen,'{diagnostico}',pg_catalog.jsonb_build_object(
               'mensaje_mascarado',p_payload->>'mensaje_mascarado',
               'error_fase',p_payload->>'error_fase'
             ),true
           )
     WHERE i.id=v_intento.id;

  ELSIF p_accion='REENVIO_VERIFICADO' THEN
    IF v_venta.afip_estado<>'RECONCILIAR'
       OR v_venta.afip_numero IS NULL
       OR v_venta.afip_snapshot IS NULL
       OR v_venta.afip_snapshot_hash IS NULL THEN
      RAISE EXCEPTION 'REENVIO_VERIFICADO sólo es válido desde RECONCILIAR completo';
    END IF;
    v_resumen := p_payload->'respuesta_resumen';
    IF pg_catalog.jsonb_typeof(v_resumen) IS DISTINCT FROM 'object'
       OR pg_catalog.octet_length(v_resumen::text)>2048 THEN
      RAISE EXCEPTION 'REENVIO_VERIFICADO: resumen de ausencia inválido';
    END IF;
    SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_resumen_claves
      FROM pg_catalog.jsonb_object_keys(v_resumen) AS k
     WHERE NOT (k=ANY(ARRAY[
       'tipo','resultado','fuente','codigo','mensaje',
       'ausencia_confirmada','observaciones'
     ]));
    IF v_resumen_claves IS NOT NULL
       OR NOT (v_resumen ?& ARRAY[
         'tipo','resultado','fuente','ausencia_confirmada','observaciones'
       ])
       OR pg_catalog.jsonb_typeof(v_resumen->'tipo') IS DISTINCT FROM 'string'
       OR v_resumen->>'tipo' IS DISTINCT FROM 'CONSULTA_ARCA'
       OR pg_catalog.jsonb_typeof(v_resumen->'resultado') IS DISTINCT FROM 'string'
       OR v_resumen->>'resultado' IS DISTINCT FROM 'AUSENTE'
       OR pg_catalog.jsonb_typeof(v_resumen->'fuente') IS DISTINCT FROM 'string'
       OR v_resumen->>'fuente' IS DISTINCT FROM 'FECompConsultar'
       OR pg_catalog.jsonb_typeof(v_resumen->'ausencia_confirmada') IS DISTINCT FROM 'boolean'
       OR (v_resumen->'ausencia_confirmada') IS DISTINCT FROM 'true'::jsonb
       OR pg_catalog.jsonb_typeof(v_resumen->'observaciones') IS DISTINCT FROM 'array'
       OR (v_resumen ? 'codigo'
           AND pg_catalog.jsonb_typeof(v_resumen->'codigo') IS DISTINCT FROM 'string')
       OR (v_resumen ? 'mensaje'
           AND pg_catalog.jsonb_typeof(v_resumen->'mensaje') IS DISTINCT FROM 'string') THEN
      RAISE EXCEPTION 'REENVIO_VERIFICADO exige ausencia ARCA literal, tipada y enmascarada';
    END IF;
    IF pg_catalog.jsonb_array_length(v_resumen->'observaciones')>10
       OR (v_resumen ? 'codigo'
           AND pg_catalog.char_length(v_resumen->>'codigo') NOT BETWEEN 1 AND 64)
       OR (v_resumen ? 'mensaje'
           AND pg_catalog.char_length(v_resumen->>'mensaje') NOT BETWEEN 1 AND 512) THEN
      RAISE EXCEPTION 'REENVIO_VERIFICADO: resumen supera el tamaño permitido';
    END IF;
    FOR v_observacion IN
      SELECT value FROM pg_catalog.jsonb_array_elements(v_resumen->'observaciones')
    LOOP
      IF pg_catalog.jsonb_typeof(v_observacion) IS DISTINCT FROM 'string'
         OR pg_catalog.char_length(v_observacion#>>'{}') NOT BETWEEN 1 AND 256 THEN
        RAISE EXCEPTION 'REENVIO_VERIFICADO: observación inválida';
      END IF;
    END LOOP;
    IF v_resumen::text ~* '(<[^>]*>|soap|xml|raw|authorization|bearer|token|secret|private.?key|certificate|certificado|clave|password|wsaa|ticket)' THEN
      RAISE EXCEPTION 'REENVIO_VERIFICADO: resumen contiene raw, XML o secreto';
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload->'ultimo_remoto') IS DISTINCT FROM 'number'
       OR p_payload->>'ultimo_remoto' !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'ultimo_remoto debe ser exactamente numero_reservado - 1';
    END IF;
    IF (p_payload->>'ultimo_remoto')::numeric>2147483647
       OR (p_payload->>'ultimo_remoto')::integer IS DISTINCT FROM v_venta.afip_numero-1 THEN
      RAISE EXCEPTION 'ultimo_remoto debe ser exactamente numero_reservado - 1';
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload->'payload_hash') IS DISTINCT FROM 'string'
       OR p_payload->>'payload_hash' !~ '^[0-9a-f]{64}$'
       OR p_payload->>'payload_hash' IS DISTINCT FROM v_venta.afip_snapshot_hash
       OR p_payload->>'payload_hash' IS DISTINCT FROM v_intento.payload_hash THEN
      RAISE EXCEPTION 'payload_hash no coincide con la identidad reservada';
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload->'nuevo_claim_token') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'nuevo_claim_token debe ser UUID string';
    END IF;
    IF v_intento.respuesta_resumen#>'{evidencia_externa,consulta_reenvio}' IS NOT NULL THEN
      RAISE EXCEPTION 'REENVIO_VERIFICADO: la consulta externa ya fue auditada';
    END IF;
    BEGIN
      v_nuevo_claim := (p_payload->>'nuevo_claim_token')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'nuevo_claim_token debe ser UUID';
    END;
    IF v_nuevo_claim IS NULL OR v_nuevo_claim=p_claim_token
       OR EXISTS (
         SELECT 1 FROM public.emision_fiscal_intentos AS i
          WHERE i.venta_id=p_venta_id AND i.claim_token=v_nuevo_claim
       ) THEN
      RAISE EXCEPTION 'nuevo_claim_token debe ser nuevo y distinto';
    END IF;

    UPDATE public.emision_fiscal_intentos AS i
       SET resultado='AUSENCIA_ARCA_VERIFICADA',
           respuesta_resumen=pg_catalog.jsonb_set(
             i.respuesta_resumen,'{evidencia_externa}',
             COALESCE(i.respuesta_resumen->'evidencia_externa','{}'::jsonb)
               || pg_catalog.jsonb_build_object('consulta_reenvio',v_resumen),
             true
           )
     WHERE i.id=v_intento.id;
    INSERT INTO public.emision_fiscal_intentos (
      venta_id,claim_token,snapshot_version,payload_hash,fase,resultado,
      numero_reservado,respuesta_resumen
    ) VALUES (
      p_venta_id,v_nuevo_claim,2,v_venta.afip_snapshot_hash,'RESERVADO',
      'REENVIO_VERIFICADO',v_venta.afip_numero,
      pg_catalog.jsonb_build_object(
        'control',pg_catalog.jsonb_build_object(
          'lease_segundos',GREATEST(v_lease,300)
        )
      )
    );
    UPDATE public.ventas AS v
       SET afip_estado='EMITIENDO',afip_fase='RESERVADO',
           afip_claim_token=v_nuevo_claim,
           afip_claimed_at=pg_catalog.clock_timestamp(),
           afip_error=NULL,afip_error_clase=NULL,afip_error_codigo=NULL,
           afip_error_fase=NULL,afip_ultimo_error_at=NULL,
           afip_intentos=v.afip_intentos+1,
           afip_version=v.afip_version+1
     WHERE v.id=p_venta_id AND v.afip_version=v_expected;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'REENVIO_VERIFICADO no actualizó exactamente una venta';
    END IF;

  ELSIF p_accion='ERROR_CORREGIBLE' THEN
    IF v_venta.afip_estado<>'EMITIENDO'
       OR v_venta.afip_fase NOT IN (
         'PREFLIGHT','RESERVADO','REQUEST_INICIADO','RESPUESTA_RECIBIDA'
       ) THEN
      RAISE EXCEPTION 'ERROR_CORREGIBLE no es válido desde estado %, fase %',
        v_venta.afip_estado,COALESCE(v_venta.afip_fase,'NULL');
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload->'liberar_identidad') IS DISTINCT FROM 'boolean'
       OR COALESCE(pg_catalog.btrim(p_payload->>'error_clase'),'')=''
       OR COALESCE(pg_catalog.btrim(p_payload->>'error_codigo'),'')=''
       OR COALESCE(pg_catalog.btrim(p_payload->>'error_fase'),'')=''
       OR COALESCE(pg_catalog.btrim(p_payload->>'mensaje_mascarado'),'')='' THEN
      RAISE EXCEPTION 'ERROR_CORREGIBLE exige error y liberar_identidad válidos';
    END IF;
    v_liberar_identidad := (p_payload->>'liberar_identidad')::boolean;

    -- Después de iniciar el request, sólo el boolean JSON literal true ya
    -- persistido por RESPUESTA_RECIBIDA prueba un rechazo definitivo. Todo lo
    -- demás se vuelve conciliación durable y conserva identidad/evidencia.
    IF v_venta.afip_fase='REQUEST_INICIADO'
       OR (
         v_venta.afip_fase='RESPUESTA_RECIBIDA'
         AND (
           pg_catalog.jsonb_typeof(
             v_intento.respuesta_resumen#>'{evidencia_externa,respuesta_emision,rechazo_confirmado}'
           ) IS DISTINCT FROM 'boolean'
           OR v_intento.respuesta_resumen#>'{evidencia_externa,respuesta_emision,rechazo_confirmado}'
                IS DISTINCT FROM 'true'::jsonb
         )
       ) THEN
      UPDATE public.ventas AS v
         SET afip_estado='RECONCILIAR',
             afip_error=p_payload->>'mensaje_mascarado',
             afip_error_clase=p_payload->>'error_clase',
             afip_error_codigo=p_payload->>'error_codigo',
             afip_error_fase=p_payload->>'error_fase',
             afip_ultimo_error_at=pg_catalog.clock_timestamp(),
             afip_version=v.afip_version+1
       WHERE v.id=p_venta_id AND v.afip_version=v_expected;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION 'ERROR_CORREGIBLE no persistió la conciliación fail-closed';
      END IF;
      UPDATE public.emision_fiscal_intentos AS i
         SET resultado='RECONCILIAR',error_clase=p_payload->>'error_clase',
             error_codigo=p_payload->>'error_codigo',
             respuesta_resumen=pg_catalog.jsonb_set(
               i.respuesta_resumen,'{diagnostico}',pg_catalog.jsonb_build_object(
                 'mensaje_mascarado',p_payload->>'mensaje_mascarado',
                 'error_fase',p_payload->>'error_fase',
                 'identidad_preservada',true,
                 'motivo','RECHAZO_NO_CONFIRMADO'
               ),true
             )
       WHERE i.id=v_intento.id;
      RETURN QUERY
      SELECT v.id,v.afip_estado,v.afip_fase,v.afip_claim_token,
             v.afip_numero,v.afip_version
        FROM public.ventas AS v WHERE v.id=p_venta_id;
      RETURN;
    END IF;

    UPDATE public.ventas AS v
       SET afip_estado='ERROR_CORREGIBLE',afip_fase=NULL,
           afip_claim_token=NULL,afip_claimed_at=NULL,
           afip_error=p_payload->>'mensaje_mascarado',
           afip_error_clase=p_payload->>'error_clase',
           afip_error_codigo=p_payload->>'error_codigo',
           afip_error_fase=p_payload->>'error_fase',
           afip_ultimo_error_at=pg_catalog.clock_timestamp(),
           afip_emisor_cuit=CASE WHEN v_liberar_identidad THEN NULL ELSE v.afip_emisor_cuit END,
           afip_punto_venta=CASE WHEN v_liberar_identidad THEN NULL ELSE v.afip_punto_venta END,
           afip_cbte_tipo=CASE WHEN v_liberar_identidad THEN NULL ELSE v.afip_cbte_tipo END,
           afip_numero=CASE WHEN v_liberar_identidad THEN NULL ELSE v.afip_numero END,
           afip_modo=CASE WHEN v_liberar_identidad THEN NULL ELSE v.afip_modo END,
           afip_simulado=CASE WHEN v_liberar_identidad THEN false ELSE v.afip_simulado END,
           afip_validez=CASE WHEN v_liberar_identidad THEN NULL ELSE v.afip_validez END,
           afip_fecha_comprobante=CASE WHEN v_liberar_identidad THEN NULL ELSE v.afip_fecha_comprobante END,
           afip_snapshot=CASE WHEN v_liberar_identidad THEN NULL ELSE v.afip_snapshot END,
           afip_snapshot_hash=CASE WHEN v_liberar_identidad THEN NULL ELSE v.afip_snapshot_hash END,
           afip_imp_total=CASE WHEN v_liberar_identidad THEN NULL ELSE v.afip_imp_total END,
           afip_version=v.afip_version+1
     WHERE v.id=p_venta_id AND v.afip_version=v_expected;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'ERROR_CORREGIBLE no actualizó exactamente una venta';
    END IF;
    UPDATE public.emision_fiscal_intentos AS i
       SET resultado='ERROR_CORREGIBLE',error_clase=p_payload->>'error_clase',
           error_codigo=p_payload->>'error_codigo',
           respuesta_resumen=pg_catalog.jsonb_set(
             i.respuesta_resumen,'{diagnostico}',pg_catalog.jsonb_build_object(
               'mensaje_mascarado',p_payload->>'mensaje_mascarado',
               'error_fase',p_payload->>'error_fase',
               'identidad_liberada',v_liberar_identidad
             ),true
           )
     WHERE i.id=v_intento.id;

  ELSIF p_accion='LIBERAR' THEN
    IF v_venta.afip_estado<>'EMITIENDO'
       OR v_venta.afip_fase NOT IN ('PREFLIGHT','RESERVADO') THEN
      RAISE EXCEPTION 'LIBERAR está prohibido desde %',COALESCE(v_venta.afip_fase,'NULL');
    END IF;
    IF (
         (v_intento.fase='PREFLIGHT' AND v_intento.resultado='RECLAMADO')
         OR (v_intento.fase='RESERVADO' AND v_intento.resultado='RESERVADO')
       ) IS DISTINCT FROM true
       OR v_intento.respuesta_resumen ? 'evidencia_externa' THEN
      RAISE EXCEPTION 'El intento contiene evidencia de envío y no se puede liberar';
    END IF;
    IF v_lease<=0 OR v_venta.afip_claimed_at + pg_catalog.make_interval(secs=>v_lease)
       > pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION 'El lease fiscal todavía no venció';
    END IF;
    v_resumen := p_payload->'verificacion';
    IF pg_catalog.jsonb_typeof(v_resumen) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'LIBERAR exige verificación explícita de nunca enviado';
    END IF;
    SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_resumen_claves
      FROM pg_catalog.jsonb_object_keys(v_resumen) AS k
     WHERE NOT (k=ANY(ARRAY['nunca_enviado','fuente']));
    IF v_resumen_claves IS NOT NULL
       OR NOT (v_resumen ?& ARRAY['nunca_enviado','fuente'])
       OR pg_catalog.jsonb_typeof(v_resumen->'nunca_enviado') IS DISTINCT FROM 'boolean'
       OR v_resumen->'nunca_enviado' IS DISTINCT FROM 'true'::jsonb
       OR pg_catalog.jsonb_typeof(v_resumen->'fuente') IS DISTINCT FROM 'string'
       OR v_resumen->>'fuente' IS DISTINCT FROM 'log_intento' THEN
      RAISE EXCEPTION 'LIBERAR exige verificación tipada y literal de nunca enviado';
    END IF;
    UPDATE public.emision_fiscal_intentos AS i
       SET resultado='LIBERADO',
           respuesta_resumen=pg_catalog.jsonb_set(
             i.respuesta_resumen,'{verificacion_liberacion}',v_resumen,true
           )
     WHERE i.id=v_intento.id;
    UPDATE public.ventas AS v
       SET afip_estado='ERROR_CORREGIBLE',afip_fase=NULL,
           afip_claim_token=NULL,afip_claimed_at=NULL,
           afip_error='Claim vencido verificado como nunca enviado',
           afip_error_clase='LEASE',afip_error_codigo='LIBERADO',
           afip_error_fase=v.afip_fase,
           afip_ultimo_error_at=pg_catalog.clock_timestamp(),
           afip_emisor_cuit=NULL,afip_punto_venta=NULL,afip_cbte_tipo=NULL,
           afip_numero=NULL,afip_modo=NULL,afip_simulado=false,afip_validez=NULL,
           afip_fecha_comprobante=NULL,afip_snapshot=NULL,afip_snapshot_hash=NULL,
           afip_imp_total=NULL,afip_version=v.afip_version+1
     WHERE v.id=p_venta_id AND v.afip_version=v_expected;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'LIBERAR no actualizó exactamente una venta';
    END IF;

  ELSIF p_accion='BLOQUEAR' THEN
    IF v_venta.afip_estado NOT IN ('EMITIENDO','RECONCILIAR') THEN
      RAISE EXCEPTION 'BLOQUEAR no es válido desde estado %',v_venta.afip_estado;
    END IF;
    IF COALESCE(pg_catalog.btrim(p_payload->>'error_clase'),'')=''
       OR COALESCE(pg_catalog.btrim(p_payload->>'error_codigo'),'')=''
       OR COALESCE(pg_catalog.btrim(p_payload->>'error_fase'),'')=''
       OR COALESCE(pg_catalog.btrim(p_payload->>'mensaje_mascarado'),'')=''
       OR pg_catalog.jsonb_typeof(p_payload->'diferencias')<>'object' THEN
      RAISE EXCEPTION 'BLOQUEAR exige error y diferencias para revisión administrativa';
    END IF;
    UPDATE public.ventas AS v
       SET afip_estado='BLOQUEADO',afip_error=p_payload->>'mensaje_mascarado',
           afip_error_clase=p_payload->>'error_clase',
           afip_error_codigo=p_payload->>'error_codigo',
           afip_error_fase=p_payload->>'error_fase',
           afip_ultimo_error_at=pg_catalog.clock_timestamp(),
           afip_version=v.afip_version+1
     WHERE v.id=p_venta_id AND v.afip_version=v_expected;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'BLOQUEAR no actualizó exactamente una venta';
    END IF;
    UPDATE public.emision_fiscal_intentos AS i
       SET resultado='BLOQUEADO',error_clase=p_payload->>'error_clase',
           error_codigo=p_payload->>'error_codigo',
           respuesta_resumen=pg_catalog.jsonb_set(
             i.respuesta_resumen,'{diagnostico}',pg_catalog.jsonb_build_object(
               'mensaje_mascarado',p_payload->>'mensaje_mascarado',
               'error_fase',p_payload->>'error_fase',
               'diferencias',p_payload->'diferencias'
             ),true
           )
     WHERE i.id=v_intento.id;
  END IF;

  RETURN QUERY
  SELECT v.id,v.afip_estado,v.afip_fase,v.afip_claim_token,v.afip_numero,v.afip_version
    FROM public.ventas AS v WHERE v.id=p_venta_id;
END;
$$;

REVOKE ALL ON FUNCTION public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)
  TO service_role;

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
  v_nc_activas integer;
  v_es_nc_fiscal boolean := false;
  v_cancelable_sin_cae boolean;
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

  -- Una venta neutral o factura legacy virgen sin identidad/incertidumbre no
  -- necesita otra venta-NC. La transición owner-only es el único escritor del
  -- CANCELADO y esta transacción revierte la mitad comercial una sola vez.
  IF v_v.tipo_comprobante IN ('VENTA','FACTURA_A','FACTURA_B','FACTURA_C')
     AND v_v.cae IS NULL THEN
    v_cancelable_sin_cae :=
      (
        v_v.tipo_comprobante='VENTA'
        AND v_v.afip_estado IN ('SIN_FACTURAR','ERROR_CORREGIBLE')
      )
      OR (
        v_v.tipo_comprobante IN ('FACTURA_A','FACTURA_B','FACTURA_C')
        AND v_v.afip_estado='PENDIENTE'
        AND v_v.afip_version=0
        AND v_v.afip_intentos=0
        AND v_v.afip_error IS NULL
        AND v_v.afip_error_clase IS NULL
        AND v_v.afip_error_codigo IS NULL
        AND v_v.afip_error_fase IS NULL
        AND v_v.afip_ultimo_error_at IS NULL
      );
    IF NOT v_cancelable_sin_cae
       OR v_v.afip_claim_token IS NOT NULL
       OR v_v.afip_claimed_at IS NOT NULL
       OR v_v.afip_legacy_incompleto
       OR v_v.afip_simulado
       OR v_v.afip_cbte_asoc_id IS NOT NULL
       OR v_v.afip_fase IS NOT NULL
       OR v_v.afip_numero IS NOT NULL
       OR v_v.afip_snapshot IS NOT NULL
       OR v_v.afip_snapshot_hash IS NOT NULL
       OR v_v.afip_emisor_cuit IS NOT NULL
       OR v_v.afip_punto_venta IS NOT NULL
       OR v_v.afip_cbte_tipo IS NOT NULL
       OR v_v.afip_modo IS NOT NULL
       OR v_v.afip_validez IS NOT NULL
       OR v_v.afip_fecha_comprobante IS NOT NULL
       OR v_v.afip_imp_total IS NOT NULL
       OR v_v.afip_emitido_at IS NOT NULL
       OR v_v.cae_vencimiento IS NOT NULL THEN
      RAISE EXCEPTION 'El comprobante tiene evidencia fiscal o incertidumbre y no se puede anular automáticamente';
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

    -- La transición de una NC toma los mismos locks original→NC. Bajo el lock
    -- del original, congelamos todas sus notas activas en orden UUID y recién
    -- entonces contamos/sumamos una única frontera, incluido legacy PENDIENTE.
    PERFORM 1
      FROM public.ventas AS n
     WHERE n.afip_cbte_asoc_id=v_v.id
       AND n.tipo_comprobante='NOTA_CREDITO'
       AND n.estado='ACTIVA'
       AND n.afip_estado NOT IN ('CANCELADO','NO_APLICA')
     ORDER BY n.id
     FOR UPDATE;

    SELECT count(*),COALESCE(pg_catalog.sum(ABS(n.total)),0)
      INTO v_nc_activas,v_nc_en_curso
      FROM public.ventas AS n
     WHERE n.afip_cbte_asoc_id=v_v.id
       AND n.tipo_comprobante='NOTA_CREDITO'
       AND n.estado='ACTIVA'
       AND n.afip_estado NOT IN ('CANCELADO','NO_APLICA');
    IF v_nc_activas>0
       OR v_nc_en_curso+ABS(v_v.total)>ABS(v_v.total)+0.01 THEN
      RAISE EXCEPTION 'Ya existe una nota de crédito activa; una segunda o su suma superarían el total del comprobante original';
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
