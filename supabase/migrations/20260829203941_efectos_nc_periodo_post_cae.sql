-- La cabecera comercial sigue pendiente durante todo el lifecycle fiscal. El
-- estado fiscal ya no puede quedar clavado en SIN_FACTURAR una vez que la
-- transición toma el claim, pero el resto de la intención continúa cerrado.
ALTER TABLE public.ventas
  DROP CONSTRAINT ventas_pendiente_fiscal_nc_periodo_check;

ALTER TABLE public.ventas
  ADD CONSTRAINT ventas_pendiente_fiscal_nc_periodo_check CHECK (
    estado<>'PENDIENTE_FISCAL'
    OR (
      tipo_comprobante='NOTA_CREDITO'
      AND afip_cbte_asoc_id IS NULL
      AND nc_periodo_modalidad IS NOT NULL
      AND periodo_asoc_desde IS NOT NULL
      AND periodo_asoc_hasta IS NOT NULL
      AND periodo_asoc_desde<=periodo_asoc_hasta
      AND motivo_nota_credito IS NOT NULL
      AND pg_catalog.length(pg_catalog.btrim(motivo_nota_credito))>=5
      AND nc_resolucion IS NOT NULL
      AND nc_periodo_payload_hash~'^[0-9a-f]{64}$'
      AND nc_efectos_aplicados_at IS NULL
      AND subtotal_sin_iva<0
      AND iva_total<=0
      AND total<0
      AND percepciones=0
      AND total_pagado=0
      AND caja_sesion_id IS NULL
      AND condicion_venta=(
        CASE nc_resolucion
          WHEN 'REINTEGRO'::public.resolucion_nc_periodo
            THEN 'CONTADO'::public.condicion_venta
          WHEN 'SALDO_FAVOR'::public.resolucion_nc_periodo
            THEN 'CTA_CTE'::public.condicion_venta
        END
      )
    )
  );

-- Guardia dura adicional al lock de ventas: aun si otro writer privilegiado
-- intentara repetir una devolución, no puede duplicar producto/referencia.
CREATE UNIQUE INDEX uq_stock_movimientos_devolucion_referencia_producto
  ON public.stock_movimientos(referencia_id,producto_id)
  WHERE tipo='DEVOLUCION' AND referencia_id IS NOT NULL;

