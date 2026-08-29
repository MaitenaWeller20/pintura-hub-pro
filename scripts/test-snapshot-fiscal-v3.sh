#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -X -v ON_ERROR_STOP=1)
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

V3="$({ ./node_modules/.bin/tsx --eval '
  import { readFileSync } from "node:fs";
  import { crearSnapshotFiscalV2, crearSnapshotFiscalV3 } from "./src/lib/fiscal/snapshot.ts";
  const fixture = JSON.parse(readFileSync("test/fixtures/fiscal-snapshot-parity-v2.json", "utf8"));
  fixture.input.items = fixture.input.items.map((item) => ({
    ...item,
    productoId: item.productoId ?? "71000000-0000-4000-8000-000000000102",
  }));
  fixture.input.importeTributos = "0.00";
  fixture.input.importeTotal = "1360.00";
  fixture.input.tributos = [];
  fixture.input.otrosImpuestosNacionalesIndirectos = "0.00";
  const v2 = structuredClone(crearSnapshotFiscalV2((({ hash, version, ...input }) => input)(fixture.input)));
  delete v2.hash;
  delete v2.version;
  delete v2.origen;
  delete v2.comprobanteOriginalId;
  delete v2.cbtesAsoc;
  v2.venta.tipoComprobante = "NOTA_CREDITO";
  v2.identidad.cbteTipo = 8;
  v2.periodoAsoc = { desde: "2026-08-01", hasta: "2026-08-20" };
  v2.notaCredito = {
    modalidad: "DEVOLUCION_PRODUCTOS",
    motivo: "Devolución de productos del período",
  };
  process.stdout.write(JSON.stringify(crearSnapshotFiscalV3(v2)));
'; } 2>"$TMP_DIR/generador.err")"
V2="$(jq -c '.input' test/fixtures/fiscal-snapshot-parity-v2.json)"

q() { "${PSQL[@]}" -qAtc "$1"; }

pass() { printf '✓ %s\n' "$1"; }
fail() { printf '✗ %s\n' "$1" >&2; exit 1; }

check() {
  local name="$1" expected="$2" actual="$3"
  [[ "$actual" == "$expected" ]] && pass "$name" || fail "$name — esperaba '$expected', obtuvo '$actual'"
}

check_sql() {
  local name="$1" expected="$2" sql="$3"
  local output
  output="$(q "$sql")" || fail "$name — la consulta falló"
  check "$name" "$expected" "$output"
}

expect_fail_like() {
  local name="$1" pattern="$2" sql="$3" output="$TMP_DIR/fallo.out"
  set +e
  "${PSQL[@]}" -qAtc "$sql" >"$output" 2>&1
  local status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    fail "$name — la operación fue aceptada"
  elif rg -qi "$pattern" "$output"; then
    pass "$name"
  else
    sed -n '1,30p' "$output" >&2
    fail "$name — falló por otro motivo"
  fi
}

rehash() {
  local filter="$1" body hash
  body="$(jq -cS "$filter | del(.hash)" <<<"$V3")"
  hash="$(printf '%s' "$body" | shasum -a 256 | awk '{print $1}')"
  jq -c --arg hash "$hash" '. + {hash:$hash}' <<<"$body"
}

expect_v3_invalido() {
  local name="$1" filter="$2" pattern="$3" snapshot
  snapshot="$(rehash "$filter")"
  expect_fail_like "$name" "$pattern" \
    "SELECT public.validar_snapshot_fiscal_v3('$snapshot'::jsonb);"
}

snapshot_con_motivo() {
  local motivo="$1" body hash
  body="$(jq -cS --arg motivo "$motivo" '.notaCredito.motivo=$motivo | del(.hash)' <<<"$V3")"
  hash="$(printf '%s' "$body" | shasum -a 256 | awk '{print $1}')"
  jq -c --arg hash "$hash" '. + {hash:$hash}' <<<"$body"
}

