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
 WHERE venta_id::text LIKE 'c3000000-0000-0000-0000-%';
DELETE FROM public.ventas
 WHERE id::text LIKE 'c3000000-0000-0000-0000-%';
DELETE FROM public.clientes
 WHERE id='b3000000-0000-0000-0000-000000000001';
DELETE FROM auth.users
 WHERE id='a3000000-0000-0000-0000-000000000001';
SQL
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
cleanup
TMP_DIR="$(mktemp -d)"
trap cleanup EXIT

# Fixture de paridad para Task 7. El hash se deriva de esta serialización
# canónica literal, no de la función bajo prueba. Los objetos ordenan claves
# recursivamente y el campo raíz `hash` se excluye del digest.
PARITY_CANONICAL='{"fechaComprobante":"2026-08-22","identidad":{"cbteTipo":1,"emisorCuit":"30900000001","modo":"PRODUCCION","numero":1,"puntoVenta":990,"simulado":false},"importeTotal":"1210.00","items":[{"cantidad":"1.00","id":"a","importe":"1210.00"}],"receptor":{"numeroDocumento":"30714199664","razonSocial":"RECEPTOR UNO","tipoDocumento":"CUIT"},"version":2}'
PARITY_HASH='0a723c78e12741e06048660e5928d96f2e9b8da7ae65346ae4be45fd16967076'

SNAPSHOT=''
SNAPSHOT_HASH=''
crear_snapshot() {
  local numero="$1" cuit="$2" pv="$3" tipo="$4" modo="$5" simulado="$6"
  local receptor_documento="$7" receptor_nombre="$8" total="$9"
  local canonical
  canonical=$(printf '%s' \
    "{\"fechaComprobante\":\"2026-08-22\",\"identidad\":{\"cbteTipo\":${tipo},\"emisorCuit\":\"${cuit}\",\"modo\":\"${modo}\",\"numero\":${numero},\"puntoVenta\":${pv},\"simulado\":${simulado}},\"importeTotal\":\"${total}\",\"items\":[{\"cantidad\":\"1.00\",\"id\":\"a\",\"importe\":\"${total}\"}],\"receptor\":{\"numeroDocumento\":\"${receptor_documento}\",\"razonSocial\":\"${receptor_nombre}\",\"tipoDocumento\":\"CUIT\"},\"version\":2}")
  SNAPSHOT_HASH="$(printf '%s' "$canonical" | shasum -a 256 | awk '{print $1}')"
  SNAPSHOT=$(printf '%s' \
    "{\"version\":2,\"hash\":\"${SNAPSHOT_HASH}\",\"identidad\":{\"numero\":${numero},\"emisorCuit\":\"${cuit}\",\"puntoVenta\":${pv},\"cbteTipo\":${tipo},\"modo\":\"${modo}\",\"simulado\":${simulado}},\"fechaComprobante\":\"2026-08-22\",\"receptor\":{\"tipoDocumento\":\"CUIT\",\"numeroDocumento\":\"${receptor_documento}\",\"razonSocial\":\"${receptor_nombre}\"},\"importeTotal\":\"${total}\",\"items\":[{\"id\":\"a\",\"cantidad\":\"1.00\",\"importe\":\"${total}\"}]}")
}

claim() {
  local venta="$1" token="$2" version="${3:-0}" lease="${4:-300}"
  q_sr "SELECT concat_ws('|',venta_id,afip_estado,afip_fase,afip_claim_token,afip_numero,afip_version) FROM public.transicionar_emision_fiscal('$venta','RECLAMAR','$token',jsonb_build_object('expected_version',$version,'lease_segundos',$lease));"
}

