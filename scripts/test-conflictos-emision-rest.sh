#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)
TMP_DIR="$(mktemp -d)"

VENTA_RACE="c3130000-0000-4000-8000-000000000001"
VENTA_SECUENCIA_UNO="c3130000-0000-4000-8000-000000000002"
VENTA_SECUENCIA_DOS="c3130000-0000-4000-8000-000000000003"
VENTA_REAL_UNO="c3130000-0000-4000-8000-000000000004"
VENTA_REAL_DOS="c3130000-0000-4000-8000-000000000005"
VENTA_REAL_DIVERGENCIA="c3130000-0000-4000-8000-000000000006"
USUARIO_ID="a3130000-0000-4000-8000-000000000001"
CLIENTE_ID="b3130000-0000-4000-8000-000000000001"
TOKEN_RACE_UNO="d3130000-0000-4000-8000-000000000001"
TOKEN_RACE_DOS="d3130000-0000-4000-8000-000000000002"
TOKEN_SECUENCIA_UNO="d3130000-0000-4000-8000-000000000003"
TOKEN_SECUENCIA_DOS="d3130000-0000-4000-8000-000000000004"
TOKEN_REAL_UNO="d3130000-0000-4000-8000-000000000005"
TOKEN_REAL_DOS="d3130000-0000-4000-8000-000000000006"
TOKEN_REAL_DOS_REINTENTO="d3130000-0000-4000-8000-000000000007"
TOKEN_REAL_DIVERGENCIA="d3130000-0000-4000-8000-000000000008"

q() { "${PSQL[@]}" -qAtc "$1"; }
q_sr() { "${PSQL[@]}" -qAtc "SET ROLE service_role; $1"; }

limpiar_sql() {
  "${PSQL[@]}" >/dev/null <<SQL
DELETE FROM public.emision_fiscal_intentos
 WHERE venta_id IN (
   '$VENTA_RACE','$VENTA_SECUENCIA_UNO','$VENTA_SECUENCIA_DOS',
   '$VENTA_REAL_UNO','$VENTA_REAL_DOS','$VENTA_REAL_DIVERGENCIA'
 );
DELETE FROM public.ventas
 WHERE id IN (
   '$VENTA_RACE','$VENTA_SECUENCIA_UNO','$VENTA_SECUENCIA_DOS',
   '$VENTA_REAL_UNO','$VENTA_REAL_DOS','$VENTA_REAL_DIVERGENCIA'
 );
DELETE FROM public.clientes WHERE id='$CLIENTE_ID';
DELETE FROM auth.users WHERE id='$USUARIO_ID';
SQL
}

cleanup() {
  local previo=$?
  trap - EXIT
  set +e
  limpiar_sql
  local limpieza=$?
  rm -r "$TMP_DIR"
  local temporal=$?
  set -e
  if [[ "$limpieza" -ne 0 || "$temporal" -ne 0 ]]; then
    echo "✗ falló el cleanup del contrato REST (${limpieza}/${temporal})" >&2
    exit 1
  fi
  exit "$previo"
}
trap cleanup EXIT

for herramienta in curl docker jq shasum supabase; do
  command -v "$herramienta" >/dev/null || {
    echo "Falta la herramienta local requerida: $herramienta" >&2
    exit 1
  }
done

