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
    IF v_columna='afip_error' THEN
      IF pg_catalog.has_column_privilege(
        'authenticated','public.ventas',v_columna,'SELECT'
      ) THEN
        RAISE EXCEPTION 'afip_error conserva un permiso de columna';
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

  -- Los datos operativos y las clasificaciones cerradas siguen disponibles.
  PERFORM id,afip_estado,afip_error_clase,afip_error_codigo
  FROM public.ventas
  LIMIT 1;
END;
$operador$;

RESET ROLE;
SET LOCAL ROLE service_role;
DO $servicio$
BEGIN
  PERFORM afip_error FROM public.ventas LIMIT 1;
END;
$servicio$;

ROLLBACK;
SQL

printf '✓ el diagnóstico fiscal técnico no es legible por operadores\n'