reservar() {
  local venta="$1" token="$2" version="$3" numero="$4" cuit="$5" pv="$6"
  local tipo="$7" modo="$8" simulado="$9" validez="${10}"
  local ultimo_remoto="${11}" ultimo_local="${12}" snapshot="${13}" hash="${14}"
  "${PSQL[@]}" -qAt \
    -v venta="$venta" -v token="$token" -v version="$version" \
    -v numero="$numero" -v cuit="$cuit" -v pv="$pv" -v tipo="$tipo" \
    -v modo="$modo" -v simulado="$simulado" -v validez="$validez" \
    -v ultimo_remoto="$ultimo_remoto" -v ultimo_local="$ultimo_local" \
    -v snapshot="$snapshot" -v snapshot_hash="$hash" <<'SQL'
SET ROLE service_role;
SELECT concat_ws('|',venta_id,afip_estado,afip_fase,afip_claim_token,afip_numero,afip_version)
  FROM public.transicionar_emision_fiscal(
    :'venta'::uuid,'RESERVAR',:'token'::uuid,
    jsonb_build_object(
      'expected_version',:version::integer,
      'snapshot',:'snapshot'::jsonb,
      'snapshot_hash',:'snapshot_hash',
      'numero_propuesto',:numero::integer,
      'fecha_comprobante','2026-08-22',
      'emisor_cuit',:'cuit',
      'punto_venta',:pv::integer,
      'cbte_tipo',:tipo::integer,
      'modo',:'modo',
      'simulado',:simulado::boolean,
      'validez',:'validez',
      'ultimo_remoto',:ultimo_remoto::integer,
      'ultimo_local_observado',:ultimo_local::integer
    )
  );
SQL
}

"${PSQL[@]}" >/dev/null <<'SQL'
INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  'a3000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','t3-fiscal@test.local','x',now(),now(),now()
);

INSERT INTO public.clientes (id,razon_social)
VALUES ('b3000000-0000-0000-0000-000000000001','T3 CLIENTE FISCAL');

INSERT INTO public.ventas (
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado,total
)
SELECT
  ('c3000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b3000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000001',
  'T3-FISCAL-'||lpad(n::text,2,'0'),
  'VENTA','SIN_FACTURAR',1210.00
FROM generate_series(1,16) AS n;
SQL

echo "== Reclamo concurrente =="
"${PSQL[@]}" >"$TMP_DIR/claim-uno.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT * FROM public.transicionar_emision_fiscal(
  'c3000000-0000-0000-0000-000000000001','RECLAMAR',
  'd3000000-0000-0000-0000-000000000001',
  '{"expected_version":0,"lease_segundos":300}'::jsonb
);
SQL
pid_claim_uno=$!

"${PSQL[@]}" >"$TMP_DIR/claim-dos.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT * FROM public.transicionar_emision_fiscal(
  'c3000000-0000-0000-0000-000000000001','RECLAMAR',
  'd3000000-0000-0000-0000-000000000002',
  '{"expected_version":0,"lease_segundos":300}'::jsonb
);
SQL
pid_claim_dos=$!

set +e
wait "$pid_claim_uno"; claim_uno_status=$?
wait "$pid_claim_dos"; claim_dos_status=$?
set -e

if [[ "$claim_uno_status" -ne 0 && "$claim_dos_status" -ne 0 ]] \
   && rg -qi "transicionar_emision_fiscal.*does not exist" \
      "$TMP_DIR/claim-uno.out" "$TMP_DIR/claim-dos.out"; then
  echo "RED válido: transicionar_emision_fiscal no existe; las dos sesiones independientes fallaron por la ausencia del RPC." >&2
  exit 1
fi

if [[ "$claim_uno_status" -eq 0 && "$claim_dos_status" -ne 0 ]] \
   || [[ "$claim_uno_status" -ne 0 && "$claim_dos_status" -eq 0 ]]; then
  pass "dos RECLAMAR concurrentes producen exactamente un ganador"
else
  fail "dos RECLAMAR concurrentes — estados ${claim_uno_status}/${claim_dos_status}"
  sed -n '1,30p' "$TMP_DIR/claim-uno.out" >&2
  sed -n '1,30p' "$TMP_DIR/claim-dos.out" >&2
fi

check "el reclamo ganador persiste una sola versión y un solo intento" \
  "EMITIENDO|PREFLIGHT|1|1" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_fase||'|'||v.afip_version||'|'||count(i.id) FROM public.ventas v LEFT JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='c3000000-0000-0000-0000-000000000001' GROUP BY v.id")"

