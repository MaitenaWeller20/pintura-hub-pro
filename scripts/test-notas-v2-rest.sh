#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)
TMP_DIR="$(mktemp -d)"
USUARIO_ID="a1310000-0000-4000-8000-000000000001"
CLIENTE_ID="b1310000-0000-4000-8000-000000000001"
ORIGINAL_ID="c1310000-0000-4000-8000-000000000001"
PRODUCTO_ID="b1310000-0000-4000-8000-000000000002"
NC_ID="d1310000-0000-4000-8000-000000000001"
ND_ID="d1310000-0000-4000-8000-000000000002"
NC_ASOCIADA_ID="d1310000-0000-4000-8000-000000000003"
NC_SIN_WRITER_ID="d1310000-0000-4000-8000-000000000004"
SUCURSAL_ID=""
SEQ_NC_EXISTIA="0"
SEQ_NC_ANTES="0"
SEQ_ND_EXISTIA="0"
SEQ_ND_ANTES="0"

q() { "${PSQL[@]}" -qAtc "$1"; }

for herramienta in curl docker jq node npx; do
  command -v "$herramienta" >/dev/null || {
    echo "Falta la herramienta local requerida: $herramienta" >&2
    exit 1
  }
done

STATUS_ENV="$(npx supabase status -o env 2>/dev/null)"
API_URL="$(sed -n 's/^API_URL="\([^"]*\)"/\1/p' <<<"$STATUS_ENV")"
ANON_KEY="$(sed -n 's/^ANON_KEY="\([^"]*\)"/\1/p' <<<"$STATUS_ENV")"
JWT_SECRET="$(sed -n 's/^JWT_SECRET="\([^"]*\)"/\1/p' <<<"$STATUS_ENV")"
if [[ -z "$PROJECT_ID" || -z "$API_URL" || -z "$ANON_KEY" || -z "$JWT_SECRET" ]]; then
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

SETTINGS_ANTES="$(q "SELECT (facturacion_receptor_v2_enabled::int)::text || '|' || (facturacion_legacy_writer_enabled::int)::text FROM public.settings WHERE id=true")"
if [[ ! "$SETTINGS_ANTES" =~ ^[01]\|[01]$ ]]; then
  echo "No se pudo capturar el estado previo de settings." >&2
  exit 1
fi
V2_ANTES="${SETTINGS_ANTES%%|*}"
LEGACY_ANTES="${SETTINGS_ANTES##*|}"

limpiar_sql() {
  "${PSQL[@]}" >/dev/null <<SQL
UPDATE public.settings
   SET facturacion_receptor_v2_enabled=('$V2_ANTES'='1'),
       facturacion_legacy_writer_enabled=('$LEGACY_ANTES'='1')
 WHERE id=true;
DELETE FROM public.emision_fiscal_intentos
 WHERE venta_id IN (
   SELECT id FROM public.ventas
    WHERE id='$ORIGINAL_ID'
       OR idempotency_key IN ('$NC_ID','$ND_ID','$NC_ASOCIADA_ID','$NC_SIN_WRITER_ID')
 );
CREATE TEMP TABLE IF NOT EXISTS pg_temp.ventas_notas_rest AS
SELECT id FROM public.ventas
 WHERE id='$ORIGINAL_ID'
    OR idempotency_key IN ('$NC_ID','$ND_ID','$NC_ASOCIADA_ID','$NC_SIN_WRITER_ID')
    OR observaciones LIKE 'T13-%-REST%';
DELETE FROM public.cuenta_corriente_movimientos
 WHERE venta_id IN (SELECT id FROM pg_temp.ventas_notas_rest);
DELETE FROM public.stock_movimientos
 WHERE referencia_id IN (SELECT id FROM pg_temp.ventas_notas_rest);
DELETE FROM public.venta_pagos
 WHERE venta_id IN (SELECT id FROM pg_temp.ventas_notas_rest);
DELETE FROM public.venta_items
 WHERE venta_id IN (SELECT id FROM pg_temp.ventas_notas_rest);
DELETE FROM public.ventas
 WHERE id IN (SELECT id FROM pg_temp.ventas_notas_rest);
DELETE FROM public.caja_sesiones AS cs
 WHERE (cs.abierta_por='$USUARIO_ID' OR cs.cerrada_por='$USUARIO_ID')
   AND NOT EXISTS (SELECT 1 FROM public.ventas v WHERE v.caja_sesion_id=cs.id)
   AND NOT EXISTS (SELECT 1 FROM public.caja_movimientos cm WHERE cm.caja_sesion_id=cs.id);
DELETE FROM public.stock_sucursal WHERE producto_id='$PRODUCTO_ID';
DELETE FROM public.productos WHERE id='$PRODUCTO_ID';
DELETE FROM public.clientes WHERE id='$CLIENTE_ID';
DELETE FROM auth.users WHERE id='$USUARIO_ID';
SQL
}

restaurar_secuencias() {
  [[ -n "$SUCURSAL_ID" ]] || return 0
  "${PSQL[@]}" >/dev/null <<SQL
DELETE FROM public.comprobante_secuencias
 WHERE sucursal_id='$SUCURSAL_ID'
   AND tipo IN ('NOTA_CREDITO','NOTA_DEBITO');
INSERT INTO public.comprobante_secuencias(sucursal_id,tipo,ultimo_numero)
SELECT '$SUCURSAL_ID','NOTA_CREDITO','$SEQ_NC_ANTES'
 WHERE '$SEQ_NC_EXISTIA'='1';
INSERT INTO public.comprobante_secuencias(sucursal_id,tipo,ultimo_numero)
SELECT '$SUCURSAL_ID','NOTA_DEBITO','$SEQ_ND_ANTES'
 WHERE '$SEQ_ND_EXISTIA'='1';
SQL
}

cleanup() {
  local previo=$?
  trap - EXIT
  set +e
  limpiar_sql
  local limpieza=$?
  restaurar_secuencias
  local secuencias=$?
  local residuos
  residuos="$(q "SELECT (SELECT count(*) FROM auth.users WHERE id='$USUARIO_ID') + (SELECT count(*) FROM public.clientes WHERE id='$CLIENTE_ID') + (SELECT count(*) FROM public.productos WHERE id='$PRODUCTO_ID') + (SELECT count(*) FROM public.ventas WHERE id='$ORIGINAL_ID' OR idempotency_key IN ('$NC_ID','$ND_ID','$NC_ASOCIADA_ID','$NC_SIN_WRITER_ID'))" 2>/dev/null)"
  local auditoria=$?
  rm -r "$TMP_DIR"
  local temporal=$?
  set -e
  if [[ "$limpieza" -ne 0 || "$secuencias" -ne 0 || "$auditoria" -ne 0 || "$temporal" -ne 0 || "$residuos" != "0" ]]; then
    echo "✗ falló el cleanup REST de notas (${limpieza}/${secuencias}/${auditoria}/${temporal}; residuos=${residuos:-desconocidos})" >&2
    exit 1
  fi
  echo "✓ cleanup REST de notas: 0 residuos"
  exit "$previo"
}
trap cleanup EXIT

limpiar_sql
SUCURSAL_ID="$(q "SELECT id FROM public.sucursales ORDER BY numero LIMIT 1")"
SEQ_NC_EXISTIA="$(q "SELECT count(*) FROM public.comprobante_secuencias WHERE sucursal_id='$SUCURSAL_ID' AND tipo='NOTA_CREDITO'")"
SEQ_NC_ANTES="$(q "SELECT COALESCE(max(ultimo_numero),0) FROM public.comprobante_secuencias WHERE sucursal_id='$SUCURSAL_ID' AND tipo='NOTA_CREDITO'")"
SEQ_ND_EXISTIA="$(q "SELECT count(*) FROM public.comprobante_secuencias WHERE sucursal_id='$SUCURSAL_ID' AND tipo='NOTA_DEBITO'")"
SEQ_ND_ANTES="$(q "SELECT COALESCE(max(ultimo_numero),0) FROM public.comprobante_secuencias WHERE sucursal_id='$SUCURSAL_ID' AND tipo='NOTA_DEBITO'")"
"${PSQL[@]}" >/dev/null <<SQL
INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  '$USUARIO_ID','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','t13-notas-rest@local.test','x',now(),now(),now()
);
UPDATE public.profiles
   SET username='t13_notas_rest',activo=true,
       sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)
 WHERE id='$USUARIO_ID';
INSERT INTO public.user_roles(user_id,role) VALUES ('$USUARIO_ID','admin');
INSERT INTO public.clientes(id,razon_social,tipo,condicion_cta_cte,activo)
VALUES ('$CLIENTE_ID','T13 NOTAS REST CLIENTE','RESPONSABLE_INSCRIPTO',true,true);
INSERT INTO public.productos(
  id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado
) VALUES (
  '$PRODUCTO_ID','T13-NOTAS-REST-PROD','T13 producto REST para notas',100,21,true,false
);
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
SELECT '$PRODUCTO_ID',s.id,10 FROM public.sucursales AS s ORDER BY s.numero LIMIT 1;
SET session_replication_role=replica;
INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
  estado_pago,observaciones,afip_estado
)
SELECT '$ORIGINAL_ID',s.id,'$CLIENTE_ID','$USUARIO_ID','T13-REST-ORIGINAL','FACTURA_A',
       'CTA_CTE',100,21,0,121,0,'PENDIENTE','T13-REST-ND-ORIGINAL','PENDIENTE'
  FROM public.sucursales AS s ORDER BY s.numero LIMIT 1;
SET session_replication_role=origin;
UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;
SQL

estado_comercial() {
  q "SELECT md5(concat_ws('|',
    (SELECT COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.ventas AS t),
    (SELECT COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.venta_items AS t),
    (SELECT COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.venta_pagos AS t),
    (SELECT COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.stock_movimientos AS t),
    (SELECT COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY t.producto_id,t.sucursal_id),'') FROM public.stock_sucursal AS t),
    (SELECT COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.caja_movimientos AS t),
    (SELECT COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.caja_sesiones AS t),
    (SELECT COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.cuenta_corriente_movimientos AS t),
    (SELECT COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY t.sucursal_id,t.tipo),'') FROM public.comprobante_secuencias AS t)))"
}
ANTES="$(estado_comercial)"

