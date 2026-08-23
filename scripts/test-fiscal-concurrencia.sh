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

check_sql() {
  local name="$1" expected="$2" sql="$3"
  local output status
  failure_index=$((failure_index + 1))
  output="$TMP_DIR/consulta-${failure_index}.out"
  set +e
  "${PSQL[@]}" -qAtc "SET ROLE service_role; $sql" >"$output" 2>&1
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    fail "$name — la consulta falló"
    sed -n '1,30p' "$output" >&2
  else
    check "$name" "$expected" "$(sed '/^SET$/d' "$output")"
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

# Fixture neutral reutilizable por el contrato SQL y por snapshot.test.ts de
# Task 7. La serialización/hash esperados no se derivan de la función bajo prueba.
PARITY_FIXTURE='test/fixtures/fiscal-snapshot-parity-v2.json'
PARITY_INPUT="$(jq -c '.input' "$PARITY_FIXTURE")"
PARITY_CANONICAL="$(jq -r '.canonical' "$PARITY_FIXTURE")"
PARITY_HASH="$(jq -r '.sha256' "$PARITY_FIXTURE")"

SNAPSHOT=''
SNAPSHOT_HASH=''
crear_snapshot() {
  local numero="$1" cuit="$2" pv="$3" tipo="$4" modo="$5" simulado="$6"
  local receptor_documento="$7" receptor_nombre="$8" total="$9"
  local canonical
  canonical=$(jq -cS \
    --argjson numero "$numero" --arg cuit "$cuit" --argjson pv "$pv" \
    --argjson tipo "$tipo" --arg modo "$modo" --argjson simulado "$simulado" \
    --arg receptor_documento "$receptor_documento" \
    --arg receptor_nombre "$receptor_nombre" --arg total "$total" '
      .input | del(.hash)
      | .emisor.cuit=$cuit
      | .receptor={
          razonSocial:$receptor_nombre,domicilio:"Domicilio fiscal",
          tipoDocumento:"CUIT",numeroDocumento:$receptor_documento,
          docTipoArca:80,docNroArca:$receptor_documento,
          condicionIva:"RESPONSABLE_INSCRIPTO",origen:"MANUAL",
          origenId:null,verificadoArcaAt:null,condicionIvaReceptorId:1
        }
      | .identidad={
          numero:$numero,emisorCuit:$cuit,puntoVenta:$pv,cbteTipo:$tipo,
          modo:$modo,simulado:$simulado,
          validez:(if $simulado then "SIMULADA" else $modo end)
        }
      | .letra="A"
      | .items=[{
          id:"71000000-0000-4000-8000-000000000011",
          productoId:"71000000-0000-4000-8000-000000000101",
          codigo:"P-1",descripcion:"Pintura",cantidad:"1.00",
          precioUnitarioSinIva:"1000.00",descuentoPorcentaje:"0.00",
          ivaPorcentaje:"21.00",subtotalNeto:"1000.00",
          importeIva:"210.00",subtotalTotal:$total
        }]
      | .importeNeto="1000.00" | .importeExento="0.00"
      | .importeNoGravado="0.00" | .importeIva="210.00"
      | .importeTributos="0.00" | .importeTotal=$total
      | .alicuotasIva=[{id:5,baseImponible:"1000.00",importe:"210.00"}]
      | .tributos=[] | .ivaContenido="0.00"
      | .otrosImpuestosNacionalesIndirectos="0.00"
      | .origen="VENTA" | .comprobanteOriginalId=null | .cbtesAsoc=[]
    ' "$PARITY_FIXTURE")
  SNAPSHOT_HASH="$(printf '%s' "$canonical" | shasum -a 256 | awk '{print $1}')"
  SNAPSHOT=$(jq -c --arg hash "$SNAPSHOT_HASH" '. + {hash:$hash}' <<<"$canonical")
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
FROM generate_series(1,40) AS n;
SQL

echo "== Matriz estado/fase =="
identity_sql="afip_claim_token='d3000000-0000-0000-0000-000000000099',afip_claimed_at=now(),afip_emisor_cuit='30900000010',afip_punto_venta=990,afip_cbte_tipo=1,afip_numero=1,afip_modo='PRODUCCION',afip_simulado=false,afip_validez='PRODUCCION',afip_fecha_comprobante='2026-08-22',afip_snapshot='$PARITY_INPUT'::jsonb,afip_snapshot_hash='$PARITY_HASH',afip_imp_total=1210.00,afip_version=2"
identity_sql_validez_null="${identity_sql/afip_validez=\'PRODUCCION\'/afip_validez=NULL}"
expect_fail_like "PERSISTIDO no es una fase válida de EMITIENDO" "ck_ventas_afip_estado_integridad" \
  "BEGIN; UPDATE public.ventas SET afip_estado='EMITIENDO',afip_fase='PERSISTIDO',$identity_sql WHERE id='c3000000-0000-0000-0000-000000000017'; ROLLBACK;"
expect_fail_like "RESPUESTA_RECIBIDA no es una fase válida de APROBADO" "ck_ventas_afip_estado_integridad" \
  "BEGIN; UPDATE public.ventas SET afip_estado='APROBADO',afip_fase='RESPUESTA_RECIBIDA',cae='CAE-MATRIX',$identity_sql WHERE id='c3000000-0000-0000-0000-000000000018'; ROLLBACK;"
expect_fail_like "RESERVADO no es una fase válida de RECONCILIAR" "ck_ventas_afip_estado_integridad" \
  "BEGIN; UPDATE public.ventas SET afip_estado='RECONCILIAR',afip_fase='RESERVADO',$identity_sql WHERE id='c3000000-0000-0000-0000-000000000019'; ROLLBACK;"
expect_fail_like "PREFLIGHT no es una fase válida de SIN_FACTURAR" "ck_ventas_afip_estado_integridad" \
  "BEGIN; UPDATE public.ventas SET afip_estado='SIN_FACTURAR',afip_fase='PREFLIGHT',afip_claim_token='d3000000-0000-0000-0000-000000000099',afip_claimed_at=now(),afip_version=1 WHERE id='c3000000-0000-0000-0000-000000000020'; ROLLBACK;"
expect_fail_like "REQUEST_INICIADO no es una fase válida de ERROR_CORREGIBLE" "ck_ventas_afip_estado_integridad" \
  "BEGIN; UPDATE public.ventas SET afip_estado='ERROR_CORREGIBLE',afip_fase='REQUEST_INICIADO',$identity_sql WHERE id='c3000000-0000-0000-0000-000000000021'; ROLLBACK;"
expect_fail_like "RESERVADO exige identidad fiscal completa y snapshot coherente" "ck_ventas_afip_estado_integridad" \
  "BEGIN; UPDATE public.ventas SET afip_estado='EMITIENDO',afip_fase='RESERVADO',afip_claim_token='d3000000-0000-0000-0000-000000000099',afip_claimed_at=now(),afip_snapshot='{\"version\":2}'::jsonb,afip_snapshot_hash=repeat('e',64),afip_version=2 WHERE id='c3000000-0000-0000-0000-000000000025'; ROLLBACK;"
expect_fail_like "RESERVADO rechaza identidad completa con afip_validez NULL" "ck_ventas_afip_estado_integridad" \
  "BEGIN; UPDATE public.ventas SET afip_estado='EMITIENDO',afip_fase='RESERVADO',$identity_sql_validez_null WHERE id='c3000000-0000-0000-0000-000000000026'; ROLLBACK;"
check_sql "la excepción legacy APROBADO versión 0 sigue siendo válida" "1" \
  "BEGIN; UPDATE public.ventas SET afip_estado='APROBADO',afip_fase=NULL,afip_version=0,afip_numero=9001,afip_emisor_cuit='30900000010',afip_punto_venta=990,afip_cbte_tipo=1,afip_modo='PRODUCCION',cae='CAE-LEGACY' WHERE id='c3000000-0000-0000-0000-000000000022'; SELECT count(*) FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000022' AND afip_estado='APROBADO'; ROLLBACK;"
check_sql "la excepción aditiva EMITIENDO sin fase sigue siendo válida" "1" \
  "BEGIN; UPDATE public.ventas SET afip_estado='EMITIENDO',afip_fase=NULL,afip_claim_token='d3000000-0000-0000-0000-000000000099',afip_claimed_at=now(),afip_snapshot='$PARITY_INPUT'::jsonb,afip_snapshot_hash='$PARITY_HASH',afip_version=2 WHERE id='c3000000-0000-0000-0000-000000000023'; SELECT count(*) FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000023' AND afip_estado='EMITIENDO'; ROLLBACK;"
check_sql "la excepción aditiva RECONCILIAR sin fase sigue siendo válida" "1" \
  "BEGIN; UPDATE public.ventas SET afip_estado='RECONCILIAR',afip_fase=NULL,$identity_sql WHERE id='c3000000-0000-0000-0000-000000000024'; SELECT count(*) FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000024' AND afip_estado='RECONCILIAR'; ROLLBACK;"

echo

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
check "el helper CUIT tiene una sola firma inmutable, invoker y search_path fijado" \
  "1|true|false|true" \
  "$(q "SELECT count(*)||'|'||bool_and(p.provolatile='i')::text||'|'||bool_or(p.prosecdef)::text||'|'||bool_and(array_to_string(p.proconfig,',') LIKE 'search_path=%')::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='cuit_fiscal_snapshot_valido' AND pg_get_function_identity_arguments(p.oid)='p_cuit text'")"
check "sólo service_role puede ejecutar el helper CUIT interno" \
  "false|false|false|true" \
  "$(q "SELECT has_function_privilege('public','public.cuit_fiscal_snapshot_valido(text)','execute')::text||'|'||has_function_privilege('anon','public.cuit_fiscal_snapshot_valido(text)','execute')::text||'|'||has_function_privilege('authenticated','public.cuit_fiscal_snapshot_valido(text)','execute')::text||'|'||has_function_privilege('service_role','public.cuit_fiscal_snapshot_valido(text)','execute')::text")"
check "el helper CUIT distingue cero, puntuado y canónico válido" \
  "false|false|true" \
  "$(q "SELECT public.cuit_fiscal_snapshot_valido('00000000000')::text||'|'||public.cuit_fiscal_snapshot_valido('30-71419966-4')::text||'|'||public.cuit_fiscal_snapshot_valido('30714199664')::text")"
check "authenticated no actualiza ventas ni escribe intentos" \
  "false|false|false|false" \
  "$(q "SELECT has_table_privilege('authenticated','public.ventas','update')::text||'|'||has_table_privilege('authenticated','public.emision_fiscal_intentos','insert')::text||'|'||has_table_privilege('authenticated','public.emision_fiscal_intentos','update')::text||'|'||has_table_privilege('authenticated','public.emision_fiscal_intentos','delete')::text")"
check "el helper de hash es interno y no está otorgado a roles API" \
  "false|false|false|false" \
  "$(q "SELECT has_function_privilege('public','public.fiscal_snapshot_hash(jsonb)','execute')::text||'|'||has_function_privilege('anon','public.fiscal_snapshot_hash(jsonb)','execute')::text||'|'||has_function_privilege('authenticated','public.fiscal_snapshot_hash(jsonb)','execute')::text||'|'||has_function_privilege('service_role','public.fiscal_snapshot_hash(jsonb)','execute')::text")"
check "sólo service_role puede ejecutar el validador v2" \
  "false|false|false|true" \
  "$(q "SELECT has_function_privilege('public','public.validar_snapshot_fiscal_v2(jsonb)','execute')::text||'|'||has_function_privilege('anon','public.validar_snapshot_fiscal_v2(jsonb)','execute')::text||'|'||has_function_privilege('authenticated','public.validar_snapshot_fiscal_v2(jsonb)','execute')::text||'|'||has_function_privilege('service_role','public.validar_snapshot_fiscal_v2(jsonb)','execute')::text")"
check "el validador v2 conserva una sola firma invoker y search_path fijado" \
  "1|false|true" \
  "$(q "SELECT count(*)||'|'||bool_or(p.prosecdef)::text||'|'||bool_and(array_to_string(p.proconfig,',') LIKE 'search_path=%')::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='validar_snapshot_fiscal_v2' AND pg_get_function_identity_arguments(p.oid)='p_snapshot jsonb'")"
check "RESERVAR aplica explícitamente el helper CUIT estricto" \
  "true" \
  "$(q "SELECT (pg_get_functiondef('public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)'::regprocedure) LIKE '%NOT public.cuit_fiscal_snapshot_valido(p_payload->>''emisor_cuit'')%')::text")"
check "fixture canónico PostgreSQL/Task 7 tiene SHA-256 determinista" \
  "$PARITY_HASH" \
  "$(q "SELECT public.fiscal_snapshot_hash('$PARITY_INPUT'::jsonb)")"
check "fixture compartido conserva la serialización canónica recursiva" \
  "$PARITY_CANONICAL" \
  "$(q "SELECT public.fiscal_json_canonico('$PARITY_INPUT'::jsonb-'hash')")"
check "el orden de claves JSON no altera el hash" \
  "$PARITY_HASH" \
  "$(q "SELECT public.fiscal_snapshot_hash(('$PARITY_INPUT'::jsonb-'version')||jsonb_build_object('version',2))")"
check_sql "PostgreSQL valida el fixture v2 compartido completo" "" \
  "SELECT public.validar_snapshot_fiscal_v2('$PARITY_INPUT'::jsonb);"

expect_snapshot_invalido() {
  local name="$1" filter="$2" pattern="$3" body hash snapshot
  body="$(jq -cS "$filter | del(.hash)" <<<"$PARITY_INPUT")"
  hash="$(printf '%s' "$body" | shasum -a 256 | awk '{print $1}')"
  snapshot="$(jq -c --arg hash "$hash" '. + {hash:$hash}' <<<"$body")"
  expect_fail_like "$name" "$pattern" \
    "SELECT public.validar_snapshot_fiscal_v2('$snapshot'::jsonb);"
}
expect_snapshot_valido() {
  local name="$1" filter="$2" body hash snapshot
  body="$(jq -cS "$filter | del(.hash)" <<<"$PARITY_INPUT")"
  hash="$(printf '%s' "$body" | shasum -a 256 | awk '{print $1}')"
  snapshot="$(jq -c --arg hash "$hash" '. + {hash:$hash}' <<<"$body")"
  check_sql "$name" "" "SELECT public.validar_snapshot_fiscal_v2('$snapshot'::jsonb);"
}
expect_snapshot_invalido "v2 rechaza claves anidadas desconocidas" \
  '.receptor.extra=true' 'receptor.*(incompleto|inválido)'
expect_snapshot_invalido "v2 rechaza claves anidadas faltantes" \
  'del(.items[0].codigo)' 'item.*(incompleto|incoherente)'
expect_snapshot_invalido "v2 rechaza importes JSON numéricos" \
  '.importeTotal=1380' 'importes.*strings'
expect_snapshot_invalido "v2 rechaza alícuotas duplicadas" \
  '.alicuotasIva=[.alicuotasIva[0],.alicuotasIva[0]]' 'alícuotas.*(desordenadas|duplicadas)'
expect_snapshot_invalido "v2 rechaza tributos duplicados" \
  '.tributos=[.tributos[0],.tributos[0]]' 'tributos.*(desordenados|duplicados)'
expect_snapshot_invalido "v2 rechaza arrays fuera del orden de dominio" \
  '.items |= reverse' 'items.*(desordenados|duplicados)'
expect_snapshot_invalido "v2 rechaza modo y validez incoherentes" \
  '.identidad.validez="HOMOLOGACION"' 'identidad.*incoherente'
expect_snapshot_invalido "v2 recalcula cada línea desde cantidad, precio y descuento" \
  '.items[0].cantidad="3.00"' 'item.*(cálculo|incoherente)'
expect_snapshot_invalido "v2 exige el ID ARCA exacto del grupo IVA" \
  '.alicuotasIva[0].id=4' 'alícuota|IVA'
expect_snapshot_invalido "v2 rechaza repartir una base 21% como tasa cero" \
  '.alicuotasIva=[{id:3,baseImponible:"100.00",importe:"0.00"},{id:5,baseImponible:"900.00",importe:"210.00"}]' \
  'alícuota|IVA'
expect_snapshot_invalido "v2 rechaza fecha comercial 24:00 normalizada" \
  '.venta.fechaComercial="2026-08-22T24:00:00Z"' 'fecha|instante'
expect_snapshot_invalido "v2 rechaza verificación ARCA 24:00 normalizada" \
  '.receptor.verificadoArcaAt="2026-08-22T24:00:00.000Z"' 'verificación|instante'
expect_snapshot_invalido "v2 rechaza fecha comercial inexistente normalizada" \
  '.venta.fechaComercial="2026-02-30T15:00:00Z"' 'fecha|instante'
expect_snapshot_invalido "v2 rechaza verificación ARCA inexistente normalizada" \
  '.receptor.verificadoArcaAt="2026-02-30T15:00:00.000Z"' 'verificación|instante'
expect_snapshot_invalido "v2 rechaza año 0000 en fecha comercial" \
  '.venta.fechaComercial="0000-01-01T00:00:00Z"' 'fecha|instante|año|inv.lid'
expect_snapshot_invalido "v2 rechaza año 0000 en verificación ARCA" \
  '.receptor.verificadoArcaAt="0000-01-01T00:00:00.000Z"' 'verificación|instante|año'
expect_snapshot_invalido "v2 rechaza año 0000 en fecha del comprobante" \
  '.fechaComprobante="0000-01-01"' 'fecha|año'
expect_snapshot_invalido "v2 rechaza año 0000 en inicio de actividades" \
  '.emisor.inicioActividades="0000-01-01"' 'emisor|fecha|año'
expect_snapshot_invalido "v2 rechaza año 0000 en comprobante asociado" '
  .venta.tipoComprobante="NOTA_CREDITO" |
  .identidad.cbteTipo=8 |
  .origen="COMPROBANTE_ORIGINAL" |
  .comprobanteOriginalId="71000000-0000-4000-8000-000000000401" |
  .cbtesAsoc=[{tipo:6,puntoVenta:5,numero:1,cuit:"30714199664",fecha:"0000-01-01"}]
' 'asociación|fecha|año|inv.lid'
expect_snapshot_invalido "v2 rechaza 2100-02-29 en fecha comercial" \
  '.venta.fechaComercial="2100-02-29T00:00:00Z"' 'fecha|instante'
expect_snapshot_invalido "v2 rechaza 2100-02-29 en verificación ARCA" \
  '.receptor.verificadoArcaAt="2100-02-29T00:00:00.000Z"' 'verificación|instante'
expect_snapshot_invalido "v2 rechaza 2100-02-29 en fecha del comprobante" \
  '.fechaComprobante="2100-02-29"' 'fecha'
expect_snapshot_invalido "v2 rechaza 2100-02-29 en inicio de actividades" \
  '.emisor.inicioActividades="2100-02-29"' 'emisor|fecha'
expect_snapshot_invalido "v2 rechaza 2100-02-29 en comprobante asociado" '
  .venta.tipoComprobante="NOTA_CREDITO" |
  .identidad.cbteTipo=8 |
  .origen="COMPROBANTE_ORIGINAL" |
  .comprobanteOriginalId="71000000-0000-4000-8000-000000000401" |
  .cbtesAsoc=[{tipo:6,puntoVenta:5,numero:1,cuit:"30714199664",fecha:"2100-02-29"}]
' 'asociación|fecha'
expect_snapshot_valido "v2 acepta año 0001 en los cinco campos" '
  .venta.fechaComercial="0001-01-01T00:00:00Z" |
  .receptor.verificadoArcaAt="0001-01-01T00:00:00.000Z" |
  .fechaComprobante="0001-01-01" |
  .emisor.inicioActividades="0001-01-01" |
  .venta.tipoComprobante="NOTA_CREDITO" |
  .identidad.cbteTipo=8 |
  .origen="COMPROBANTE_ORIGINAL" |
  .comprobanteOriginalId="71000000-0000-4000-8000-000000000401" |
  .cbtesAsoc=[{tipo:6,puntoVenta:5,numero:1,cuit:"30714199664",fecha:"0001-01-01"}]
'
expect_snapshot_valido "v2 acepta 2024-02-29 en los cinco campos" '
  .venta.fechaComercial="2024-02-29T00:00:00Z" |
  .receptor.verificadoArcaAt="2024-02-29T00:00:00.000Z" |
  .fechaComprobante="2024-02-29" |
  .emisor.inicioActividades="2024-02-29" |
  .venta.tipoComprobante="NOTA_CREDITO" |
  .identidad.cbteTipo=8 |
  .origen="COMPROBANTE_ORIGINAL" |
  .comprobanteOriginalId="71000000-0000-4000-8000-000000000401" |
  .cbtesAsoc=[{tipo:6,puntoVenta:5,numero:1,cuit:"30714199664",fecha:"2024-02-29"}]
'
expect_snapshot_valido "v2 acepta instantes canónicos con y sin milisegundos" \
  '.venta.fechaComercial="2026-08-20T15:00:00Z" | .receptor.verificadoArcaAt="2026-08-21T14:59:58.123Z"'
expect_snapshot_invalido "v2 rechaza CUIT emisor todo cero" \
  '.emisor.cuit="00000000000" | .identidad.emisorCuit="00000000000"' 'CUIT|emisor|identidad'
expect_snapshot_invalido "v2 rechaza CUIT emisor puntuado" \
  '.emisor.cuit="30-71419966-4" | .identidad.emisorCuit="30-71419966-4"' 'CUIT|emisor|identidad'
expect_snapshot_invalido "v2 rechaza CUIT receptor todo cero" '
  .receptor.tipoDocumento="CUIT" |
  .receptor.numeroDocumento="00000000000" |
  .receptor.docTipoArca=80 |
  .receptor.docNroArca="00000000000" |
  .receptor.condicionIva="RESPONSABLE_INSCRIPTO" |
  .receptor.condicionIvaReceptorId=1 |
  .letra="A" | .identidad.cbteTipo=1 | .ivaContenido="0.00"
' 'CUIT|receptor|documento'
expect_snapshot_invalido "v2 rechaza CUIT receptor puntuado" '
  .receptor.tipoDocumento="CUIT" |
  .receptor.numeroDocumento="30-71419966-4" |
  .receptor.docTipoArca=80 |
  .receptor.docNroArca="30714199664" |
  .receptor.condicionIva="RESPONSABLE_INSCRIPTO" |
  .receptor.condicionIvaReceptorId=1 |
  .letra="A" | .identidad.cbteTipo=1 | .ivaContenido="0.00"
' 'CUIT|receptor|documento'
expect_snapshot_valido "v2 acepta CUIT canónico válido en emisor, identidad, receptor y asociación" '
  .receptor.tipoDocumento="CUIT" |
  .receptor.numeroDocumento="30714199664" |
  .receptor.docTipoArca=80 |
  .receptor.docNroArca="30714199664" |
  .receptor.condicionIva="RESPONSABLE_INSCRIPTO" |
  .receptor.condicionIvaReceptorId=1 |
  .letra="A" |
  .venta.tipoComprobante="NOTA_CREDITO" |
  .identidad.cbteTipo=3 |
  .ivaContenido="0.00" |
  .origen="COMPROBANTE_ORIGINAL" |
  .comprobanteOriginalId="71000000-0000-4000-8000-000000000401" |
  .cbtesAsoc=[{tipo:1,puntoVenta:5,numero:1,cuit:"30714199664",fecha:"2026-08-20"}]
'
expect_snapshot_valido "v2 redondea IVA por ítem antes de agrupar" '
  .items=[
    (.items[0] | .id="71000000-0000-4000-8000-000000000011" | .productoId=null |
      .cantidad="1.00" | .precioUnitarioSinIva="0.05" | .descuentoPorcentaje="10.00" |
      .ivaPorcentaje="10.50" | .subtotalNeto="0.05" | .importeIva="0.01" | .subtotalTotal="0.06"),
    (.items[0] | .id="71000000-0000-4000-8000-000000000012" | .productoId=null |
      .cantidad="1.00" | .precioUnitarioSinIva="0.05" | .descuentoPorcentaje="10.00" |
      .ivaPorcentaje="10.50" | .subtotalNeto="0.05" | .importeIva="0.01" | .subtotalTotal="0.06")
  ] |
  .importeNeto="0.10" | .importeExento="0.00" | .importeNoGravado="0.00" |
  .importeIva="0.02" | .importeTributos="0.00" | .importeTotal="0.12" |
  .alicuotasIva=[{id:4,baseImponible:"0.10",importe:"0.02"}] |
  .tributos=[] | .ivaContenido="0.02" | .otrosImpuestosNacionalesIndirectos="0.00"
'
expect_snapshot_valido "v2 representa neto gravado a tasa cero con ID 3" '
  .items=[(.items[1] | .ivaPorcentaje="0.00" | .subtotalNeto="100.00" |
    .importeIva="0.00" | .subtotalTotal="100.00")] |
  .importeNeto="100.00" | .importeExento="0.00" | .importeNoGravado="0.00" |
  .importeIva="0.00" | .importeTributos="0.00" | .importeTotal="100.00" |
  .alicuotasIva=[{id:3,baseImponible:"100.00",importe:"0.00"}] |
  .tributos=[] | .ivaContenido="0.00" | .otrosImpuestosNacionalesIndirectos="0.00"
'

expect_fail_like "authenticated no llama la RPC" "permission denied for function" \
  "RESET ROLE; SET ROLE authenticated; SELECT public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000014','CANCELAR',NULL,'{\"expected_version\":0}'::jsonb);"
expect_fail_like "authenticated no modifica columnas fiscales directamente" "permission denied for table ventas" \
  "RESET ROLE; SET ROLE authenticated; UPDATE public.ventas SET afip_estado='BLOQUEADO' WHERE id='c3000000-0000-0000-0000-000000000014';"

echo
echo "== Validación optimista, token y allowlists =="
claim 'c3000000-0000-0000-0000-000000000015' 'd3000000-0000-0000-0000-000000000015' >/dev/null
crear_snapshot 1 30900000150 995 1 PRODUCCION false 30714199664 'RECEPTOR STALE' 1210.00
reserva_base="$(jq -cn \
  --argjson snapshot "$SNAPSHOT" --arg hash "$SNAPSHOT_HASH" \
  '{expected_version:1,snapshot:$snapshot,snapshot_hash:$hash,numero_propuesto:1,fecha_comprobante:"2026-08-22",emisor_cuit:"30900000150",punto_venta:995,cbte_tipo:1,modo:"PRODUCCION",simulado:false,validez:"PRODUCCION",ultimo_remoto:0,ultimo_local_observado:0}')"
expect_reserva_invalida() {
  local name="$1" filter="$2" payload
  payload="$(jq -c "$filter" <<<"$reserva_base")"
  expect_fail_like "$name" "RESERVAR.*(inv.lid|debe|requiere|rango)" \
    "BEGIN; SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000015','RESERVAR','d3000000-0000-0000-0000-000000000015','$payload'::jsonb); ROLLBACK;"
}
expect_reserva_invalida "RESERVAR rechaza numero_propuesto JSON null" '.numero_propuesto=null'
expect_reserva_invalida "RESERVAR rechaza numero_propuesto string" '.numero_propuesto="1"'
expect_reserva_invalida "RESERVAR rechaza numero_propuesto fuera de dominio" '.numero_propuesto=0'
expect_reserva_invalida "RESERVAR rechaza punto_venta JSON null antes del advisory lock" '.punto_venta=null'
expect_reserva_invalida "RESERVAR rechaza punto_venta fuera de rango" '.punto_venta=100000'
expect_reserva_invalida "RESERVAR rechaza cbte_tipo JSON null antes del advisory lock" '.cbte_tipo=null'
expect_reserva_invalida "RESERVAR rechaza cbte_tipo fuera de rango" '.cbte_tipo=10000'
expect_reserva_invalida "RESERVAR rechaza ultimo_remoto JSON null" '.ultimo_remoto=null'
expect_reserva_invalida "RESERVAR rechaza ultimo_local_observado JSON null" '.ultimo_local_observado=null'
expect_reserva_invalida "RESERVAR rechaza CUIT JSON null antes del advisory lock" '.emisor_cuit=null'
expect_reserva_invalida "RESERVAR rechaza CUIT con formato inválido" '.emisor_cuit=""'
expect_reserva_invalida "RESERVAR rechaza CUIT todo cero" '.emisor_cuit="00000000000"'
expect_reserva_invalida "RESERVAR rechaza CUIT puntuado" '.emisor_cuit="30-90000015-0"'
expect_reserva_invalida "RESERVAR rechaza modo JSON null antes del advisory lock" '.modo=null'
expect_reserva_invalida "RESERVAR rechaza simulado JSON null antes del advisory lock" '.simulado=null'
expect_reserva_invalida "RESERVAR rechaza validez JSON null" '.validez=null'
expect_reserva_invalida "RESERVAR rechaza fecha_comprobante JSON null" '.fecha_comprobante=null'
expect_reserva_invalida "RESERVAR rechaza fecha_comprobante no string" '.fecha_comprobante=20260822'
expect_reserva_invalida "RESERVAR rechaza snapshot JSON null" '.snapshot=null'
expect_reserva_invalida "RESERVAR rechaza identidad snapshot JSON null" '.snapshot.identidad=null'
expect_reserva_invalida "RESERVAR rechaza scalar de identidad snapshot con tipo incorrecto" '.snapshot.identidad.puntoVenta="995"'
expect_reserva_invalida "RESERVAR rechaza snapshot_hash JSON null" '.snapshot_hash=null'
expect_reserva_invalida "RESERVAR rechaza snapshot_hash no string" '.snapshot_hash=123'
expect_fail_like "expected_version obsoleto levanta error" "versi.n esperada" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000015','RESERVAR','d3000000-0000-0000-0000-000000000015',jsonb_build_object('expected_version',0,'snapshot','$SNAPSHOT'::jsonb,'snapshot_hash','$SNAPSHOT_HASH','numero_propuesto',1,'fecha_comprobante','2026-08-22','emisor_cuit','30900000150','punto_venta',995,'cbte_tipo',1,'modo','PRODUCCION','simulado',false,'validez','PRODUCCION','ultimo_remoto',0,'ultimo_local_observado',0));"
expect_fail_like "un token ajeno levanta error" "token.*no coincide" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000015','RESERVAR','d3000000-0000-0000-0000-000000000099',jsonb_build_object('expected_version',1,'snapshot','$SNAPSHOT'::jsonb,'snapshot_hash','$SNAPSHOT_HASH','numero_propuesto',1,'fecha_comprobante','2026-08-22','emisor_cuit','30900000150','punto_venta',995,'cbte_tipo',1,'modo','PRODUCCION','simulado',false,'validez','PRODUCCION','ultimo_remoto',0,'ultimo_local_observado',0));"
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
crear_snapshot 1 30900000010 990 1 PRODUCCION false 30714199664 'RECEPTOR UNO' 1210.00
snapshot_uno="$SNAPSHOT"; hash_uno="$SNAPSHOT_HASH"
crear_snapshot 1 30900000010 990 1 PRODUCCION false 30717322467 'RECEPTOR DOS' 1210.00
snapshot_dos="$SNAPSHOT"; hash_dos="$SNAPSHOT_HASH"

reservar 'c3000000-0000-0000-0000-000000000002' 'd3000000-0000-0000-0000-000000000022' 1 1 30900000010 990 1 PRODUCCION false PRODUCCION 0 0 "$snapshot_uno" "$hash_uno" >"$TMP_DIR/reserva-uno.out" 2>&1 &
pid_reserva_uno=$!
reservar 'c3000000-0000-0000-0000-000000000003' 'd3000000-0000-0000-0000-000000000023' 1 1 30900000010 990 1 PRODUCCION false PRODUCCION 0 0 "$snapshot_dos" "$hash_dos" >"$TMP_DIR/reserva-dos.out" 2>&1 &
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

crear_snapshot 1 30900000029 990 1 PRODUCCION false 30714199664 'CUIT DISTINTO' 1210.00
reservar 'c3000000-0000-0000-0000-000000000005' 'd3000000-0000-0000-0000-000000000005' 1 1 30900000029 990 1 PRODUCCION false PRODUCCION 0 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
crear_snapshot 1 30900000010 990 1 HOMOLOGACION false 30714199664 'MODO DISTINTO' 1210.00
reservar 'c3000000-0000-0000-0000-000000000006' 'd3000000-0000-0000-0000-000000000006' 1 1 30900000010 990 1 HOMOLOGACION false HOMOLOGACION 0 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
crear_snapshot 1 30900000010 990 1 PRODUCCION true 30714199664 'SIMULADA UNO' 1210.00
reservar 'c3000000-0000-0000-0000-000000000007' 'd3000000-0000-0000-0000-000000000007' 1 1 30900000010 990 1 PRODUCCION true SIMULADA 987654 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
check "CUIT, modo y simulación separan secuencias aun con número 1" "4" \
  "$(q "SELECT count(*) FROM public.ventas WHERE afip_numero=1 AND afip_punto_venta=990 AND id::text LIKE 'c3000000-0000-0000-0000-%'")"

crear_snapshot 2 30900000010 990 1 PRODUCCION true 30714199664 'SIMULADA DOS' 1210.00
reservar 'c3000000-0000-0000-0000-000000000008' 'd3000000-0000-0000-0000-000000000008' 1 2 30900000010 990 1 PRODUCCION true SIMULADA 0 1 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
check "dos simuladas secuenciales usan números locales 1 y 2" "1|2" \
  "$(q "SELECT min(afip_numero)||'|'||max(afip_numero) FROM public.ventas WHERE afip_emisor_cuit='30900000010' AND afip_punto_venta=990 AND afip_cbte_tipo=1 AND afip_modo='PRODUCCION' AND afip_simulado")"

crear_snapshot 3 30900000010 990 1 PRODUCCION false 30714199664 'NUMERO INCORRECTO' 1210.00
expect_fail_like "la numeración real exige ultimo_remoto + 1" "numero_propuesto.*ultimo_remoto" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000016','RESERVAR','d3000000-0000-0000-0000-000000000016',jsonb_build_object('expected_version',1,'snapshot','$SNAPSHOT'::jsonb,'snapshot_hash','$SNAPSHOT_HASH','numero_propuesto',3,'fecha_comprobante','2026-08-22','emisor_cuit','30900000010','punto_venta',990,'cbte_tipo',1,'modo','PRODUCCION','simulado',false,'validez','PRODUCCION','ultimo_remoto',1,'ultimo_local_observado',1));"
crear_snapshot 1 30900000010 990 1 PRODUCCION false 30714199664 'LOCAL ADELANTADO' 1210.00
check_sql "reserva ajena activa libera el claim y deja un conflicto reintentable" \
  $'ERROR_CORREGIBLE||||2\nIDENTIDAD_FISCAL_OCUPADA|1|0' \
  "SELECT afip_estado||'|'||coalesce(afip_fase,'')||'|'||coalesce(afip_claim_token::text,'')||'|'||coalesce(afip_numero::text,'')||'|'||afip_version FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000016','RESERVAR','d3000000-0000-0000-0000-000000000016',jsonb_build_object('expected_version',1,'snapshot','$SNAPSHOT'::jsonb,'snapshot_hash','$SNAPSHOT_HASH','numero_propuesto',1,'fecha_comprobante','2026-08-22','emisor_cuit','30900000010','punto_venta',990,'cbte_tipo',1,'modo','PRODUCCION','simulado',false,'validez','PRODUCCION','ultimo_remoto',0,'ultimo_local_observado',1)); SELECT resultado||'|'||(respuesta_resumen#>>'{diagnostico,maximo_local}')||'|'||(respuesta_resumen#>>'{diagnostico,ultimo_remoto}') FROM public.emision_fiscal_intentos WHERE venta_id='c3000000-0000-0000-0000-000000000016';"

crear_snapshot 1 30900000150 995 1 PRODUCCION false 30714199664 'HASH MALO' 1210.00
expect_fail_like "la reserva no confía en un hash del cliente" "hash.*(no coincide|inválido)" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000015','RESERVAR','d3000000-0000-0000-0000-000000000015',jsonb_build_object('expected_version',1,'snapshot',jsonb_set('$SNAPSHOT'::jsonb,'{hash}','\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\"'::jsonb),'snapshot_hash','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','numero_propuesto',1,'fecha_comprobante','2026-08-22','emisor_cuit','30900000150','punto_venta',995,'cbte_tipo',1,'modo','PRODUCCION','simulado',false,'validez','PRODUCCION','ultimo_remoto',0,'ultimo_local_observado',0));"

echo
echo "== Durabilidad, incertidumbre y reenvío seguro =="
claim 'c3000000-0000-0000-0000-000000000004' 'd3000000-0000-0000-0000-000000000004' >/dev/null
crear_snapshot 1 30900000045 994 1 PRODUCCION false 30714199664 'RECEPTOR INMUTABLE' 1210.00
hash_reenvio="$SNAPSHOT_HASH"
reservar 'c3000000-0000-0000-0000-000000000004' 'd3000000-0000-0000-0000-000000000004' 1 1 30900000045 994 1 PRODUCCION false PRODUCCION 0 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
identity_before="$(q "SELECT concat_ws('|',afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,afip_simulado,afip_fecha_comprobante,afip_imp_total,afip_snapshot::text,afip_snapshot_hash) FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000004'")"
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','REQUEST_INICIADO','d3000000-0000-0000-0000-000000000004','{\"expected_version\":2}'::jsonb);" >/dev/null
check "REQUEST_INICIADO queda durable en una conexión nueva" \
  "EMITIENDO|REQUEST_INICIADO|REQUEST_INICIADO|3" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_fase||'|'||i.fase||'|'||v.afip_version FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id AND i.claim_token=v.afip_claim_token WHERE v.id='c3000000-0000-0000-0000-000000000004'")"
check_sql "evidencia enviada no se convierte ciegamente en error liberable" \
  "RECONCILIAR|REQUEST_INICIADO|1|4|true" \
  "BEGIN; SELECT afip_estado||'|'||afip_fase||'|'||afip_numero||'|'||afip_version||'|'||(afip_claim_token IS NOT NULL) FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','ERROR_CORREGIBLE','d3000000-0000-0000-0000-000000000004','{\"expected_version\":3,\"error_clase\":\"TIMEOUT\",\"error_codigo\":\"T1\",\"error_fase\":\"REQUEST\",\"mensaje_mascarado\":\"timeout\",\"liberar_identidad\":true}'::jsonb); ROLLBACK;"
expect_fail_like "LIBERAR está prohibido desde REQUEST_INICIADO" "LIBERAR.*REQUEST_INICIADO" \
  "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','LIBERAR','d3000000-0000-0000-0000-000000000004','{\"expected_version\":3,\"verificacion\":{\"nunca_enviado\":true}}'::jsonb);"
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','RECONCILIAR','d3000000-0000-0000-0000-000000000004','{\"expected_version\":3,\"error_clase\":\"TRANSPORTE\",\"error_codigo\":\"TIMEOUT\",\"error_fase\":\"REQUEST_INICIADO\",\"mensaje_mascarado\":\"sin respuesta\"}'::jsonb);" >/dev/null
expect_reenvio_invalido() {
  local name="$1" resumen="$2" ultimo="$3"
  local hash_sql="'$hash_reenvio'"
  [[ "$#" -ge 4 ]] && hash_sql="$4"
  expect_fail_like "$name" "REENVIO_VERIFICADO.*(ausencia|resumen)|ultimo_remoto|payload_hash" \
    "BEGIN; SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','REENVIO_VERIFICADO','d3000000-0000-0000-0000-000000000004',jsonb_build_object('expected_version',4,'nuevo_claim_token','d3000000-0000-0000-0000-000000000044','ultimo_remoto',$ultimo,'respuesta_resumen','$resumen'::jsonb,'payload_hash',$hash_sql)); ROLLBACK;"
}
expect_reenvio_invalido "REENVIO_VERIFICADO rechaza ausencia faltante" '{"tipo":"CONSULTA_ARCA","resultado":"AUSENTE","fuente":"FECompConsultar","observaciones":[]}' '0'
expect_reenvio_invalido "REENVIO_VERIFICADO rechaza ausencia JSON null" '{"tipo":"CONSULTA_ARCA","resultado":"AUSENTE","fuente":"FECompConsultar","ausencia_confirmada":null,"observaciones":[]}' '0'
expect_reenvio_invalido "REENVIO_VERIFICADO rechaza ausencia string" '{"tipo":"CONSULTA_ARCA","resultado":"AUSENTE","fuente":"FECompConsultar","ausencia_confirmada":"true","observaciones":[]}' '0'
expect_reenvio_invalido "REENVIO_VERIFICADO rechaza ausencia false" '{"tipo":"CONSULTA_ARCA","resultado":"AUSENTE","fuente":"FECompConsultar","ausencia_confirmada":false,"observaciones":[]}' '0'
expect_reenvio_invalido "REENVIO_VERIFICADO rechaza ultimo_remoto JSON null" '{"tipo":"CONSULTA_ARCA","resultado":"AUSENTE","fuente":"FECompConsultar","ausencia_confirmada":true,"observaciones":[]}' 'NULL'
expect_reenvio_invalido "REENVIO_VERIFICADO rechaza ultimo_remoto string" '{"tipo":"CONSULTA_ARCA","resultado":"AUSENTE","fuente":"FECompConsultar","ausencia_confirmada":true,"observaciones":[]}' "'0'"
expect_reenvio_invalido "REENVIO_VERIFICADO rechaza payload_hash JSON null" '{"tipo":"CONSULTA_ARCA","resultado":"AUSENTE","fuente":"FECompConsultar","ausencia_confirmada":true,"observaciones":[]}' '0' NULL
expect_reenvio_invalido "REENVIO_VERIFICADO rechaza payload_hash distinto" '{"tipo":"CONSULTA_ARCA","resultado":"AUSENTE","fuente":"FECompConsultar","ausencia_confirmada":true,"observaciones":[]}' '0' "'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'"
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','REENVIO_VERIFICADO','d3000000-0000-0000-0000-000000000004',jsonb_build_object('expected_version',4,'nuevo_claim_token','d3000000-0000-0000-0000-000000000044','ultimo_remoto',0,'respuesta_resumen',jsonb_build_object('tipo','CONSULTA_ARCA','resultado','AUSENTE','fuente','FECompConsultar','ausencia_confirmada',true,'observaciones',jsonb_build_array()),'payload_hash','$hash_reenvio'));" >/dev/null
identity_after="$(q "SELECT concat_ws('|',afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,afip_simulado,afip_fecha_comprobante,afip_imp_total,afip_snapshot::text,afip_snapshot_hash) FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000004'")"
check "REENVIO_VERIFICADO rota claim y vuelve a RESERVADO" \
  "EMITIENDO|RESERVADO|d3000000-0000-0000-0000-000000000044|5|2" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_fase||'|'||v.afip_claim_token||'|'||v.afip_version||'|'||count(i.id) FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='c3000000-0000-0000-0000-000000000004' GROUP BY v.id")"
check "el reenvío preserva emisor, PV, número, fecha, monto, receptor, snapshot y hash" \
  "$identity_before" "$identity_after"
check "la ausencia ARCA queda auditada antes de rotar" "AUSENCIA_ARCA_VERIFICADA|true" \
  "$(q "SELECT resultado||'|'||(respuesta_resumen#>>'{evidencia_externa,consulta_reenvio,ausencia_confirmada}') FROM public.emision_fiscal_intentos WHERE venta_id='c3000000-0000-0000-0000-000000000004' AND claim_token='d3000000-0000-0000-0000-000000000004'")"
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000004','REQUEST_INICIADO','d3000000-0000-0000-0000-000000000044','{\"expected_version\":5}'::jsonb);" >/dev/null
check "el reenvío verificado reutiliza la transición REQUEST normal" "REQUEST_INICIADO|6" \
  "$(q "SELECT afip_fase||'|'||afip_version FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000004'")"

echo
echo "== Resultado, rechazo, liberación, cancelación y bloqueo =="
claim 'c3000000-0000-0000-0000-000000000009' 'd3000000-0000-0000-0000-000000000009' >/dev/null
crear_snapshot 1 30900000096 999 1 PRODUCCION false 30714199664 'APROBADA' 1210.00
reservar 'c3000000-0000-0000-0000-000000000009' 'd3000000-0000-0000-0000-000000000009' 1 1 30900000096 999 1 PRODUCCION false PRODUCCION 0 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000009','REQUEST_INICIADO','d3000000-0000-0000-0000-000000000009','{\"expected_version\":2}'::jsonb);" >/dev/null
expect_resumen_invalido() {
  local name="$1" resumen_sql="$2"
  expect_fail_like "$name" "respuesta_resumen.*(esquema|enmascarado|permitid|tipo|tama.o)" \
    "BEGIN; SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000009','RESPUESTA_RECIBIDA','d3000000-0000-0000-0000-000000000009',jsonb_build_object('expected_version',3,'respuesta_resumen',$resumen_sql)); ROLLBACK;"
}
resumen_aprobado="jsonb_build_object('tipo','EMISION','resultado','A','fuente','FECAESolicitar','rechazo_confirmado',false,'observaciones',jsonb_build_array())"
expect_resumen_invalido "el resumen no puede sobrescribir lease_segundos" "$resumen_aprobado||jsonb_build_object('lease_segundos',999999)"
expect_resumen_invalido "el resumen rechaza claves desconocidas" "$resumen_aprobado||jsonb_build_object('detalle_inocente','x')"
expect_resumen_invalido "el resumen rechaza XML/raw bajo una clave permitida" "$resumen_aprobado||jsonb_build_object('mensaje','<soap>Authorization secret</soap>')"
expect_resumen_invalido "el resumen rechaza secretos bajo una clave permitida" "$resumen_aprobado||jsonb_build_object('mensaje','Bearer token=abc')"
expect_resumen_invalido "el resumen rechaza tipo incorrecto" "$resumen_aprobado||jsonb_build_object('codigo',jsonb_build_array('100'))"
expect_resumen_invalido "el resumen limita escalares" "$resumen_aprobado||jsonb_build_object('mensaje',pg_catalog.repeat('x',513))"
expect_resumen_invalido "el resumen exige observaciones array" "$resumen_aprobado||jsonb_build_object('observaciones','no-array')"
expect_resumen_invalido "el resumen limita cantidad de observaciones" "$resumen_aprobado||jsonb_build_object('observaciones',(SELECT jsonb_agg(n::text) FROM generate_series(1,11) n))"
expect_resumen_invalido "el resumen limita cada observación" "$resumen_aprobado||jsonb_build_object('observaciones',jsonb_build_array(pg_catalog.repeat('x',257)))"
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000009','RESPUESTA_RECIBIDA','d3000000-0000-0000-0000-000000000009',jsonb_build_object('expected_version',3,'respuesta_resumen',$resumen_aprobado));" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000009','APROBAR','d3000000-0000-0000-0000-000000000009','{\"expected_version\":4,\"cae\":\"CAE-T3-0001\",\"cae_vencimiento\":\"2026-09-01\",\"emitido_at\":\"2026-08-22T15:00:00Z\"}'::jsonb);" >/dev/null
check "RESPUESTA_RECIBIDA y APROBAR persisten resultado y CAE" \
  "APROBADO|PERSISTIDO|CAE-T3-0001|5|PERSISTIDO|APROBADO" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_fase||'|'||v.cae||'|'||v.afip_version||'|'||i.fase||'|'||i.resultado FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='c3000000-0000-0000-0000-000000000009'")"
check "la evidencia externa no sobrescribe el control interno del lease" "300|EMISION|A" \
  "$(q "SELECT (respuesta_resumen#>>'{control,lease_segundos}')||'|'||(respuesta_resumen#>>'{evidencia_externa,respuesta_emision,tipo}')||'|'||(respuesta_resumen#>>'{evidencia_externa,respuesta_emision,resultado}') FROM public.emision_fiscal_intentos WHERE venta_id='c3000000-0000-0000-0000-000000000009'")"

claim 'c3000000-0000-0000-0000-000000000010' 'd3000000-0000-0000-0000-000000000010' >/dev/null
crear_snapshot 1 30900000109 998 1 PRODUCCION false 30714199664 'RECHAZADA' 1210.00
reservar 'c3000000-0000-0000-0000-000000000010' 'd3000000-0000-0000-0000-000000000010' 1 1 30900000109 998 1 PRODUCCION false PRODUCCION 0 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000010','REQUEST_INICIADO','d3000000-0000-0000-0000-000000000010','{\"expected_version\":2}'::jsonb);" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000010','RESPUESTA_RECIBIDA','d3000000-0000-0000-0000-000000000010',jsonb_build_object('expected_version',3,'respuesta_resumen',jsonb_build_object('tipo','EMISION','resultado','R','fuente','FECAESolicitar','rechazo_confirmado',true,'observaciones',jsonb_build_array())));" >/dev/null
check_rechazo_no_confirmado() {
  local name="$1" evidencia_sql="$2" liberar="${3:-true}"
  local metadata_ajena="'{}'::jsonb"
  [[ "$#" -ge 4 ]] && metadata_ajena="$4"
  check_sql "$name" \
    $'RECONCILIAR|RESPUESTA_RECIBIDA|1|5\nRECONCILIAR|1|'"$SNAPSHOT_HASH"$'|true' \
    "BEGIN; UPDATE public.emision_fiscal_intentos SET respuesta_resumen=jsonb_build_object('control',jsonb_build_object('lease_segundos',300),'evidencia_externa',jsonb_build_object('respuesta_emision',$evidencia_sql))||$metadata_ajena WHERE venta_id='c3000000-0000-0000-0000-000000000010' AND claim_token='d3000000-0000-0000-0000-000000000010'; SELECT afip_estado||'|'||afip_fase||'|'||afip_numero||'|'||afip_version FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000010','ERROR_CORREGIBLE','d3000000-0000-0000-0000-000000000010',jsonb_build_object('expected_version',4,'error_clase','RECHAZO','error_codigo','100','error_fase','RESPUESTA_RECIBIDA','mensaje_mascarado','rechazo no confirmado','liberar_identidad',$liberar)); SELECT resultado||'|'||numero_reservado||'|'||payload_hash||'|'||(respuesta_resumen ? 'evidencia_externa') FROM public.emision_fiscal_intentos WHERE venta_id='c3000000-0000-0000-0000-000000000010' AND claim_token='d3000000-0000-0000-0000-000000000010'; ROLLBACK;"
}
check_rechazo_no_confirmado "rechazo faltante se desvía a RECONCILIAR y conserva identidad" \
  "jsonb_build_object('tipo','EMISION','resultado','R','fuente','FECAESolicitar','observaciones',jsonb_build_array())"
check_rechazo_no_confirmado "rechazo JSON null se desvía a RECONCILIAR y conserva identidad" \
  "jsonb_build_object('tipo','EMISION','resultado','R','fuente','FECAESolicitar','rechazo_confirmado',NULL,'observaciones',jsonb_build_array())"
check_rechazo_no_confirmado "rechazo false se desvía a RECONCILIAR y conserva identidad" \
  "jsonb_build_object('tipo','EMISION','resultado','R','fuente','FECAESolicitar','rechazo_confirmado',false,'observaciones',jsonb_build_array())"
check_rechazo_no_confirmado "rechazo con tipo incorrecto se desvía a RECONCILIAR y conserva identidad" \
  "jsonb_build_object('tipo','EMISION','resultado','R','fuente','FECAESolicitar','rechazo_confirmado','true','observaciones',jsonb_build_array())"
check_rechazo_no_confirmado "rechazo no confirmado nunca sale de conciliación aunque no pidan liberar" \
  "jsonb_build_object('tipo','EMISION','resultado','R','fuente','FECAESolicitar','rechazo_confirmado',false,'observaciones',jsonb_build_array())" false
check_rechazo_no_confirmado "metadata top-level no puede falsear el rechazo externo" \
  "jsonb_build_object('tipo','EMISION','resultado','R','fuente','FECAESolicitar','observaciones',jsonb_build_array())" true \
  "jsonb_build_object('rechazo_confirmado',true,'lease_segundos',999999)"
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000010','ERROR_CORREGIBLE','d3000000-0000-0000-0000-000000000010','{\"expected_version\":4,\"error_clase\":\"RECHAZO\",\"error_codigo\":\"100\",\"error_fase\":\"RESPUESTA_RECIBIDA\",\"mensaje_mascarado\":\"rechazo validado\",\"liberar_identidad\":true}'::jsonb);" >/dev/null
check "rechazo confirmado puede liberar identidad sin borrar auditoría" \
  "ERROR_CORREGIBLE|||||5|1|ERROR_CORREGIBLE" \
  "$(q "SELECT v.afip_estado||'|'||coalesce(v.afip_claim_token::text,'')||'|'||coalesce(v.afip_numero::text,'')||'|'||coalesce(v.afip_snapshot_hash,'')||'|'||coalesce(v.afip_fecha_comprobante::text,'')||'|'||v.afip_version||'|'||count(i.id)||'|'||max(i.resultado) FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='c3000000-0000-0000-0000-000000000010' GROUP BY v.id")"

claim 'c3000000-0000-0000-0000-000000000011' 'd3000000-0000-0000-0000-000000000011' 0 1 >/dev/null
q "SELECT pg_sleep(1.1)" >/dev/null
expect_liberar_invalido() {
  local name="$1" verificacion_sql="$2" preparacion="${3:-}"
  expect_fail_like "$name" "LIBERAR|evidencia de env.o|verificaci.n" \
    "BEGIN; $preparacion SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000011','LIBERAR','d3000000-0000-0000-0000-000000000011',jsonb_build_object('expected_version',1,'verificacion',$verificacion_sql)); ROLLBACK;"
}
expect_liberar_invalido "LIBERAR rechaza nunca_enviado faltante" "jsonb_build_object('fuente','log_intento')"
expect_liberar_invalido "LIBERAR rechaza nunca_enviado JSON null" "jsonb_build_object('nunca_enviado',NULL,'fuente','log_intento')"
expect_liberar_invalido "LIBERAR rechaza nunca_enviado false" "jsonb_build_object('nunca_enviado',false,'fuente','log_intento')"
expect_liberar_invalido "LIBERAR rechaza nunca_enviado string" "jsonb_build_object('nunca_enviado','true','fuente','log_intento')"
expect_liberar_invalido "LIBERAR rechaza fuente de verificación inesperada" "jsonb_build_object('nunca_enviado',true,'fuente','otra')"
expect_liberar_invalido "LIBERAR rechaza resultado de intento fuera de whitelist" \
  "jsonb_build_object('nunca_enviado',true,'fuente','log_intento')" \
  "UPDATE public.emision_fiscal_intentos SET resultado='ERROR_PREFLIGHT' WHERE venta_id='c3000000-0000-0000-0000-000000000011';"
expect_liberar_invalido "LIBERAR rechaza resultado de intento SQL NULL" \
  "jsonb_build_object('nunca_enviado',true,'fuente','log_intento')" \
  "UPDATE public.emision_fiscal_intentos SET resultado=NULL WHERE venta_id='c3000000-0000-0000-0000-000000000011';"
expect_liberar_invalido "LIBERAR rechaza combinación fase/resultado incoherente" \
  "jsonb_build_object('nunca_enviado',true,'fuente','log_intento')" \
  "UPDATE public.emision_fiscal_intentos SET fase='RESERVADO',resultado='RECLAMADO' WHERE venta_id='c3000000-0000-0000-0000-000000000011';"
expect_liberar_invalido "LIBERAR rechaza toda evidencia de request" \
  "jsonb_build_object('nunca_enviado',true,'fuente','log_intento')" \
  "UPDATE public.emision_fiscal_intentos SET respuesta_resumen=jsonb_set(respuesta_resumen,'{evidencia_externa}',jsonb_build_object('tipo','EMISION'),true) WHERE venta_id='c3000000-0000-0000-0000-000000000011';"
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000011','LIBERAR','d3000000-0000-0000-0000-000000000011','{\"expected_version\":1,\"verificacion\":{\"nunca_enviado\":true,\"fuente\":\"log_intento\"}}'::jsonb);" >/dev/null
check "LIBERAR exige lease vencido y evidencia nunca-enviado" \
  "ERROR_CORREGIBLE||2|LIBERADO|true" \
  "$(q "SELECT v.afip_estado||'|'||coalesce(v.afip_claim_token::text,'')||'|'||v.afip_version||'|'||i.resultado||'|'||(i.respuesta_resumen#>>'{verificacion_liberacion,nunca_enviado}') FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='c3000000-0000-0000-0000-000000000011'")"

q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000012','CANCELAR',NULL,'{\"expected_version\":0}'::jsonb);" >/dev/null
check "CANCELAR sólo sin claim/request/número deja CANCELADO" "CANCELADO||1" \
  "$(q "SELECT afip_estado||'|'||coalesce(afip_claim_token::text,'')||'|'||afip_version FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000012'")"

claim 'c3000000-0000-0000-0000-000000000013' 'd3000000-0000-0000-0000-000000000013' >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal('c3000000-0000-0000-0000-000000000013','BLOQUEAR','d3000000-0000-0000-0000-000000000013','{\"expected_version\":1,\"error_clase\":\"DIVERGENCIA\",\"error_codigo\":\"D1\",\"error_fase\":\"PREFLIGHT\",\"mensaje_mascarado\":\"requiere admin\",\"diferencias\":{\"receptor\":true}}'::jsonb);" >/dev/null
check "BLOQUEAR conserva evidencia y exige revisión" \
  "BLOQUEADO|DIVERGENCIA|D1|PREFLIGHT|2|BLOQUEADO|true" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_error_clase||'|'||v.afip_error_codigo||'|'||v.afip_error_fase||'|'||v.afip_version||'|'||i.resultado||'|'||(i.respuesta_resumen#>>'{diagnostico,diferencias,receptor}') FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id WHERE v.id='c3000000-0000-0000-0000-000000000013'")"

echo
echo "== Task 9: lectura exacta y recuperación de CAE =="

"${PSQL[@]}" >/dev/null <<'SQL'
UPDATE public.ventas
   SET subtotal_sin_iva=0.15,
       iva_total=0.03,
       percepciones=0.00,
       total=0.18,
       total_pagado=0.10
 WHERE id='c3000000-0000-0000-0000-000000000040';
INSERT INTO public.venta_items (
  id,venta_id,producto_id,codigo,descripcion,cantidad,
  precio_unitario_sin_iva,descuento_porcentaje,iva_porcentaje,
  subtotal_sin_iva,iva_monto,subtotal_con_iva
) VALUES (
  'e3000000-0000-0000-0000-000000000040',
  'c3000000-0000-0000-0000-000000000040',NULL,
  'DERIVA-IEEE','Importe exacto PostgreSQL',0.02,7.25,0.00,21.00,
  0.15,0.03,0.18
);
SQL

check_sql "la lectura exacta devuelve strings canónicos y no la deriva IEEE-754" \
  "0.15|0.03|0.00|0.18|0.10|0.08|0.02|7.25|0.00|21.00|0.15|0.03|0.18" \
  "SELECT concat_ws('|',
     fiscal#>>'{venta,subtotalSinIva}',fiscal#>>'{venta,ivaTotal}',
     fiscal#>>'{venta,percepciones}',fiscal#>>'{venta,total}',
     fiscal#>>'{venta,totalPagado}',fiscal#>>'{venta,saldo}',
     fiscal#>>'{items,0,cantidad}',fiscal#>>'{items,0,precioUnitarioSinIva}',
     fiscal#>>'{items,0,descuentoPorcentaje}',fiscal#>>'{items,0,ivaPorcentaje}',
     fiscal#>>'{items,0,subtotalNeto}',fiscal#>>'{items,0,importeIva}',
     fiscal#>>'{items,0,subtotalTotal}')
   FROM (SELECT public.leer_venta_fiscal_exacta(
     'c3000000-0000-0000-0000-000000000040'
   ) AS fiscal) AS exacta;"

check_sql "la lectura exacta tiene una sola firma SECURITY INVOKER y search_path fijo" \
  "1|false|true" \
  "SELECT count(*)||'|'||bool_or(p.prosecdef)::text||'|'||bool_and(array_to_string(p.proconfig,',') LIKE 'search_path=%')::text
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='leer_venta_fiscal_exacta'
      AND pg_get_function_identity_arguments(p.oid)='p_venta_id uuid';"

check_sql "sólo service_role ejecuta la lectura fiscal exacta" \
  "false|false|false|true" \
  "SELECT has_function_privilege('public','public.leer_venta_fiscal_exacta(uuid)','execute')::text||'|'||
          has_function_privilege('anon','public.leer_venta_fiscal_exacta(uuid)','execute')::text||'|'||
          has_function_privilege('authenticated','public.leer_venta_fiscal_exacta(uuid)','execute')::text||'|'||
          has_function_privilege('service_role','public.leer_venta_fiscal_exacta(uuid)','execute')::text;"

claim 'c3000000-0000-0000-0000-000000000027' \
  'd3000000-0000-0000-0000-000000000027' >/dev/null
crear_snapshot 1 30714199664 927 1 PRODUCCION false 30714199664 \
  'RECUPERACION EXACTA' 1210.00
hash_recuperacion="$SNAPSHOT_HASH"
snapshot_recuperacion="$SNAPSHOT"
reservar 'c3000000-0000-0000-0000-000000000027' \
  'd3000000-0000-0000-0000-000000000027' 1 1 30714199664 927 1 \
  PRODUCCION false PRODUCCION 0 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal(
  'c3000000-0000-0000-0000-000000000027','REQUEST_INICIADO',
  'd3000000-0000-0000-0000-000000000027','{\"expected_version\":2}'::jsonb);" >/dev/null
q_sr "SELECT * FROM public.transicionar_emision_fiscal(
  'c3000000-0000-0000-0000-000000000027','RECONCILIAR',
  'd3000000-0000-0000-0000-000000000027',
  '{\"expected_version\":3,\"error_clase\":\"TRANSPORTE\",\"error_codigo\":\"TIMEOUT\",\"error_fase\":\"REQUEST_INICIADO\",\"mensaje_mascarado\":\"respuesta incierta\"}'::jsonb);" >/dev/null

resumen_recuperacion='{"tipo":"CONSULTA_ARCA","resultado":"COINCIDE","fuente":"FECompConsultar","coincidencia_completa":true,"observaciones":[]}'
payload_recuperacion="jsonb_build_object(
  'expected_version',4,'cae','74123456789012','cae_vencimiento',NULL,
  'payload_hash','$hash_recuperacion','respuesta_resumen','$resumen_recuperacion'::jsonb
)"

expect_fail_like "RECUPERAR_CAE conserva APROBAR cerrado desde RECONCILIAR" \
  "APROBAR exige respuesta|APROBAR.*respuesta" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    'c3000000-0000-0000-0000-000000000027','APROBAR',
    'd3000000-0000-0000-0000-000000000027',
    '{\"expected_version\":4,\"cae\":\"74123456789012\",\"cae_vencimiento\":\"2026-09-01\",\"emitido_at\":\"2026-08-22T15:00:00Z\"}'::jsonb);"

expect_fail_like "RECUPERAR_CAE rechaza claves desconocidas" \
  "Clave.*no permitida" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    'c3000000-0000-0000-0000-000000000027','RECUPERAR_CAE',
    'd3000000-0000-0000-0000-000000000027',$payload_recuperacion||jsonb_build_object('emitido_at','2026-08-22T15:00:00Z'));"
expect_fail_like "RECUPERAR_CAE exige todas las claves" \
  "Faltan claves.*cae_vencimiento" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    'c3000000-0000-0000-0000-000000000027','RECUPERAR_CAE',
    'd3000000-0000-0000-0000-000000000027',$payload_recuperacion-'cae_vencimiento');"
expect_fail_like "RECUPERAR_CAE rechaza CAE no textual o no canónico" \
  "CAE.*14" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    'c3000000-0000-0000-0000-000000000027','RECUPERAR_CAE',
    'd3000000-0000-0000-0000-000000000027',$payload_recuperacion||jsonb_build_object('cae',74123456789012));"
expect_fail_like "RECUPERAR_CAE rechaza vencimiento JSON de tipo incorrecto" \
  "cae_vencimiento.*null.*string|vencimiento.*tipo" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    'c3000000-0000-0000-0000-000000000027','RECUPERAR_CAE',
    'd3000000-0000-0000-0000-000000000027',$payload_recuperacion||jsonb_build_object('cae_vencimiento',20260831));"
expect_fail_like "RECUPERAR_CAE rechaza fecha inexistente" \
  "cae_vencimiento.*fecha válida|vencimiento.*fecha válida" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    'c3000000-0000-0000-0000-000000000027','RECUPERAR_CAE',
    'd3000000-0000-0000-0000-000000000027',$payload_recuperacion||jsonb_build_object('cae_vencimiento','2026-02-30'));"
expect_fail_like "RECUPERAR_CAE rechaza hash distinto" \
  "payload_hash.*(coincide|identidad)|hash.*coincide" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    'c3000000-0000-0000-0000-000000000027','RECUPERAR_CAE',
    'd3000000-0000-0000-0000-000000000027',$payload_recuperacion||jsonb_build_object('payload_hash',repeat('f',64)));"
expect_fail_like "RECUPERAR_CAE exige resumen exacto sin claves opcionales" \
  "resumen.*(exacto|literal|inválido)" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    'c3000000-0000-0000-0000-000000000027','RECUPERAR_CAE',
    'd3000000-0000-0000-0000-000000000027',$payload_recuperacion||jsonb_build_object(
      'respuesta_resumen','$resumen_recuperacion'::jsonb||jsonb_build_object('codigo','602')));"
expect_fail_like "RECUPERAR_CAE exige observaciones exactamente vacías" \
  "resumen.*(exacto|observaciones|inválido)" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    'c3000000-0000-0000-0000-000000000027','RECUPERAR_CAE',
    'd3000000-0000-0000-0000-000000000027',$payload_recuperacion||jsonb_build_object(
      'respuesta_resumen',jsonb_set('$resumen_recuperacion'::jsonb,'{observaciones}','[\"x\"]'::jsonb)));"
expect_fail_like "RECUPERAR_CAE revalida CAS" \
  "Versión esperada" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    'c3000000-0000-0000-0000-000000000027','RECUPERAR_CAE',
    'd3000000-0000-0000-0000-000000000027',$payload_recuperacion||jsonb_build_object('expected_version',3));"
expect_fail_like "RECUPERAR_CAE revalida el token" \
  "token fiscal" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    'c3000000-0000-0000-0000-000000000027','RECUPERAR_CAE',
    'd3000000-0000-0000-0000-000000000099',$payload_recuperacion);"

identidad_recuperacion_antes="$(q "SELECT concat_ws('|',
  afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,
  afip_simulado,afip_validez,afip_fecha_comprobante,afip_imp_total,
  afip_snapshot::text,afip_snapshot_hash,tipo_comprobante,numero_comprobante,
  total,total_pagado,cliente_id,sucursal_id)
 FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000027'")"

check_sql "RECUPERAR_CAE persiste sólo CAE/auditoría y usa reloj del servidor" \
  $'1\nAPROBADO|PERSISTIDO|74123456789012||5|t|PERSISTIDO|RECUPERADO_CAE|COINCIDE|true' \
  "SELECT count(*) FROM public.transicionar_emision_fiscal(
       'c3000000-0000-0000-0000-000000000027','RECUPERAR_CAE',
       'd3000000-0000-0000-0000-000000000027',$payload_recuperacion);
   SELECT concat_ws('|',v.afip_estado,v.afip_fase,v.cae,
          coalesce(v.cae_vencimiento::text,''),v.afip_version,
          (v.afip_emitido_at BETWEEN clock_timestamp()-interval '5 seconds' AND clock_timestamp()+interval '1 second'),
          i.fase,i.resultado,
          coalesce(i.respuesta_resumen#>>'{evidencia_externa,consulta_recuperacion,resultado}',''),
          coalesce(i.respuesta_resumen#>>'{evidencia_externa,consulta_recuperacion,coincidencia_completa}',''))
     FROM public.ventas v
     JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id
      AND i.claim_token='d3000000-0000-0000-0000-000000000027'
    WHERE v.id='c3000000-0000-0000-0000-000000000027';"

identidad_recuperacion_despues="$(q "SELECT concat_ws('|',
  afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,
  afip_simulado,afip_validez,afip_fecha_comprobante,afip_imp_total,
  afip_snapshot::text,afip_snapshot_hash,tipo_comprobante,numero_comprobante,
  total,total_pagado,cliente_id,sucursal_id)
 FROM public.ventas WHERE id='c3000000-0000-0000-0000-000000000027'")"
check "RECUPERAR_CAE no reescribe identidad fiscal ni comercial" \
  "$identidad_recuperacion_antes" "$identidad_recuperacion_despues"
expect_fail_like "RECUPERAR_CAE rechaza una segunda recuperación/auditoría" \
  "Versión esperada|token fiscal|RECUPERAR_CAE.*RECONCILIAR|recuperación.*auditada" \
  "SELECT * FROM public.transicionar_emision_fiscal(
    'c3000000-0000-0000-0000-000000000027','RECUPERAR_CAE',
    'd3000000-0000-0000-0000-000000000027',$payload_recuperacion);"

for suffix in 28 29; do
  venta="c3000000-0000-0000-0000-0000000000${suffix}"
  token="d3000000-0000-0000-0000-0000000000${suffix}"
  claim "$venta" "$token" >/dev/null
  crear_snapshot 1 30714199664 $((900 + suffix)) 1 PRODUCCION false 30714199664 \
    "RECUPERACION CONCURRENTE $suffix" 1210.00
  reservar "$venta" "$token" 1 1 30714199664 $((900 + suffix)) 1 \
    PRODUCCION false PRODUCCION 0 0 "$SNAPSHOT" "$SNAPSHOT_HASH" >/dev/null
  q_sr "SELECT * FROM public.transicionar_emision_fiscal(
    '$venta','REQUEST_INICIADO','$token','{\"expected_version\":2}'::jsonb);" >/dev/null
  q_sr "SELECT * FROM public.transicionar_emision_fiscal(
    '$venta','RECONCILIAR','$token',
    '{\"expected_version\":3,\"error_clase\":\"TRANSPORTE\",\"error_codigo\":\"TIMEOUT\",\"error_fase\":\"REQUEST_INICIADO\",\"mensaje_mascarado\":\"respuesta incierta\"}'::jsonb);" >/dev/null
  if [[ "$suffix" == "28" ]]; then
    hash_concurrente="$SNAPSHOT_HASH"
  fi
