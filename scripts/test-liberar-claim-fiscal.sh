#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)
TMP_DIR="$(mktemp -d)"
ok=0
failures=0
failure_index=0

q() { "${PSQL[@]}" -qAtc "$1"; }
q_sr() { "${PSQL[@]}" -qAtc "SET ROLE service_role; $1"; }

pass() {
  echo "✓ $1"
  ok=$((ok + 1))
}

fail() {
  echo "✗ $1" >&2
  failures=$((failures + 1))
}

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name — esperaba '$expected', obtuvo '$actual'"
  fi
}

expect_fail_like() {
  local name="$1" pattern="$2" sql="$3"
  local output status
  failure_index=$((failure_index + 1))
  output="$TMP_DIR/fallo-${failure_index}.out"
  set +e
  "${PSQL[@]}" -qAtc "SET ROLE service_role; $sql" >"$output" 2>&1
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    fail "$name — la operación fue aceptada"
  elif rg -qi "$pattern" "$output"; then
    pass "$name"
  else
    fail "$name — falló por otro motivo"
    sed -n '1,30p' "$output" >&2
  fi
}

cleanup() {
  "${PSQL[@]}" >/dev/null 2>&1 <<'SQL' || true
DELETE FROM public.emision_fiscal_intentos
 WHERE venta_id::text LIKE 'c6400000-0000-0000-0000-%';
DELETE FROM public.ventas
 WHERE id::text LIKE 'c6400000-0000-0000-0000-%';
DELETE FROM public.clientes
 WHERE id='b6400000-0000-0000-0000-000000000001';
DELETE FROM auth.users
 WHERE id='a6400000-0000-0000-0000-000000000001';
SQL
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
cleanup
TMP_DIR="$(mktemp -d)"
trap cleanup EXIT

snapshot_para() {
  local venta="$1" pv="$2" numero="$3" body hash
  body="$(jq -cS \
    --arg venta "$venta" --argjson pv "$pv" --argjson numero "$numero" '
      .input
      | del(.hash)
      | .venta.id=$venta
      | .venta.numeroComercial=("F640-"+($numero|tostring))
      | .identidad.numero=$numero
      | .identidad.puntoVenta=$pv
      | .fechaComprobante="2026-08-23"
    ' test/fixtures/fiscal-snapshot-parity-v2.json)"
  hash="$(printf '%s' "$body" | shasum -a 256 | awk '{print $1}')"
  jq -c --arg hash "$hash" '. + {hash:$hash}' <<<"$body"
}

VENTA_PREFLIGHT='c6400000-0000-0000-0000-000000000001'
VENTA_RESERVADA='c6400000-0000-0000-0000-000000000002'
VENTA_CARRERA='c6400000-0000-0000-0000-000000000003'
TOKEN_PREFLIGHT='d6400000-0000-0000-0000-000000000001'
TOKEN_RESERVADA='d6400000-0000-0000-0000-000000000002'
TOKEN_CARRERA='d6400000-0000-0000-0000-000000000003'
SNAPSHOT_RESERVADA="$(snapshot_para "$VENTA_RESERVADA" 64001 1)"
HASH_RESERVADA="$(jq -r '.hash' <<<"$SNAPSHOT_RESERVADA")"
SNAPSHOT_CARRERA="$(snapshot_para "$VENTA_CARRERA" 64002 1)"
HASH_CARRERA="$(jq -r '.hash' <<<"$SNAPSHOT_CARRERA")"

"${PSQL[@]}" -v snapshot_reservada="$SNAPSHOT_RESERVADA" \
  -v hash_reservada="$HASH_RESERVADA" >/dev/null <<'SQL'
INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  'a6400000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','liberar-fiscal@test.local','x',now(),now(),now()
);

INSERT INTO public.clientes (id,razon_social)
VALUES ('b6400000-0000-0000-0000-000000000001','FIXTURE LIBERAR CLAIM');