JWT="$({ JWT_SECRET="$JWT_SECRET" USUARIO_ID="$USUARIO_ID" node --input-type=module <<'NODE'
import { createHmac } from "node:crypto";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = encode({ alg: "HS256", typ: "JWT" });
const payload = encode({
  aud: "authenticated",
  exp: now + 300,
  iat: now,
  iss: "supabase-demo",
  role: "authenticated",
  sub: process.env.USUARIO_ID,
});
const signature = createHmac("sha256", process.env.JWT_SECRET)
  .update(`${header}.${payload}`)
  .digest("base64url");
process.stdout.write(`${header}.${payload}.${signature}`);
NODE
} 2>/dev/null)"

payload_nota() {
  local tipo="$1" idempotencia="$2" observacion="$3" asociado="${4:-}"
  jq -nc \
  --arg sucursal "$(q "SELECT id FROM public.sucursales ORDER BY numero LIMIT 1")" \
  --arg cliente "$CLIENTE_ID" --arg producto "$PRODUCTO_ID" \
  --arg original "$asociado" --arg idempotencia "$idempotencia" \
  --arg tipo "$tipo" --arg observacion "$observacion" '
  {
    p_sucursal_id:$sucursal,p_cliente_id:$cliente,p_tipo_comprobante:$tipo,
    p_condicion_venta:"CTA_CTE",
    p_items:(if $tipo=="NOTA_CREDITO"
      then [{producto_id:$producto,cantidad:1}]
      else [{producto_id:null,descripcion:"Recargo REST",cantidad:1,precio_unitario_sin_iva:100,iva_porcentaje:21}]
      end),
    p_pagos:[],p_percepciones:0,p_observaciones:$observacion,
    p_nombre_obra:null,p_fecha:null,
    p_cbte_asoc_id:(if $original=="" then null else $original end),
    p_idempotency_key:$idempotencia
  }'
}