echo
echo "== Firma, hash y privilegios =="
check "la RPC tiene una sola firma SECURITY INVOKER y search_path fijado" \
  "1|false|true" \
  "$(q "SELECT count(*)||'|'||bool_or(p.prosecdef)::text||'|'||bool_and(array_to_string(p.proconfig,',') LIKE 'search_path=%')::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='transicionar_emision_fiscal' AND pg_get_function_identity_arguments(p.oid)='p_venta_id uuid, p_accion text, p_claim_token uuid, p_payload jsonb'")"
check "sólo service_role puede ejecutar la RPC" \
  "false|false|false|true" \
  "$(q "SELECT has_function_privilege('public','public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)','execute')::text||'|'||has_function_privilege('anon','public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)','execute')::text||'|'||has_function_privilege('authenticated','public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)','execute')::text||'|'||has_function_privilege('service_role','public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)','execute')::text")"
check "authenticated no actualiza ventas ni escribe intentos" \
  "false|false|false|false" \
  "$(q "SELECT has_table_privilege('authenticated','public.ventas','update')::text||'|'||has_table_privilege('authenticated','public.emision_fiscal_intentos','insert')::text||'|'||has_table_privilege('authenticated','public.emision_fiscal_intentos','update')::text||'|'||has_table_privilege('authenticated','public.emision_fiscal_intentos','delete')::text")"
check "el helper de hash es interno y no está otorgado a roles API" \
  "false|false|false|false" \
  "$(q "SELECT has_function_privilege('public','public.fiscal_snapshot_hash(jsonb)','execute')::text||'|'||has_function_privilege('anon','public.fiscal_snapshot_hash(jsonb)','execute')::text||'|'||has_function_privilege('authenticated','public.fiscal_snapshot_hash(jsonb)','execute')::text||'|'||has_function_privilege('service_role','public.fiscal_snapshot_hash(jsonb)','execute')::text")"
check "fixture canónico PostgreSQL/Task 7 tiene SHA-256 determinista" \
  "$PARITY_HASH" \
  "$(q "SELECT public.fiscal_snapshot_hash((jsonb_build_object('hash','$PARITY_HASH')||'$PARITY_CANONICAL'::jsonb))")"
check "el orden de claves JSON no altera el hash" \
  "$PARITY_HASH" \
  "$(q "SELECT public.fiscal_snapshot_hash(jsonb_build_object('version',2,'receptor',jsonb_build_object('tipoDocumento','CUIT','razonSocial','RECEPTOR UNO','numeroDocumento','30714199664'),'items',jsonb_build_array(jsonb_build_object('importe','1210.00','id','a','cantidad','1.00')),'importeTotal','1210.00','identidad',jsonb_build_object('simulado',false,'puntoVenta',990,'numero',1,'modo','PRODUCCION','emisorCuit','30900000001','cbteTipo',1),'fechaComprobante','2026-08-22','hash','$PARITY_HASH'))")"

expect_fail_like "authenticated no llama la RPC" "permission denied for function" \
  "RESET ROLE; SET ROLE authenticated; SELECT public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000014','CANCELAR',NULL,'{\"expected_version\":0}'::jsonb);"
expect_fail_like "authenticated no modifica columnas fiscales directamente" "permission denied for table ventas" \
  "RESET ROLE; SET ROLE authenticated; UPDATE public.ventas SET afip_estado='BLOQUEADO' WHERE id='c3000000-0000-0000-0000-000000000014';"