STATUS_ENV="$(supabase status -o env 2>/dev/null)"
API_URL="$(sed -n 's/^API_URL="\([^"]*\)"/\1/p' <<<"$STATUS_ENV")"
SERVICE_ROLE_KEY="$(sed -n 's/^SERVICE_ROLE_KEY="\([^"]*\)"/\1/p' <<<"$STATUS_ENV")"
if [[ -z "$PROJECT_ID" || -z "$API_URL" || -z "$SERVICE_ROLE_KEY" ]]; then
  echo "No se pudo derivar project_id/API_URL/service-role del Supabase local." >&2
  exit 1
fi
case "$API_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    echo "El contrato REST se negó a usar un Supabase no local." >&2
    exit 1
    ;;
esac
RPC_URL="${API_URL%/}/rest/v1/rpc/transicionar_emision_fiscal"

post_rpc() {
  local nombre="$1" payload="$2"
  curl --silent --show-error --connect-timeout 1 --max-time 2 \
    --output "$TMP_DIR/${nombre}.body" \
    --write-out '%{http_code}|%{time_total}' \
    --request POST "$RPC_URL" \
    --header "apikey: $SERVICE_ROLE_KEY" \
    --header "Authorization: Bearer $SERVICE_ROLE_KEY" \
    --header "Content-Type: application/json" \
    --data "$payload" >"$TMP_DIR/${nombre}.meta" 2>"$TMP_DIR/${nombre}.err"
}

assert_eq() {
  local nombre="$1" esperado="$2" obtenido="$3"
  if [[ "$obtenido" != "$esperado" ]]; then
    echo "✗ $nombre: esperaba '$esperado', obtuvo '$obtenido'" >&2
    exit 1
  fi
  echo "✓ $nombre"
}

assert_rapido() {
  local nombre="$1" meta="$2"
  local segundos="${meta#*|}"
  if ! awk -v segundos="$segundos" 'BEGIN { exit !(segundos < 2) }'; then
    echo "✗ $nombre tardó ${segundos}s (límite 2s)" >&2
    exit 1
  fi
  echo "✓ $nombre (${segundos}s)"
}

limpiar_sql
"${PSQL[@]}" >/dev/null <<SQL
INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  '$USUARIO_ID','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','t13-rest-conflict@local.test','x',now(),now(),now()
);
INSERT INTO public.clientes (id,razon_social)
VALUES ('$CLIENTE_ID','T13 REST CONFLICT CLIENTE');
INSERT INTO public.ventas (
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  afip_estado,total
)
SELECT id,
       (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
       '$CLIENTE_ID','$USUARIO_ID',numero,'VENTA','SIN_FACTURAR',1380.00
  FROM (VALUES
    ('$VENTA_RACE'::uuid,'T13-REST-RACE'),
    ('$VENTA_SECUENCIA_UNO'::uuid,'T13-REST-SECUENCIA-1'),
    ('$VENTA_SECUENCIA_DOS'::uuid,'T13-REST-SECUENCIA-2'),
    ('$VENTA_REAL_UNO'::uuid,'T13-REST-REAL-1'),
    ('$VENTA_REAL_DOS'::uuid,'T13-REST-REAL-2'),
    ('$VENTA_REAL_DIVERGENCIA'::uuid,'T13-REST-REAL-DIVERGENCIA')
  ) AS fixture(id,numero);
SQL

payload_claim_uno="$(jq -nc \
  --arg venta "$VENTA_RACE" --arg token "$TOKEN_RACE_UNO" \
  '{p_venta_id:$venta,p_accion:"RECLAMAR",p_claim_token:$token,p_payload:{expected_version:0,lease_segundos:300}}')"
payload_claim_dos="$(jq -nc \
  --arg venta "$VENTA_RACE" --arg token "$TOKEN_RACE_DOS" \
  '{p_venta_id:$venta,p_accion:"RECLAMAR",p_claim_token:$token,p_payload:{expected_version:0,lease_segundos:300}}')"

post_rpc claim-uno "$payload_claim_uno" & pid_uno=$!
post_rpc claim-dos "$payload_claim_dos" & pid_dos=$!
set +e
wait "$pid_uno"; exit_uno=$?
wait "$pid_dos"; exit_dos=$?
set -e
assert_eq "ambos POST RECLAMAR terminan sin timeout" "0|0" "$exit_uno|$exit_dos"
meta_uno="$(<"$TMP_DIR/claim-uno.meta")"
meta_dos="$(<"$TMP_DIR/claim-dos.meta")"
codigos="$(printf '%s\n%s\n' "${meta_uno%%|*}" "${meta_dos%%|*}" | sort -n | paste -sd, -)"
assert_eq "dos RECLAMAR simultáneos producen 200/409" "200,409" "$codigos"
assert_rapido "primer RECLAMAR responde antes del deadline" "$meta_uno"
assert_rapido "segundo RECLAMAR responde antes del deadline" "$meta_dos"

if [[ "${meta_uno%%|*}" == "200" ]]; then
  ganador="$TOKEN_RACE_UNO"
  perdedor_body="$TMP_DIR/claim-dos.body"
else
  ganador="$TOKEN_RACE_DOS"
  perdedor_body="$TMP_DIR/claim-uno.body"
fi
jq -e '
  .code == "PT409" and
  (.message | startswith("EMISION_FISCAL_VERSION_CONFLICT"))
' "$perdedor_body" >/dev/null || {
  echo "✗ el perdedor no devolvió PT409 + prefijo de versión" >&2
  exit 1
}
echo "✓ el perdedor devuelve PT409 + EMISION_FISCAL_VERSION_CONFLICT"
assert_eq "queda un claim y un intento auditado" \
  "EMITIENDO|PREFLIGHT|$ganador|1|1" \
  "$(q "SELECT concat_ws('|',v.afip_estado,v.afip_fase,v.afip_claim_token,v.afip_version,count(i.id))
          FROM public.ventas v
          LEFT JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id
         WHERE v.id='$VENTA_RACE'
         GROUP BY v.id")"

payload_siguiente="$(jq -nc \
  --arg venta "$VENTA_RACE" --arg token "$ganador" \
  '{p_venta_id:$venta,p_accion:"ERROR_CORREGIBLE",p_claim_token:$token,p_payload:{expected_version:1,error_clase:"APLICACION",error_codigo:"TEST_REST",error_fase:"PREFLIGHT",mensaje_mascarado:"prueba local sin red ARCA",liberar_identidad:true}}')"
post_rpc siguiente "$payload_siguiente"
meta_siguiente="$(<"$TMP_DIR/siguiente.meta")"
assert_eq "el ganador continúa con una transición inmediata" "200" "${meta_siguiente%%|*}"
assert_rapido "la transición siguiente no queda retenida" "$meta_siguiente"

q_sr "SELECT * FROM public.transicionar_emision_fiscal(
  '$VENTA_SECUENCIA_UNO','RECLAMAR','$TOKEN_SECUENCIA_UNO',
  '{\"expected_version\":0,\"lease_segundos\":300}'::jsonb);" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal(
  '$VENTA_SECUENCIA_DOS','RECLAMAR','$TOKEN_SECUENCIA_DOS',
  '{\"expected_version\":0,\"lease_segundos\":300}'::jsonb);" >/dev/null

crear_snapshot() {
  local venta="$1" numero="$2"
  local canonical
  canonical="$(jq -cS \
    --arg venta "$venta" --argjson numero "$numero" '
      .input | del(.hash)
      | .venta.id=$venta
      | .identidad={
          numero:$numero,emisorCuit:"30714199664",puntoVenta:987,
          cbteTipo:6,modo:"PRODUCCION",simulado:true,validez:"SIMULADA"
        }
    ' test/fixtures/fiscal-snapshot-parity-v2.json)"
  SNAPSHOT_HASH="$(printf '%s' "$canonical" | shasum -a 256 | awk '{print $1}')"
  SNAPSHOT="$(jq -c --arg hash "$SNAPSHOT_HASH" '. + {hash:$hash}' <<<"$canonical")"
}

payload_reserva() {
  local venta="$1" token="$2" numero="$3" ultimo_local="$4"
  jq -nc \
    --arg venta "$venta" --arg token "$token" \
    --argjson snapshot "$SNAPSHOT" --arg hash "$SNAPSHOT_HASH" \
    --argjson numero "$numero" --argjson ultimo_local "$ultimo_local" '
      {
        p_venta_id:$venta,p_accion:"RESERVAR",p_claim_token:$token,
        p_payload:{
          expected_version:1,snapshot:$snapshot,snapshot_hash:$hash,
          numero_propuesto:$numero,fecha_comprobante:"2026-08-22",
          emisor_cuit:"30714199664",punto_venta:987,cbte_tipo:6,
          modo:"PRODUCCION",simulado:true,validez:"SIMULADA",
          ultimo_remoto:0,ultimo_local_observado:$ultimo_local
        }
      }
    '
}

crear_snapshot "$VENTA_SECUENCIA_UNO" 1
post_rpc reserva-uno "$(payload_reserva "$VENTA_SECUENCIA_UNO" "$TOKEN_SECUENCIA_UNO" 1 0)"
assert_eq "la primera reserva establece el máximo local" "200" \
  "$(cut -d'|' -f1 "$TMP_DIR/reserva-uno.meta")"

crear_snapshot "$VENTA_SECUENCIA_DOS" 1
post_rpc reserva-obsoleta \
  "$(payload_reserva "$VENTA_SECUENCIA_DOS" "$TOKEN_SECUENCIA_DOS" 1 0)"
meta_obsoleta="$(<"$TMP_DIR/reserva-obsoleta.meta")"
assert_eq "ultimo_local_observado obsoleto responde 409" "409" "${meta_obsoleta%%|*}"
assert_rapido "el conflicto de secuencia responde antes del deadline" "$meta_obsoleta"
jq -e '
  .code == "PT409" and
  (.message | startswith("EMISION_FISCAL_SECUENCIA_OBSOLETA"))
' "$TMP_DIR/reserva-obsoleta.body" >/dev/null || {
  echo "✗ la secuencia obsoleta no devolvió PT409 + prefijo estable" >&2
  exit 1
}
echo "✓ la secuencia obsoleta devuelve PT409 + EMISION_FISCAL_SECUENCIA_OBSOLETA"
assert_eq "el 409 de secuencia no deja una reserva parcial" \
  "EMITIENDO|PREFLIGHT||1|RECLAMADO" \
  "$(q "SELECT concat_ws('|',v.afip_estado,v.afip_fase,coalesce(v.afip_numero::text,''),v.afip_version,i.resultado)
          FROM public.ventas v
          JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id
         WHERE v.id='$VENTA_SECUENCIA_DOS'")"