post_nota_rechazada() {
  local nombre="$1" tipo="$2" idempotencia="$3" observacion="$4" mensaje="$5" asociado="${6:-}"
  local http_code
  http_code="$(curl --silent --show-error --connect-timeout 1 --max-time 5 \
    --output "$TMP_DIR/${nombre}.json" --write-out '%{http_code}' \
    --request POST "${API_URL%/}/rest/v1/rpc/crear_venta" \
    --header "apikey: $ANON_KEY" \
    --header "Authorization: Bearer $JWT" \
    --header "Content-Type: application/json" \
    --data "$(payload_nota "$tipo" "$idempotencia" "$observacion" "$asociado")")"
  if [[ "$http_code" -lt 400 || "$http_code" -ge 500 ]]; then
    echo "✗ $nombre esperaba rechazo 4xx y obtuvo HTTP $http_code" >&2
    exit 1
  fi
  jq -e --arg mensaje "$mensaje" '.message | ascii_downcase | contains($mensaje)' \
    "$TMP_DIR/${nombre}.json" >/dev/null || {
    echo "✗ $nombre no contiene el mensaje estable esperado" >&2
    exit 1
  }
  echo "✓ $nombre rechazada por REST autenticado local (HTTP $http_code)"
}

post_nc_interna_aceptada() {
  local nombre="$1" idempotencia="$2" observacion="$3"
  local http_code
  http_code="$(curl --silent --show-error --connect-timeout 1 --max-time 5 \
    --output "$TMP_DIR/${nombre}.json" --write-out '%{http_code}' \
    --request POST "${API_URL%/}/rest/v1/rpc/crear_venta" \
    --header "apikey: $ANON_KEY" \
    --header "Authorization: Bearer $JWT" \
    --header "Content-Type: application/json" \
    --data "$(payload_nota "NOTA_CREDITO" "$idempotencia" "$observacion" "")")"
  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    echo "✗ $nombre esperaba éxito y obtuvo HTTP $http_code: $(jq -r '.message // .' "$TMP_DIR/${nombre}.json")" >&2
    exit 1
  fi
  jq -e 'type=="array" and length==1 and .[0].venta_id!=null' \
    "$TMP_DIR/${nombre}.json" >/dev/null || {
    echo "✗ $nombre no devolvió la venta creada" >&2
    exit 1
  }
  echo "✓ $nombre aceptada por REST autenticado local (HTTP $http_code)"
}