expect_v3_valido() {
  local name="$1" snapshot="$2"
  check_sql "$name" "" "SELECT public.validar_snapshot_fiscal_v3('$snapshot'::jsonb);"
}

check_sql "PostgreSQL acepta el snapshot v3 producido por TypeScript" "" \
  "SELECT public.validar_snapshot_fiscal_v3('$V3'::jsonb);"
check_sql "el dispatcher devuelve 3 para v3" "3" \
  "SELECT public.validar_snapshot_fiscal_persistido('$V3'::jsonb);"
check_sql "el dispatcher conserva el fixture v2 sin cambios" "2" \
  "SELECT public.validar_snapshot_fiscal_persistido('$V2'::jsonb);"
check_sql "TypeScript y PostgreSQL calculan el mismo hash v3" "$(jq -r '.hash' <<<"$V3")" \
  "SELECT public.fiscal_snapshot_hash('$V3'::jsonb);"
check "el fixture TypeScript no persiste condición comercial" "false" \
  "$(jq '(.venta | has("condicionVenta"))' <<<"$V3")"

V3_CON_CONDICION="$(rehash '.venta.condicionVenta="CONTADO"')"
expect_fail_like "v3 rechaza condicionVenta aunque el hash sea canónico" "venta|clave" \
  "SELECT public.validar_snapshot_fiscal_v3('$V3_CON_CONDICION'::jsonb);"

expect_fail_like "un byte alterado invalida el hash" "hash" \
  "SELECT public.validar_snapshot_fiscal_v3('$(jq -c '.notaCredito.motivo="Devolución de Productos del período"' <<<"$V3")'::jsonb);"
expect_v3_invalido "rechaza fecha inexistente" '.periodoAsoc.desde="2026-02-30"' 'fecha|período'
expect_v3_invalido "rechaza período invertido" '.periodoAsoc.desde="2026-08-21"' 'período'
expect_v3_invalido "rechaza período posterior a emisión" '.periodoAsoc.hasta="2026-08-23"' 'período|emisión'
expect_v3_invalido "rechaza motivo corto" '.notaCredito.motivo=" abc "' 'motivo'
expect_v3_invalido "rechaza tab/newline corto con whitespace fiscal" '.notaCredito.motivo="\tabc\n"' 'motivo'
expect_v3_invalido "rechaza cuatro code points aunque UTF-16 mida cinco" '.notaCredito.motivo="😀abc"' 'motivo'
expect_v3_valido "acepta exactamente cinco code points" "$(snapshot_con_motivo 'abcde')"
expect_v3_valido "acepta cinco code points con emoji" "$(snapshot_con_motivo '😀abcd')"
expect_v3_valido "acepta motivo de 500 code points" "$(snapshot_con_motivo "$(printf 'a%.0s' {1..500})")"
expect_fail_like "rechaza motivo de 501 code points" "motivo" \
  "SELECT public.validar_snapshot_fiscal_v3('$(snapshot_con_motivo "$(printf 'a%.0s' {1..501})")'::jsonb);"
expect_v3_invalido "rechaza modalidad desconocida" '.notaCredito.modalidad="OTRA"' 'modalidad'
expect_v3_invalido "rechaza tipo que no es NC" '.venta.tipoComprobante="VENTA"' 'NOTA_CREDITO|tipo'
expect_v3_invalido "rechaza CbteTipo no estándar" '.identidad.cbteTipo=7' 'CbteTipo'
expect_v3_invalido "rechaza una clave fiscal inesperada" '.resolucion="REINTEGRO"' 'claves|raíz'
expect_v3_invalido "rechaza una clave fiscal faltante" 'del(.periodoAsoc)' 'claves|raíz'
expect_v3_invalido "rechaza tributos" '.importeTributos="1.00" | .importeTotal="1361.00" | .tributos=[{id:1,descripcion:"Tasa",baseImponible:"100.00",alicuota:"1.00",importe:"1.00"}]' 'tributos'
expect_v3_invalido "devolución exige producto" '.items[0].productoId=null' 'productoId|producto'
expect_v3_invalido "bonificación exige concepto único" '.notaCredito.modalidad="BONIFICACION_AJUSTE"' 'concepto|bonificación'