crear_snapshot "$VENTA_SECUENCIA_DOS" 2
post_rpc reserva-dos \
  "$(payload_reserva "$VENTA_SECUENCIA_DOS" "$TOKEN_SECUENCIA_DOS" 2 1)"
meta_reserva_dos="$(<"$TMP_DIR/reserva-dos.meta")"
assert_eq "la segunda venta reserva tras refrescar con el mismo claim" \
  "200" "${meta_reserva_dos%%|*}"
assert_rapido "la reserva reconstruida no queda retenida" "$meta_reserva_dos"
assert_eq "dos ventas de la misma identidad reciben números consecutivos distintos" \
  "1|2|2|2" \
  "$(q "SELECT concat_ws('|',min(v.afip_numero),max(v.afip_numero),count(DISTINCT v.afip_numero),count(i.id))
          FROM public.ventas v
          JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id
         WHERE v.id IN ('$VENTA_SECUENCIA_UNO','$VENTA_SECUENCIA_DOS')")"

crear_snapshot_real() {
  local venta="$1" numero="$2"
  local canonical
  canonical="$(jq -cS \
    --arg venta "$venta" --argjson numero "$numero" '
      .input | del(.hash)
      | .venta.id=$venta
      | .identidad={
          numero:$numero,emisorCuit:"30714199664",puntoVenta:986,
          cbteTipo:6,modo:"PRODUCCION",simulado:false,validez:"PRODUCCION"
        }
    ' test/fixtures/fiscal-snapshot-parity-v2.json)"
  SNAPSHOT_HASH="$(printf '%s' "$canonical" | shasum -a 256 | awk '{print $1}')"
  SNAPSHOT="$(jq -c --arg hash "$SNAPSHOT_HASH" '. + {hash:$hash}' <<<"$canonical")"
}

