#!/usr/bin/env bash
# Dos conexiones reales: una corrige el fondo mientras otra intenta abrir el
# turno siguiente. La apertura debe esperar el advisory lock y heredar el valor
# corregido, nunca el anterior.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
ADMIN_ID="a3100000-0000-0000-0000-000000000001"
CIERRE_ID="c3100000-0000-0000-0000-000000000001"
TASK_TMP="$(mktemp -d)"
CORRECCION_LOG="$TASK_TMP/correccion.log"

cleanup() {
  docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.caja_cierre_correcciones
WHERE caja_sesion_id='$CIERRE_ID'::uuid;
DELETE FROM public.caja_sesiones
WHERE id='$CIERRE_ID'::uuid OR abierta_por='$ADMIN_ID'::uuid;
DELETE FROM public.profile_sucursales WHERE profile_id='$ADMIN_ID'::uuid;
DELETE FROM public.user_roles WHERE user_id='$ADMIN_ID'::uuid;
DELETE FROM public.profiles WHERE id='$ADMIN_ID'::uuid;
DELETE FROM auth.users WHERE id='$ADMIN_ID'::uuid;
COMMIT;
SQL
  rm -f "$CORRECCION_LOG"
  rmdir "$TASK_TMP" 2>/dev/null || true
}
trap cleanup EXIT

# Recupera de forma exacta una ejecución interrumpida anterior y crea el fixture
# comprometido para que ambas conexiones puedan verlo.
cleanup
trap cleanup EXIT
TASK_TMP="$(mktemp -d)"
CORRECCION_LOG="$TASK_TMP/correccion.log"

SUCURSAL_ID="$(
  docker exec "$DB" psql -U postgres -d postgres -tAq -v ON_ERROR_STOP=1 -c "
    SELECT s.id
    FROM public.sucursales AS s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.caja_sesiones AS cs WHERE cs.sucursal_id=s.id
    )
    ORDER BY s.created_at,s.id
    LIMIT 1;
  "
)"

if [[ -z "$SUCURSAL_ID" ]]; then
  printf '✗ la prueba concurrente necesita una sucursal local sin sesiones de caja\n' >&2
  exit 1
fi

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  '$ADMIN_ID','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'admin-concurrencia-cierre@test.local','x',now(),now(),now()
);
INSERT INTO public.profiles (id,username,nombre_completo,activo,sucursal_id)
VALUES (
  '$ADMIN_ID','admin_concurrencia_cierre','Admin concurrencia cierre',true,'$SUCURSAL_ID'
)
ON CONFLICT (id) DO UPDATE
SET username=EXCLUDED.username,
    nombre_completo=EXCLUDED.nombre_completo,
    activo=EXCLUDED.activo,
    sucursal_id=EXCLUDED.sucursal_id;
INSERT INTO public.user_roles (user_id,role) VALUES ('$ADMIN_ID','admin');
INSERT INTO public.caja_sesiones (
  id,sucursal_id,estado,abierta_por,abierta_en,fondo_inicial,cerrada_por,cerrada_en,
  esperado,contado,diferencia,total_esperado,total_contado,total_diferencia,
  efectivo_dejado,notas
) VALUES (
  '$CIERRE_ID','$SUCURSAL_ID','CERRADA','$ADMIN_ID',now()-interval '2 hours',0,
  '$ADMIN_ID',now()-interval '1 hour',
  '{"EFECTIVO":{"entra":100,"sale":0,"neto":100}}',
  '{"EFECTIVO":100}','{"EFECTIVO":0}',100,100,0,5,'Fixture concurrente'
);
SQL

# Conexión A corrige y mantiene su transacción abierta. El pg_sleep ocurre
# después de la RPC, por lo que conserva todos sus locks hasta COMMIT.
docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >"$CORRECCION_LOG" 2>&1 <<SQL &
BEGIN;
SET application_name='test_correccion_cierre_lock_a';
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims='{"sub":"$ADMIN_ID","role":"authenticated"}';
SELECT * FROM public.corregir_cierre_caja(
  '$CIERRE_ID',100,20,'Fixture concurrente corregido',
  'Corrección concurrente del fondo heredado',0
);
SELECT pg_sleep(3);
COMMIT;
SQL
CORRECCION_PID=$!

# Espera una señal observable de que A ya terminó la RPC y está durmiendo con
# los locks tomados. No se usa un tiempo fijo para decidir la carrera.
LISTA=false
for ((intento=0; intento<80; intento++)); do
  if [[ "$(docker exec "$DB" psql -U postgres -d postgres -tAq -c "
    SELECT count(*)
    FROM pg_catalog.pg_stat_activity
    WHERE application_name='test_correccion_cierre_lock_a'
      AND state='active'
      AND query LIKE '%pg_sleep(3)%';
  ")" == "1" ]]; then
    LISTA=true
    break
  fi
  sleep 0.05
done

if [[ "$LISTA" != true ]]; then
  wait "$CORRECCION_PID" || true
  cat "$CORRECCION_LOG" >&2
  printf '✗ la conexión correctora no llegó al punto de sincronización\n' >&2
  exit 1
fi

# Conexión B ejecuta la apertura automática real. Con el protocolo correcto se
# bloquea hasta el COMMIT de A y luego lee efectivo_dejado=20.
docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"$ADMIN_ID","role":"authenticated"}',
  true
);
SELECT public.caja_sesion_actual('$SUCURSAL_ID');
COMMIT;
SQL

wait "$CORRECCION_PID"

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
DO \$assert_concurrencia\$
DECLARE
  v_fondo numeric;
  v_version integer;
BEGIN
  SELECT fondo_inicial INTO STRICT v_fondo
  FROM public.caja_sesiones
  WHERE sucursal_id='$SUCURSAL_ID'::uuid AND estado='ABIERTA';
  SELECT correccion_version INTO STRICT v_version
  FROM public.caja_sesiones WHERE id='$CIERRE_ID'::uuid;

  IF v_fondo <> 20 OR v_version <> 1 THEN
    RAISE EXCEPTION
      'La apertura heredó un fondo obsoleto o la corrección no terminó (fondo %, versión %)',
      v_fondo,v_version;
  END IF;
END;
\$assert_concurrencia\$;
SQL

printf '✓ corrección y apertura automática serializadas entre dos conexiones\n'