CREATE FUNCTION public.aplicar_efectos_nc_periodo(p_venta_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_venta public.ventas%ROWTYPE;
  v_snapshot jsonb;
  v_items jsonb;
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

    -- Productos inactivos siguen siendo válidos: sólo se bloquean y nunca se
    -- repricingan. El orden estable evita ciclos entre devoluciones simultáneas.
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
    SELECT pg_catalog.count(*),COALESCE(pg_catalog.sum(reintegro.monto),0),
           COALESCE(pg_catalog.sum(reintegro.monto)
             FILTER (WHERE reintegro.forma_pago='EFECTIVO'),0)
      INTO v_rows,v_plan_total,v_efectivo
      FROM public.nota_credito_periodo_reintegros AS reintegro
     WHERE reintegro.venta_id=p_venta_id;
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
    SELECT p_venta_id,reintegro.forma_pago,-reintegro.monto,reintegro.detalle,
           v_sesion_id,reintegro.id
      FROM public.nota_credito_periodo_reintegros AS reintegro
     WHERE reintegro.venta_id=p_venta_id
     ORDER BY reintegro.orden,reintegro.id;

  ELSIF v_venta.nc_resolucion='SALDO_FAVOR' THEN
    IF v_venta.condicion_venta<>'CTA_CTE'
       OR EXISTS (
         SELECT 1 FROM public.nota_credito_periodo_reintegros reintegro
          WHERE reintegro.venta_id=p_venta_id
       )
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

CREATE OR REPLACE FUNCTION public.transicionar_emision_fiscal(p_venta_id uuid, p_accion text, p_claim_token uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(venta_id uuid, afip_estado text, afip_fase text, afip_claim_token uuid, afip_numero integer, afip_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid;
  v_venta public.ventas%ROWTYPE;
  v_original public.ventas%ROWTYPE;
  v_intento public.emision_fiscal_intentos%ROWTYPE;
  v_tipo_pre public.tipo_comprobante;
  v_asoc_pre uuid;
  v_acciones constant text[] := ARRAY[
    'RECLAMAR','RESERVAR','REQUEST_INICIADO','RESPUESTA_RECIBIDA','APROBAR',
    'RECUPERAR_CAE','ERROR_CORREGIBLE','RECONCILIAR','REENVIO_VERIFICADO','LIBERAR',
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
  v_max_local_nuevo integer;
  v_max_local_id uuid;
  v_max_local_id_nuevo uuid;
  v_max_local_version integer;
  v_max_local_version_nueva integer;
  v_max_local_fila public.ventas%ROWTYPE;
  v_max_local_cambio_concurrente boolean := false;
  v_reserva_ajena_id uuid;
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
  v_cae text;
  v_cae_vencimiento date;
  v_cae_vencimiento_text text;
  v_snapshot_version integer;
  v_periodo_enabled boolean;
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

  -- El worker fiscal usa service_role sin sesión de usuario; en ese caso la
  -- autoridad revalidada es el usuario persistido en la venta bloqueada. Una
  -- llamada con JWT siempre se valida contra el actor real y no contra la fila.
  v_uid := COALESCE(auth.uid(),v_venta.usuario_id);
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE='42501';
  END IF;
  IF v_venta.nc_periodo_modalidad IS NOT NULL THEN
    IF NOT public.puede_emitir_nc_periodo(v_uid) THEN
      RAISE EXCEPTION 'Sin permiso para emitir notas de crédito por período'
        USING ERRCODE='42501';
    END IF;
    SELECT s.nota_credito_periodo_enabled
      INTO v_periodo_enabled
      FROM public.settings AS s
     WHERE s.id=true
     FOR SHARE;
    v_periodo_enabled := COALESCE(v_periodo_enabled,false);
    IF NOT v_periodo_enabled
       AND (
         (p_accion='RECLAMAR' AND v_venta.afip_estado<>'RECONCILIAR')
         OR p_accion IN ('RESERVAR','REQUEST_INICIADO','REENVIO_VERIFICADO')
       ) THEN
      RAISE EXCEPTION 'La emisión de notas de crédito por período está deshabilitada';
    END IF;
  ELSIF NOT public.puede_facturar(v_uid) THEN
    RAISE EXCEPTION 'Sin permiso para emitir comprobantes fiscales'
      USING ERRCODE='42501';
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
    WHEN 'RECUPERAR_CAE' THEN
      v_permitidas := ARRAY[
        'expected_version','cae','cae_vencimiento','payload_hash',
        'respuesta_resumen'
      ];
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
    RAISE EXCEPTION 'EMISION_FISCAL_VERSION_CONFLICT: versión esperada % no coincide con versión fiscal %',
      v_expected,v_venta.afip_version USING ERRCODE='PT409';
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
    IF v_venta.nc_periodo_modalidad IS NOT NULL THEN
      IF v_venta.estado<>'PENDIENTE_FISCAL'
         OR v_venta.afip_estado<>'SIN_FACTURAR'
         OR v_venta.afip_numero IS NOT NULL
         OR v_venta.afip_fase IS NOT NULL
         OR v_venta.afip_intentos<>0
         OR v_venta.nc_efectos_aplicados_at IS NOT NULL
         OR v_venta.afip_claim_token IS NOT NULL
         OR v_venta.afip_claimed_at IS NOT NULL
         OR v_venta.cae IS NOT NULL
         OR v_venta.afip_snapshot IS NOT NULL
         OR v_venta.afip_snapshot_hash IS NOT NULL THEN
        RAISE EXCEPTION 'CANCELAR está prohibido: la NC por período ya no está intacta';
      END IF;
      UPDATE public.ventas AS v
         SET estado='ANULADA',afip_estado='CANCELADO',
             afip_version=v.afip_version+1
       WHERE v.id=p_venta_id AND v.afip_version=v_expected;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION 'CANCELAR no actualizó exactamente una NC por período';
      END IF;
      RETURN QUERY
      SELECT v.id,v.afip_estado,v.afip_fase,v.afip_claim_token,
             v.afip_numero,v.afip_version
        FROM public.ventas AS v WHERE v.id=p_venta_id;
      RETURN;
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
       OR v_snapshot->>'version' NOT IN ('2','3')
       OR pg_catalog.jsonb_typeof(v_snapshot->'hash') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_snapshot->'identidad') IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_snapshot->'fechaComprobante') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_snapshot->'importeTotal') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_snapshot->'receptor') IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_snapshot->'items') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'RESERVAR: snapshot fiscal persistido requiere objeto, identidad, fecha, monto, receptor e items';
    END IF;
    SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_desconocidas
      FROM pg_catalog.jsonb_object_keys(v_snapshot->'identidad') AS k
     WHERE NOT (k=ANY(ARRAY[
       'numero','emisorCuit','puntoVenta','cbteTipo','modo','simulado','validez'
     ]));
    IF v_desconocidas IS NOT NULL
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,numero}') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,emisorCuit}') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,puntoVenta}') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,cbteTipo}') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,modo}') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,simulado}') IS DISTINCT FROM 'boolean'
       OR pg_catalog.jsonb_typeof(v_snapshot#>'{identidad,validez}') IS DISTINCT FROM 'string' THEN
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
       OR NOT public.cuit_fiscal_snapshot_valido(p_payload->>'emisor_cuit')
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
       OR v_snapshot#>>'{identidad,validez}' IS DISTINCT FROM v_validez
       OR v_snapshot->>'fechaComprobante' IS DISTINCT FROM p_payload->>'fecha_comprobante' THEN
      RAISE EXCEPTION 'RESERVAR: identidad/fecha del snapshot no coincide con la reserva';
    END IF;
    v_snapshot_version := public.validar_snapshot_fiscal_persistido(v_snapshot);
    IF v_snapshot->>'importeTotal' IS NULL
       OR NOT (v_snapshot->>'importeTotal' ~ '^(0|[1-9][0-9]*)\.[0-9]{2}$') THEN
      RAISE EXCEPTION 'RESERVAR: importeTotal debe ser decimal canónico con dos posiciones';
    END IF;
    IF (v_snapshot->>'importeTotal')::numeric > 999999999999.99 THEN
      RAISE EXCEPTION 'RESERVAR: importeTotal excede el rango fiscal';
    END IF;
    v_imp_total := (v_snapshot->>'importeTotal')::numeric(14,2);
    IF v_imp_total IS DISTINCT FROM ABS(v_venta.total) THEN
      RAISE EXCEPTION 'RESERVAR: importeTotal no coincide con la venta';
    END IF;

    IF v_venta.tipo_comprobante='NOTA_CREDITO'
       AND v_venta.afip_cbte_asoc_id IS NOT NULL THEN
      -- Shape canónico que consumen Tasks 7/9:
      -- {
      --   ..., "origen":"COMPROBANTE_ORIGINAL",
      --   "comprobanteOriginalId":"<ventas.id>",
      --   "cbtesAsoc":[{"tipo":6,"puntoVenta":997,
      --                  "numero":997001,"cuit":"<CUIT>",
      --                  "fecha":"YYYY-MM-DD"}]
      -- }
      -- receptor es copia JSON exacta del snapshot aprobado original; la
      -- identidad superior corresponde a la NC y deriva emisor/PV/modo del
      -- original, con cbteTipo 1→3, 6→8 o 11→13.
      IF v_original.afip_estado<>'APROBADO'
         OR v_original.afip_fase IS DISTINCT FROM 'PERSISTIDO'
         OR v_original.afip_version<2
         OR v_original.afip_legacy_incompleto
         OR v_original.estado<>'ANULADA'
         OR v_original.venta_anulada_por IS DISTINCT FROM v_venta.id
         OR v_original.cae IS NULL
         OR v_original.afip_validez IS DISTINCT FROM 'PRODUCCION'
         OR v_original.afip_modo IS DISTINCT FROM 'PRODUCCION'
         OR v_original.afip_simulado
         OR v_original.afip_emisor_cuit IS NULL
         OR v_original.afip_punto_venta IS NULL
         OR v_original.afip_cbte_tipo IS NULL
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
         OR v_original.afip_snapshot#>>'{identidad,validez}' IS DISTINCT FROM v_original.afip_validez
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

      BEGIN
        PERFORM public.validar_snapshot_fiscal_v2(v_original.afip_snapshot);
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'NC asociada: snapshot original v2 inválido: %',SQLERRM;
      END;

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

      IF v_snapshot->'emisor' IS DISTINCT FROM v_original.afip_snapshot->'emisor'
         OR v_snapshot->'sucursal' IS DISTINCT FROM v_original.afip_snapshot->'sucursal'
         OR v_snapshot->'receptor' IS DISTINCT FROM v_original.afip_snapshot->'receptor'
         OR v_snapshot->>'letra' IS DISTINCT FROM v_original.afip_snapshot->>'letra'
         OR v_snapshot->'concepto' IS DISTINCT FROM v_original.afip_snapshot->'concepto'
         OR v_snapshot->>'moneda' IS DISTINCT FROM v_original.afip_snapshot->>'moneda'
         OR v_snapshot->>'cotizacion' IS DISTINCT FROM v_original.afip_snapshot->>'cotizacion'
         OR v_snapshot->>'importeNeto' IS DISTINCT FROM v_original.afip_snapshot->>'importeNeto'
         OR v_snapshot->>'importeExento' IS DISTINCT FROM v_original.afip_snapshot->>'importeExento'
         OR v_snapshot->>'importeNoGravado' IS DISTINCT FROM v_original.afip_snapshot->>'importeNoGravado'
         OR v_snapshot->>'importeIva' IS DISTINCT FROM v_original.afip_snapshot->>'importeIva'
         OR v_snapshot->>'importeTributos' IS DISTINCT FROM v_original.afip_snapshot->>'importeTributos'
         OR v_snapshot->>'importeTotal' IS DISTINCT FROM v_original.afip_snapshot->>'importeTotal'
         OR v_snapshot->'items' IS DISTINCT FROM v_original.afip_snapshot->'items'
         OR v_snapshot->'alicuotasIva' IS DISTINCT FROM v_original.afip_snapshot->'alicuotasIva'
         OR v_snapshot->'tributos' IS DISTINCT FROM v_original.afip_snapshot->'tributos'
         OR v_snapshot->>'ivaContenido' IS DISTINCT FROM v_original.afip_snapshot->>'ivaContenido'
         OR v_snapshot->>'otrosImpuestosNacionalesIndirectos'
              IS DISTINCT FROM v_original.afip_snapshot->>'otrosImpuestosNacionalesIndirectos' THEN
        RAISE EXCEPTION 'NC asociada: emisor, sucursal, receptor, items, letra/concepto, moneda y desglose positivo deben heredarse del original';
      END IF;

      IF pg_catalog.jsonb_typeof(v_snapshot->'origen') IS DISTINCT FROM 'string'
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
       WHERE NOT (k=ANY(ARRAY['tipo','puntoVenta','numero','cuit','fecha']));
      IF v_desconocidas IS NOT NULL
         OR NOT (v_cbte_asoc ?& ARRAY['tipo','puntoVenta','numero','cuit','fecha'])
         OR pg_catalog.jsonb_typeof(v_cbte_asoc->'tipo') IS DISTINCT FROM 'number'
         OR pg_catalog.jsonb_typeof(v_cbte_asoc->'puntoVenta') IS DISTINCT FROM 'number'
         OR pg_catalog.jsonb_typeof(v_cbte_asoc->'numero') IS DISTINCT FROM 'number'
         OR pg_catalog.jsonb_typeof(v_cbte_asoc->'cuit') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(v_cbte_asoc->'fecha') IS DISTINCT FROM 'string'
         OR v_cbte_asoc->>'tipo' IS DISTINCT FROM v_original.afip_cbte_tipo::text
         OR v_cbte_asoc->>'puntoVenta' IS DISTINCT FROM v_original.afip_punto_venta::text
         OR v_cbte_asoc->>'numero' IS DISTINCT FROM v_original.afip_numero::text
         OR v_cbte_asoc->>'cuit' IS DISTINCT FROM v_original.afip_emisor_cuit
         OR v_cbte_asoc->>'fecha' IS DISTINCT FROM v_original.afip_fecha_comprobante::text THEN
        RAISE EXCEPTION 'NC asociada: CbtesAsoc debe copiar tipo, PV, número, CUIT y fecha del original';
      END IF;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_emisor_cuit||'|'||v_punto_venta::text||'|'||v_cbte_tipo::text||'|'||
        v_modo||'|'||v_simulado::text,
        0
      )
    );

    -- La fila que define el máximo puede cambiar mientras esperamos su lock
    -- (por ejemplo, pasa a APROBADO o libera la identidad). Primero fijamos su
    -- id inmutable, la bloqueamos por id y luego recomputamos bajo el advisory.
    -- Así no dependemos de predicados fiscales mutables durante EvalPlanQual.
    SELECT v.id,v.afip_numero,v.afip_version
      INTO v_max_local_id,v_max_local,v_max_local_version
      FROM public.ventas AS v
     WHERE v.afip_emisor_cuit=v_emisor_cuit
       AND v.afip_punto_venta=v_punto_venta
       AND v.afip_cbte_tipo=v_cbte_tipo
       AND v.afip_modo=v_modo
       AND v.afip_simulado=v_simulado
       AND v.afip_numero IS NOT NULL
     ORDER BY v.afip_numero DESC,v.id
     LIMIT 1;
    v_max_local := COALESCE(v_max_local,0);
    IF v_ultimo_local_observado<>v_max_local THEN
      RAISE EXCEPTION 'EMISION_FISCAL_SECUENCIA_OBSOLETA: ultimo_local_observado % quedó obsoleto; máximo local %',
        v_ultimo_local_observado,v_max_local USING ERRCODE='PT409';
    END IF;

    LOOP
      EXIT WHEN v_max_local_id IS NULL;

      SELECT v.* INTO v_max_local_fila
        FROM public.ventas AS v
       WHERE v.id=v_max_local_id
       FOR UPDATE;
      IF NOT FOUND
         OR v_max_local_fila.afip_version IS DISTINCT FROM v_max_local_version
         OR v_max_local_fila.afip_numero IS DISTINCT FROM v_max_local THEN
        v_max_local_cambio_concurrente := true;
      END IF;

      SELECT v.id,v.afip_numero,v.afip_version
        INTO v_max_local_id_nuevo,v_max_local_nuevo,v_max_local_version_nueva
        FROM public.ventas AS v
       WHERE v.afip_emisor_cuit=v_emisor_cuit
         AND v.afip_punto_venta=v_punto_venta
         AND v.afip_cbte_tipo=v_cbte_tipo
         AND v.afip_modo=v_modo
         AND v.afip_simulado=v_simulado
         AND v.afip_numero IS NOT NULL
       ORDER BY v.afip_numero DESC,v.id
       LIMIT 1;
      v_max_local_nuevo := COALESCE(v_max_local_nuevo,0);

      IF v_max_local_id_nuevo IS NOT DISTINCT FROM v_max_local_id THEN
        v_max_local := v_max_local_nuevo;
        EXIT;
      END IF;

      v_max_local_id := v_max_local_id_nuevo;
      v_max_local := v_max_local_nuevo;
      v_max_local_version := v_max_local_version_nueva;
    END LOOP;

    IF v_simulado THEN
      IF v_max_local=2147483647 THEN
        RAISE EXCEPTION 'RESERVAR: secuencia simulada agotada';
      END IF;
      IF v_numero<>v_max_local+1 THEN
        RAISE EXCEPTION 'numero_propuesto simulado debe ser max_local + 1';
      END IF;
    ELSE
      IF v_max_local>v_ultimo_remoto THEN
        v_reserva_ajena_id := NULL;
        IF v_max_local=v_ultimo_remoto+1
           AND v_max_local_fila.id IS NOT NULL
           AND v_max_local_fila.id<>p_venta_id
           AND v_max_local_fila.afip_numero=v_max_local
           AND v_max_local_fila.cae IS NULL
           AND v_max_local_fila.afip_claim_token IS NOT NULL
           AND (
             (
               v_max_local_fila.afip_estado='EMITIENDO'
               AND v_max_local_fila.afip_fase IN (
                 'RESERVADO','REQUEST_INICIADO','RESPUESTA_RECIBIDA'
               )
             )
             OR (
               v_max_local_fila.afip_estado='RECONCILIAR'
               AND v_max_local_fila.afip_fase IN (
                 'REQUEST_INICIADO','RESPUESTA_RECIBIDA'
               )
             )
           ) THEN
          v_reserva_ajena_id := v_max_local_fila.id;
        END IF;

        IF v_reserva_ajena_id IS NOT NULL THEN
          UPDATE public.ventas AS v
             SET afip_estado='ERROR_CORREGIBLE',
                 afip_fase=NULL,
                 afip_claim_token=NULL,
                 afip_claimed_at=NULL,
                 afip_error='Otra emisión de la misma identidad fiscal está en curso',
                 afip_error_clase='SECUENCIA',
                 afip_error_codigo='IDENTIDAD_FISCAL_OCUPADA',
                 afip_error_fase='PREFLIGHT',
                 afip_ultimo_error_at=pg_catalog.clock_timestamp(),
                 afip_emisor_cuit=NULL,
                 afip_punto_venta=NULL,
                 afip_cbte_tipo=NULL,
                 afip_numero=NULL,
                 afip_modo=NULL,
                 afip_simulado=false,
                 afip_validez=NULL,
                 afip_fecha_comprobante=NULL,
                 afip_snapshot=NULL,
                 afip_snapshot_hash=NULL,
                 afip_imp_total=NULL,
                 afip_version=v.afip_version+1
           WHERE v.id=p_venta_id AND v.afip_version=v_expected;
          GET DIAGNOSTICS v_rows=ROW_COUNT;
          IF v_rows<>1 THEN
            RAISE EXCEPTION 'RESERVAR no liberó el claim ante una identidad fiscal ocupada';
          END IF;
          UPDATE public.emision_fiscal_intentos AS i
             SET resultado='IDENTIDAD_FISCAL_OCUPADA',
                 error_clase='SECUENCIA',
                 error_codigo='IDENTIDAD_FISCAL_OCUPADA',
                 respuesta_resumen=pg_catalog.jsonb_set(
                   i.respuesta_resumen,'{diagnostico}',
                   pg_catalog.jsonb_build_object(
                     'identidad_fiscal_ocupada',true,
                     'venta_activa_id',v_reserva_ajena_id,
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

        IF v_max_local_cambio_concurrente THEN
          RAISE EXCEPTION 'EMISION_FISCAL_SECUENCIA_OBSOLETA: la fila que definía el máximo local cambió durante RESERVAR; reintentar'
            USING ERRCODE='PT409';
        END IF;

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
       SET snapshot_version=v_snapshot_version,payload_hash=v_snapshot_hash,
           fase='RESERVADO',resultado='RESERVADO',numero_reservado=v_numero
     WHERE i.id=v_intento.id;

  ELSIF p_accion='REQUEST_INICIADO' THEN
    IF v_venta.afip_estado<>'EMITIENDO' OR v_venta.afip_fase<>'RESERVADO'
       OR v_venta.afip_numero IS NULL THEN
      RAISE EXCEPTION 'REQUEST_INICIADO sólo es válido desde RESERVADO';
    END IF;
    IF pg_catalog.jsonb_typeof(v_venta.afip_snapshot) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_venta.afip_snapshot->'version') IS DISTINCT FROM 'number'
       OR v_intento.snapshot_version IS DISTINCT FROM (v_venta.afip_snapshot->>'version')::integer
       OR v_intento.payload_hash IS DISTINCT FROM v_venta.afip_snapshot_hash THEN
      RAISE EXCEPTION 'REQUEST_INICIADO exige intento y snapshot de la misma versión';
    END IF;
    PERFORM public.validar_snapshot_fiscal_persistido(v_venta.afip_snapshot);
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
       OR v_venta.afip_snapshot_hash IS NULL
       OR v_venta.afip_fecha_comprobante IS NULL THEN
      RAISE EXCEPTION 'APROBAR exige respuesta, número, fecha y snapshot/hash persistido';
    END IF;
    IF pg_catalog.jsonb_typeof(v_venta.afip_snapshot->'version') IS DISTINCT FROM 'number'
       OR v_intento.snapshot_version IS DISTINCT FROM (v_venta.afip_snapshot->>'version')::integer
       OR v_intento.payload_hash IS DISTINCT FROM v_venta.afip_snapshot_hash THEN
      RAISE EXCEPTION 'APROBAR exige intento y snapshot de la misma versión';
    END IF;
    PERFORM public.validar_snapshot_fiscal_persistido(v_venta.afip_snapshot);
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
    PERFORM public.aplicar_efectos_nc_periodo(p_venta_id);

  ELSIF p_accion='RECUPERAR_CAE' THEN
    -- La recuperación no reutiliza APROBAR: sólo una consulta ARCA completa y
    -- exacta puede cerrar una identidad que quedó durable en RECONCILIAR.
    IF v_venta.afip_estado<>'RECONCILIAR'
       OR v_venta.afip_fase NOT IN ('REQUEST_INICIADO','RESPUESTA_RECIBIDA')
       OR v_venta.afip_claim_token IS NULL
       OR v_venta.afip_claimed_at IS NULL
       OR v_venta.afip_numero IS NULL
       OR v_venta.afip_emisor_cuit IS NULL
       OR v_venta.afip_punto_venta IS NULL
       OR v_venta.afip_cbte_tipo IS NULL
       OR v_venta.afip_modo IS NULL
       OR v_venta.afip_validez IS NULL
       OR v_venta.afip_fecha_comprobante IS NULL
       OR v_venta.afip_imp_total IS NULL
       OR v_venta.cae IS NOT NULL
       OR v_venta.cae_vencimiento IS NOT NULL
       OR v_venta.afip_emitido_at IS NOT NULL
       OR pg_catalog.jsonb_typeof(v_venta.afip_snapshot) IS DISTINCT FROM 'object'
       OR v_venta.afip_snapshot_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'RECUPERAR_CAE exige RECONCILIAR con identidad y snapshot completos sin CAE';
    END IF;
    IF v_intento.fase IS DISTINCT FROM v_venta.afip_fase
       OR v_intento.fase NOT IN ('REQUEST_INICIADO','RESPUESTA_RECIBIDA')
       OR v_intento.resultado IS DISTINCT FROM 'RECONCILIAR'
       OR pg_catalog.jsonb_typeof(v_venta.afip_snapshot->'version') IS DISTINCT FROM 'number'
       OR v_intento.snapshot_version IS DISTINCT FROM (v_venta.afip_snapshot->>'version')::integer
       OR v_intento.numero_reservado IS DISTINCT FROM v_venta.afip_numero THEN
      RAISE EXCEPTION 'RECUPERAR_CAE exige un intento vigente reconciliable y coherente';
    END IF;

    v_snapshot := v_venta.afip_snapshot;
    v_snapshot_hash := v_venta.afip_snapshot_hash;
    BEGIN
      PERFORM public.validar_snapshot_fiscal_persistido(v_snapshot);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'RECUPERAR_CAE: snapshot fiscal persistido inválido: %',SQLERRM;
    END;
    v_hash_recalculado := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(public.fiscal_json_canonico(v_snapshot-'hash'),'UTF8'),
        'sha256'
      ),'hex'
    );
    IF v_hash_recalculado IS DISTINCT FROM v_snapshot_hash
       OR v_snapshot->>'hash' IS DISTINCT FROM v_snapshot_hash
       OR v_intento.payload_hash IS DISTINCT FROM v_snapshot_hash
       OR pg_catalog.jsonb_typeof(p_payload->'payload_hash') IS DISTINCT FROM 'string'
       OR p_payload->>'payload_hash' !~ '^[0-9a-f]{64}$'
       OR p_payload->>'payload_hash' IS DISTINCT FROM v_snapshot_hash THEN
      RAISE EXCEPTION 'RECUPERAR_CAE: payload_hash no coincide con la identidad reservada';
    END IF;
    IF v_snapshot#>>'{identidad,numero}' IS DISTINCT FROM v_venta.afip_numero::text
       OR v_snapshot#>>'{identidad,emisorCuit}' IS DISTINCT FROM v_venta.afip_emisor_cuit
       OR v_snapshot#>>'{identidad,puntoVenta}' IS DISTINCT FROM v_venta.afip_punto_venta::text
       OR v_snapshot#>>'{identidad,cbteTipo}' IS DISTINCT FROM v_venta.afip_cbte_tipo::text
       OR v_snapshot#>>'{identidad,modo}' IS DISTINCT FROM v_venta.afip_modo
       OR v_snapshot#>'{identidad,simulado}'
            IS DISTINCT FROM pg_catalog.to_jsonb(v_venta.afip_simulado)
       OR v_snapshot#>>'{identidad,validez}' IS DISTINCT FROM v_venta.afip_validez
       OR v_snapshot->>'fechaComprobante'
            IS DISTINCT FROM v_venta.afip_fecha_comprobante::text
       OR v_snapshot->>'importeTotal' !~ '^(0|[1-9][0-9]*)\.[0-9]{2}$'
       OR (v_snapshot->>'importeTotal')::numeric
            IS DISTINCT FROM pg_catalog.abs(v_venta.afip_imp_total)
       OR pg_catalog.abs(v_venta.afip_imp_total)
            IS DISTINCT FROM pg_catalog.abs(v_venta.total) THEN
      RAISE EXCEPTION 'RECUPERAR_CAE: identidad, fecha o total congelado no coincide con el snapshot';
    END IF;

    IF pg_catalog.jsonb_typeof(p_payload->'cae') IS DISTINCT FROM 'string'
       OR p_payload->>'cae' !~ '^[0-9]{14}$' THEN
      RAISE EXCEPTION 'RECUPERAR_CAE exige CAE textual canónico de 14 dígitos';
    END IF;
    v_cae := p_payload->>'cae';

    IF pg_catalog.jsonb_typeof(p_payload->'cae_vencimiento')='null' THEN
      v_cae_vencimiento := NULL;
    ELSIF pg_catalog.jsonb_typeof(p_payload->'cae_vencimiento')='string' THEN
      v_cae_vencimiento_text := p_payload->>'cae_vencimiento';
      IF v_cae_vencimiento_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'RECUPERAR_CAE: cae_vencimiento debe ser fecha válida YYYY-MM-DD o null';
      END IF;
      BEGIN
        v_cae_vencimiento := v_cae_vencimiento_text::date;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
        RAISE EXCEPTION 'RECUPERAR_CAE: cae_vencimiento debe ser una fecha válida';
      END;
      IF v_cae_vencimiento_text
           IS DISTINCT FROM pg_catalog.to_char(v_cae_vencimiento,'YYYY-MM-DD') THEN
        RAISE EXCEPTION 'RECUPERAR_CAE: cae_vencimiento debe ser una fecha válida YYYY-MM-DD';
      END IF;
    ELSE
      RAISE EXCEPTION 'RECUPERAR_CAE: cae_vencimiento debe ser null o string';
    END IF;

    v_resumen := p_payload->'respuesta_resumen';
    IF pg_catalog.jsonb_typeof(v_resumen) IS DISTINCT FROM 'object'
       OR pg_catalog.octet_length(v_resumen::text)>1024 THEN
      RAISE EXCEPTION 'RECUPERAR_CAE: resumen de consulta exacta inválido';
    END IF;
    SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_resumen_claves
      FROM pg_catalog.jsonb_object_keys(v_resumen) AS k
     WHERE NOT (k=ANY(ARRAY[
       'tipo','resultado','fuente','coincidencia_completa','observaciones'
     ]));
    IF v_resumen_claves IS NOT NULL
       OR NOT (v_resumen ?& ARRAY[
         'tipo','resultado','fuente','coincidencia_completa','observaciones'
       ])
       OR pg_catalog.jsonb_typeof(v_resumen->'tipo') IS DISTINCT FROM 'string'
       OR v_resumen->>'tipo' IS DISTINCT FROM 'CONSULTA_ARCA'
       OR pg_catalog.jsonb_typeof(v_resumen->'resultado') IS DISTINCT FROM 'string'
       OR v_resumen->>'resultado' IS DISTINCT FROM 'COINCIDE'
       OR pg_catalog.jsonb_typeof(v_resumen->'fuente') IS DISTINCT FROM 'string'
       OR v_resumen->>'fuente' IS DISTINCT FROM 'FECompConsultar'
       OR pg_catalog.jsonb_typeof(v_resumen->'coincidencia_completa')
            IS DISTINCT FROM 'boolean'
       OR v_resumen->'coincidencia_completa' IS DISTINCT FROM 'true'::jsonb
       OR pg_catalog.jsonb_typeof(v_resumen->'observaciones') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(v_resumen->'observaciones')<>0 THEN
      RAISE EXCEPTION 'RECUPERAR_CAE exige resumen exacto y literal de coincidencia completa';
    END IF;
    IF v_resumen::text ~* '(<[^>]*>|soap|xml|raw|authorization|bearer|token|secret|private.?key|certificate|certificado|clave|password|wsaa|ticket)' THEN
      RAISE EXCEPTION 'RECUPERAR_CAE: resumen contiene raw, XML o secreto';
    END IF;
    IF v_intento.respuesta_resumen#>'{evidencia_externa,consulta_recuperacion}'
         IS NOT NULL THEN
      RAISE EXCEPTION 'RECUPERAR_CAE: la consulta de recuperación ya fue auditada';
    END IF;

    UPDATE public.ventas AS v
       SET afip_estado='APROBADO',
           afip_fase='PERSISTIDO',
           cae=v_cae,
           cae_vencimiento=v_cae_vencimiento,
           afip_emitido_at=pg_catalog.clock_timestamp(),
           afip_claim_token=NULL,
           afip_claimed_at=NULL,
           afip_error=NULL,
           afip_error_clase=NULL,
           afip_error_codigo=NULL,
           afip_error_fase=NULL,
           afip_ultimo_error_at=NULL,
           afip_version=v.afip_version+1
     WHERE v.id=p_venta_id
       AND v.afip_version=v_expected
       AND v.afip_estado='RECONCILIAR'
       AND v.afip_claim_token=p_claim_token
       AND v.cae IS NULL;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'RECUPERAR_CAE no actualizó exactamente una venta';
    END IF;

    UPDATE public.emision_fiscal_intentos AS i
       SET fase='PERSISTIDO',
           resultado='RECUPERADO_CAE',
           respuesta_resumen=pg_catalog.jsonb_set(
             i.respuesta_resumen,'{evidencia_externa}',
             COALESCE(i.respuesta_resumen->'evidencia_externa','{}'::jsonb)
               || pg_catalog.jsonb_build_object('consulta_recuperacion',v_resumen),
             true
           )
     WHERE i.id=v_intento.id
       AND i.resultado='RECONCILIAR'
       AND i.respuesta_resumen#>'{evidencia_externa,consulta_recuperacion}' IS NULL;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'RECUPERAR_CAE no actualizó exactamente un intento auditado';
    END IF;
    PERFORM public.aplicar_efectos_nc_periodo(p_venta_id);

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
      p_venta_id,v_nuevo_claim,(v_venta.afip_snapshot->>'version')::integer,
      v_venta.afip_snapshot_hash,'RESERVADO',
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
$function$;

ALTER FUNCTION public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)
  TO service_role;
