#!/usr/bin/env bash
# Verifica la frontera de columna: un operador autenticado puede leer el estado
# fiscal cerrado, pero nunca el diagnóstico técnico histórico de afip_error.
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
    IF v_columna IN ('afip_error','nc_periodo_payload_hash') THEN
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

SET LOCAL ROLE service_role;
DO $servicio$
BEGIN
  PERFORM afip_error FROM public.ventas LIMIT 1;
END;
$servicio$;

ROLLBACK;
SQL

printf '✓ el diagnóstico fiscal técnico no es legible por operadores\n'