payload_claim() {
  local venta="$1" token="$2" version="$3"
  jq -nc --arg venta "$venta" --arg token "$token" --argjson version "$version" '
    {p_venta_id:$venta,p_accion:"RECLAMAR",p_claim_token:$token,
     p_payload:{expected_version:$version,lease_segundos:300}}'
}

payload_reserva_real() {
  local venta="$1" token="$2" version="$3" numero="$4" remoto="$5" local_observado="$6"
  jq -nc \
    --arg venta "$venta" --arg token "$token" --argjson version "$version" \
    --argjson snapshot "$SNAPSHOT" --arg hash "$SNAPSHOT_HASH" \
    --argjson numero "$numero" --argjson remoto "$remoto" \
    --argjson local_observado "$local_observado" '
      {
        p_venta_id:$venta,p_accion:"RESERVAR",p_claim_token:$token,
        p_payload:{
          expected_version:$version,snapshot:$snapshot,snapshot_hash:$hash,
          numero_propuesto:$numero,fecha_comprobante:"2026-08-22",
          emisor_cuit:"30714199664",punto_venta:986,cbte_tipo:6,
          modo:"PRODUCCION",simulado:false,validez:"PRODUCCION",
          ultimo_remoto:$remoto,ultimo_local_observado:$local_observado
        }
      }'
}

