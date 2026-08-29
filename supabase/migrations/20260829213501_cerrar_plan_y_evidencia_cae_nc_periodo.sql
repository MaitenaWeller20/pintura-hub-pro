-- El plan de reintegro es parte de la intención idempotente. Los consumidores
-- API sólo pueden leerlo; toda escritura queda detrás del owner de las RPC.
REVOKE ALL ON TABLE public.nota_credito_periodo_reintegros
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.nota_credito_periodo_reintegros
  TO authenticated,service_role;

CREATE FUNCTION public.guard_plan_reintegro_nc_periodo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_owner name;
  v_venta_id uuid;
BEGIN
  v_venta_id := CASE WHEN TG_OP='DELETE' THEN OLD.venta_id ELSE NEW.venta_id END;

  -- El mismo lock lógico lo toma el materializador antes de congelar el
  -- vector. Aun un writer owner no puede intercalarse durante los efectos.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_venta_id::text,82801)
  );

  SELECT pg_catalog.pg_get_userbyid(c.relowner)
    INTO v_owner
    FROM pg_catalog.pg_class AS c
   WHERE c.oid=TG_RELID;
  IF current_user<>v_owner THEN
    RAISE EXCEPTION 'El plan de reintegro sólo se escribe mediante funciones owner'
      USING ERRCODE='42501';
  END IF;

  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

ALTER FUNCTION public.guard_plan_reintegro_nc_periodo() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_plan_reintegro_nc_periodo()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER guard_plan_reintegro_nc_periodo_antes_de_mutar
BEFORE INSERT OR UPDATE OR DELETE
ON public.nota_credito_periodo_reintegros
FOR EACH ROW EXECUTE FUNCTION public.guard_plan_reintegro_nc_periodo();

-- Única reconstrucción canónica de la intención v1 desde filas persistidas.
-- Devuelve además el vector bloqueado que debe consumir el post-CAE: el helper
-- de efectos nunca vuelve a consultar la tabla mutable.
CREATE FUNCTION public.materializar_intencion_nc_periodo(p_venta_id uuid)
RETURNS TABLE(payload jsonb,payload_hash text,reintegros_vector jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_venta public.ventas%ROWTYPE;
  v_items jsonb;
  v_reintegros jsonb;
  v_vector jsonb;
  v_payload jsonb;
  v_hash text;
BEGIN
  SELECT v.* INTO v_venta
    FROM public.ventas AS v
   WHERE v.id=p_venta_id
   FOR UPDATE;
  IF NOT FOUND OR v_venta.nc_periodo_modalidad IS NULL THEN
    RAISE EXCEPTION 'No existe una intención de NC por período para materializar';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_venta_id::text,82801)
  );

  WITH bloqueados AS MATERIALIZED (
    SELECT r.id,r.forma_pago,r.monto,r.detalle,r.orden
      FROM public.nota_credito_periodo_reintegros AS r
     WHERE r.venta_id=p_venta_id
     ORDER BY r.orden,r.id
     FOR UPDATE
  )
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id',b.id::text,
               'forma_pago',b.forma_pago::text,
               'monto',b.monto,
               'detalle',b.detalle,
               'orden',b.orden
             ) ORDER BY b.orden,b.id
           ),
           '[]'::jsonb
         )
    INTO v_vector
    FROM bloqueados AS b;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_vector)
           WITH ORDINALITY AS e(item,ordinal)
     WHERE pg_catalog.jsonb_typeof(e.item)<>'object'
        OR e.item->>'orden' IS DISTINCT FROM (e.ordinal-1)::text
        OR e.item->>'forma_pago' NOT IN (
          'EFECTIVO','TRANSFERENCIA','TARJETA_DEBITO','TARJETA_CREDITO',
          'MERCADO_PAGO','CHEQUE'
        )
        OR (e.item->>'monto')::numeric<=0
        OR (e.item->>'monto')::numeric
             <>pg_catalog.round((e.item->>'monto')::numeric,2)
        OR e.item->'detalle' IS DISTINCT FROM '{}'::jsonb
  ) OR (
    SELECT pg_catalog.count(*)<>pg_catalog.count(DISTINCT e.item->>'forma_pago')
      FROM pg_catalog.jsonb_array_elements(v_vector) AS e(item)
  ) THEN
    RAISE EXCEPTION 'El vector persistido de reintegros no es canónico';
  END IF;

  IF v_venta.nc_periodo_modalidad='DEVOLUCION_PRODUCTOS' THEN
    SELECT COALESCE(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'producto_id',i.producto_id::text,
                 'cantidad',pg_catalog.round(i.cantidad,2),
                 'precio_unitario_sin_iva',
                   pg_catalog.round(i.precio_unitario_sin_iva,2),
                 'iva_porcentaje',pg_catalog.round(i.iva_porcentaje,2)
               ) ORDER BY i.producto_id
             ),
             '[]'::jsonb
           )
      INTO v_items
      FROM public.venta_items AS i
     WHERE i.venta_id=p_venta_id;
  ELSIF v_venta.nc_periodo_modalidad='BONIFICACION_AJUSTE' THEN
    SELECT COALESCE(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'producto_id',NULL,
                 'descripcion',pg_catalog.btrim(i.descripcion),
                 'cantidad',1,
                 'precio_unitario_sin_iva',
                   pg_catalog.round(i.precio_unitario_sin_iva,2),
                 'iva_porcentaje',pg_catalog.round(i.iva_porcentaje,2)
               ) ORDER BY i.id
             ),
             '[]'::jsonb
           )
      INTO v_items
      FROM public.venta_items AS i
     WHERE i.venta_id=p_venta_id;
  ELSE
    RAISE EXCEPTION 'Modalidad de NC por período no soportada';
  END IF;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'forma_pago',e.item->>'forma_pago',
               'monto_centavos',pg_catalog.round(
                 (e.item->>'monto')::numeric*100,0
               )
             ) ORDER BY e.item->>'forma_pago'
           ),
           '[]'::jsonb
         )
    INTO v_reintegros
    FROM pg_catalog.jsonb_array_elements(v_vector) AS e(item);

  v_payload := pg_catalog.jsonb_build_object(
    'version',1,
    'actor_id',v_venta.usuario_id::text,
    'sucursal_id',v_venta.sucursal_id::text,
    'cliente_id',v_venta.cliente_id::text,
    'modalidad',v_venta.nc_periodo_modalidad::text,
    'periodo_desde',v_venta.periodo_asoc_desde::text,
    'periodo_hasta',v_venta.periodo_asoc_hasta::text,
    'motivo',pg_catalog.btrim(v_venta.motivo_nota_credito),
    'resolucion',v_venta.nc_resolucion::text,
    'items',v_items,
    'reintegros',v_reintegros
  );
  v_hash := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_payload::text,'UTF8'),'sha256'),
    'hex'
  );

  RETURN QUERY SELECT v_payload,v_hash,v_vector;