echo
echo "== Validación optimista, token y allowlists =="
claim 'c3000000-0000-0000-0000-000000000015' 'd3000000-0000-0000-0000-000000000015' >/dev/null
crear_snapshot 1 30900000015 995 1 PRODUCCION false 30714199664 'RECEPTOR STALE' 1210.00
expect_fail_like "expected_version obsoleto levanta error" "versi.n esperada" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000015','RESERVAR','d3000000-0000-0000-0000-000000000015',jsonb_build_object('expected_version',0,'snapshot','$SNAPSHOT'::jsonb,'snapshot_hash','$SNAPSHOT_HASH','numero_propuesto',1,'fecha_comprobante','2026-08-22','emisor_cuit','30900000015','punto_venta',995,'cbte_tipo',1,'modo','PRODUCCION','simulado',false,'validez','PRODUCCION','ultimo_remoto',0,'ultimo_local_observado',0));"
expect_fail_like "un token ajeno levanta error" "token.*no coincide" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000015','RESERVAR','d3000000-0000-0000-0000-000000000099',jsonb_build_object('expected_version',1,'snapshot','$SNAPSHOT'::jsonb,'snapshot_hash','$SNAPSHOT_HASH','numero_propuesto',1,'fecha_comprobante','2026-08-22','emisor_cuit','30900000015','punto_venta',995,'cbte_tipo',1,'modo','PRODUCCION','simulado',false,'validez','PRODUCCION','ultimo_remoto',0,'ultimo_local_observado',0));"
check "fallos optimistas no mutan la venta ni el intento" "EMITIENDO|PREFLIGHT|1|1" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_fase||'|'||v.afip_version||'|'||count(i.id) FROM public.ventas v LEFT JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='c3000000-0000-0000-0000-000000000015' GROUP BY v.id")"