V3_A="$(rehash '
  .letra="A" | .identidad.cbteTipo=3 | .ivaContenido="0.00" |
  .receptor={
    razonSocial:"CLIENTE RI",domicilio:"Domicilio fiscal 123",
    tipoDocumento:"CUIT",numeroDocumento:"30714199664",docTipoArca:80,
    docNroArca:"30714199664",condicionIva:"RESPONSABLE_INSCRIPTO",
    origen:"MANUAL",origenId:null,verificadoArcaAt:null,condicionIvaReceptorId:1
  }
')"
V3_C="$(rehash '.letra="C" | .identidad.cbteTipo=13 | .emisor.condicionIva="MONOTRIBUTO" | .ivaContenido="0.00"')"
V3_BONIFICACION="$(rehash '
  .notaCredito.modalidad="BONIFICACION_AJUSTE" |
  .items=[(.items[0] | .productoId=null)] |
  .importeNeto="1000.00" | .importeExento="0.00" | .importeNoGravado="0.00" |
  .importeIva="210.00" | .importeTotal="1210.00" |
  .alicuotasIva=[{id:5,baseImponible:"1000.00",importe:"210.00"}] |
  .ivaContenido="210.00"
')"
expect_v3_valido "acepta NC A por período" "$V3_A"
expect_v3_valido "acepta NC B por período" "$V3"
expect_v3_valido "acepta NC C de emisor monotributista" "$V3_C"
expect_v3_valido "acepta bonificación con concepto libre único" "$V3_BONIFICACION"

expect_fail_like "el dispatcher rechaza versiones desconocidas" "versión|version" \
  "SELECT public.validar_snapshot_fiscal_persistido('{\"version\":4}'::jsonb);"