END;
$$;

ALTER FUNCTION public.materializar_intencion_nc_periodo(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.materializar_intencion_nc_periodo(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- El writer original sigue siendo la autoridad de validación de Tarea 4. Se
-- envuelve para probar, en la misma transacción, que su huella coincide con la
-- única reconstrucción que luego consumen los efectos.
ALTER FUNCTION public._crear_nota_credito_periodo_fiscal_core_20260828(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) RENAME TO _crear_nc_periodo_core_pre_hash_fix1;

REVOKE ALL ON FUNCTION public._crear_nc_periodo_core_pre_hash_fix1(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public._crear_nota_credito_periodo_fiscal_core_20260828(
  p_sucursal_id uuid,
  p_cliente_id uuid,
  p_modalidad public.modalidad_nc_periodo,
  p_periodo_desde date,
  p_periodo_hasta date,
  p_motivo text,
  p_resolucion public.resolucion_nc_periodo,
  p_items jsonb,
  p_reintegros jsonb,
  p_idempotency_key uuid
)
RETURNS TABLE(venta_id uuid,numero text,es_cta_cte boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_resultado record;
  v_hash_reconstruido text;
  v_hash_persistido text;
BEGIN
  SELECT * INTO STRICT v_resultado
    FROM public._crear_nc_periodo_core_pre_hash_fix1(
      p_sucursal_id,p_cliente_id,p_modalidad,p_periodo_desde,p_periodo_hasta,
      p_motivo,p_resolucion,p_items,p_reintegros,p_idempotency_key
    );

  SELECT m.payload_hash
    INTO STRICT v_hash_reconstruido
    FROM public.materializar_intencion_nc_periodo(v_resultado.venta_id) AS m;
  SELECT v.nc_periodo_payload_hash
    INTO STRICT v_hash_persistido
    FROM public.ventas AS v
   WHERE v.id=v_resultado.venta_id;
  IF v_hash_reconstruido IS DISTINCT FROM v_hash_persistido THEN
    RAISE EXCEPTION 'La huella canónica persistida de la NC por período no coincide';
  END IF;

  RETURN QUERY SELECT
    v_resultado.venta_id::uuid,v_resultado.numero::text,
    v_resultado.es_cta_cte::boolean;
END;
$$;

ALTER FUNCTION public._crear_nota_credito_periodo_fiscal_core_20260828(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._crear_nota_credito_periodo_fiscal_core_20260828(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.aplicar_efectos_nc_periodo(p_venta_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_venta public.ventas%ROWTYPE;
  v_snapshot jsonb;
  v_items jsonb;
  v_plan_vector jsonb;
  v_intencion_hash text;
  v_version integer;
  v_stock_anterior numeric(14,2);
  v_stock_nuevo numeric(14,2);
  v_sesion_id uuid;
  v_efectivo numeric(14,2);
  v_plan_total numeric(14,2);
  v_rows integer;
  r record;
BEGIN
  SELECT * INTO v_venta
    FROM public.ventas
   WHERE id=p_venta_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NC por período inexistente: %',p_venta_id;
  END IF;
  IF v_venta.nc_periodo_modalidad IS NULL
     OR v_venta.nc_efectos_aplicados_at IS NOT NULL THEN
    RETURN;
  END IF;

  IF v_venta.tipo_comprobante<>'NOTA_CREDITO'
     OR v_venta.afip_cbte_asoc_id IS NOT NULL
     OR v_venta.estado<>'PENDIENTE_FISCAL'
     OR v_venta.afip_estado<>'APROBADO'
     OR v_venta.afip_fase IS DISTINCT FROM 'PERSISTIDO'
     OR v_venta.cae IS NULL
     OR v_venta.afip_numero IS NULL
     OR v_venta.afip_fecha_comprobante IS NULL
     OR v_venta.afip_imp_total IS NULL
     OR v_venta.periodo_asoc_desde IS NULL
     OR v_venta.periodo_asoc_hasta IS NULL
     OR v_venta.motivo_nota_credito IS NULL
     OR v_venta.nc_resolucion IS NULL
     OR v_venta.nc_periodo_payload_hash IS NULL
     OR v_venta.total>=0
     OR v_venta.percepciones<>0
     OR v_venta.total_pagado<>0
     OR v_venta.nc_efectos_aplicados_at IS NOT NULL THEN
    RAISE EXCEPTION 'La NC por período no está completa y aprobada para aplicar efectos';
  END IF;

  -- Este SELECT bloquea y materializa el plan una sola vez. El mismo vector se
  -- usa para la huella, caja y pagos; no existe una segunda lectura de tabla.
  SELECT m.payload_hash,m.reintegros_vector
    INTO STRICT v_intencion_hash,v_plan_vector
    FROM public.materializar_intencion_nc_periodo(p_venta_id) AS m;
  IF v_intencion_hash IS DISTINCT FROM v_venta.nc_periodo_payload_hash THEN
    RAISE EXCEPTION 'La huella canónica de la intención de NC por período no coincide';
  END IF;

  v_snapshot := v_venta.afip_snapshot;
  v_version := public.validar_snapshot_fiscal_persistido(v_snapshot);
  IF v_version<>3
     OR v_venta.afip_snapshot_hash IS NULL
     OR v_snapshot->>'hash' IS DISTINCT FROM v_venta.afip_snapshot_hash
     OR public.fiscal_snapshot_hash(v_snapshot) IS DISTINCT FROM v_venta.afip_snapshot_hash
     OR v_snapshot#>>'{venta,id}' IS DISTINCT FROM v_venta.id::text
     OR v_snapshot#>>'{venta,numeroComercial}' IS DISTINCT FROM v_venta.numero_comprobante
     OR v_snapshot#>>'{venta,tipoComprobante}' IS DISTINCT FROM v_venta.tipo_comprobante::text
     OR v_snapshot#>>'{venta,fechaComercial}' IS DISTINCT FROM pg_catalog.to_char(
          v_venta.fecha AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
     OR v_snapshot#>>'{sucursal,id}' IS DISTINCT FROM v_venta.sucursal_id::text
     OR v_snapshot#>>'{emisor,cuit}' IS DISTINCT FROM v_venta.afip_emisor_cuit
     OR v_snapshot#>>'{notaCredito,modalidad}' IS DISTINCT FROM v_venta.nc_periodo_modalidad::text
     OR v_snapshot#>>'{notaCredito,motivo}' IS DISTINCT FROM v_venta.motivo_nota_credito
     OR v_snapshot#>>'{periodoAsoc,desde}' IS DISTINCT FROM v_venta.periodo_asoc_desde::text
     OR v_snapshot#>>'{periodoAsoc,hasta}' IS DISTINCT FROM v_venta.periodo_asoc_hasta::text
     OR v_snapshot#>>'{identidad,numero}' IS DISTINCT FROM v_venta.afip_numero::text
     OR v_snapshot#>>'{identidad,emisorCuit}' IS DISTINCT FROM v_venta.afip_emisor_cuit
     OR v_snapshot#>>'{identidad,puntoVenta}' IS DISTINCT FROM v_venta.afip_punto_venta::text
     OR v_snapshot#>>'{identidad,cbteTipo}' IS DISTINCT FROM v_venta.afip_cbte_tipo::text
     OR v_snapshot#>>'{identidad,modo}' IS DISTINCT FROM v_venta.afip_modo
     OR v_snapshot#>'{identidad,simulado}'
          IS DISTINCT FROM pg_catalog.to_jsonb(v_venta.afip_simulado)
     OR v_snapshot#>>'{identidad,validez}' IS DISTINCT FROM v_venta.afip_validez
     OR v_snapshot->>'fechaComprobante' IS DISTINCT FROM v_venta.afip_fecha_comprobante::text
     OR v_snapshot->>'importeNeto' IS DISTINCT FROM pg_catalog.to_char(
          pg_catalog.abs(v_venta.subtotal_sin_iva),'FM999999999999990.00'
        )
     OR v_snapshot->>'importeIva' IS DISTINCT FROM pg_catalog.to_char(
          pg_catalog.abs(v_venta.iva_total),'FM999999999999990.00'
        )
     OR v_snapshot->>'importeTotal' IS DISTINCT FROM pg_catalog.to_char(
          pg_catalog.abs(v_venta.total),'FM999999999999990.00'
        )
     OR pg_catalog.abs(v_venta.afip_imp_total) IS DISTINCT FROM pg_catalog.abs(v_venta.total) THEN
    RAISE EXCEPTION 'El snapshot v3 persistido no coincide con la NC por período';
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id',i.id,
           'productoId',i.producto_id,
           'codigo',i.codigo,
           'descripcion',i.descripcion,
           'cantidad',pg_catalog.to_char(pg_catalog.abs(i.cantidad),'FM999999999999990.00'),
           'precioUnitarioSinIva',pg_catalog.to_char(pg_catalog.abs(i.precio_unitario_sin_iva),'FM999999999999990.00'),
           'descuentoPorcentaje',pg_catalog.to_char(i.descuento_porcentaje,'FM990.00'),
           'ivaPorcentaje',pg_catalog.to_char(i.iva_porcentaje,'FM990.00'),
           'subtotalNeto',pg_catalog.to_char(pg_catalog.abs(i.subtotal_sin_iva),'FM999999999999990.00'),
           'importeIva',pg_catalog.to_char(pg_catalog.abs(i.iva_monto),'FM999999999999990.00'),
           'subtotalTotal',pg_catalog.to_char(pg_catalog.abs(i.subtotal_con_iva),'FM999999999999990.00')
         ) ORDER BY i.id),'[]'::jsonb)
    INTO v_items
    FROM public.venta_items AS i
   WHERE i.venta_id=p_venta_id;
  IF v_snapshot->'items' IS DISTINCT FROM v_items THEN
    RAISE EXCEPTION 'Los ítems persistidos no coinciden con el snapshot fiscal v3';
  END IF;

  IF v_venta.nc_periodo_modalidad='DEVOLUCION_PRODUCTOS' THEN
    IF NOT EXISTS (
         SELECT 1 FROM public.venta_items i WHERE i.venta_id=p_venta_id
       )
       OR EXISTS (
         SELECT 1 FROM public.venta_items i
          WHERE i.venta_id=p_venta_id
            AND (i.producto_id IS NULL OR i.cantidad<=0)
       )
       OR (
         SELECT pg_catalog.count(*)
           FROM public.venta_items i WHERE i.venta_id=p_venta_id
       )<>(
         SELECT pg_catalog.count(DISTINCT i.producto_id)
           FROM public.venta_items i WHERE i.venta_id=p_venta_id
       ) THEN
      RAISE EXCEPTION 'DEVOLUCION_PRODUCTOS exige productos únicos y cantidades congeladas positivas';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.stock_movimientos m
       WHERE m.referencia_id=p_venta_id AND m.tipo='DEVOLUCION'
    ) THEN
      RAISE EXCEPTION 'La NC contiene movimientos previos sin marcador de efectos';
    END IF;

    PERFORM 1
      FROM public.productos AS p
     WHERE p.id IN (
       SELECT i.producto_id FROM public.venta_items AS i
        WHERE i.venta_id=p_venta_id
     )
     ORDER BY p.id
     FOR UPDATE;

    INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
    SELECT i.producto_id,v_venta.sucursal_id,0
      FROM public.venta_items AS i
     WHERE i.venta_id=p_venta_id
     ORDER BY i.producto_id
    ON CONFLICT (producto_id,sucursal_id) DO NOTHING;

    PERFORM 1
      FROM public.stock_sucursal AS s
     WHERE s.sucursal_id=v_venta.sucursal_id
       AND s.producto_id IN (
         SELECT i.producto_id FROM public.venta_items AS i
          WHERE i.venta_id=p_venta_id
       )
     ORDER BY s.producto_id
     FOR UPDATE;

    FOR r IN
      SELECT i.producto_id,pg_catalog.abs(i.cantidad) AS cantidad,i.descripcion
        FROM public.venta_items AS i
       WHERE i.venta_id=p_venta_id
       ORDER BY i.producto_id
    LOOP
      UPDATE public.stock_sucursal AS s
         SET cantidad=s.cantidad+r.cantidad
       WHERE s.producto_id=r.producto_id
         AND s.sucursal_id=v_venta.sucursal_id
      RETURNING s.cantidad-r.cantidad,s.cantidad
        INTO v_stock_anterior,v_stock_nuevo;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No se pudo bloquear el stock de la devolución';
      END IF;

      INSERT INTO public.stock_movimientos(
        producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,
        motivo,referencia_id,usuario_id
      ) VALUES (
        r.producto_id,v_venta.sucursal_id,'DEVOLUCION',r.cantidad,
        v_stock_anterior,v_stock_nuevo,
        'NC por período: '||r.descripcion,v_venta.id,v_venta.usuario_id
      );
    END LOOP;
  ELSIF v_venta.nc_periodo_modalidad='BONIFICACION_AJUSTE' THEN
    IF (SELECT pg_catalog.count(*) FROM public.venta_items i WHERE i.venta_id=p_venta_id)<>1
       OR EXISTS (
         SELECT 1 FROM public.venta_items i
          WHERE i.venta_id=p_venta_id
            AND (
              i.producto_id IS NOT NULL OR i.codigo<>'AJUSTE' OR i.cantidad<>1
              OR i.precio_lista_sin_iva IS DISTINCT FROM i.precio_unitario_sin_iva
              OR i.descuento_porcentaje<>0
            )
       ) THEN
      RAISE EXCEPTION 'BONIFICACION_AJUSTE exige un único concepto AJUSTE congelado';
    END IF;
  ELSE
    RAISE EXCEPTION 'Modalidad de NC por período no soportada';
  END IF;

  IF v_venta.nc_resolucion='REINTEGRO' THEN
    SELECT pg_catalog.count(*),COALESCE(pg_catalog.sum((e.item->>'monto')::numeric),0),
           COALESCE(pg_catalog.sum((e.item->>'monto')::numeric)
             FILTER (WHERE e.item->>'forma_pago'='EFECTIVO'),0)
      INTO v_rows,v_plan_total,v_efectivo
      FROM pg_catalog.jsonb_array_elements(v_plan_vector) AS e(item);
    IF v_venta.condicion_venta<>'CONTADO'
       OR v_rows<1
       OR v_plan_total IS DISTINCT FROM pg_catalog.abs(v_venta.total)
       OR EXISTS (SELECT 1 FROM public.venta_pagos p WHERE p.venta_id=p_venta_id)
       OR EXISTS (
         SELECT 1 FROM public.cuenta_corriente_movimientos m
          WHERE m.venta_id=p_venta_id
       ) THEN
      RAISE EXCEPTION 'El plan de reintegro no coincide con la resolución comercial';
    END IF;

    v_sesion_id := public.caja_sesion_actual(v_venta.sucursal_id);
    IF v_sesion_id IS NULL THEN
      RAISE EXCEPTION 'El reintegro exige una sesión de caja abierta';
    END IF;
    PERFORM public.exigir_efectivo(
      v_venta.sucursal_id,v_sesion_id,v_efectivo,'reintegrar la nota de crédito'
    );

    INSERT INTO public.venta_pagos(
      venta_id,forma_pago,monto,detalle,caja_sesion_id,cobro_idempotency_key
    )
    SELECT p_venta_id,(e.item->>'forma_pago')::public.forma_pago,
           -(e.item->>'monto')::numeric,e.item->'detalle',v_sesion_id,
           (e.item->>'id')::uuid
      FROM pg_catalog.jsonb_array_elements(v_plan_vector) AS e(item)
     ORDER BY (e.item->>'orden')::integer,(e.item->>'id')::uuid;

  ELSIF v_venta.nc_resolucion='SALDO_FAVOR' THEN
    IF v_venta.condicion_venta<>'CTA_CTE'
       OR pg_catalog.jsonb_array_length(v_plan_vector)<>0
       OR EXISTS (SELECT 1 FROM public.venta_pagos p WHERE p.venta_id=p_venta_id)
       OR EXISTS (
         SELECT 1 FROM public.cuenta_corriente_movimientos m
          WHERE m.venta_id=p_venta_id
       ) THEN
      RAISE EXCEPTION 'El saldo a favor no coincide con la resolución comercial';
    END IF;

    PERFORM public.cc_registrar_por_venta(p_venta_id);
    IF NOT EXISTS (
      SELECT 1 FROM public.cuenta_corriente_movimientos AS m
       WHERE m.venta_id=p_venta_id
         AND m.cliente_id=v_venta.cliente_id
         AND m.tipo='CREDITO'
         AND m.estado='CONFIRMADO'
         AND m.monto=pg_catalog.abs(v_venta.total)
    ) THEN
      RAISE EXCEPTION 'No se pudo registrar el crédito comercial de la NC';
    END IF;

  ELSE
    RAISE EXCEPTION 'Resolución de NC por período no soportada';
  END IF;

  UPDATE public.ventas
     SET estado='ACTIVA',
         total_pagado=CASE nc_resolucion
           WHEN 'REINTEGRO'::public.resolucion_nc_periodo THEN total
           ELSE 0
         END,
         estado_pago=CASE nc_resolucion
           WHEN 'REINTEGRO'::public.resolucion_nc_periodo
             THEN 'PAGADO'::public.estado_pago
           ELSE 'PENDIENTE'::public.estado_pago
         END,
         nc_efectos_aplicados_at=pg_catalog.clock_timestamp()
   WHERE id=p_venta_id AND nc_efectos_aplicados_at IS NULL;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Los efectos de la NC no se marcaron exactamente una vez';
  END IF;
END;
$$;

ALTER FUNCTION public.aplicar_efectos_nc_periodo(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.aplicar_efectos_nc_periodo(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- Contrato único para cualquier CAE que se vaya a persistir, sea respuesta
-- directa o recuperación. Los jsonb de entrada preservan tipo/ausencia/null.
CREATE FUNCTION public.validar_evidencia_cae_fiscal(
  p_origen text,
  p_evidencia jsonb,
  p_cae jsonb,
  p_cae_vencimiento jsonb,
  p_emitido_at jsonb
)
RETURNS TABLE(cae text,cae_vencimiento date,emitido_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_cae text;
  v_vencimiento_text text;
  v_vencimiento date;
  v_emitido_text text;
  v_emitido timestamptz;
  v_claves text[];
BEGIN
  IF p_origen NOT IN ('EMISION','RECUPERACION') THEN
    RAISE EXCEPTION 'Origen de evidencia CAE no válido';
  END IF;
  IF pg_catalog.jsonb_typeof(p_cae) IS DISTINCT FROM 'string'
     OR p_cae#>>'{}' !~ '^[0-9]{14}$' THEN
    RAISE EXCEPTION 'CAE debe ser un texto canónico de 14 dígitos';
  END IF;
  v_cae := p_cae#>>'{}';

  IF pg_catalog.jsonb_typeof(p_cae_vencimiento)='null' THEN
    IF p_origen='EMISION' THEN
      RAISE EXCEPTION 'La fecha de vencimiento CAE es obligatoria para APROBAR';
    END IF;
    v_vencimiento := NULL;
  ELSIF pg_catalog.jsonb_typeof(p_cae_vencimiento)='string' THEN
    v_vencimiento_text := p_cae_vencimiento#>>'{}';
    IF v_vencimiento_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'La fecha CAE debe usar YYYY-MM-DD canónico';
    END IF;
    BEGIN
      v_vencimiento := v_vencimiento_text::date;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RAISE EXCEPTION 'cae_vencimiento debe ser una fecha válida';
    END;
    IF v_vencimiento_text IS DISTINCT FROM
         pg_catalog.to_char(v_vencimiento,'YYYY-MM-DD') THEN
      RAISE EXCEPTION 'La fecha CAE debe usar YYYY-MM-DD canónico';
    END IF;
  ELSE
    RAISE EXCEPTION 'cae_vencimiento tiene tipo inválido: debe ser null o string según el origen';
  END IF;

  IF p_origen='EMISION' THEN
    IF pg_catalog.jsonb_typeof(p_emitido_at) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'El timestamp de emisión debe ser texto UTC finito';
    END IF;
    v_emitido_text := p_emitido_at#>>'{}';
    IF v_emitido_text !~
         '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' THEN
      RAISE EXCEPTION 'El timestamp de emisión debe ser UTC canónico y finito';
    END IF;
    BEGIN
      v_emitido := v_emitido_text::timestamptz;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RAISE EXCEPTION 'El timestamp de emisión no es válido';
    END;
    IF NOT pg_catalog.isfinite(v_emitido)
       OR (
         CASE WHEN v_emitido_text LIKE '%.%'
           THEN pg_catalog.to_char(
             v_emitido AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           )
           ELSE pg_catalog.to_char(
             v_emitido AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'
           )
         END
       ) IS DISTINCT FROM v_emitido_text THEN
      RAISE EXCEPTION 'El timestamp de emisión debe ser UTC canónico y finito';
    END IF;

    IF pg_catalog.jsonb_typeof(p_evidencia) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'respuesta_resumen de aprobación: esquema de evidencia inválido';
    END IF;
    SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_claves
      FROM pg_catalog.jsonb_object_keys(p_evidencia) AS k
     WHERE NOT (k=ANY(ARRAY[
       'tipo','resultado','fuente','rechazo_confirmado','observaciones',
       'cae','cae_vencimiento','emitido_at'
     ]));
    IF v_claves IS NOT NULL
       OR p_evidencia->>'tipo' IS DISTINCT FROM 'EMISION'
       OR p_evidencia->>'resultado' IS DISTINCT FROM 'A'
       OR p_evidencia->>'fuente' IS DISTINCT FROM 'FECAESolicitar'
       OR p_evidencia->'rechazo_confirmado' IS DISTINCT FROM 'false'::jsonb
       OR pg_catalog.jsonb_typeof(p_evidencia->'observaciones') IS DISTINCT FROM 'array'
       OR p_evidencia->'cae' IS DISTINCT FROM p_cae
       OR p_evidencia->'cae_vencimiento' IS DISTINCT FROM p_cae_vencimiento
       OR p_evidencia->'emitido_at' IS DISTINCT FROM p_emitido_at THEN
      RAISE EXCEPTION 'respuesta_resumen: esquema no permitido o evidencia de aprobación no coincidente con CAE y parámetros';
    END IF;
  ELSE
    IF p_emitido_at IS NOT NULL AND p_emitido_at<>'null'::jsonb THEN
      RAISE EXCEPTION 'La recuperación usa el reloj del servidor';
    END IF;
    IF pg_catalog.jsonb_typeof(p_evidencia) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'respuesta_resumen de recuperación: esquema de evidencia inválido';
    END IF;
    SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_claves
      FROM pg_catalog.jsonb_object_keys(p_evidencia) AS k
     WHERE NOT (k=ANY(ARRAY[
       'tipo','resultado','fuente','coincidencia_completa','observaciones',
       'cae','cae_vencimiento'
     ]));
    IF v_claves IS NOT NULL
       OR p_evidencia->>'tipo' IS DISTINCT FROM 'CONSULTA_ARCA'
       OR p_evidencia->>'resultado' IS DISTINCT FROM 'COINCIDE'
       OR p_evidencia->>'fuente' IS DISTINCT FROM 'FECompConsultar'
       OR p_evidencia->'coincidencia_completa' IS DISTINCT FROM 'true'::jsonb
       OR p_evidencia->'observaciones' IS DISTINCT FROM '[]'::jsonb
       OR p_evidencia->'cae' IS DISTINCT FROM p_cae
       OR p_evidencia->'cae_vencimiento' IS DISTINCT FROM p_cae_vencimiento THEN
      RAISE EXCEPTION 'respuesta_resumen de recuperación no es exacto para CAE y parámetros';
    END IF;
    v_emitido := pg_catalog.clock_timestamp();
  END IF;

  RETURN QUERY SELECT v_cae,v_vencimiento,v_emitido;
END;
$$;

ALTER FUNCTION public.validar_evidencia_cae_fiscal(text,jsonb,jsonb,jsonb,jsonb)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.validar_evidencia_cae_fiscal(
  text,jsonb,jsonb,jsonb,jsonb
) FROM PUBLIC,anon,authenticated,service_role;

-- Se conserva intacta la máquina efectiva y se la oculta detrás de un wrapper
-- que sólo agrega la frontera de evidencia. El wrapper toma exactamente los
-- mismos locks original→NC→intento antes de validar y luego delega el CAS.
ALTER FUNCTION public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)
  RENAME TO _transicionar_emision_fiscal_core_task8_fix1;
REVOKE ALL ON FUNCTION public._transicionar_emision_fiscal_core_task8_fix1(
  uuid,text,uuid,jsonb
) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.transicionar_emision_fiscal(
  p_venta_id uuid,
  p_accion text,
  p_claim_token uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE(
  venta_id uuid,afip_estado text,afip_fase text,afip_claim_token uuid,
  afip_numero integer,afip_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_tipo public.tipo_comprobante;
  v_original_id uuid;
  v_venta public.ventas%ROWTYPE;
  v_intento public.emision_fiscal_intentos%ROWTYPE;
  v_resumen jsonb;
  v_resumen_core jsonb;
  v_payload_core jsonb := p_payload;
  v_rows integer;
  v_schema_ok boolean;
BEGIN
  IF p_accion IS NULL
     OR p_accion NOT IN ('RESPUESTA_RECIBIDA','APROBAR','RECUPERAR_CAE') THEN
    RETURN QUERY
    SELECT * FROM public._transicionar_emision_fiscal_core_task8_fix1(
      p_venta_id,p_accion,p_claim_token,p_payload
    );
    RETURN;
  END IF;

  SELECT v.tipo_comprobante,v.afip_cbte_asoc_id
    INTO v_tipo,v_original_id
    FROM public.ventas AS v
   WHERE v.id=p_venta_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta fiscal inexistente: %',p_venta_id;
  END IF;
  IF v_tipo='NOTA_CREDITO' AND v_original_id IS NOT NULL THEN
    PERFORM 1 FROM public.ventas AS o
     WHERE o.id=v_original_id
     FOR UPDATE;
  END IF;
  SELECT v.* INTO STRICT v_venta
    FROM public.ventas AS v
   WHERE v.id=p_venta_id
   FOR UPDATE;
  SELECT i.* INTO v_intento
    FROM public.emision_fiscal_intentos AS i
   WHERE i.venta_id=p_venta_id AND i.claim_token=p_claim_token
   FOR UPDATE;

  IF p_accion='RESPUESTA_RECIBIDA' THEN
    v_schema_ok := pg_catalog.jsonb_typeof(p_payload)='object'
      AND p_payload ?& ARRAY['expected_version','respuesta_resumen']
      AND (SELECT pg_catalog.count(*)=2
             FROM pg_catalog.jsonb_object_keys(p_payload)) ;
    IF v_schema_ok IS DISTINCT FROM true THEN
      RETURN QUERY
      SELECT * FROM public._transicionar_emision_fiscal_core_task8_fix1(
        p_venta_id,p_accion,p_claim_token,p_payload
      );
      RETURN;
    END IF;
    v_resumen := p_payload->'respuesta_resumen';
    IF v_resumen->>'resultado'='A' THEN
      PERFORM * FROM public.validar_evidencia_cae_fiscal(
        'EMISION',v_resumen,v_resumen->'cae',
        v_resumen->'cae_vencimiento',v_resumen->'emitido_at'
      );
      v_resumen_core := v_resumen-'cae'-'cae_vencimiento'-'emitido_at';
      v_payload_core := pg_catalog.jsonb_set(
        p_payload,'{respuesta_resumen}',v_resumen_core,false
      );
    END IF;

    RETURN QUERY
    SELECT * FROM public._transicionar_emision_fiscal_core_task8_fix1(
      p_venta_id,p_accion,p_claim_token,v_payload_core
    );
    IF v_resumen->>'resultado'='A' THEN
      UPDATE public.emision_fiscal_intentos AS i
         SET respuesta_resumen=pg_catalog.jsonb_set(
           i.respuesta_resumen,'{evidencia_externa,respuesta_emision}',
           v_resumen,true
         )
       WHERE i.id=v_intento.id;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION 'No se persistió exactamente una evidencia de aprobación';
      END IF;
    END IF;
    RETURN;
  END IF;

  IF p_accion='APROBAR' THEN
    v_schema_ok := pg_catalog.jsonb_typeof(p_payload)='object'
      AND p_payload ?& ARRAY[
        'expected_version','cae','cae_vencimiento','emitido_at'
      ]
      AND (SELECT pg_catalog.count(*)=4
             FROM pg_catalog.jsonb_object_keys(p_payload));
    IF v_schema_ok IS DISTINCT FROM true
       OR v_venta.afip_estado<>'EMITIENDO'
       OR v_venta.afip_fase IS DISTINCT FROM 'RESPUESTA_RECIBIDA' THEN
      RETURN QUERY
      SELECT * FROM public._transicionar_emision_fiscal_core_task8_fix1(
        p_venta_id,p_accion,p_claim_token,p_payload
      );
      RETURN;
    END IF;
    v_resumen := v_intento.respuesta_resumen#>'{evidencia_externa,respuesta_emision}';
    PERFORM * FROM public.validar_evidencia_cae_fiscal(
      'EMISION',v_resumen,p_payload->'cae',
      p_payload->'cae_vencimiento',p_payload->'emitido_at'
    );
    RETURN QUERY
    SELECT * FROM public._transicionar_emision_fiscal_core_task8_fix1(
      p_venta_id,p_accion,p_claim_token,p_payload
    );
    RETURN;
  END IF;

  v_schema_ok := pg_catalog.jsonb_typeof(p_payload)='object'
    AND p_payload ?& ARRAY[
      'expected_version','cae','cae_vencimiento','payload_hash',
      'respuesta_resumen'
    ]
    AND (SELECT pg_catalog.count(*)=5
           FROM pg_catalog.jsonb_object_keys(p_payload));
  IF v_schema_ok IS DISTINCT FROM true
     OR v_venta.afip_estado<>'RECONCILIAR' THEN
    RETURN QUERY
    SELECT * FROM public._transicionar_emision_fiscal_core_task8_fix1(
      p_venta_id,p_accion,p_claim_token,p_payload
    );
    RETURN;
  END IF;
  v_resumen := p_payload->'respuesta_resumen';
  PERFORM * FROM public.validar_evidencia_cae_fiscal(
    'RECUPERACION',v_resumen,p_payload->'cae',
    p_payload->'cae_vencimiento',NULL
  );
  v_resumen_core := v_resumen-'cae'-'cae_vencimiento';
  v_payload_core := pg_catalog.jsonb_set(
    p_payload,'{respuesta_resumen}',v_resumen_core,false
  );
  RETURN QUERY
  SELECT * FROM public._transicionar_emision_fiscal_core_task8_fix1(
    p_venta_id,p_accion,p_claim_token,v_payload_core
  );
  UPDATE public.emision_fiscal_intentos AS i
     SET respuesta_resumen=pg_catalog.jsonb_set(
       i.respuesta_resumen,'{evidencia_externa,consulta_recuperacion}',
       v_resumen,true
     )
   WHERE i.id=v_intento.id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'No se persistió exactamente una evidencia de recuperación';
  END IF;
END;
$$;

ALTER FUNCTION public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)
  TO service_role;