post_transicion() {
  local nombre="$1" venta="$2" accion="$3" token="$4" payload="$5"
  local request
  request="$(jq -nc --arg venta "$venta" --arg accion "$accion" --arg token "$token" \
    --argjson payload "$payload" \
    '{p_venta_id:$venta,p_accion:$accion,p_claim_token:$token,p_payload:$payload}')"
  post_rpc "$nombre" "$request"
  assert_eq "$nombre responde 200" "200" "$(cut -d'|' -f1 "$TMP_DIR/${nombre}.meta")"
}

post_rpc claim-real-uno "$(payload_claim "$VENTA_REAL_UNO" "$TOKEN_REAL_UNO" 0)"
post_rpc claim-real-dos "$(payload_claim "$VENTA_REAL_DOS" "$TOKEN_REAL_DOS" 0)"
assert_eq "las dos ventas reales obtienen claim" "200|200" \
  "$(cut -d'|' -f1 "$TMP_DIR/claim-real-uno.meta")|$(cut -d'|' -f1 "$TMP_DIR/claim-real-dos.meta")"

crear_snapshot_real "$VENTA_REAL_UNO" 1
post_rpc reserva-real-uno \
  "$(payload_reserva_real "$VENTA_REAL_UNO" "$TOKEN_REAL_UNO" 1 1 0 0)"
assert_eq "la primera venta real queda reservada con número 1" "200" \
  "$(cut -d'|' -f1 "$TMP_DIR/reserva-real-uno.meta")"

crear_snapshot_real "$VENTA_REAL_DOS" 1
post_rpc reserva-real-dos-obsoleta \
  "$(payload_reserva_real "$VENTA_REAL_DOS" "$TOKEN_REAL_DOS" 1 1 0 0)"
assert_eq "la segunda venta refresca el máximo local ocupado" "409" \
  "$(cut -d'|' -f1 "$TMP_DIR/reserva-real-dos-obsoleta.meta")"

post_rpc reserva-real-dos-busy \
  "$(payload_reserva_real "$VENTA_REAL_DOS" "$TOKEN_REAL_DOS" 1 1 0 1)"
assert_eq "una reserva ajena activa responde sin bloqueo permanente" \
  "ERROR_CORREGIBLE||true|true" \
  "$(jq -r '.[0] | [.afip_estado,(.afip_fase // ""),(.afip_claim_token==null),(.afip_numero==null)] | join("|")' "$TMP_DIR/reserva-real-dos-busy.body")"
assert_eq "la segunda venta queda retryable y el intento registra busy" \
  "ERROR_CORREGIBLE||IDENTIDAD_FISCAL_OCUPADA||2|IDENTIDAD_FISCAL_OCUPADA" \
  "$(q "SELECT concat_ws('|',v.afip_estado,coalesce(v.afip_fase,''),v.afip_error_codigo,
                         coalesce(v.afip_numero::text,''),v.afip_version,i.resultado)
          FROM public.ventas v
          JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id
         WHERE v.id='$VENTA_REAL_DOS'")"
assert_eq "la primera reserva real sigue intacta" \
  "EMITIENDO|RESERVADO|1|$TOKEN_REAL_UNO" \
  "$(q "SELECT concat_ws('|',afip_estado,afip_fase,afip_numero,afip_claim_token)
          FROM public.ventas WHERE id='$VENTA_REAL_UNO'")"

