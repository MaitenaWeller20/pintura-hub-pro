#!/usr/bin/env bash
# Verifica la frontera de columna y la proyección recursiva de la cola fiscal.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

SET LOCAL ROLE authenticated;
DO $operador$
DECLARE
  v_columna text;
  v_reservadas text[] := ARRAY[
    'afip_error','nc_periodo_payload_hash',
    'afip_claim_token','afip_claimed_at','afip_snapshot','afip_snapshot_hash',
    'idempotency_key','idempotency_payload_hash',
    'anulacion_idempotency_key','anulacion_idempotency_payload_hash'
  ];
BEGIN
  IF pg_catalog.has_table_privilege('authenticated','public.ventas','SELECT') THEN
    RAISE EXCEPTION 'authenticated todavía conserva SELECT de tabla completa';
  END IF;

  FOR v_columna IN
    SELECT attname
    FROM pg_catalog.pg_attribute
    WHERE attrelid='public.ventas'::pg_catalog.regclass
      AND attnum>0
      AND NOT attisdropped
  LOOP
    IF v_columna=ANY(v_reservadas) THEN
      IF pg_catalog.has_column_privilege(
        'authenticated','public.ventas',v_columna,'SELECT'
      ) THEN
        RAISE EXCEPTION 'la columna reservada % conserva permiso de operador',v_columna;
      END IF;
    ELSIF NOT pg_catalog.has_column_privilege(
      'authenticated','public.ventas',v_columna,'SELECT'
    ) THEN
      RAISE EXCEPTION 'la columna operativa % perdió su permiso de lectura',v_columna;
    END IF;
  END LOOP;

  BEGIN
    PERFORM afip_error FROM public.ventas LIMIT 1;
    RAISE EXCEPTION 'afip_error sigue accesible para authenticated';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  -- Prueba efectiva, no sólo introspección: las ocho columnas señaladas por la
  -- revisión deben fallar exactamente con insufficient_privilege / 42501.
  FOREACH v_columna IN ARRAY ARRAY[
    'afip_claim_token','afip_claimed_at','afip_snapshot','afip_snapshot_hash',
    'idempotency_key','idempotency_payload_hash',
    'anulacion_idempotency_key','anulacion_idempotency_payload_hash'
  ]
  LOOP
    BEGIN
      EXECUTE pg_catalog.format('SELECT %I FROM public.ventas LIMIT 1',v_columna);
      RAISE EXCEPTION '% sigue accesible para authenticated',v_columna;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN NULL;
    END;
  END LOOP;

  -- Los datos operativos, las clasificaciones cerradas y la auditoría visible
  -- de NC por período siguen disponibles para un operador autenticado.
  PERFORM id,afip_estado,afip_error_clase,afip_error_codigo,
          nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
          motivo_nota_credito,nc_resolucion,nc_efectos_aplicados_at
  FROM public.ventas
  LIMIT 1;
END;
$operador$;

RESET ROLE;
DO $anonimo$
DECLARE
  v_columna text;
BEGIN
  FOREACH v_columna IN ARRAY ARRAY[
    'afip_claim_token',
    'afip_claimed_at',
    'afip_snapshot',
    'afip_snapshot_hash',
    'idempotency_key',
    'idempotency_payload_hash',
    'anulacion_idempotency_key',
    'anulacion_idempotency_payload_hash',
    'motivo_nota_credito',
    'nc_efectos_aplicados_at',
    'nc_periodo_modalidad',
    'nc_resolucion',
    'periodo_asoc_desde',
    'periodo_asoc_hasta'
  ]
  LOOP
    IF pg_catalog.has_column_privilege('anon','public.ventas',v_columna,'SELECT') THEN
      RAISE EXCEPTION 'anon obtuvo lectura inesperada de %',v_columna;
    END IF;
  END LOOP;
  IF NOT (
    SELECT c.relrowsecurity
      FROM pg_catalog.pg_class AS c
     WHERE c.oid='public.ventas'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'la reparación deshabilitó RLS de ventas';
  END IF;
END;
$anonimo$;

-- Actor local descartable: permite ejecutar la RPC realmente como authenticated
-- y recorrer filas, filtros y cualquier rama futura de su JSON.
INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_user_meta_data,created_at,updated_at
) VALUES (
  'a7c10000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'acl-cola-cerrada@test.local','x',pg_catalog.now(),
  '{"username":"acl_cola_cerrada"}'::jsonb,pg_catalog.now(),pg_catalog.now()
);
INSERT INTO public.user_roles(user_id,role)
VALUES ('a7c10000-0000-4000-8000-000000000001','admin');
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"a7c10000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

SET LOCAL ROLE authenticated;
DO $cola_cerrada$
DECLARE
  v_salida jsonb;
  v_clave text;
BEGIN
  SELECT pg_catalog.jsonb_build_object(
           'filas',q.filas,
           'filtros_disponibles',q.filtros_disponibles
         )
    INTO v_salida
    FROM public.cola_fiscal_lectura(
      'pendientes',1,100,NULL::date,NULL::date,NULL::uuid,NULL::uuid,
      NULL::text,NULL::text,NULL::uuid
    ) AS q;

  WITH RECURSIVE nodos(valor) AS (
    SELECT v_salida
    UNION ALL
    SELECT hijo.valor
      FROM nodos AS n
      CROSS JOIN LATERAL (
        SELECT e.value AS valor
          FROM pg_catalog.jsonb_each(
            CASE WHEN pg_catalog.jsonb_typeof(n.valor)='object' THEN n.valor ELSE '{}'::jsonb END
          ) AS e
        UNION ALL
        SELECT a.value
          FROM pg_catalog.jsonb_array_elements(
            CASE WHEN pg_catalog.jsonb_typeof(n.valor)='array' THEN n.valor ELSE '[]'::jsonb END
          ) AS a
      ) AS hijo
  ), claves AS (
    SELECT k.clave
      FROM nodos AS n
      CROSS JOIN LATERAL pg_catalog.jsonb_object_keys(
        CASE WHEN pg_catalog.jsonb_typeof(n.valor)='object' THEN n.valor ELSE '{}'::jsonb END
      ) AS k(clave)
  )
  SELECT clave INTO v_clave
    FROM claves
   WHERE clave~*'(snapshot|hash|claim|idempotency|payload|raw|secret|service_role)'
   LIMIT 1;

  IF v_clave IS NOT NULL THEN
    RAISE EXCEPTION 'la cola serializó la clave reservada %',v_clave;
  END IF;
END;
$cola_cerrada$;

RESET ROLE;
SET LOCAL ROLE service_role;
DO $servicio$
BEGIN
  PERFORM afip_error,afip_claim_token,afip_claimed_at,afip_snapshot,
          afip_snapshot_hash,idempotency_key,idempotency_payload_hash,
          anulacion_idempotency_key,anulacion_idempotency_payload_hash
  FROM public.ventas LIMIT 1;
END;
$servicio$;

ROLLBACK;
SQL

printf '✓ ACL de ventas y proyección recursiva de cola cerradas para operadores\n'