VENTA_FIXTURE_SQL="
  INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
  VALUES ('a5000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','snapshot-v3@test.local','x',now(),now(),now());
  INSERT INTO public.ventas(
    id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
    condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
    estado_pago,estado,afip_estado
  ) SELECT
    'a5000000-0000-4000-8000-000000000002',
    (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
    (SELECT id FROM public.clientes ORDER BY created_at LIMIT 1),
    'a5000000-0000-4000-8000-000000000001','SNAPSHOT-V3-FIXTURE','VENTA',
    'CONTADO',100,21,0,121,121,'PAGADO','ACTIVA','SIN_FACTURAR';"

check_sql "las filas ordinarias con snapshot persistido conservan v2" "2" \
  "BEGIN; $VENTA_FIXTURE_SQL UPDATE public.ventas SET afip_snapshot='$V2'::jsonb,afip_snapshot_hash='$(jq -r '.hash' <<<"$V2")',afip_version=2 WHERE id='a5000000-0000-4000-8000-000000000002'; SELECT afip_snapshot->>'version' FROM public.ventas WHERE id='a5000000-0000-4000-8000-000000000002'; ROLLBACK;"
expect_fail_like "una fila ordinaria rechaza snapshot v3" "ck_ventas_afip_snapshot_coherente" \
  "BEGIN; $VENTA_FIXTURE_SQL UPDATE public.ventas SET afip_snapshot='$V3'::jsonb,afip_snapshot_hash='$(jq -r '.hash' <<<"$V3")',afip_version=2 WHERE id='a5000000-0000-4000-8000-000000000002'; ROLLBACK;"

NC_PERIODO_SQL="
  UPDATE public.ventas SET
    tipo_comprobante='NOTA_CREDITO',condicion_venta='CONTADO',
    subtotal_sin_iva=-100,iva_total=-21,percepciones=0,total=-121,total_pagado=0,
    estado_pago='PENDIENTE',estado='PENDIENTE_FISCAL',afip_estado='SIN_FACTURAR',
    nc_periodo_modalidad='DEVOLUCION_PRODUCTOS',
    periodo_asoc_desde='2026-08-01',periodo_asoc_hasta='2026-08-20',
    motivo_nota_credito='Devolución de productos del período',
    nc_resolucion='REINTEGRO',nc_periodo_payload_hash=repeat('a',64),
    afip_version=2"
check_sql "una NC por período persiste exactamente snapshot v3" "3" \
  "BEGIN; $VENTA_FIXTURE_SQL $NC_PERIODO_SQL,afip_snapshot='$V3'::jsonb,afip_snapshot_hash='$(jq -r '.hash' <<<"$V3")' WHERE id='a5000000-0000-4000-8000-000000000002'; SELECT afip_snapshot->>'version' FROM public.ventas WHERE id='a5000000-0000-4000-8000-000000000002'; ROLLBACK;"
expect_fail_like "una NC por período rechaza snapshot v2" "ck_ventas_afip_snapshot_coherente" \
  "BEGIN; $VENTA_FIXTURE_SQL $NC_PERIODO_SQL,afip_snapshot='$V2'::jsonb,afip_snapshot_hash='$(jq -r '.hash' <<<"$V2")' WHERE id='a5000000-0000-4000-8000-000000000002'; ROLLBACK;"

check_sql "PENDIENTE_FISCAL conserva snapshot nulo" "true|true" \
  "BEGIN; $VENTA_FIXTURE_SQL $NC_PERIODO_SQL,afip_snapshot=NULL,afip_snapshot_hash=NULL WHERE id='a5000000-0000-4000-8000-000000000002'; SELECT (afip_snapshot IS NULL)::text||'|'||(afip_snapshot_hash IS NULL)::text FROM public.ventas WHERE id='a5000000-0000-4000-8000-000000000002'; ROLLBACK;"

NC_REQUERIDA_SQL="
  UPDATE public.ventas SET
    tipo_comprobante='NOTA_CREDITO',condicion_venta='CONTADO',
    subtotal_sin_iva=-100,iva_total=-21,percepciones=0,total=-121,total_pagado=0,
    estado_pago='PENDIENTE',estado='ACTIVA',
    periodo_asoc_desde='2026-08-01',periodo_asoc_hasta='2026-08-20',
    motivo_nota_credito='Devolución de productos del período',
    nc_resolucion='REINTEGRO',nc_periodo_payload_hash=repeat('a',64),
    afip_version=2"

estado_requerido_sql() {
  local estado="$1" snapshot="$2" hash="$3" fase estado_afip claim cae
  local modalidad emisor_cuit punto_venta cbte_tipo numero modo simulado validez fecha total
  case "$estado" in
    RESERVADO)
      estado_afip="EMITIENDO"; fase="RESERVADO"; claim="true"; cae="NULL" ;;
    EMITIENDO)
      estado_afip="EMITIENDO"; fase="REQUEST_INICIADO"; claim="true"; cae="NULL" ;;
    RECONCILIAR)
      estado_afip="RECONCILIAR"; fase="REQUEST_INICIADO"; claim="true"; cae="NULL" ;;
    APROBADO)
      estado_afip="APROBADO"; fase="PERSISTIDO"; claim="false"; cae="'CAE-V3-VALIDO'" ;;
    *) fail "estado de prueba desconocido: $estado" ;;
  esac
  if [[ "$claim" == "true" ]]; then
    claim="afip_claim_token='a5000000-0000-4000-8000-000000000099',afip_claimed_at=now()"
  else
    claim="afip_claim_token=NULL,afip_claimed_at=NULL"
  fi
  modalidad="$(jq -r '.notaCredito.modalidad' <<<"$snapshot")"
  emisor_cuit="$(jq -r '.identidad.emisorCuit' <<<"$snapshot")"
  punto_venta="$(jq -r '.identidad.puntoVenta' <<<"$snapshot")"
  cbte_tipo="$(jq -r '.identidad.cbteTipo' <<<"$snapshot")"
  numero="$(jq -r '.identidad.numero' <<<"$snapshot")"
  modo="$(jq -r '.identidad.modo' <<<"$snapshot")"
  simulado="$(jq -r '.identidad.simulado' <<<"$snapshot")"
  validez="$(jq -r '.identidad.validez' <<<"$snapshot")"
  fecha="$(jq -r '.fechaComprobante' <<<"$snapshot")"
  total="$(jq -r '.importeTotal' <<<"$snapshot")"
  printf "%s,nc_periodo_modalidad='%s',afip_emisor_cuit='%s',afip_punto_venta=%s,afip_cbte_tipo=%s,afip_numero=%s,afip_modo='%s',afip_simulado=%s,afip_validez='%s',afip_fecha_comprobante='%s',afip_imp_total=%s,afip_estado='%s',afip_fase='%s',%s,cae=%s,afip_snapshot='%s'::jsonb,afip_snapshot_hash='%s' WHERE id='a5000000-0000-4000-8000-000000000002'" \
    "$NC_REQUERIDA_SQL" "$modalidad" "$emisor_cuit" "$punto_venta" "$cbte_tipo" "$numero" "$modo" "$simulado" "$validez" "$fecha" "$total" "$estado_afip" "$fase" "$claim" "$cae" "$snapshot" "$hash"
}