INSERT INTO public.ventas (
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado,total
)
SELECT
  ('c6400000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b6400000-0000-0000-0000-000000000001',
  'a6400000-0000-0000-0000-000000000001',
  'F640-'||n,'VENTA','SIN_FACTURAR',1380.00
FROM generate_series(1,3) AS n;

UPDATE public.ventas
   SET afip_estado='EMITIENDO',afip_fase='PREFLIGHT',
       afip_claim_token='d6400000-0000-0000-0000-000000000001',
       afip_claimed_at=now()-interval '10 minutes',afip_version=1
 WHERE id='c6400000-0000-0000-0000-000000000001';
INSERT INTO public.emision_fiscal_intentos (
  venta_id,claim_token,snapshot_version,payload_hash,fase,resultado,respuesta_resumen
) VALUES (
  'c6400000-0000-0000-0000-000000000001',
  'd6400000-0000-0000-0000-000000000001',2,repeat('0',64),
  'PREFLIGHT','RECLAMADO','{"control":{"lease_segundos":1}}'::jsonb
);

UPDATE public.ventas
   SET afip_estado='EMITIENDO',afip_fase='RESERVADO',
       afip_claim_token='d6400000-0000-0000-0000-000000000002',
       afip_claimed_at=now()-interval '10 minutes',afip_version=2,
       afip_emisor_cuit='30714199664',afip_punto_venta=64001,
       afip_cbte_tipo=6,afip_numero=1,afip_modo='PRODUCCION',
       afip_simulado=false,afip_validez='PRODUCCION',
       afip_fecha_comprobante='2026-08-23',afip_imp_total=1380.00,
       afip_snapshot=:'snapshot_reservada'::jsonb,
       afip_snapshot_hash=:'hash_reservada'
 WHERE id='c6400000-0000-0000-0000-000000000002';
INSERT INTO public.emision_fiscal_intentos (
  venta_id,claim_token,snapshot_version,payload_hash,fase,resultado,
  numero_reservado,respuesta_resumen
) VALUES (
  'c6400000-0000-0000-0000-000000000002',
  'd6400000-0000-0000-0000-000000000002',2,:'hash_reservada',
  'RESERVADO','RESERVADO',1,'{"control":{"lease_segundos":1}}'::jsonb
);

UPDATE public.ventas
   SET afip_estado='EMITIENDO',afip_fase='PREFLIGHT',
       afip_claim_token='d6400000-0000-0000-0000-000000000003',
       afip_claimed_at=now(),afip_version=1
 WHERE id='c6400000-0000-0000-0000-000000000003';
INSERT INTO public.emision_fiscal_intentos (
  venta_id,claim_token,snapshot_version,payload_hash,fase,resultado,respuesta_resumen
) VALUES (
  'c6400000-0000-0000-0000-000000000003',
  'd6400000-0000-0000-0000-000000000003',2,repeat('0',64),
  'PREFLIGHT','RECLAMADO','{"control":{"lease_segundos":1}}'::jsonb
);
SQL

echo "== Permisos y estados admitidos =="
check "la RPC fiscal sigue siendo exclusiva de service_role" \
  "false|false|false|true" \
  "$(q "SELECT has_function_privilege('public','public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)','execute')::text||'|'||has_function_privilege('anon','public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)','execute')::text||'|'||has_function_privilege('authenticated','public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)','execute')::text||'|'||has_function_privilege('service_role','public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)','execute')::text")"
check "el guard interno de liberación no es invocable por roles API" \
  "1|true|false|true|false|false|false|false" \
  "$(q "SELECT count(*)||'|'||bool_and(pg_get_function_identity_arguments(p.oid)='')::text||'|'||bool_or(p.prosecdef)::text||'|'||bool_and(p.proconfig @> ARRAY['search_path=\"\"']::text[])::text||'|'||coalesce(bool_or(has_function_privilege('public',p.oid,'execute')),false)::text||'|'||coalesce(bool_or(has_function_privilege('anon',p.oid,'execute')),false)::text||'|'||coalesce(bool_or(has_function_privilege('authenticated',p.oid,'execute')),false)::text||'|'||coalesce(bool_or(has_function_privilege('service_role',p.oid,'execute')),false)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='proteger_liberacion_claim_fiscal'")"

q_sr "SELECT * FROM public.transicionar_emision_fiscal(
  '$VENTA_PREFLIGHT','LIBERAR','$TOKEN_PREFLIGHT',
  '{\"expected_version\":1,\"verificacion\":{\"nunca_enviado\":true,\"fuente\":\"log_intento\"}}'::jsonb
);" >/dev/null
check "PREFLIGHT vencido sin identidad se puede liberar" \
  "ERROR_CORREGIBLE||2|LIBERADO" \
  "$(q "SELECT v.afip_estado||'|'||coalesce(v.afip_claim_token::text,'')||'|'||v.afip_version||'|'||i.resultado FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='$VENTA_PREFLIGHT'")"

