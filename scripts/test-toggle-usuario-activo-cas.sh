#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)
TMP_DIR="$(mktemp -d)"
ACTOR_EMAIL="t25-admin@local.test"
TARGET_EMAIL="t25-target@local.test"
PASSWORD="T25-local-only-1234"
OP1="25250000-0000-4000-8000-000000000001"
OP2="25250000-0000-4000-8000-000000000002"
OP3="25250000-0000-4000-8000-000000000003"
OP4="25250000-0000-4000-8000-000000000004"

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
case "$API_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "El test CAS se negó a usar un Supabase no local." >&2; exit 1 ;;
esac

cleanup() {
  local previo=$?
  trap - EXIT
  set +e
  "${PSQL[@]}" -q >/dev/null <<SQL
DELETE FROM auth.users WHERE email IN ('$ACTOR_EMAIL','$TARGET_EMAIL');
SQL
  local limpieza=$?
  local residuos
  residuos="$(q "SELECT
    (SELECT pg_catalog.count(*) FROM auth.users WHERE email IN ('$ACTOR_EMAIL','$TARGET_EMAIL'))+
    (SELECT pg_catalog.count(*) FROM public.usuario_estado_acceso e
      LEFT JOIN auth.users u ON u.id=e.profile_id
     WHERE u.id IS NULL)" 2>/dev/null)"
  local auditoria=$?
  rm -r "$TMP_DIR"
  local temporal=$?
  set -e
  if [[ "$limpieza" -ne 0 || "$auditoria" -ne 0 || "$temporal" -ne 0 || "$residuos" != "0" ]]; then
    echo "✗ cleanup CAS falló (${limpieza}/${auditoria}/${temporal}; residuos=${residuos:-?})" >&2
    exit 1
  fi
  echo "✓ cleanup CAS: 0 residuos"
  exit "$previo"
}
trap cleanup EXIT

http() {
  local nombre="$1" metodo="$2" url="$3" api_key="$4" bearer="$5" payload="${6:-}"
  local args=(
    --silent --show-error --connect-timeout 1 --max-time 8
    --output "$TMP_DIR/${nombre}.json" --write-out '%{http_code}'
    --request "$metodo" "$url"
    --header "apikey: $api_key"
    --header "Authorization: Bearer $bearer"
    --header "Content-Type: application/json"
  )
  [[ -z "$payload" ]] || args+=(--data "$payload")
  curl "${args[@]}"
}

assert_http() {
  local nombre="$1" esperado="$2" obtenido="$3"
  if [[ "$obtenido" != "$esperado" ]]; then
    echo "✗ $nombre: esperaba HTTP $esperado, obtuvo $obtenido" >&2
    jq -c . "$TMP_DIR/${nombre}.json" >&2 2>/dev/null || true
    exit 1
  fi
  echo "✓ $nombre (HTTP $obtenido)"
}

crear_usuario() {
  local nombre="$1" email="$2" codigo
  codigo="$(http "$nombre-create" POST "${API_URL%/}/auth/v1/admin/users" \
    "$SERVICE_ROLE_KEY" "$SERVICE_ROLE_KEY" \
    "$(jq -nc --arg email "$email" --arg password "$PASSWORD" \
      '{email:$email,password:$password,email_confirm:true}')")"
  assert_http "crear $nombre" 200 "$codigo" >&2
  jq -er '.id' "$TMP_DIR/${nombre}-create.json"
}

login() {
  local nombre="$1" email="$2" codigo
  codigo="$(http "$nombre-login" POST "${API_URL%/}/auth/v1/token?grant_type=password" \
    "$ANON_KEY" "$ANON_KEY" \
    "$(jq -nc --arg email "$email" --arg password "$PASSWORD" \
      '{email:$email,password:$password}')")"
  assert_http "login $nombre" 200 "$codigo" >&2
  jq -er '.access_token' "$TMP_DIR/${nombre}-login.json"
}

rpc_service() {
  local nombre="$1" funcion="$2" payload="$3" codigo
  codigo="$(http "$nombre" POST "${API_URL%/}/rest/v1/rpc/${funcion}" \
    "$SERVICE_ROLE_KEY" "$SERVICE_ROLE_KEY" "$payload")"
  assert_http "$nombre" 200 "$codigo" >&2
  jq -c . "$TMP_DIR/${nombre}.json"
}