V3_MOTIVO_CORTO="$(snapshot_con_motivo 'abc')"
V3_PERIODO_INVERTIDO="$(rehash '.periodoAsoc.desde="2026-08-21"')"
V3_MODALIDAD_LINEAS="$(rehash '.notaCredito.modalidad="BONIFICACION_AJUSTE"')"
V3_HASH_FALSO="$(jq -c '.hash=("f" * 64)' <<<"$V3")"

for estado in RESERVADO EMITIENDO RECONCILIAR APROBADO; do
  check_sql "$estado acepta snapshot v3 semántica y canónicamente válido" "1" \
    "BEGIN; $VENTA_FIXTURE_SQL $(estado_requerido_sql "$estado" "$V3" "$(jq -r '.hash' <<<"$V3")"); SELECT 1; ROLLBACK;"

  for caso in motivo periodo modalidad; do
    case "$caso" in
      motivo) invalido="$V3_MOTIVO_CORTO" ;;
      periodo) invalido="$V3_PERIODO_INVERTIDO" ;;
      modalidad) invalido="$V3_MODALIDAD_LINEAS" ;;
    esac
    expect_fail_like "$estado rechaza snapshot rehasheado inválido por $caso" \
      "snapshot v3|motivo|período|bonificación|concepto" \
      "BEGIN; $VENTA_FIXTURE_SQL $(estado_requerido_sql "$estado" "$invalido" "$(jq -r '.hash' <<<"$invalido")"); ROLLBACK;"
  done

  expect_fail_like "$estado rechaza hash declarado no canónico" "hash|snapshot" \
    "BEGIN; $VENTA_FIXTURE_SQL $(estado_requerido_sql "$estado" "$V3_HASH_FALSO" "$(jq -r '.hash' <<<"$V3_HASH_FALSO")"); ROLLBACK;"
done

for variante in A C BONIFICACION; do
  case "$variante" in
    A) valido="$V3_A" ;;
    C) valido="$V3_C" ;;
    BONIFICACION) valido="$V3_BONIFICACION" ;;
  esac
  check_sql "RESERVADO persiste el happy path $variante mediante el trigger real" "1" \
    "BEGIN; $VENTA_FIXTURE_SQL $(estado_requerido_sql "RESERVADO" "$valido" "$(jq -r '.hash' <<<"$valido")"); SELECT 1; ROLLBACK;"
