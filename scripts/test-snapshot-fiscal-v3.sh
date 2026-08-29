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

check_sql "PostgreSQL acepta el snapshot v3 producido por TypeScript" "" \
  "SELECT public.validar_snapshot_fiscal_v3('$V3'::jsonb);"
check_sql "el dispatcher devuelve 3 para v3" "3" \
  "SELECT public.validar_snapshot_fiscal_persistido('$V3'::jsonb);"
check_sql "el dispatcher conserva el fixture v2 sin cambios" "2" \
  "SELECT public.validar_snapshot_fiscal_persistido('$V2'::jsonb);"
check_sql "TypeScript y PostgreSQL calculan el mismo hash v3" "$(jq -r '.hash' <<<"$V3")" \
  "SELECT public.fiscal_snapshot_hash('$V3'::jsonb);"

expect_fail_like "un byte alterado invalida el hash" "hash" \
  "SELECT public.validar_snapshot_fiscal_v3('$(jq -c '.notaCredito.motivo="Devolución de Productos del período"' <<<"$V3")'::jsonb);"
expect_v3_invalido "rechaza fecha inexistente" '.periodoAsoc.desde="2026-02-30"' 'fecha|período'
expect_v3_invalido "rechaza período invertido" '.periodoAsoc.desde="2026-08-21"' 'período'
expect_v3_invalido "rechaza período posterior a emisión" '.periodoAsoc.hasta="2026-08-23"' 'período|emisión'
expect_v3_invalido "rechaza motivo corto" '.notaCredito.motivo=" abc "' 'motivo'
expect_v3_invalido "rechaza modalidad desconocida" '.notaCredito.modalidad="OTRA"' 'modalidad'
expect_v3_invalido "rechaza tipo que no es NC" '.venta.tipoComprobante="VENTA"' 'NOTA_CREDITO|tipo'
expect_v3_invalido "rechaza CbteTipo no estándar" '.identidad.cbteTipo=7' 'CbteTipo'
expect_v3_invalido "rechaza una clave fiscal inesperada" '.resolucion="REINTEGRO"' 'claves|raíz'
expect_v3_invalido "rechaza una clave fiscal faltante" 'del(.periodoAsoc)' 'claves|raíz'
expect_v3_invalido "rechaza tributos" '.importeTributos="1.00" | .importeTotal="1361.00" | .tributos=[{id:1,descripcion:"Tasa",baseImponible:"100.00",alicuota:"1.00",importe:"1.00"}]' 'tributos'
expect_v3_invalido "devolución exige producto" '.items[0].productoId=null' 'productoId|producto'
expect_v3_invalido "bonificación exige concepto único" '.notaCredito.modalidad="BONIFICACION_AJUSTE"' 'concepto|bonificación'

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

check_sql "los helpers v3 y dispatcher no se exponen a roles API" "false|false|false|false|false|false" \
  "SELECT has_function_privilege('anon','public.validar_snapshot_fiscal_v3(jsonb)','execute')||'|'||has_function_privilege('authenticated','public.validar_snapshot_fiscal_v3(jsonb)','execute')||'|'||has_function_privilege('service_role','public.validar_snapshot_fiscal_v3(jsonb)','execute')||'|'||has_function_privilege('anon','public.validar_snapshot_fiscal_persistido(jsonb)','execute')||'|'||has_function_privilege('authenticated','public.validar_snapshot_fiscal_persistido(jsonb)','execute')||'|'||has_function_privilege('service_role','public.validar_snapshot_fiscal_persistido(jsonb)','execute');"

printf '\nContrato snapshot fiscal v3: OK\n'
