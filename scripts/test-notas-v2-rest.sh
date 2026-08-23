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
ND_ID="d1310000-0000-4000-8000-000000000001"

q() { "${PSQL[@]}" -qAtc "$1"; }

for herramienta in curl docker jq node supabase; do
  command -v "$herramienta" >/dev/null || {
    echo "Falta la herramienta local requerida: $herramienta" >&2
    exit 1
  }
done

STATUS_ENV="$(supabase status -o env 2>/dev/null)"
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
DELETE FROM public.emision_fiscal_intentos WHERE venta_id IN ('$ORIGINAL_ID','$ND_ID');
DELETE FROM public.ventas WHERE id IN ('$ORIGINAL_ID','$ND_ID');
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
  local residuos
  residuos="$(q "SELECT (SELECT count(*) FROM auth.users WHERE id='$USUARIO_ID') + (SELECT count(*) FROM public.clientes WHERE id='$CLIENTE_ID') + (SELECT count(*) FROM public.ventas WHERE id IN ('$ORIGINAL_ID','$ND_ID'))" 2>/dev/null)"
  local auditoria=$?
  rm -r "$TMP_DIR"
  local temporal=$?
  set -e
  if [[ "$limpieza" -ne 0 || "$auditoria" -ne 0 || "$temporal" -ne 0 || "$residuos" != "0" ]]; then
    echo "✗ falló el cleanup REST de ND (${limpieza}/${auditoria}/${temporal}; residuos=${residuos:-desconocidos})" >&2
    exit 1
  fi
  echo "✓ cleanup REST de ND: 0 residuos"
  exit "$previo"
}
trap cleanup EXIT

limpiar_sql
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
INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
  estado_pago,observaciones,afip_estado
)
SELECT '$ORIGINAL_ID',s.id,'$CLIENTE_ID','$USUARIO_ID','T13-REST-ORIGINAL','FACTURA_A',
       'CTA_CTE',100,21,0,121,0,'PENDIENTE','T13-REST-ND-ORIGINAL','PENDIENTE'
  FROM public.sucursales AS s ORDER BY s.numero LIMIT 1;
UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;
SQL

estado_comercial() {
  q "SELECT concat_ws('|',
    (SELECT count(*) FROM public.ventas),
    (SELECT count(*) FROM public.venta_items),
    (SELECT count(*) FROM public.venta_pagos),
    (SELECT count(*) FROM public.stock_movimientos),
    (SELECT count(*) FROM public.caja_movimientos),
    (SELECT count(*) FROM public.cuenta_corriente_movimientos),
    (SELECT COALESCE(sum(ultimo_numero),0) FROM public.comprobante_secuencias))"
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

PAYLOAD="$(jq -nc \
  --arg sucursal "$(q "SELECT id FROM public.sucursales ORDER BY numero LIMIT 1")" \
  --arg cliente "$CLIENTE_ID" --arg original "$ORIGINAL_ID" --arg idempotencia "$ND_ID" '
  {
    p_sucursal_id:$sucursal,p_cliente_id:$cliente,p_tipo_comprobante:"NOTA_DEBITO",
    p_condicion_venta:"CTA_CTE",
    p_items:[{producto_id:null,descripcion:"Recargo REST",cantidad:1,precio_unitario_sin_iva:100,iva_porcentaje:21}],
    p_pagos:[],p_percepciones:0,p_observaciones:"T13-ND-REST-NO-DEBE-PERSISTIR",
    p_nombre_obra:null,p_fecha:null,p_cbte_asoc_id:$original,p_idempotency_key:$idempotencia
  }')"

HTTP_CODE="$(curl --silent --show-error --connect-timeout 1 --max-time 5 \
  --output "$TMP_DIR/respuesta.json" --write-out '%{http_code}' \
  --request POST "${API_URL%/}/rest/v1/rpc/crear_venta" \
  --header "apikey: $ANON_KEY" \
  --header "Authorization: Bearer $JWT" \
  --header "Content-Type: application/json" \
  --data "$PAYLOAD")"

if [[ "$HTTP_CODE" -lt 400 || "$HTTP_CODE" -ge 500 ]]; then
  echo "✗ la ND REST esperaba rechazo 4xx y obtuvo HTTP $HTTP_CODE" >&2
  exit 1
fi
jq -e '.message | contains("nota de débito nueva queda fuera de alcance fiscal")' \
  "$TMP_DIR/respuesta.json" >/dev/null || {
  echo "✗ el rechazo REST no contiene el mensaje estable de alcance" >&2
  exit 1
}
[[ "$(estado_comercial)" == "$ANTES" ]] || {
  echo "✗ el rechazo REST modificó venta, ítems, pagos, stock, caja, deuda o secuencia" >&2
  exit 1
}
[[ "$(q "SELECT count(*) FROM public.ventas WHERE id='$ND_ID' OR observaciones='T13-ND-REST-NO-DEBE-PERSISTIR'")" == "0" ]] || {
  echo "✗ el rechazo REST dejó una ND" >&2
  exit 1
}

echo "✓ REST autenticado local rechaza ND v2 con HTTP $HTTP_CODE"
echo "✓ REST no deja mutaciones comerciales ni avanza la secuencia"
