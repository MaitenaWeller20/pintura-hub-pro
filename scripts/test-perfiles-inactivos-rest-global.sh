#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)
TMP_DIR="$(mktemp -d)"

ACTIVE_EMAIL="t24-activo@local.test"
INACTIVE_EMAIL="t24-inactivo@local.test"
MISSING_EMAIL="t24-sin-perfil@local.test"
PASSWORD="T24-local-only-1234"
CLIENTE_ID="b4240000-0000-4000-8000-000000000001"
PROVEEDOR_ID="c4240000-0000-4000-8000-000000000001"
CLIENTE_INACTIVE_INSERT_ID="b4240000-0000-4000-8000-000000000002"
PROVEEDOR_INACTIVE_INSERT_ID="c4240000-0000-4000-8000-000000000002"
CLIENTE_MISSING_INSERT_ID="b4240000-0000-4000-8000-000000000003"
PROVEEDOR_MISSING_INSERT_ID="c4240000-0000-4000-8000-000000000003"

q() { "${PSQL[@]}" -qAtc "$1"; }

for herramienta in curl docker jq supabase; do
  command -v "$herramienta" >/dev/null || {
    echo "Falta la herramienta local requerida: $herramienta" >&2
    exit 1
  }
done

STATUS_ENV="$(supabase status -o env 2>/dev/null)"
API_URL="$(sed -n 's/^API_URL="\([^"]*\)"/\1/p' <<<"$STATUS_ENV")"
ANON_KEY="$(sed -n 's/^ANON_KEY="\([^"]*\)"/\1/p' <<<"$STATUS_ENV")"
SERVICE_ROLE_KEY="$(sed -n 's/^SERVICE_ROLE_KEY="\([^"]*\)"/\1/p' <<<"$STATUS_ENV")"
if [[ -z "$PROJECT_ID" || -z "$API_URL" || -z "$ANON_KEY" || -z "$SERVICE_ROLE_KEY" ]]; then
  echo "No se pudo derivar el entorno del Supabase local." >&2
  exit 1
fi
case "$API_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    echo "El contrato REST se negó a usar un Supabase no local." >&2
    exit 1
    ;;
esac

limpiar_sql() {
  "${PSQL[@]}" >/dev/null <<SQL
DELETE FROM public.clientes
 WHERE id IN ('$CLIENTE_ID','$CLIENTE_INACTIVE_INSERT_ID','$CLIENTE_MISSING_INSERT_ID');
DELETE FROM public.proveedores
 WHERE id IN ('$PROVEEDOR_ID','$PROVEEDOR_INACTIVE_INSERT_ID','$PROVEEDOR_MISSING_INSERT_ID');
DELETE FROM auth.users WHERE email IN ('$ACTIVE_EMAIL','$INACTIVE_EMAIL','$MISSING_EMAIL');
SQL
}

cleanup() {
  local previo=$?
  trap - EXIT
  set +e
  limpiar_sql
  local limpieza=$?
  local residuos
  residuos="$(q "SELECT
    (SELECT pg_catalog.count(*) FROM public.clientes
      WHERE id IN ('$CLIENTE_ID','$CLIENTE_INACTIVE_INSERT_ID','$CLIENTE_MISSING_INSERT_ID'))+
    (SELECT pg_catalog.count(*) FROM public.proveedores
      WHERE id IN ('$PROVEEDOR_ID','$PROVEEDOR_INACTIVE_INSERT_ID','$PROVEEDOR_MISSING_INSERT_ID'))+
    (SELECT pg_catalog.count(*) FROM auth.users WHERE email IN ('$ACTIVE_EMAIL','$INACTIVE_EMAIL','$MISSING_EMAIL'))" 2>/dev/null)"
  local auditoria=$?
  rm -r "$TMP_DIR"
  local temporal=$?
  set -e
  if [[ "$limpieza" -ne 0 || "$auditoria" -ne 0 || "$temporal" -ne 0 || "$residuos" != "0" ]]; then
    echo "✗ falló el cleanup del contrato REST global (${limpieza}/${auditoria}/${temporal}; residuos=${residuos:-desconocidos})" >&2
    exit 1
  fi
  echo "✓ cleanup REST global: 0 residuos"
  exit "$previo"
}
trap cleanup EXIT

assert_http() {
  local nombre="$1" esperado="$2" obtenido="$3"
  if [[ "$obtenido" != "$esperado" ]]; then
    echo "✗ $nombre: esperaba HTTP $esperado, obtuvo HTTP $obtenido" >&2
    exit 1
  fi
  echo "✓ $nombre (HTTP $obtenido)"
}

crear_usuario() {
  local nombre="$1" email="$2"
  local codigo
  codigo="$(curl --silent --show-error --connect-timeout 1 --max-time 5 \
    --output "$TMP_DIR/${nombre}-create.json" --write-out '%{http_code}' \
    --request POST "${API_URL%/}/auth/v1/admin/users" \
    --header "apikey: $SERVICE_ROLE_KEY" \
    --header "Authorization: Bearer $SERVICE_ROLE_KEY" \
    --header "Content-Type: application/json" \
    --data "$(jq -nc --arg email "$email" --arg password "$PASSWORD" \
      '{email:$email,password:$password,email_confirm:true}')")"
  assert_http "crear usuario auth $nombre" "200" "$codigo" >&2
  jq -er '.id' "$TMP_DIR/${nombre}-create.json"
}

login() {
  local nombre="$1" email="$2"
  local codigo
  codigo="$(curl --silent --show-error --connect-timeout 1 --max-time 5 \
    --output "$TMP_DIR/${nombre}-login.json" --write-out '%{http_code}' \
    --request POST "${API_URL%/}/auth/v1/token?grant_type=password" \
    --header "apikey: $ANON_KEY" \
    --header "Content-Type: application/json" \
    --data "$(jq -nc --arg email "$email" --arg password "$PASSWORD" \
      '{email:$email,password:$password}')")"
  assert_http "login $nombre no depende del pre-request de PostgREST" "200" "$codigo" >&2
  jq -er '.access_token' "$TMP_DIR/${nombre}-login.json"
}

rest() {
  local nombre="$1" metodo="$2" ruta="$3" api_key="$4" bearer="$5" payload="${6:-}"
  local args=(
    --silent --show-error --connect-timeout 1 --max-time 5
    --output "$TMP_DIR/${nombre}.json" --write-out '%{http_code}'
    --request "$metodo" "${API_URL%/}/rest/v1/${ruta}"
    --header "apikey: $api_key"
    --header "Authorization: Bearer $bearer"
    --header "Content-Type: application/json"
  )
  if [[ -n "$payload" ]]; then
    args+=(--data "$payload")
  fi
  curl "${args[@]}"
}

assert_barrera() {
  local nombre="$1" token="$2" metodo="$3" ruta="$4" payload="${5:-}"
  local codigo
  codigo="$(rest "$nombre" "$metodo" "$ruta" "$ANON_KEY" "$token" "$payload")"
  assert_http "$nombre" "403" "$codigo"
  jq -e '
    .code == "42501" and
    (.message | contains("perfil autenticado no existe o está inactivo"))
  ' "$TMP_DIR/${nombre}.json" >/dev/null || {
    echo "✗ $nombre no devolvió el error estable de perfil inactivo" >&2
    jq -c . "$TMP_DIR/${nombre}.json" >&2 || true
    exit 1
  }
}

limpiar_sql
ACTIVE_ID="$(crear_usuario activo "$ACTIVE_EMAIL")"
INACTIVE_ID="$(crear_usuario inactivo "$INACTIVE_EMAIL")"
MISSING_ID="$(crear_usuario sin-perfil "$MISSING_EMAIL")"
SUCURSAL_ID="$(q "SELECT id FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1")"

"${PSQL[@]}" >/dev/null <<SQL
UPDATE public.profiles
   SET username='t24_activo',nombre_completo='T24 activo',activo=true,sucursal_id='$SUCURSAL_ID'
 WHERE id='$ACTIVE_ID';
UPDATE public.profiles
   SET username='t24_inactivo',nombre_completo='T24 inactivo',activo=false,sucursal_id='$SUCURSAL_ID'
 WHERE id='$INACTIVE_ID';
DELETE FROM public.profiles WHERE id='$MISSING_ID';
INSERT INTO public.user_roles(user_id,role)
VALUES ('$INACTIVE_ID','admin'),('$MISSING_ID','admin')
ON CONFLICT (user_id,role) DO NOTHING;
INSERT INTO public.clientes(id,razon_social,tipo,activo)
VALUES ('$CLIENTE_ID','T24 CLIENTE ORIGINAL','CONSUMIDOR_FINAL',true);
INSERT INTO public.proveedores(id,razon_social,activo)
VALUES ('$PROVEEDOR_ID','T24 PROVEEDOR ORIGINAL',true);
SQL

ACTIVE_JWT="$(login activo "$ACTIVE_EMAIL")"
INACTIVE_JWT="$(login inactivo "$INACTIVE_EMAIL")"
MISSING_JWT="$(login sin-perfil "$MISSING_EMAIL")"

codigo="$(rest activo-clientes-select GET "clientes?id=eq.${CLIENTE_ID}&select=id" "$ANON_KEY" "$ACTIVE_JWT")"
if [[ "$codigo" != "200" ]]; then
  jq -c . "$TMP_DIR/activo-clientes-select.json" >&2 || true
fi
assert_http "un perfil activo conserva SELECT de clientes" "200" "$codigo"
jq -e --arg id "$CLIENTE_ID" 'length == 1 and .[0].id == $id' "$TMP_DIR/activo-clientes-select.json" >/dev/null

codigo="$(rest activo-proveedores-select GET "proveedores?id=eq.${PROVEEDOR_ID}&select=id" "$ANON_KEY" "$ACTIVE_JWT")"
assert_http "un perfil activo conserva SELECT de proveedores" "200" "$codigo"
jq -e --arg id "$PROVEEDOR_ID" 'length == 1 and .[0].id == $id' "$TMP_DIR/activo-proveedores-select.json" >/dev/null

codigo="$(rest activo-clientes-update PATCH "clientes?id=eq.${CLIENTE_ID}" "$ANON_KEY" "$ACTIVE_JWT" '{"razon_social":"T24 CLIENTE ACTIVO"}')"
assert_http "un perfil activo conserva UPDATE de clientes" "204" "$codigo"
codigo="$(rest activo-proveedores-update PATCH "proveedores?id=eq.${PROVEEDOR_ID}" "$ANON_KEY" "$ACTIVE_JWT" '{"razon_social":"T24 PROVEEDOR ACTIVO"}')"
assert_http "un perfil activo conserva UPDATE de proveedores" "204" "$codigo"

assert_barrera inactivo-clientes-select "$INACTIVE_JWT" GET "clientes?id=eq.${CLIENTE_ID}&select=id"
assert_barrera inactivo-proveedores-select "$INACTIVE_JWT" GET "proveedores?id=eq.${PROVEEDOR_ID}&select=id"
assert_barrera inactivo-profiles-select "$INACTIVE_JWT" GET "profiles?select=id&limit=1"
assert_barrera inactivo-user-roles-select "$INACTIVE_JWT" GET "user_roles?select=id&limit=1"
assert_barrera inactivo-clientes-insert "$INACTIVE_JWT" POST "clientes" "$(jq -nc --arg id "$CLIENTE_INACTIVE_INSERT_ID" '{id:$id,razon_social:"T24 CLIENTE INACTIVO INSERT"}')"
assert_barrera inactivo-proveedores-insert "$INACTIVE_JWT" POST "proveedores" "$(jq -nc --arg id "$PROVEEDOR_INACTIVE_INSERT_ID" '{id:$id,razon_social:"T24 PROVEEDOR INACTIVO INSERT"}')"
assert_barrera inactivo-clientes-update "$INACTIVE_JWT" PATCH "clientes?id=eq.${CLIENTE_ID}" '{"razon_social":"T24 CLIENTE INACTIVO NO DEBE PERSISTIR"}'
assert_barrera inactivo-proveedores-update "$INACTIVE_JWT" PATCH "proveedores?id=eq.${PROVEEDOR_ID}" '{"razon_social":"T24 PROVEEDOR INACTIVO NO DEBE PERSISTIR"}'
assert_barrera inactivo-clientes-delete "$INACTIVE_JWT" DELETE "clientes?id=eq.${CLIENTE_ID}"
assert_barrera inactivo-proveedores-delete "$INACTIVE_JWT" DELETE "proveedores?id=eq.${PROVEEDOR_ID}"
assert_barrera inactivo-rpc "$INACTIVE_JWT" POST "rpc/is_admin" "$(jq -nc --arg id "$INACTIVE_ID" '{_user_id:$id}')"

assert_barrera sin-perfil-clientes-select "$MISSING_JWT" GET "clientes?id=eq.${CLIENTE_ID}&select=id"
assert_barrera sin-perfil-proveedores-select "$MISSING_JWT" GET "proveedores?id=eq.${PROVEEDOR_ID}&select=id"
assert_barrera sin-perfil-profiles-select "$MISSING_JWT" GET "profiles?select=id&limit=1"
assert_barrera sin-perfil-user-roles-select "$MISSING_JWT" GET "user_roles?select=id&limit=1"
assert_barrera sin-perfil-clientes-insert "$MISSING_JWT" POST "clientes" "$(jq -nc --arg id "$CLIENTE_MISSING_INSERT_ID" '{id:$id,razon_social:"T24 CLIENTE SIN PERFIL INSERT"}')"
assert_barrera sin-perfil-proveedores-insert "$MISSING_JWT" POST "proveedores" "$(jq -nc --arg id "$PROVEEDOR_MISSING_INSERT_ID" '{id:$id,razon_social:"T24 PROVEEDOR SIN PERFIL INSERT"}')"
assert_barrera sin-perfil-clientes-update "$MISSING_JWT" PATCH "clientes?id=eq.${CLIENTE_ID}" '{"razon_social":"T24 CLIENTE SIN PERFIL NO DEBE PERSISTIR"}'
assert_barrera sin-perfil-proveedores-update "$MISSING_JWT" PATCH "proveedores?id=eq.${PROVEEDOR_ID}" '{"razon_social":"T24 PROVEEDOR SIN PERFIL NO DEBE PERSISTIR"}'
assert_barrera sin-perfil-clientes-delete "$MISSING_JWT" DELETE "clientes?id=eq.${CLIENTE_ID}"
assert_barrera sin-perfil-proveedores-delete "$MISSING_JWT" DELETE "proveedores?id=eq.${PROVEEDOR_ID}"
assert_barrera sin-perfil-rpc "$MISSING_JWT" POST "rpc/is_admin" "$(jq -nc --arg id "$MISSING_ID" '{_user_id:$id}')"

if [[ "$(q "SELECT razon_social FROM public.clientes WHERE id='$CLIENTE_ID'")" != "T24 CLIENTE ACTIVO" ]] ||
   [[ "$(q "SELECT razon_social FROM public.proveedores WHERE id='$PROVEEDOR_ID'")" != "T24 PROVEEDOR ACTIVO" ]] ||
   [[ "$(q "SELECT pg_catalog.count(*) FROM public.clientes WHERE id IN ('$CLIENTE_INACTIVE_INSERT_ID','$CLIENTE_MISSING_INSERT_ID')")" != "0" ]] ||
   [[ "$(q "SELECT pg_catalog.count(*) FROM public.proveedores WHERE id IN ('$PROVEEDOR_INACTIVE_INSERT_ID','$PROVEEDOR_MISSING_INSERT_ID')")" != "0" ]]; then
  echo "✗ una identidad inactiva o sin perfil logró mutar datos" >&2
  exit 1
fi
echo "✓ los rechazos stale-JWT no mutan clientes ni proveedores"

codigo="$(rest anon-remitos-select GET "remitos?select=id&limit=1" "$ANON_KEY" "$ANON_KEY")"
assert_http "la lectura anon explícitamente publicada sigue disponible" "200" "$codigo"

codigo="$(rest service-clientes-select GET "clientes?id=eq.${CLIENTE_ID}&select=id" "$SERVICE_ROLE_KEY" "$SERVICE_ROLE_KEY")"
assert_http "service_role interno conserva SELECT de clientes" "200" "$codigo"
codigo="$(rest service-proveedores-update PATCH "proveedores?id=eq.${PROVEEDOR_ID}" "$SERVICE_ROLE_KEY" "$SERVICE_ROLE_KEY" '{"razon_social":"T24 PROVEEDOR SERVICE"}')"
assert_http "service_role interno conserva UPDATE de proveedores" "204" "$codigo"

echo "Barrera REST global para perfiles inactivos o ausentes: OK"