post_nc_interna_aceptada \
  "NC v2 interna" "$NC_ID" "T13-NC-REST-INTERNA"
NC_CREADA_ID="$(q "SELECT id FROM public.ventas WHERE idempotency_key='$NC_ID'")"
[[ -n "$NC_CREADA_ID" ]] || {
  echo "✗ la NC interna REST no quedó persistida" >&2
  exit 1
}
[[ "$(q "SELECT (afip_cbte_asoc_id IS NULL AND afip_estado='NO_APLICA' AND cae IS NULL AND afip_numero IS NULL)::text FROM public.ventas WHERE id='$NC_CREADA_ID'")" == "true" ]] || {
  echo "✗ la NC manual REST no quedó interna/sin CAE" >&2
  exit 1
}
[[ "$(q "SELECT count(*) FROM public.emision_fiscal_intentos WHERE venta_id='$NC_CREADA_ID'")" == "0" ]] || {
  echo "✗ la NC interna REST entró en la cola fiscal" >&2
  exit 1
}
DESPUES_NC="$(estado_comercial)"

post_nota_rechazada \
  "NC v2 asociada directa" "NOTA_CREDITO" "$NC_ASOCIADA_ID" \
  "T13-NC-ASOCIADA-REST-NO-DEBE-PERSISTIR" \
  "nota de crédito v2 se crea exclusivamente mediante anular_venta" \
  "$ORIGINAL_ID"
post_nota_rechazada \
  "ND v2 directa" "NOTA_DEBITO" "$ND_ID" \
  "T13-ND-REST-NO-DEBE-PERSISTIR" \
  "nota de débito nueva queda fuera de alcance fiscal" \
  "$ORIGINAL_ID"
[[ "$(estado_comercial)" == "$DESPUES_NC" ]] || {
  echo "✗ el rechazo REST modificó la NC interna o agregó efectos" >&2
  exit 1
}
[[ "$(q "SELECT count(*) FROM public.ventas WHERE idempotency_key IN ('$NC_ASOCIADA_ID','$ND_ID') OR observaciones IN ('T13-NC-ASOCIADA-REST-NO-DEBE-PERSISTIR','T13-ND-REST-NO-DEBE-PERSISTIR')")" == "0" ]] || {
  echo "✗ el rechazo REST dejó una NC asociada o ND" >&2
  exit 1
}

"${PSQL[@]}" -q >/dev/null <<'SQL'
UPDATE public.settings
   SET facturacion_receptor_v2_enabled=false,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;
SQL
post_nc_interna_aceptada \
  "NC interna sin writer" "$NC_SIN_WRITER_ID" "T13-NC-SIN-WRITER-REST"
DESPUES_NC_SIN_WRITER="$(estado_comercial)"
post_nota_rechazada \
  "ND en mantenimiento" "NOTA_DEBITO" "$ND_ID" \
  "T13-ND-REST-NO-DEBE-PERSISTIR" \
  "escritor fiscal legacy está deshabilitado" \
  "$ORIGINAL_ID"
[[ "$(estado_comercial)" == "$DESPUES_NC_SIN_WRITER" ]] || {
  echo "✗ el rechazo de ND en mantenimiento alteró las NC internas" >&2
  exit 1
}

echo "✓ REST distingue NC interna de NC fiscal/ND sin mutaciones parciales"