done

payload_concurrente="jsonb_build_object(
  'expected_version',4,'cae','74123456789028','cae_vencimiento','2026-09-01',
  'payload_hash','$hash_concurrente','respuesta_resumen','$resumen_recuperacion'::jsonb
)"
for intento in uno dos; do
  "${PSQL[@]}" >"$TMP_DIR/recuperar-${intento}.out" 2>&1 <<SQL &
SET ROLE service_role;
SELECT * FROM public.transicionar_emision_fiscal(
  'c3000000-0000-0000-0000-000000000028','RECUPERAR_CAE',
  'd3000000-0000-0000-0000-000000000028',$payload_concurrente
);
SQL
  if [[ "$intento" == "uno" ]]; then pid_recuperar_uno=$!; else pid_recuperar_dos=$!; fi
done
set +e
wait "$pid_recuperar_uno"; recuperar_uno_status=$?
wait "$pid_recuperar_dos"; recuperar_dos_status=$?
set -e
if [[ "$recuperar_uno_status" -eq 0 && "$recuperar_dos_status" -ne 0 ]] \
   || [[ "$recuperar_uno_status" -ne 0 && "$recuperar_dos_status" -eq 0 ]]; then
  pass "dos RECUPERAR_CAE concurrentes dejan exactamente un ganador"
else
  fail "dos RECUPERAR_CAE concurrentes — estados ${recuperar_uno_status}/${recuperar_dos_status}"
  sed -n '1,20p' "$TMP_DIR/recuperar-uno.out" >&2
  sed -n '1,20p' "$TMP_DIR/recuperar-dos.out" >&2
fi
check "la recuperación concurrente deja un CAE y una sola auditoría inmutable" \
  "APROBADO|PERSISTIDO|74123456789028|5|1|RECUPERADO_CAE" \
  "$(q "SELECT v.afip_estado||'|'||v.afip_fase||'|'||v.cae||'|'||v.afip_version||'|'||
              count(i.respuesta_resumen#>'{evidencia_externa,consulta_recuperacion}')||'|'||max(i.resultado)
          FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id
         WHERE v.id='c3000000-0000-0000-0000-000000000028' GROUP BY v.id")"

echo
echo "── resumen ──────────────────"
printf 'ok: %d   fallas: %d\n' "$ok" "$failures"
[[ "$failures" -eq 0 ]]