expect_fail_like "acción desconocida se rechaza" "acci.n fiscal no v.lida" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000014','DESCONOCIDA',NULL,'{\"expected_version\":0}'::jsonb);"
expect_fail_like "RECLAMAR exige lease_segundos" "faltan claves requeridas" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000014','RECLAMAR','d3000000-0000-0000-0000-000000000014','{\"expected_version\":0}'::jsonb);"

for action in RECLAMAR RESERVAR REQUEST_INICIADO RESPUESTA_RECIBIDA APROBAR ERROR_CORREGIBLE RECONCILIAR REENVIO_VERIFICADO LIBERAR CANCELAR BLOQUEAR; do
  token="'d3000000-0000-0000-0000-000000000014'"
  [[ "$action" == "CANCELAR" ]] && token="NULL"
  expect_fail_like "$action rechaza claves desconocidas" "clave.*no permitida" \
    "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000014','$action',$token,'{\"expected_version\":0,\"__desconocida\":true}'::jsonb);"
done

echo
echo "== Reserva serializada =="
claim 'c3000000-0000-0000-0000-000000000002' 'd3000000-0000-0000-0000-000000000022' >/dev/null
claim 'c3000000-0000-0000-0000-000000000003' 'd3000000-0000-0000-0000-000000000023' >/dev/null
crear_snapshot 1 30900000001 990 1 PRODUCCION false 30714199664 'RECEPTOR UNO' 1210.00
snapshot_uno="$SNAPSHOT"; hash_uno="$SNAPSHOT_HASH"
crear_snapshot 1 30900000001 990 1 PRODUCCION false 30714199665 'RECEPTOR DOS' 1210.00
snapshot_dos="$SNAPSHOT"; hash_dos="$SNAPSHOT_HASH"

reservar 'c3000000-0000-0000-0000-000000000002' 'd3000000-0000-0000-0000-000000000022' 1 1 30900000001 990 1 PRODUCCION false PRODUCCION 0 0 "$snapshot_uno" "$hash_uno" >"$TMP_DIR/reserva-uno.out" 2>&1 &
pid_reserva_uno=$!
reservar 'c3000000-0000-0000-0000-000000000003' 'd3000000-0000-0000-0000-000000000023' 1 1 30900000001 990 1 PRODUCCION false PRODUCCION 0 0 "$snapshot_dos" "$hash_dos" >"$TMP_DIR/reserva-dos.out" 2>&1 &
pid_reserva_dos=$!

set +e
wait "$pid_reserva_uno"; reserva_uno_status=$?
wait "$pid_reserva_dos"; reserva_dos_status=$?
set -e

if [[ "$reserva_uno_status" -eq 0 && "$reserva_dos_status" -ne 0 ]] \
   || [[ "$reserva_uno_status" -ne 0 && "$reserva_dos_status" -eq 0 ]]; then
  pass "dos RESERVAR paralelos sobre una secuencia producen un solo ganador"
else
  fail "reservas paralelas — estados ${reserva_uno_status}/${reserva_dos_status}"
  sed -n '1,30p' "$TMP_DIR/reserva-uno.out" >&2
  sed -n '1,30p' "$TMP_DIR/reserva-dos.out" >&2
fi
if rg -qi "ultimo_local_observado.*obsoleto" \
   "$TMP_DIR/reserva-uno.out" "$TMP_DIR/reserva-dos.out"; then
  pass "la reserva perdedora revalida el máximo después del advisory lock"
else
  fail "la reserva perdedora no observó el máximo serializado"
  sed -n '1,30p' "$TMP_DIR/reserva-uno.out" >&2
  sed -n '1,30p' "$TMP_DIR/reserva-dos.out" >&2
fi
check "la secuencia conserva un número y un único receptor congelado" "1|1|1" \
  "$(q "SELECT count(*) FILTER (WHERE afip_numero=1)||'|'||count(DISTINCT afip_numero)||'|'||count(DISTINCT afip_snapshot->'receptor'->>'numeroDocumento') FROM public.ventas WHERE id IN ('c3000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000003') AND afip_numero IS NOT NULL")"
check "la reserva perdedora queda intacta en PREFLIGHT" "1" \
  "$(q "SELECT count(*) FROM public.ventas WHERE id IN ('c3000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000003') AND afip_fase='PREFLIGHT' AND afip_numero IS NULL AND afip_version=1")"

echo
echo "== Secuencias independientes y simuladas =="
for n in 5 6 7 8 16; do
  claim "c3000000-0000-0000-0000-$(printf '%012d' "$n")" "d3000000-0000-0000-0000-$(printf '%012d' "$n")" >/dev/null
done

crear_snapshot 1 30900000002 990 1 PRODUCCION false 30714199664 'CUIT DISTINTO' 1210.00
reservar 'c3000000-0000-0000-0000-000000000005' 'd3000000-0000-0000-0000-000000000005' 1 1 30900000002 990 1 PRODUCCION false PRODUCCION 0 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
crear_snapshot 1 30900000001 990 1 HOMOLOGACION false 30714199664 'MODO DISTINTO' 1210.00
reservar 'c3000000-0000-0000-0000-000000000006' 'd3000000-0000-0000-0000-000000000006' 1 1 30900000001 990 1 HOMOLOGACION false HOMOLOGACION 0 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
crear_snapshot 1 30900000001 990 1 PRODUCCION true 30714199664 'SIMULADA UNO' 1210.00
reservar 'c3000000-0000-0000-0000-000000000007' 'd3000000-0000-0000-0000-000000000007' 1 1 30900000001 990 1 PRODUCCION true SIMULADA 987654 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
check "CUIT, modo y simulación separan secuencias aun con número 1" "4" \
  "$(q "SELECT count(*) FROM public.ventas WHERE afip_numero=1 AND afip_punto_venta=990 AND id::text LIKE 'c3000000-0000-0000-0000-%'")"

crear_snapshot 2 30900000001 990 1 PRODUCCION true 30714199664 'SIMULADA DOS' 1210.00
reservar 'c3000000-0000-0000-0000-000000000008' 'd3000000-0000-0000-0000-000000000008' 1 2 30900000001 990 1 PRODUCCION true SIMULADA 0 1 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
check "dos simuladas secuenciales usan números locales 1 y 2" "1|2" \
  "$(q "SELECT min(afip_numero)||'|'||max(afip_numero) FROM public.ventas WHERE afip_emisor_cuit='30900000001' AND afip_punto_venta=990 AND afip_cbte_tipo=1 AND afip_modo='PRODUCCION' AND afip_simulado")"

crear_snapshot 3 30900000001 990 1 PRODUCCION false 30714199664 'NUMERO INCORRECTO' 1210.00
expect_fail_like "la numeración real exige ultimo_remoto + 1" "numero_propuesto.*ultimo_remoto" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000016','RESERVAR','d3000000-0000-0000-0000-000000000016',jsonb_build_object('expected_version',1,'snapshot','$SNAPSHOT'::jsonb,'snapshot_hash','$SNAPSHOT_HASH','numero_propuesto',3,'fecha_comprobante','2026-08-22','emisor_cuit','30900000001','punto_venta',990,'cbte_tipo',1,'modo','PRODUCCION','simulado',false,'validez','PRODUCCION','ultimo_remoto',1,'ultimo_local_observado',1));"
crear_snapshot 1 30900000001 990 1 PRODUCCION false 30714199664 'LOCAL ADELANTADO' 1210.00
expect_fail_like "local adelantado a ARCA exige conciliación" "local.*adelantad.*reconciliar" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000016','RESERVAR','d3000000-0000-0000-0000-000000000016',jsonb_build_object('expected_version',1,'snapshot','$SNAPSHOT'::jsonb,'snapshot_hash','$SNAPSHOT_HASH','numero_propuesto',1,'fecha_comprobante','2026-08-22','emisor_cuit','30900000001','punto_venta',990,'cbte_tipo',1,'modo','PRODUCCION','simulado',false,'validez','PRODUCCION','ultimo_remoto',0,'ultimo_local_observado',1));"

crear_snapshot 1 30900000015 995 1 PRODUCCION false 30714199664 'HASH MALO' 1210.00
expect_fail_like "la reserva no confía en un hash del cliente" "hash.*no coincide" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000015','RESERVAR','d3000000-0000-0000-0000-000000000015',jsonb_build_object('expected_version',1,'snapshot',jsonb_set('$SNAPSHOT'::jsonb,'{hash}','\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\"'::jsonb),'snapshot_hash','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','numero_propuesto',1,'fecha_comprobante','2026-08-22','emisor_cuit','30900000015','punto_venta',995,'cbte_tipo',1,'modo','PRODUCCION','simulado',false,'validez','PRODUCCION','ultimo_remoto',0,'ultimo_local_observado',0));"

echo
echo "== Durabilidad, incertidumbre y reenvío seguro =="
claim 'c3000000-0000-0000-0000-000000000004' 'd3000000-0000-0000-0000-000000000004' >/dev/null
crear_snapshot 1 30900000004 994 1 PRODUCCION false 30714199664 'RECEPTOR INMUTABLE' 1210.00
hash_reenvio="$SNAPSHOT_HASH"
reservar 'c3000000-0000-0000-0000-000000000004' 'd3000000-0000-0000-0000-000000000004' 1 1 30900000004 994 1 PRODUCCION false PRODUCCION 0 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
identity_before="$(q "SELECT concat_ws('|',afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,afip_simulado,afip_fecha_comprobante,afip_imp_total,afip_snapshot::text,afip_snapshot_hash) FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000004'")"
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','REQUEST_INICIADO','d3000000-0000-0000-0000-000000000004','{\"expected_version\":2}'::jsonb);" >/dev/null
check "REQUEST_INICIADO queda durable en una conexión nueva" \
  "EMITIENDO|REQUEST_INICIADO|REQUEST_INICIADO|3" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_fase||'|'||i.fase||'|'||v.afip_version FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id AND i.claim_token=v.afip_claim_token WHERE v.id='c3000000-0000-0000-0000-000000000004'")"
expect_fail_like "evidencia enviada no se convierte ciegamente en error liberable" "inciert.*RECONCILIAR" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','ERROR_CORREGIBLE','d3000000-0000-0000-0000-000000000004','{\"expected_version\":3,\"error_clase\":\"TIMEOUT\",\"error_codigo\":\"T1\",\"error_fase\":\"REQUEST\",\"mensaje_mascarado\":\"timeout\",\"liberar_identidad\":true}'::jsonb);"
expect_fail_like "LIBERAR está prohibido desde REQUEST_INICIADO" "LIBERAR.*REQUEST_INICIADO" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','LIBERAR','d3000000-0000-0000-0000-000000000004','{\"expected_version\":3,\"verificacion\":{\"nunca_enviado\":true}}'::jsonb);"
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','RECONCILIAR','d3000000-0000-0000-0000-000000000004','{\"expected_version\":3,\"error_clase\":\"TRANSPORTE\",\"error_codigo\":\"TIMEOUT\",\"error_fase\":\"REQUEST_INICIADO\",\"mensaje_mascarado\":\"sin respuesta\"}'::jsonb);" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','REENVIO_VERIFICADO','d3000000-0000-0000-0000-000000000004',jsonb_build_object('expected_version',4,'nuevo_claim_token','d3000000-0000-0000-0000-000000000044','ultimo_remoto',0,'respuesta_resumen',jsonb_build_object('ausencia_confirmada',true,'fuente','FECompConsultar'),'payload_hash','$hash_reenvio'));" >/dev/null
identity_after="$(q "SELECT concat_ws('|',afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,afip_simulado,afip_fecha_comprobante,afip_imp_total,afip_snapshot::text,afip_snapshot_hash) FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000004'")"
check "REENVIO_VERIFICADO rota claim y vuelve a RESERVADO" \
  "EMITIENDO|RESERVADO|d3000000-0000-0000-0000-000000000044|5|2" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_fase||'|'||v.afip_claim_token||'|'||v.afip_version||'|'||count(i.id) FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='c3000000-0000-0000-0000-000000000004' GROUP BY v.id")"
check "el reenvío preserva emisor, PV, número, fecha, monto, receptor, snapshot y hash" \
  "$identity_before" "$identity_after"
check "la ausencia ARCA queda auditada antes de rotar" "AUSENCIA_ARCA_VERIFICADA|true" \
  "$(q "SELECT resultado||'|'||(respuesta_resumen->>'ausencia_confirmada') FROM public.emision_fiscal_intentos WHERE venta_id='c3000000-0000-0000-0000-000000000004' AND claim_token='d3000000-0000-0000-0000-000000000004'")"
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','REQUEST_INICIADO','d3000000-0000-0000-0000-000000000044','{\"expected_version\":5}'::jsonb);" >/dev/null
check "el reenvío verificado reutiliza la transición REQUEST normal" "REQUEST_INICIADO|6" \
  "$(q "SELECT afip_fase||'|'||afip_version FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000004'")"

echo
echo "== Resultado, rechazo, liberación, cancelación y bloqueo =="
claim 'c3000000-0000-0000-0000-000000000009' 'd3000000-0000-0000-0000-000000000009' >/dev/null
crear_snapshot 1 30900000009 999 1 PRODUCCION false 30714199664 'APROBADA' 1210.00
reservar 'c3000000-0000-0000-0000-000000000009' 'd3000000-0000-0000-0000-000000000009' 1 1 30900000009 999 1 PRODUCCION false PRODUCCION 0 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000009','REQUEST_INICIADO','d3000000-0000-0000-0000-000000000009','{\"expected_version\":2}'::jsonb);" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000009','RESPUESTA_RECIBIDA','d3000000-0000-0000-0000-000000000009','{\"expected_version\":3,\"respuesta_resumen\":{\"resultado\":\"A\",\"rechazo_confirmado\":false}}'::jsonb);" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000009','APROBAR','d3000000-0000-0000-0000-000000000009','{\"expected_version\":4,\"cae\":\"CAE-T3-0001\",\"cae_vencimiento\":\"2026-09-01\",\"emitido_at\":\"2026-08-22T15:00:00Z\"}'::jsonb);" >/dev/null
check "RESPUESTA_RECIBIDA y APROBAR persisten resultado y CAE" \
  "APROBADO|PERSISTIDO|CAE-T3-0001|5|PERSISTIDO|APROBADO" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_fase||'|'||v.cae||'|'||v.afip_version||'|'||i.fase||'|'||i.resultado FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='c3000000-0000-0000-0000-000000000009'")"

claim 'c3000000-0000-0000-0000-000000000010' 'd3000000-0000-0000-0000-000000000010' >/dev/null
crear_snapshot 1 30900000010 998 1 PRODUCCION false 30714199664 'RECHAZADA' 1210.00
reservar 'c3000000-0000-0000-0000-000000000010' 'd3000000-0000-0000-0000-000000000010' 1 1 30900000010 998 1 PRODUCCION false PRODUCCION 0 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000010','REQUEST_INICIADO','d3000000-0000-0000-0000-000000000010','{\"expected_version\":2}'::jsonb);" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000010','RESPUESTA_RECIBIDA','d3000000-0000-0000-0000-000000000010','{\"expected_version\":3,\"respuesta_resumen\":{\"resultado\":\"R\",\"rechazo_confirmado\":true}}'::jsonb);" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000010','ERROR_CORREGIBLE','d3000000-0000-0000-0000-000000000010','{\"expected_version\":4,\"error_clase\":\"RECHAZO\",\"error_codigo\":\"100\",\"error_fase\":\"RESPUESTA_RECIBIDA\",\"mensaje_mascarado\":\"rechazo validado\",\"liberar_identidad\":true}'::jsonb);" >/dev/null
check "rechazo confirmado puede liberar identidad sin borrar auditoría" \
  "ERROR_CORREGIBLE|||||5|1|ERROR_CORREGIBLE" \
  "$(q "SELECT v.afip_estado||'|'||coalesce(v.afip_claim_token::text,'')||'|'||coalesce(v.afip_numero::text,'')||'|'||coalesce(v.afip_snapshot_hash,'')||'|'||coalesce(v.afip_fecha_comprobante::text,'')||'|'||v.afip_version||'|'||count(i.id)||'|'||max(i.resultado) FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='c3000000-0000-0000-0000-000000000010' GROUP BY v.id")"

claim 'c3000000-0000-0000-0000-000000000011' 'd3000000-0000-0000-0000-000000000011' 0 1 >/dev/null
q "SELECT pg_sleep(1.1)" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000011','LIBERAR','d3000000-0000-0000-0000-000000000011','{\"expected_version\":1,\"verificacion\":{\"nunca_enviado\":true,\"fuente\":\"log_intento\"}}'::jsonb);" >/dev/null
check "LIBERAR exige lease vencido y evidencia nunca-enviado" \
  "ERROR_CORREGIBLE||2|LIBERADO|true" \
  "$(q "SELECT v.afip_estado||'|'||coalesce(v.afip_claim_token::text,'')||'|'||v.afip_version||'|'||i.resultado||'|'||(i.respuesta_resumen->'verificacion'->>'nunca_enviado') FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='c3000000-0000-0000-0000-000000000011'")"

q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000012','CANCELAR',NULL,'{\"expected_version\":0}'::jsonb);" >/dev/null
check "CANCELAR sólo sin claim/request/número deja CANCELADO" "CANCELADO||1" \
  "$(q "SELECT afip_estado||'|'||coalesce(afip_claim_token::text,'')||'|'||afip_version FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000012'")"

claim 'c3000000-0000-0000-0000-000000000013' 'd3000000-0000-0000-0000-000000000013' >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000013','BLOQUEAR','d3000000-0000-0000-0000-000000000013','{\"expected_version\":1,\"error_clase\":\"DIVERGENCIA\",\"error_codigo\":\"D1\",\"error_fase\":\"PREFLIGHT\",\"mensaje_mascarado\":\"requiere admin\",\"diferencias\":{\"receptor\":true}}'::jsonb);" >/dev/null
check "BLOQUEAR conserva evidencia y exige revisión" \
  "BLOQUEADO|DIVERGENCIA|D1|PREFLIGHT|2|BLOQUEADO|true" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_error_clase||'|'||v.afip_error_codigo||'|'||v.afip_error_fase||'|'||v.afip_version||'|'||i.resultado||'|'||(i.respuesta_resumen->'diferencias'->>'receptor') FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='c3000000-0000-0000-0000-000000000013'")"

echo
echo "── resumen ──────────────────"
printf 'ok: %d   fallas: %d\n' "$ok" "$failures"
[[ "$failures" -eq 0 ]]