actualizar_auth() {
  local nombre="$1" user_id="$2" ban="$3" codigo
  codigo="$(http "$nombre" PUT "${API_URL%/}/auth/v1/admin/users/${user_id}" \
    "$SERVICE_ROLE_KEY" "$SERVICE_ROLE_KEY" \
    "$(jq -nc --arg ban "$ban" '{ban_duration:$ban}')")"
  assert_http "$nombre" 200 "$codigo"
}

ACTOR_ID="$(crear_usuario actor "$ACTOR_EMAIL")"
TARGET_ID="$(crear_usuario target "$TARGET_EMAIL")"
TARGET_JWT="$(login target "$TARGET_EMAIL")"
"${PSQL[@]}" -q >/dev/null <<SQL
UPDATE public.profiles SET username='t25_admin' WHERE id='$ACTOR_ID';
UPDATE public.profiles SET username='t25_target' WHERE id='$TARGET_ID';
INSERT INTO public.user_roles(user_id,role)
VALUES ('$ACTOR_ID','admin')
ON CONFLICT (user_id,role) DO NOTHING;
SQL

codigo="$(http rpc-authenticated-denegada POST \
  "${API_URL%/}/rest/v1/rpc/iniciar_transicion_usuario_activo" \
  "$ANON_KEY" "$TARGET_JWT" \
  "$(jq -nc --arg actor "$ACTOR_ID" --arg target "$TARGET_ID" --arg op "$OP1" \
    '{p_actor_id:$actor,p_profile_id:$target,p_activo:false,p_operacion_id:$op}')")"
if [[ "$codigo" == 2* ]]; then
  echo "✗ authenticated pudo invocar la RPC service_role-only" >&2
  exit 1
fi
echo "✓ authenticated no puede invocar la RPC de transición (HTTP $codigo)"

codigo="$(http update-directo-denegado PATCH \
  "${API_URL%/}/rest/v1/profiles?id=eq.${TARGET_ID}" \
  "$SERVICE_ROLE_KEY" "$SERVICE_ROLE_KEY" '{"activo":false}')"
assert_http "service_role no puede saltear el CAS con UPDATE directo" 403 "$codigo"
[[ "$(q "SELECT activo FROM public.profiles WHERE id='$TARGET_ID'")" == "t" ]]

inicio1="$(rpc_service inicio-1 iniciar_transicion_usuario_activo \
  "$(jq -nc --arg actor "$ACTOR_ID" --arg target "$TARGET_ID" --arg op "$OP1" \
    '{p_actor_id:$actor,p_profile_id:$target,p_activo:false,p_operacion_id:$op}')")"
jq -e '.version==1 and .pendiente==true and .activo_deseado==false and .activo_actual==false' \
  <<<"$inicio1" >/dev/null

replay1="$(rpc_service inicio-1-replay iniciar_transicion_usuario_activo \
  "$(jq -nc --arg actor "$ACTOR_ID" --arg target "$TARGET_ID" --arg op "$OP1" \
    '{p_actor_id:$actor,p_profile_id:$target,p_activo:false,p_operacion_id:$op}')")"
jq -e '.version==1 and .idempotente==true and .pendiente==true' <<<"$replay1" >/dev/null
echo "✓ respuesta perdida al iniciar recupera la misma versión"

inicio2="$(rpc_service inicio-2 iniciar_transicion_usuario_activo \
  "$(jq -nc --arg actor "$ACTOR_ID" --arg target "$TARGET_ID" --arg op "$OP2" \
    '{p_actor_id:$actor,p_profile_id:$target,p_activo:true,p_operacion_id:$op}')")"
jq -e '.version==2 and .pendiente==true and .activo_deseado==true' <<<"$inicio2" >/dev/null

finalViejo="$(rpc_service final-viejo finalizar_transicion_usuario_activo \
  "$(jq -nc --arg target "$TARGET_ID" --arg op "$OP1" \
    '{p_profile_id:$target,p_version:1,p_operacion_id:$op}')")"
jq -e '.aplicada==false and .supersedida==true and .version==2 and .activo_actual==false' \
  <<<"$finalViejo" >/dev/null
echo "✓ una finalización vieja queda supersedida y el perfil sigue cerrado"

