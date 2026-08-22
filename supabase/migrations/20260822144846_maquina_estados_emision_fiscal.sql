-- ============================================================
-- Máquina durable de emisión fiscal.
--
-- No llama a ARCA: el lookup remoto ocurre antes de RESERVAR. La transacción
-- corta toma locks de fila + advisory únicamente para validar y congelar la
-- identidad fiscal que después no puede reescribirse.
-- ============================================================

-- Matriz explícita estado/fase. Las excepciones sin fase están limitadas a
-- filas version-0 del escritor legacy y a los tres fixtures aditivos de Task 2.
-- Desde RESERVADO, toda identidad fiscal debe estar completa y ser coherente
-- con el snapshot que quedó congelado.
ALTER TABLE public.ventas
  DROP CONSTRAINT ck_ventas_afip_estado_integridad;

ALTER TABLE public.ventas
  ADD CONSTRAINT ck_ventas_afip_estado_integridad
  CHECK (
    (
      afip_estado <> 'APROBADO'
      OR (
        cae IS NOT NULL
        AND afip_numero IS NOT NULL
        AND (
          afip_version=0
          OR afip_legacy_incompleto
          OR (
            afip_version >= 2
            AND afip_snapshot IS NOT NULL
            AND afip_snapshot->>'version' IS NOT DISTINCT FROM '2'
            AND afip_snapshot_hash IS NOT NULL
            AND afip_fecha_comprobante IS NOT NULL
            AND afip_validez IS NOT NULL
          )
        )
      )
    )
    AND (afip_estado <> 'CANCELADO' OR cae IS NULL)
    AND (
      afip_estado <> 'RECONCILIAR'
      OR (
        afip_numero IS NOT NULL
        AND afip_snapshot IS NOT NULL
        AND afip_snapshot->>'version' IS NOT DISTINCT FROM '2'
        AND afip_snapshot_hash IS NOT NULL
        AND afip_version >= 2
        AND NOT afip_legacy_incompleto
      )
    )
    AND (
      -- Todo dato version-0 pertenece al escritor legacy y nunca tiene fase.
      (afip_version=0 AND afip_fase IS NULL)
      OR (
        afip_version >= 1
        AND (
          -- Estados fuera del workflow durable o ya liberados.
          (
            afip_fase IS NULL
            AND afip_estado IN (
              'NO_APLICA','PENDIENTE','ERROR','SIN_FACTURAR',
              'ERROR_CORREGIBLE','CANCELADO','BLOQUEADO'
            )
            AND afip_claim_token IS NULL
            AND afip_claimed_at IS NULL
          )
          -- Compatibilidad aditiva exacta con los fixtures version-2 de Task 2.
          OR (
            afip_fase IS NULL
            AND afip_version = 2
            AND (
              (
                afip_estado='EMITIENDO'
                AND afip_claim_token IS NOT NULL
                AND afip_claimed_at IS NOT NULL
                AND afip_numero IS NULL
                AND afip_snapshot IS NOT NULL
                AND afip_snapshot->>'version' IS NOT DISTINCT FROM '2'
                AND afip_snapshot_hash IS NOT NULL
              )
              OR afip_estado IN ('RECONCILIAR','APROBADO')
            )
          )
          -- Claim adquirido, todavía sin identidad reservada.
          OR (
            afip_fase='PREFLIGHT'
            AND afip_estado IN ('EMITIENDO','BLOQUEADO')
            AND afip_claim_token IS NOT NULL
            AND afip_claimed_at IS NOT NULL
            AND afip_numero IS NULL
            AND afip_emisor_cuit IS NULL
            AND afip_punto_venta IS NULL
            AND afip_cbte_tipo IS NULL
            AND afip_modo IS NULL
            AND afip_validez IS NULL
            AND afip_fecha_comprobante IS NULL
            AND afip_snapshot IS NULL
            AND afip_snapshot_hash IS NULL
            AND afip_imp_total IS NULL
          )
          -- Identidad congelada antes de iniciar el request.
          OR (
            afip_fase='RESERVADO'
            AND afip_estado IN ('EMITIENDO','BLOQUEADO')
            AND afip_claim_token IS NOT NULL
            AND afip_claimed_at IS NOT NULL
            AND afip_numero IS NOT NULL AND afip_numero>0
            AND afip_emisor_cuit ~ '^[0-9]{11}$'
            AND afip_punto_venta BETWEEN 1 AND 99999
            AND afip_cbte_tipo BETWEEN 1 AND 9999
            AND afip_modo IN ('PRODUCCION','HOMOLOGACION')
            AND afip_validez IN ('PRODUCCION','HOMOLOGACION','SIMULADA')
            AND afip_fecha_comprobante IS NOT NULL
            AND afip_imp_total IS NOT NULL
            AND pg_catalog.jsonb_typeof(afip_snapshot) IS NOT DISTINCT FROM 'object'
            AND pg_catalog.jsonb_typeof(afip_snapshot->'version') IS NOT DISTINCT FROM 'number'
            AND afip_snapshot->>'version' IS NOT DISTINCT FROM '2'
            AND pg_catalog.jsonb_typeof(afip_snapshot->'hash') IS NOT DISTINCT FROM 'string'
            AND afip_snapshot_hash ~ '^[0-9a-f]{64}$'
            AND afip_snapshot->>'hash' IS NOT DISTINCT FROM afip_snapshot_hash
            AND pg_catalog.jsonb_typeof(afip_snapshot->'identidad') IS NOT DISTINCT FROM 'object'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,numero}') IS NOT DISTINCT FROM 'number'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,emisorCuit}') IS NOT DISTINCT FROM 'string'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,puntoVenta}') IS NOT DISTINCT FROM 'number'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,cbteTipo}') IS NOT DISTINCT FROM 'number'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,modo}') IS NOT DISTINCT FROM 'string'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,simulado}') IS NOT DISTINCT FROM 'boolean'
            AND afip_snapshot#>>'{identidad,numero}' IS NOT DISTINCT FROM afip_numero::text
            AND afip_snapshot#>>'{identidad,emisorCuit}' IS NOT DISTINCT FROM afip_emisor_cuit
            AND afip_snapshot#>>'{identidad,puntoVenta}' IS NOT DISTINCT FROM afip_punto_venta::text
            AND afip_snapshot#>>'{identidad,cbteTipo}' IS NOT DISTINCT FROM afip_cbte_tipo::text
            AND afip_snapshot#>>'{identidad,modo}' IS NOT DISTINCT FROM afip_modo
            AND afip_snapshot#>'{identidad,simulado}' IS NOT DISTINCT FROM pg_catalog.to_jsonb(afip_simulado)
            AND afip_snapshot->>'fechaComprobante' IS NOT DISTINCT FROM afip_fecha_comprobante::text
          )
          -- Hay evidencia de request: sólo emisión, conciliación o bloqueo.
          OR (
            afip_fase IN ('REQUEST_INICIADO','RESPUESTA_RECIBIDA')
            AND afip_estado IN ('EMITIENDO','RECONCILIAR','BLOQUEADO')
            AND afip_claim_token IS NOT NULL
            AND afip_claimed_at IS NOT NULL
            AND afip_numero IS NOT NULL AND afip_numero>0
            AND afip_emisor_cuit ~ '^[0-9]{11}$'
            AND afip_punto_venta BETWEEN 1 AND 99999
            AND afip_cbte_tipo BETWEEN 1 AND 9999
            AND afip_modo IN ('PRODUCCION','HOMOLOGACION')
            AND afip_validez IN ('PRODUCCION','HOMOLOGACION','SIMULADA')
            AND afip_fecha_comprobante IS NOT NULL
            AND afip_imp_total IS NOT NULL
            AND pg_catalog.jsonb_typeof(afip_snapshot) IS NOT DISTINCT FROM 'object'
            AND pg_catalog.jsonb_typeof(afip_snapshot->'version') IS NOT DISTINCT FROM 'number'
            AND afip_snapshot->>'version' IS NOT DISTINCT FROM '2'
            AND pg_catalog.jsonb_typeof(afip_snapshot->'hash') IS NOT DISTINCT FROM 'string'
            AND afip_snapshot_hash ~ '^[0-9a-f]{64}$'
            AND afip_snapshot->>'hash' IS NOT DISTINCT FROM afip_snapshot_hash
            AND pg_catalog.jsonb_typeof(afip_snapshot->'identidad') IS NOT DISTINCT FROM 'object'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,numero}') IS NOT DISTINCT FROM 'number'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,emisorCuit}') IS NOT DISTINCT FROM 'string'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,puntoVenta}') IS NOT DISTINCT FROM 'number'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,cbteTipo}') IS NOT DISTINCT FROM 'number'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,modo}') IS NOT DISTINCT FROM 'string'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,simulado}') IS NOT DISTINCT FROM 'boolean'
            AND afip_snapshot#>>'{identidad,numero}' IS NOT DISTINCT FROM afip_numero::text
            AND afip_snapshot#>>'{identidad,emisorCuit}' IS NOT DISTINCT FROM afip_emisor_cuit
            AND afip_snapshot#>>'{identidad,puntoVenta}' IS NOT DISTINCT FROM afip_punto_venta::text
            AND afip_snapshot#>>'{identidad,cbteTipo}' IS NOT DISTINCT FROM afip_cbte_tipo::text
            AND afip_snapshot#>>'{identidad,modo}' IS NOT DISTINCT FROM afip_modo
            AND afip_snapshot#>'{identidad,simulado}' IS NOT DISTINCT FROM pg_catalog.to_jsonb(afip_simulado)
            AND afip_snapshot->>'fechaComprobante' IS NOT DISTINCT FROM afip_fecha_comprobante::text
          )
          -- Resultado autorizado ya persistido.
          OR (
            afip_fase='PERSISTIDO'
            AND afip_estado='APROBADO'
            AND afip_claim_token IS NULL
            AND afip_claimed_at IS NULL
            AND cae IS NOT NULL
            AND afip_numero IS NOT NULL AND afip_numero>0
            AND afip_emisor_cuit ~ '^[0-9]{11}$'
            AND afip_punto_venta BETWEEN 1 AND 99999
            AND afip_cbte_tipo BETWEEN 1 AND 9999
            AND afip_modo IN ('PRODUCCION','HOMOLOGACION')
            AND afip_validez IN ('PRODUCCION','HOMOLOGACION','SIMULADA')
            AND afip_fecha_comprobante IS NOT NULL
            AND afip_imp_total IS NOT NULL
            AND pg_catalog.jsonb_typeof(afip_snapshot) IS NOT DISTINCT FROM 'object'
            AND pg_catalog.jsonb_typeof(afip_snapshot->'version') IS NOT DISTINCT FROM 'number'
            AND afip_snapshot->>'version' IS NOT DISTINCT FROM '2'
            AND pg_catalog.jsonb_typeof(afip_snapshot->'hash') IS NOT DISTINCT FROM 'string'
            AND afip_snapshot_hash ~ '^[0-9a-f]{64}$'
            AND afip_snapshot->>'hash' IS NOT DISTINCT FROM afip_snapshot_hash
            AND pg_catalog.jsonb_typeof(afip_snapshot->'identidad') IS NOT DISTINCT FROM 'object'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,numero}') IS NOT DISTINCT FROM 'number'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,emisorCuit}') IS NOT DISTINCT FROM 'string'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,puntoVenta}') IS NOT DISTINCT FROM 'number'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,cbteTipo}') IS NOT DISTINCT FROM 'number'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,modo}') IS NOT DISTINCT FROM 'string'
            AND pg_catalog.jsonb_typeof(afip_snapshot#>'{identidad,simulado}') IS NOT DISTINCT FROM 'boolean'
            AND afip_snapshot#>>'{identidad,numero}' IS NOT DISTINCT FROM afip_numero::text
            AND afip_snapshot#>>'{identidad,emisorCuit}' IS NOT DISTINCT FROM afip_emisor_cuit
            AND afip_snapshot#>>'{identidad,puntoVenta}' IS NOT DISTINCT FROM afip_punto_venta::text
            AND afip_snapshot#>>'{identidad,cbteTipo}' IS NOT DISTINCT FROM afip_cbte_tipo::text
            AND afip_snapshot#>>'{identidad,modo}' IS NOT DISTINCT FROM afip_modo
            AND afip_snapshot#>'{identidad,simulado}' IS NOT DISTINCT FROM pg_catalog.to_jsonb(afip_simulado)
            AND afip_snapshot->>'fechaComprobante' IS NOT DISTINCT FROM afip_fecha_comprobante::text
          )
        )
      )
    )
  );

