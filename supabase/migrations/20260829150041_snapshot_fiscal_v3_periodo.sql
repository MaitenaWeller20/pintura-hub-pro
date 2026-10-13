-- Snapshot fiscal canónico para notas de crédito asociadas por período.
-- V2 permanece cerrado; v3 proyecta únicamente su cuerpo común al validador
-- existente y valida por separado la asociación por período.
CREATE FUNCTION public.validar_snapshot_fiscal_v3(p_snapshot jsonb)
RETURNS void
LANGUAGE plpgsql
STABLE
STRICT
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_desconocidas text[];
  v_periodo jsonb;
  v_nota jsonb;
  v_venta jsonb;
  v_identidad jsonb;
  v_emisor jsonb;
  v_receptor jsonb;
  v_desde date;
  v_hasta date;
  v_emision date;
  v_letra text;
  v_letra_validacion text;
  v_tipo_esperado integer;
  v_proxy jsonb;
BEGIN
  IF pg_catalog.jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'snapshot v3: la raíz debe ser un objeto';
  END IF;
  SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_desconocidas
    FROM pg_catalog.jsonb_object_keys(p_snapshot) AS k
   WHERE NOT (k=ANY(ARRAY[
     'version','hash','venta','items','emisor','sucursal','receptor','identidad',
     'letra','concepto','fechaComprobante','importeNeto','importeExento',
     'importeNoGravado','importeIva','importeTributos','importeTotal',
     'alicuotasIva','tributos','moneda','cotizacion','ivaContenido',
     'otrosImpuestosNacionalesIndirectos','origen','comprobanteOriginalId',
     'cbtesAsoc','periodoAsoc','notaCredito'
   ]));
  IF v_desconocidas IS NOT NULL
     OR NOT (p_snapshot ?& ARRAY[
       'version','hash','venta','items','emisor','sucursal','receptor','identidad',
       'letra','concepto','fechaComprobante','importeNeto','importeExento',
       'importeNoGravado','importeIva','importeTributos','importeTotal',
       'alicuotasIva','tributos','moneda','cotizacion','ivaContenido',
       'otrosImpuestosNacionalesIndirectos','origen','comprobanteOriginalId',
       'cbtesAsoc','periodoAsoc','notaCredito'
     ]) THEN
    RAISE EXCEPTION 'snapshot v3: la raíz tiene claves faltantes o desconocidas';
  END IF;
  IF pg_catalog.jsonb_typeof(p_snapshot->'version') IS DISTINCT FROM 'number'
     OR p_snapshot->>'version' IS DISTINCT FROM '3'
     OR pg_catalog.jsonb_typeof(p_snapshot->'hash') IS DISTINCT FROM 'string'
     OR p_snapshot->>'hash' !~ '^[0-9a-f]{64}$'
     OR public.fiscal_snapshot_hash(p_snapshot) IS DISTINCT FROM p_snapshot->>'hash' THEN
    RAISE EXCEPTION 'snapshot v3: versión o hash inválido';
  END IF;
  IF pg_catalog.jsonb_typeof(p_snapshot->'origen') IS DISTINCT FROM 'string'
     OR p_snapshot->>'origen' IS DISTINCT FROM 'PERIODO_ASOCIADO'
     OR pg_catalog.jsonb_typeof(p_snapshot->'comprobanteOriginalId') IS DISTINCT FROM 'null'
     OR pg_catalog.jsonb_typeof(p_snapshot->'cbtesAsoc') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_snapshot->'cbtesAsoc')<>0 THEN
    RAISE EXCEPTION 'snapshot v3: origen y asociación por período inválidos';
  END IF;

  v_periodo := p_snapshot->'periodoAsoc';
  IF pg_catalog.jsonb_typeof(v_periodo) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'snapshot v3: periodoAsoc debe ser objeto';
  END IF;
  SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_desconocidas
    FROM pg_catalog.jsonb_object_keys(v_periodo) AS k
   WHERE NOT (k=ANY(ARRAY['desde','hasta']));
  IF v_desconocidas IS NOT NULL OR NOT (v_periodo ?& ARRAY['desde','hasta'])
     OR pg_catalog.jsonb_typeof(v_periodo->'desde') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(v_periodo->'hasta') IS DISTINCT FROM 'string'
     OR v_periodo->>'desde' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR v_periodo->>'hasta' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR pg_catalog.substr(v_periodo->>'desde',1,4) NOT BETWEEN '0001' AND '9999'
     OR pg_catalog.substr(v_periodo->>'hasta',1,4) NOT BETWEEN '0001' AND '9999'
     OR pg_catalog.jsonb_typeof(p_snapshot->'fechaComprobante') IS DISTINCT FROM 'string'
     OR p_snapshot->>'fechaComprobante' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR pg_catalog.substr(p_snapshot->>'fechaComprobante',1,4) NOT BETWEEN '0001' AND '9999' THEN
    RAISE EXCEPTION 'snapshot v3: período o fecha de emisión inválidos';
  END IF;
  BEGIN
    v_desde := (v_periodo->>'desde')::date;
    v_hasta := (v_periodo->>'hasta')::date;
    v_emision := (p_snapshot->>'fechaComprobante')::date;
    IF pg_catalog.to_char(v_desde,'YYYY-MM-DD') IS DISTINCT FROM v_periodo->>'desde'
       OR pg_catalog.to_char(v_hasta,'YYYY-MM-DD') IS DISTINCT FROM v_periodo->>'hasta'
       OR pg_catalog.to_char(v_emision,'YYYY-MM-DD') IS DISTINCT FROM p_snapshot->>'fechaComprobante' THEN
      RAISE EXCEPTION 'fecha no canónica';
    END IF;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'snapshot v3: período o fecha de emisión inválidos';
  END;
  IF v_desde>v_hasta OR v_hasta>v_emision THEN
    RAISE EXCEPTION 'snapshot v3: período invertido o posterior a la emisión';
  END IF;

  v_nota := p_snapshot->'notaCredito';
  IF pg_catalog.jsonb_typeof(v_nota) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'snapshot v3: notaCredito debe ser objeto';
  END IF;
  SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_desconocidas
    FROM pg_catalog.jsonb_object_keys(v_nota) AS k
   WHERE NOT (k=ANY(ARRAY['modalidad','motivo']));
  IF v_desconocidas IS NOT NULL OR NOT (v_nota ?& ARRAY['modalidad','motivo'])
     OR pg_catalog.jsonb_typeof(v_nota->'modalidad') IS DISTINCT FROM 'string'
     OR v_nota->>'modalidad' NOT IN ('DEVOLUCION_PRODUCTOS','BONIFICACION_AJUSTE')
     OR pg_catalog.jsonb_typeof(v_nota->'motivo') IS DISTINCT FROM 'string'
     OR pg_catalog.length(pg_catalog.btrim(v_nota->>'motivo'))<5 THEN
    RAISE EXCEPTION 'snapshot v3: modalidad o motivo inválidos';
  END IF;

  v_venta := p_snapshot->'venta';
  v_identidad := p_snapshot->'identidad';
  v_emisor := p_snapshot->'emisor';
  v_receptor := p_snapshot->'receptor';
  v_letra := p_snapshot->>'letra';
  v_tipo_esperado := CASE v_letra WHEN 'A' THEN 3 WHEN 'B' THEN 8 WHEN 'C' THEN 13 END;
  IF pg_catalog.jsonb_typeof(v_venta) IS DISTINCT FROM 'object'
     OR v_venta->>'tipoComprobante' IS DISTINCT FROM 'NOTA_CREDITO'
     OR pg_catalog.jsonb_typeof(v_identidad) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_identidad->'cbteTipo') IS DISTINCT FROM 'number'
     OR v_tipo_esperado IS NULL
     OR v_identidad->>'cbteTipo' IS DISTINCT FROM v_tipo_esperado::text THEN
    RAISE EXCEPTION 'snapshot v3: NOTA_CREDITO o CbteTipo 3/8/13 inválido';
  END IF;
  IF pg_catalog.jsonb_typeof(v_emisor) IS DISTINCT FROM 'object'
     OR (v_letra='C' AND v_emisor->>'condicionIva' IS DISTINCT FROM 'MONOTRIBUTO')
     OR (v_letra<>'C' AND v_emisor->>'condicionIva' IS DISTINCT FROM 'RESPONSABLE_INSCRIPTO') THEN
    RAISE EXCEPTION 'snapshot v3: letra incompatible con condición IVA del emisor';
  END IF;
  IF pg_catalog.jsonb_typeof(p_snapshot->'importeTributos') IS DISTINCT FROM 'string'
     OR p_snapshot->>'importeTributos' IS DISTINCT FROM '0.00'
     OR pg_catalog.jsonb_typeof(p_snapshot->'otrosImpuestosNacionalesIndirectos') IS DISTINCT FROM 'string'
     OR p_snapshot->>'otrosImpuestosNacionalesIndirectos' IS DISTINCT FROM '0.00'
     OR pg_catalog.jsonb_typeof(p_snapshot->'tributos') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_snapshot->'tributos')<>0 THEN
    RAISE EXCEPTION 'snapshot v3: no admite tributos';
  END IF;
  IF pg_catalog.jsonb_typeof(p_snapshot->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'snapshot v3: items debe ser array';
  END IF;
  IF v_nota->>'modalidad'='DEVOLUCION_PRODUCTOS' THEN
    IF pg_catalog.jsonb_array_length(p_snapshot->'items')=0 OR EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(p_snapshot->'items') AS item
       WHERE pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object'
          OR pg_catalog.jsonb_typeof(item->'productoId') IS DISTINCT FROM 'string'
    ) THEN
      RAISE EXCEPTION 'snapshot v3: devolución exige líneas con productoId';
    END IF;
  ELSIF pg_catalog.jsonb_array_length(p_snapshot->'items')<>1
        OR pg_catalog.jsonb_typeof(p_snapshot->'items'->0) IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(p_snapshot#>'{items,0,productoId}') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'snapshot v3: bonificación exige un concepto libre único';
  END IF;

  -- Proyección cerrada para reutilizar el contrato canónico v2 sin aceptar v3
  -- en validar_snapshot_fiscal_v2 ni reconstruir ningún dato vivo.
  v_letra_validacion := CASE
    WHEN v_letra<>'C' THEN v_letra
    WHEN v_receptor->>'condicionIva' IN ('RESPONSABLE_INSCRIPTO','MONOTRIBUTO') THEN 'A'
    ELSE 'B'
  END;
  v_proxy := p_snapshot-'hash'-'periodoAsoc'-'notaCredito';
  v_proxy := pg_catalog.jsonb_set(v_proxy,'{version}','2'::jsonb,false);
  IF v_letra='C' THEN
    v_proxy := pg_catalog.jsonb_set(
      v_proxy,'{emisor,condicionIva}',pg_catalog.to_jsonb('RESPONSABLE_INSCRIPTO'::text),false
    );
  END IF;
  v_proxy := pg_catalog.jsonb_set(v_proxy,'{letra}',pg_catalog.to_jsonb(v_letra_validacion),false);
  v_proxy := pg_catalog.jsonb_set(
    v_proxy,'{identidad,cbteTipo}',
    pg_catalog.to_jsonb(CASE v_letra_validacion WHEN 'A' THEN 3 ELSE 8 END),false
  );
  v_proxy := pg_catalog.jsonb_set(
    v_proxy,'{ivaContenido}',
    pg_catalog.to_jsonb(CASE
      WHEN v_letra_validacion='B' AND v_receptor->>'condicionIva'='CONSUMIDOR_FINAL'
        THEN p_snapshot->>'importeIva'
      ELSE '0.00'
    END),false
  );
  v_proxy := pg_catalog.jsonb_set(
    v_proxy,'{origen}',pg_catalog.to_jsonb('COMPROBANTE_ORIGINAL'::text),false
  );
  v_proxy := pg_catalog.jsonb_set(
    v_proxy,'{comprobanteOriginalId}',
    pg_catalog.to_jsonb('00000000-0000-4000-8000-000000000001'::text),false
  );
  v_proxy := pg_catalog.jsonb_set(
    v_proxy,'{cbtesAsoc}',
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'tipo',CASE v_letra_validacion WHEN 'A' THEN 1 ELSE 6 END,
      'puntoVenta',v_identidad->'puntoVenta',
      'numero',1,
      'cuit',v_identidad->'emisorCuit',
      'fecha',p_snapshot->'fechaComprobante'
    )),false
  );
  v_proxy := v_proxy||pg_catalog.jsonb_build_object(
    'hash',public.fiscal_snapshot_hash(v_proxy)
  );
  PERFORM public.validar_snapshot_fiscal_v2(v_proxy);

  IF v_letra='C' AND p_snapshot->>'ivaContenido' IS DISTINCT FROM '0.00' THEN
    RAISE EXCEPTION 'snapshot v3: una NC C no admite IVA Contenido';
  END IF;