expect_fail_like "RESERVADO jamás se libera aunque el lease esté vencido" \
  "LIBERAR.*PREFLIGHT|identidad fiscal reservada" \
  "BEGIN; SELECT * FROM public.transicionar_emision_fiscal(
    '$VENTA_RESERVADA','LIBERAR','$TOKEN_RESERVADA',
    '{\"expected_version\":2,\"verificacion\":{\"nunca_enviado\":true,\"fuente\":\"log_intento\"}}'::jsonb
  ); ROLLBACK;"
check "el rechazo conserva número, identidad, snapshot y claim" \
  "EMITIENDO|RESERVADO|1|30714199664|64001|6|$TOKEN_RESERVADA|$HASH_RESERVADA|2|RESERVADO" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_fase||'|'||v.afip_numero||'|'||v.afip_emisor_cuit||'|'||v.afip_punto_venta||'|'||v.afip_cbte_tipo||'|'||v.afip_claim_token||'|'||v.afip_snapshot_hash||'|'||v.afip_version||'|'||i.resultado FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='$VENTA_RESERVADA'")"

echo
echo "== Carrera RESERVAR contra LIBERAR =="
"${PSQL[@]}" -v snapshot="$SNAPSHOT_CARRERA" -v hash="$HASH_CARRERA" \
  >"$TMP_DIR/reservar.out" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL ROLE service_role;
SELECT * FROM public.transicionar_emision_fiscal(
  'c6400000-0000-0000-0000-000000000003','RESERVAR',
  'd6400000-0000-0000-0000-000000000003',
  jsonb_build_object(
    'expected_version',1,'snapshot',:'snapshot'::jsonb,'snapshot_hash',:'hash',
    'numero_propuesto',1,'fecha_comprobante','2026-08-23',
    'emisor_cuit','30714199664','punto_venta',64002,'cbte_tipo',6,
    'modo','PRODUCCION','simulado',false,'validez','PRODUCCION',
    'ultimo_remoto',0,'ultimo_local_observado',0
  )
);
SELECT pg_advisory_lock(64000,3);
SELECT pg_sleep(0.8);
COMMIT;
SQL
pid_reservar=$!

lock_visible=false
for _ in $(seq 1 100); do
  if [[ "$(q "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND classid=64000 AND objid=3)::text")" == "true" ]]; then
    lock_visible=true
    break
  fi
  sleep 0.02
done
if [[ "$lock_visible" == "true" ]]; then
  pass "la sesión RESERVAR adquirió el row lock antes de competir"
else
  fail "la sesión RESERVAR no llegó al punto de coordinación"
fi

expect_fail_like "LIBERAR concurrente pierde por CAS y no borra la reserva ganadora" \
  "VERSION_CONFLICT|versi.n" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    '$VENTA_CARRERA','LIBERAR','$TOKEN_CARRERA',
    '{\"expected_version\":1,\"verificacion\":{\"nunca_enviado\":true,\"fuente\":\"log_intento\"}}'::jsonb
  );"
set +e
wait "$pid_reservar"
status_reservar=$?
set -e
if [[ "$status_reservar" -eq 0 ]]; then
  pass "RESERVAR concurrente confirmó su transición"
else
  fail "RESERVAR concurrente falló"
  sed -n '1,30p' "$TMP_DIR/reservar.out" >&2
fi
check "la carrera termina RESERVADO con identidad intacta" \
  "EMITIENDO|RESERVADO|1|30714199664|64002|6|$TOKEN_CARRERA|2|RESERVADO" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_fase||'|'||v.afip_numero||'|'||v.afip_emisor_cuit||'|'||v.afip_punto_venta||'|'||v.afip_cbte_tipo||'|'||v.afip_claim_token||'|'||v.afip_version||'|'||i.resultado FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='$VENTA_CARRERA'")"

echo
echo "$ok verificaciones OK; $failures fallas"
[[ "$failures" -eq 0 ]]