final2="$(rpc_service final-2 finalizar_transicion_usuario_activo \
  "$(jq -nc --arg target "$TARGET_ID" --arg op "$OP2" \
    '{p_profile_id:$target,p_version:2,p_operacion_id:$op}')")"
jq -e '.aplicada==true and .pendiente==false and .activo_actual==true' <<<"$final2" >/dev/null
replayFinal="$(rpc_service final-2-replay finalizar_transicion_usuario_activo \
  "$(jq -nc --arg target "$TARGET_ID" --arg op "$OP2" \
    '{p_profile_id:$target,p_version:2,p_operacion_id:$op}')")"
jq -e '.aplicada==true and .replay==true and .version==2' <<<"$replayFinal" >/dev/null
echo "✓ respuesta perdida al finalizar se recupera sin repetir la transición"

retryViejo="$(rpc_service inicio-1-retry-tardio iniciar_transicion_usuario_activo \
  "$(jq -nc --arg actor "$ACTOR_ID" --arg target "$TARGET_ID" --arg op "$OP1" \
    '{p_actor_id:$actor,p_profile_id:$target,p_activo:false,p_operacion_id:$op}')")"
jq -e '.version==2 and .idempotente==true and .supersedida==true and
  .activo_deseado==true and .pendiente==false and .activo_actual==true' \
  <<<"$retryViejo" >/dev/null
[[ "$(q "SELECT version||':'||activo_deseado||':'||pendiente FROM public.usuario_estado_acceso WHERE profile_id='$TARGET_ID'")" == "2:true:false" ]]
echo "✓ un retry tardío no revive una operación supersedida"

reclamoViejo="$(rpc_service reclamo-version-vieja reclamar_reconciliacion_usuario_activo \
  "$(jq -nc --arg target "$TARGET_ID" --arg op "$OP3" \
    '{p_profile_id:$target,p_version_observada:1,p_operacion_id:$op}')")"
jq -e '.reclamada==false and .version==2 and .pendiente==false' <<<"$reclamoViejo" >/dev/null

reclamo="$(rpc_service reclamo-cas reclamar_reconciliacion_usuario_activo \
  "$(jq -nc --arg target "$TARGET_ID" --arg op "$OP4" \
    '{p_profile_id:$target,p_version_observada:2,p_operacion_id:$op}')")"
jq -e '.reclamada==true and .version==3 and .pendiente==true and .activo_deseado==true and .activo_actual==false' \
  <<<"$reclamo" >/dev/null
rpc_service final-reclamo finalizar_transicion_usuario_activo \
  "$(jq -nc --arg target "$TARGET_ID" --arg op "$OP4" \
    '{p_profile_id:$target,p_version:3,p_operacion_id:$op}')" >/dev/null
echo "✓ reconciliación CAS conserva la intención más nueva"

actualizar_auth bloquear-target "$TARGET_ID" 876000h
codigo="$(http jwt-viejo-bloqueado GET \
  "${API_URL%/}/rest/v1/profiles?select=id&limit=1" "$ANON_KEY" "$TARGET_JWT")"
assert_http "JWT previo al ban queda bloqueado aunque profiles.activo=true" 403 "$codigo"
jq -e '.code=="42501" and (.message|contains("acceso está bloqueado"))' \
  "$TMP_DIR/jwt-viejo-bloqueado.json" >/dev/null
[[ "$(q "SELECT public.is_admin('$ACTOR_ID')")" == "t" ]]

actualizar_auth bloquear-actor "$ACTOR_ID" 876000h
codigo="$(http actor-bloqueado-no-inicia POST \
  "${API_URL%/}/rest/v1/rpc/iniciar_transicion_usuario_activo" \
  "$SERVICE_ROLE_KEY" "$SERVICE_ROLE_KEY" \
  "$(jq -nc --arg actor "$ACTOR_ID" --arg target "$TARGET_ID" --arg op "$OP3" \
    '{p_actor_id:$actor,p_profile_id:$target,p_activo:false,p_operacion_id:$op}')")"
assert_http "service_role no puede representar un admin bloqueado" 403 "$codigo"
[[ "$(q "SELECT public.is_admin('$ACTOR_ID')")" == "f" ]]

echo "Toggle de usuario CAS/versionado, ACL y barrera Auth: OK"