post_transicion request-real-uno "$VENTA_REAL_UNO" REQUEST_INICIADO "$TOKEN_REAL_UNO" \
  '{"expected_version":2}'
post_transicion respuesta-real-uno "$VENTA_REAL_UNO" RESPUESTA_RECIBIDA "$TOKEN_REAL_UNO" \
  '{"expected_version":3,"respuesta_resumen":{"tipo":"EMISION","resultado":"A","fuente":"FECAESolicitar","rechazo_confirmado":false,"observaciones":[]}}'
post_transicion aprobar-real-uno "$VENTA_REAL_UNO" APROBAR "$TOKEN_REAL_UNO" \
  '{"expected_version":4,"cae":"74123456789021","cae_vencimiento":"2026-09-01","emitido_at":"2026-08-22T15:00:00.000Z"}'

post_rpc claim-real-dos-reintento \
  "$(payload_claim "$VENTA_REAL_DOS" "$TOKEN_REAL_DOS_REINTENTO" 2)"
assert_eq "la segunda venta admite reintento después de liberar busy" "200" \
  "$(cut -d'|' -f1 "$TMP_DIR/claim-real-dos-reintento.meta")"
crear_snapshot_real "$VENTA_REAL_DOS" 2
post_rpc reserva-real-dos-final \
  "$(payload_reserva_real "$VENTA_REAL_DOS" "$TOKEN_REAL_DOS_REINTENTO" 3 2 1 1)"
assert_eq "tras avanzar remoto la segunda reserva el número 2" "200" \
  "$(cut -d'|' -f1 "$TMP_DIR/reserva-real-dos-final.meta")"
post_transicion request-real-dos "$VENTA_REAL_DOS" REQUEST_INICIADO "$TOKEN_REAL_DOS_REINTENTO" \
  '{"expected_version":4}'
post_transicion respuesta-real-dos "$VENTA_REAL_DOS" RESPUESTA_RECIBIDA "$TOKEN_REAL_DOS_REINTENTO" \
  '{"expected_version":5,"respuesta_resumen":{"tipo":"EMISION","resultado":"A","fuente":"FECAESolicitar","rechazo_confirmado":false,"observaciones":[]}}'
post_transicion aprobar-real-dos "$VENTA_REAL_DOS" APROBAR "$TOKEN_REAL_DOS_REINTENTO" \
  '{"expected_version":6,"cae":"74123456789022","cae_vencimiento":"2026-09-01","emitido_at":"2026-08-22T15:00:01.000Z"}'
assert_eq "dos ventas reales terminan aprobadas con números consecutivos" \
  "1|2|2|2" \
  "$(q "SELECT concat_ws('|',min(afip_numero),max(afip_numero),count(DISTINCT afip_numero),count(cae))
          FROM public.ventas WHERE id IN ('$VENTA_REAL_UNO','$VENTA_REAL_DOS')")"

post_rpc claim-real-divergencia \
  "$(payload_claim "$VENTA_REAL_DIVERGENCIA" "$TOKEN_REAL_DIVERGENCIA" 0)"
crear_snapshot_real "$VENTA_REAL_DIVERGENCIA" 1
post_rpc reserva-real-divergencia \
  "$(payload_reserva_real "$VENTA_REAL_DIVERGENCIA" "$TOKEN_REAL_DIVERGENCIA" 1 1 0 2)"
assert_eq "un adelanto real irreconciliable conserva BLOQUEADO" "BLOQUEADO|LOCAL_ADELANTADO" \
  "$(q "SELECT concat_ws('|',afip_estado,afip_error_codigo)
          FROM public.ventas WHERE id='$VENTA_REAL_DIVERGENCIA'")"

assert_eq "PostgREST no deja transacciones abortadas ociosas" "0" \
  "$(q "SELECT count(*) FROM pg_stat_activity
         WHERE datname=current_database()
           AND pid<>pg_backend_pid()
           AND state LIKE 'idle in transaction%'
           AND query ILIKE '%transicionar_emision_fiscal%'")"

echo "Contrato REST fiscal local: claim, secuencia simulada y busy real OK; cero requests ARCA."