done

# Simula filas históricas inválidas anteriores a la frontera y prueba que un
# UPDATE cualquiera no puede mantenerlas en ningún estado obligatorio.
for estado in RESERVADO EMITIENDO RECONCILIAR APROBADO; do
  expect_fail_like "un UPDATE no puede mantener $estado con snapshot semánticamente inválido" \
    "snapshot v3|motivo" \
    "BEGIN; $VENTA_FIXTURE_SQL SET LOCAL session_replication_role='replica'; $(estado_requerido_sql "$estado" "$V3_MOTIVO_CORTO" "$(jq -r '.hash' <<<"$V3_MOTIVO_CORTO")"); SET LOCAL session_replication_role='origin'; UPDATE public.ventas SET numero_comprobante=numero_comprobante WHERE id='a5000000-0000-4000-8000-000000000002'; ROLLBACK;"
done

check_sql "INSERT obligatorio acepta sólo un snapshot válido" "1" \
  "BEGIN; $VENTA_FIXTURE_SQL $(estado_requerido_sql "RESERVADO" "$V3" "$(jq -r '.hash' <<<"$V3")"); CREATE TEMP TABLE t_snapshot_insert AS SELECT to_jsonb(v)||jsonb_build_object('id','a5000000-0000-4000-8000-000000000003','numero_comprobante','SNAPSHOT-V3-INSERT') AS data FROM public.ventas v WHERE id='a5000000-0000-4000-8000-000000000002'; DELETE FROM public.ventas WHERE id='a5000000-0000-4000-8000-000000000002'; INSERT INTO public.ventas SELECT (pg_catalog.jsonb_populate_record(NULL::public.ventas,data)).* FROM t_snapshot_insert; SELECT count(*) FROM public.ventas WHERE id='a5000000-0000-4000-8000-000000000003'; ROLLBACK;"
expect_fail_like "INSERT obligatorio rechaza snapshot semánticamente inválido" \
  "snapshot v3|motivo" \
  "BEGIN; $VENTA_FIXTURE_SQL SET LOCAL session_replication_role='replica'; $(estado_requerido_sql "RESERVADO" "$V3_MOTIVO_CORTO" "$(jq -r '.hash' <<<"$V3_MOTIVO_CORTO")"); CREATE TEMP TABLE t_snapshot_insert AS SELECT to_jsonb(v)||jsonb_build_object('id','a5000000-0000-4000-8000-000000000003','numero_comprobante','SNAPSHOT-V3-INSERT-INVALIDO') AS data FROM public.ventas v WHERE id='a5000000-0000-4000-8000-000000000002'; DELETE FROM public.ventas WHERE id='a5000000-0000-4000-8000-000000000002'; SET LOCAL session_replication_role='origin'; INSERT INTO public.ventas SELECT (pg_catalog.jsonb_populate_record(NULL::public.ventas,data)).* FROM t_snapshot_insert; ROLLBACK;"

check_sql "los helpers v3 y dispatcher no se exponen a roles API" "false|false|false|false|false|false" \
  "SELECT has_function_privilege('anon','public.validar_snapshot_fiscal_v3(jsonb)','execute')||'|'||has_function_privilege('authenticated','public.validar_snapshot_fiscal_v3(jsonb)','execute')||'|'||has_function_privilege('service_role','public.validar_snapshot_fiscal_v3(jsonb)','execute')||'|'||has_function_privilege('anon','public.validar_snapshot_fiscal_persistido(jsonb)','execute')||'|'||has_function_privilege('authenticated','public.validar_snapshot_fiscal_persistido(jsonb)','execute')||'|'||has_function_privilege('service_role','public.validar_snapshot_fiscal_persistido(jsonb)','execute');"

printf '\nContrato snapshot fiscal v3: OK\n'
