-- Corrige la frontera v3 sin reabrir ni modificar el contrato persistido v2.
-- El validador anterior se conserva owner-only como core de los invariantes
-- compartidos. La condición comercial que necesita su proyección v2 existe
-- sólo en una copia local y nunca participa de los bytes/hash del v3 aprobado.
ALTER FUNCTION public.validar_snapshot_fiscal_v3(jsonb)
  RENAME TO _validar_snapshot_fiscal_v3_con_condicion_legacy_20260829;

REVOKE ALL ON FUNCTION
  public._validar_snapshot_fiscal_v3_con_condicion_legacy_20260829(jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.validar_snapshot_fiscal_v3(p_snapshot jsonb)
RETURNS void
LANGUAGE plpgsql
STABLE
STRICT
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_venta jsonb;
  v_nota jsonb;
  v_desconocidas text[];
  v_motivo text;
  v_motivo_util text;
  v_proxy jsonb;
BEGIN
  IF pg_catalog.jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(p_snapshot->'version') IS DISTINCT FROM 'number'
     OR p_snapshot->>'version' IS DISTINCT FROM '3'
     OR pg_catalog.jsonb_typeof(p_snapshot->'hash') IS DISTINCT FROM 'string'
     OR p_snapshot->>'hash' !~ '^[0-9a-f]{64}$'
     OR public.fiscal_snapshot_hash(p_snapshot) IS DISTINCT FROM p_snapshot->>'hash' THEN
    RAISE EXCEPTION 'snapshot v3: versión o hash inválido';
  END IF;

  v_venta := p_snapshot->'venta';
  IF pg_catalog.jsonb_typeof(v_venta) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'snapshot v3: venta debe ser objeto';
  END IF;
  SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_desconocidas
    FROM pg_catalog.jsonb_object_keys(v_venta) AS k
   WHERE NOT (k=ANY(ARRAY[
     'id','numeroComercial','tipoComprobante','fechaComercial'
   ]));
  IF v_desconocidas IS NOT NULL
     OR NOT (v_venta ?& ARRAY[
       'id','numeroComercial','tipoComprobante','fechaComercial'
     ]) THEN
    RAISE EXCEPTION 'snapshot v3: venta tiene claves faltantes o desconocidas';
  END IF;

  v_nota := p_snapshot->'notaCredito';
  IF pg_catalog.jsonb_typeof(v_nota) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_nota->'motivo') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'snapshot v3: motivo inválido';
  END IF;
  v_motivo := v_nota->>'motivo';
  -- Whitespace fiscal explícito y compartido con TypeScript: HT, LF, VT, FF,
  -- CR y SPACE. length(text) cuenta caracteres Unicode/code points en UTF-8.
  v_motivo_util := pg_catalog.btrim(v_motivo,E' \t\n\v\f\r');
  IF pg_catalog.length(v_motivo_util) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'snapshot v3: motivo debe tener entre 5 y 500 code points útiles';
  END IF;

  v_proxy := pg_catalog.jsonb_set(
    p_snapshot,
    '{venta}',
    v_venta||pg_catalog.jsonb_build_object('condicionVenta','CONTADO'),
    false
  );
  v_proxy := pg_catalog.jsonb_set(
    v_proxy,
    '{hash}',
    pg_catalog.to_jsonb(public.fiscal_snapshot_hash(v_proxy)),
    false
  );
  PERFORM public._validar_snapshot_fiscal_v3_con_condicion_legacy_20260829(v_proxy);
END;
$$;

ALTER FUNCTION public.validar_snapshot_fiscal_v3(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.validar_snapshot_fiscal_v3(jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

COMMENT ON FUNCTION public.validar_snapshot_fiscal_v3(jsonb) IS
  'Valida snapshot fiscal v3 sin condición ni resolución comercial; motivo 5..500 code points.';

-- La función trigger corre como owner para que ningún caller pueda eludir los
-- helpers owner-only. También se ejecuta para escrituras del owner: un writer
-- futuro sólo atraviesa esta frontera si entrega un snapshot íntegro.
CREATE FUNCTION public.guard_snapshot_fiscal_persistido_obligatorio()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_hash_recalculado text;
  v_exige_snapshot boolean;
BEGIN
  v_exige_snapshot := COALESCE(
    NOT (NEW.afip_version=0 OR NEW.afip_legacy_incompleto)
    AND (
      NEW.afip_fase IN ('RESERVADO','REQUEST_INICIADO','RESPUESTA_RECIBIDA','PERSISTIDO')
      OR NEW.afip_estado IN ('RECONCILIAR','APROBADO')
      OR (NEW.afip_estado='EMITIENDO' AND NEW.afip_snapshot IS NOT NULL)
    ),false
  );

  IF NOT v_exige_snapshot THEN
    RETURN NEW;
  END IF;
  IF NEW.afip_snapshot IS NULL OR NEW.afip_snapshot_hash IS NULL THEN
    RAISE EXCEPTION 'ck_ventas_afip_estado_integridad: el estado fiscal exige snapshot persistido y hash canónico';
  END IF;

  v_hash_recalculado := public.fiscal_snapshot_hash(NEW.afip_snapshot);
  IF pg_catalog.jsonb_typeof(NEW.afip_snapshot->'hash') IS DISTINCT FROM 'string'
     OR NEW.afip_snapshot->>'hash' IS DISTINCT FROM v_hash_recalculado
     OR NEW.afip_snapshot_hash IS DISTINCT FROM v_hash_recalculado THEN
    RAISE EXCEPTION 'ck_ventas_afip_estado_integridad: el estado fiscal exige hash canónico coincidente con el snapshot';
  END IF;
  PERFORM public.validar_snapshot_fiscal_persistido(NEW.afip_snapshot);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_snapshot_fiscal_persistido_obligatorio() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_snapshot_fiscal_persistido_obligatorio()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER trg_ventas_snapshot_fiscal_persistido_obligatorio
  BEFORE INSERT OR UPDATE ON public.ventas
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_snapshot_fiscal_persistido_obligatorio();

COMMENT ON FUNCTION public.guard_snapshot_fiscal_persistido_obligatorio() IS
  'Frontera owner-enforced: valida semántica, versión y hash canónico en estados fiscales obligatorios.';
