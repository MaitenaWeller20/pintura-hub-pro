#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^" ]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" <<'SQL'
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_ok boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FALLO: %',p_message;
  END IF;
  RAISE NOTICE '✓ %',p_message;
END;
$$;

WITH roles(rol) AS (
  VALUES ('anon'::name),('authenticated'::name)
), tablas(tabla) AS (
  VALUES ('public.remitos'::regclass),('public.remito_items'::regclass)
), privilegios(privilegio) AS (
  VALUES
    ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
    ('TRUNCATE'),('REFERENCES'),('TRIGGER')
), matriz AS (
  SELECT
    r.rol,
    t.tabla,
    p.privilegio,
    pg_catalog.has_table_privilege(r.rol,t.tabla,p.privilegio) AS concedido
  FROM roles AS r
  CROSS JOIN tablas AS t
  CROSS JOIN privilegios AS p
)
SELECT pg_temp.assert_true(
  pg_catalog.bool_and(concedido IS NOT DISTINCT FROM (privilegio='SELECT')),
  'anon y authenticated tienen exactamente SELECT efectivo sobre remitos y remito_items'
)
FROM matriz;

WITH acl AS (
  SELECT
    c.relname,
    grantee.rolname,
    a.privilege_type,
    a.is_grantable
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,'{}')) AS a
  JOIN pg_catalog.pg_roles AS grantee ON grantee.oid=a.grantee
  WHERE n.nspname='public'
    AND c.relname IN ('remitos','remito_items')
    AND grantee.rolname IN ('anon','authenticated')
)
SELECT pg_temp.assert_true(
  (SELECT pg_catalog.count(*) FROM acl)=4
  AND NOT EXISTS (
    SELECT 1 FROM acl
     WHERE privilege_type<>'SELECT' OR is_grantable
  )
  AND (
    SELECT pg_catalog.count(DISTINCT (relname,rolname)) FROM acl
  )=4,
  'el ACL directo contiene una sola concesión SELECT sin grant option por tabla y rol'
);

ROLLBACK;
SQL

echo "ACL exacta de remitos: OK"