END;
$$;

ALTER FUNCTION public.validar_snapshot_fiscal_v3(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.validar_snapshot_fiscal_v3(jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.validar_snapshot_fiscal_persistido(p_snapshot jsonb)
RETURNS integer
LANGUAGE plpgsql
STABLE
STRICT
SECURITY INVOKER
SET search_path=''
AS $$
BEGIN
  IF pg_catalog.jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(p_snapshot->'version') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'La versión del snapshot fiscal no está soportada';
  END IF;
  IF p_snapshot->>'version'='2' THEN
    PERFORM public.validar_snapshot_fiscal_v2(p_snapshot);
    RETURN 2;
  ELSIF p_snapshot->>'version'='3' THEN
    PERFORM public.validar_snapshot_fiscal_v3(p_snapshot);
    RETURN 3;
  END IF;
  RAISE EXCEPTION 'La versión del snapshot fiscal no está soportada';
END;
$$;

ALTER FUNCTION public.validar_snapshot_fiscal_persistido(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.validar_snapshot_fiscal_persistido(jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

-- Un snapshot presente queda unido de forma inequívoca a la clase de venta.
-- PENDIENTE_FISCAL conserva snapshot nulo hasta que una etapa posterior reserve
-- identidad; afip_version sigue siendo sólo la versión optimista del workflow.
ALTER TABLE public.ventas
  DROP CONSTRAINT ck_ventas_afip_snapshot_coherente;

ALTER TABLE public.ventas
  ADD CONSTRAINT ck_ventas_afip_snapshot_coherente
  CHECK (
    (
      afip_snapshot IS NULL
      OR afip_snapshot->>'version'=(CASE WHEN nc_periodo_modalidad IS NULL THEN '2' ELSE '3' END)
    )
    AND (afip_snapshot_hash IS NULL OR (
      afip_snapshot IS NOT NULL
      AND afip_version >= 2
      AND afip_snapshot->>'version'=(CASE WHEN nc_periodo_modalidad IS NULL THEN '2' ELSE '3' END)
    ))
    AND (
      afip_numero IS NULL
      OR afip_version=0
      OR (
        afip_snapshot IS NOT NULL
        AND afip_snapshot_hash IS NOT NULL
        AND afip_version >= 2
        AND afip_snapshot->>'version'=(CASE WHEN nc_periodo_modalidad IS NULL THEN '2' ELSE '3' END)
      )
      OR (afip_estado='BLOQUEADO' AND afip_legacy_incompleto)
    )
  );

-- Preserva literalmente la matriz efectiva y sustituye sólo la expectativa de
-- versión de snapshot por la unión persistida v2/v3.
DO $$
DECLARE
  v_definition text;
  v_old constant text :=
    'NOT ((afip_snapshot ->> ''version''::text) IS DISTINCT FROM ''2''::text)';
  v_new constant text :=
    'NOT ((afip_snapshot ->> ''version''::text) IS DISTINCT FROM (CASE WHEN nc_periodo_modalidad IS NULL THEN ''2''::text ELSE ''3''::text END))';
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid)
    INTO v_definition
    FROM pg_catalog.pg_constraint AS c
   WHERE c.conrelid='public.ventas'::regclass
     AND c.conname='ck_ventas_afip_estado_integridad';
  IF v_definition IS NULL OR pg_catalog.strpos(v_definition,v_old)=0 THEN
    RAISE EXCEPTION 'No se encontró la definición efectiva esperada de ck_ventas_afip_estado_integridad';
  END IF;
  v_definition := pg_catalog.replace(v_definition,v_old,v_new);
  ALTER TABLE public.ventas DROP CONSTRAINT ck_ventas_afip_estado_integridad;
  EXECUTE 'ALTER TABLE public.ventas ADD CONSTRAINT ck_ventas_afip_estado_integridad '
    ||v_definition;
END;
$$;

COMMENT ON FUNCTION public.validar_snapshot_fiscal_v3(jsonb) IS
  'Valida el snapshot fiscal v3 canónico de una NC asociada por período.';
COMMENT ON FUNCTION public.validar_snapshot_fiscal_persistido(jsonb) IS
  'Despacha snapshots fiscales persistidos v2/v3 y devuelve la versión validada.';