-- Serializador JSON sin espacios: objetos por clave C, arrays en el orden ya
-- normalizado por el dominio y escalares con la codificación JSON de Postgres.
-- Task 7 ordena sus arrays de dominio por IDs estables antes de llegar aquí.
CREATE OR REPLACE FUNCTION public.fiscal_json_canonico(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
STRICT
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_tipo text := pg_catalog.jsonb_typeof(p_value);
  v_resultado text;
BEGIN
  IF v_tipo='object' THEN
    SELECT '{'||COALESCE(
      pg_catalog.string_agg(
        pg_catalog.to_jsonb(e.key)::text||':'||public.fiscal_json_canonico(e.value),
        ',' ORDER BY e.key COLLATE "C"
      ),''
    )||'}'
      INTO v_resultado
      FROM pg_catalog.jsonb_each(p_value) AS e(key,value);
    RETURN v_resultado;
  ELSIF v_tipo='array' THEN
    SELECT '['||COALESCE(
      pg_catalog.string_agg(
        public.fiscal_json_canonico(e.value),',' ORDER BY e.ordinality
      ),''
    )||']'
      INTO v_resultado
      FROM pg_catalog.jsonb_array_elements(p_value)
        WITH ORDINALITY AS e(value,ordinality);
    RETURN v_resultado;
  END IF;
  RETURN p_value::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.fiscal_snapshot_hash(p_snapshot jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
STRICT
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_canonico text;
BEGIN
  IF pg_catalog.jsonb_typeof(p_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'El snapshot fiscal debe ser un objeto JSON';
  END IF;
  v_canonico := public.fiscal_json_canonico(p_snapshot - 'hash');
  RETURN pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_canonico,'UTF8'),'sha256'),
    'hex'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fiscal_json_canonico(jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
-- La RPC invoker usa sólo el serializador; no se expone el helper de hash.
GRANT EXECUTE ON FUNCTION public.fiscal_json_canonico(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fiscal_snapshot_hash(jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

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
  v_intento public.emision_fiscal_intentos%ROWTYPE;
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
BEGIN
  SELECT v.* INTO v_venta
    FROM public.ventas AS v
   WHERE v.id=p_venta_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta fiscal inexistente: %',p_venta_id;
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
    IF v_venta.afip_estado NOT IN ('SIN_FACTURAR','ERROR_CORREGIBLE')
       OR v_venta.afip_claim_token IS NOT NULL
       OR v_venta.afip_fase IS NOT NULL
       OR v_venta.afip_numero IS NOT NULL
       OR v_venta.cae IS NOT NULL THEN
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
    IF NOT (
         (v_intento.fase='PREFLIGHT' AND v_intento.resultado='RECLAMADO')
         OR (v_intento.fase='RESERVADO' AND v_intento.resultado='RESERVADO')
       )
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
REVOKE INSERT, UPDATE, DELETE ON public.emision_fiscal_intentos FROM anon, authenticated;
REVOKE UPDATE ON public.ventas FROM authenticated;

-- Copia completa de 20260810140000, más emisor multi-CUIT y todos los campos
-- fiscales añadidos después. Aunque UPDATE ya no está otorgado al navegador,
-- el trigger conserva defensa en profundidad si un grant futuro se amplía.
CREATE OR REPLACE FUNCTION public.guard_ventas_columnas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $$
BEGIN
  IF current_user='authenticated' THEN
    IF NEW.cae IS DISTINCT FROM OLD.cae
       OR NEW.cae_vencimiento IS DISTINCT FROM OLD.cae_vencimiento
       OR NEW.afip_estado IS DISTINCT FROM OLD.afip_estado
       OR NEW.afip_error IS DISTINCT FROM OLD.afip_error
       OR NEW.afip_cbte_tipo IS DISTINCT FROM OLD.afip_cbte_tipo
       OR NEW.afip_punto_venta IS DISTINCT FROM OLD.afip_punto_venta
       OR NEW.afip_numero IS DISTINCT FROM OLD.afip_numero
       OR NEW.afip_modo IS DISTINCT FROM OLD.afip_modo
       OR NEW.afip_emitido_at IS DISTINCT FROM OLD.afip_emitido_at
       OR NEW.afip_intentos IS DISTINCT FROM OLD.afip_intentos
       OR NEW.afip_cbte_asoc_id IS DISTINCT FROM OLD.afip_cbte_asoc_id
       OR NEW.afip_imp_total IS DISTINCT FROM OLD.afip_imp_total
       OR NEW.afip_simulado IS DISTINCT FROM OLD.afip_simulado
       OR NEW.afip_snapshot IS DISTINCT FROM OLD.afip_snapshot
       OR NEW.afip_emisor_cuit IS DISTINCT FROM OLD.afip_emisor_cuit
       OR NEW.afip_fecha_comprobante IS DISTINCT FROM OLD.afip_fecha_comprobante
       OR NEW.afip_snapshot_hash IS DISTINCT FROM OLD.afip_snapshot_hash
       OR NEW.afip_claim_token IS DISTINCT FROM OLD.afip_claim_token
       OR NEW.afip_claimed_at IS DISTINCT FROM OLD.afip_claimed_at
       OR NEW.afip_fase IS DISTINCT FROM OLD.afip_fase
       OR NEW.afip_error_clase IS DISTINCT FROM OLD.afip_error_clase
       OR NEW.afip_error_codigo IS DISTINCT FROM OLD.afip_error_codigo
       OR NEW.afip_error_fase IS DISTINCT FROM OLD.afip_error_fase
       OR NEW.afip_ultimo_error_at IS DISTINCT FROM OLD.afip_ultimo_error_at
       OR NEW.afip_validez IS DISTINCT FROM OLD.afip_validez
       OR NEW.afip_legacy_incompleto IS DISTINCT FROM OLD.afip_legacy_incompleto
       OR NEW.afip_version IS DISTINCT FROM OLD.afip_version
       OR NEW.total IS DISTINCT FROM OLD.total
       OR NEW.total_pagado IS DISTINCT FROM OLD.total_pagado
       OR NEW.estado IS DISTINCT FROM OLD.estado
       OR NEW.estado_pago IS DISTINCT FROM OLD.estado_pago
       OR NEW.subtotal_sin_iva IS DISTINCT FROM OLD.subtotal_sin_iva
       OR NEW.iva_total IS DISTINCT FROM OLD.iva_total
       OR NEW.numero_comprobante IS DISTINCT FROM OLD.numero_comprobante
       OR NEW.tipo_comprobante IS DISTINCT FROM OLD.tipo_comprobante THEN
      RAISE EXCEPTION 'Esos campos de la venta no se editan directamente (facturación y montos van por el sistema)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_ventas_columnas()
  FROM PUBLIC,anon,authenticated;
