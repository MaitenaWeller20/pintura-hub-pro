#!/usr/bin/env bash
# ============================================================
# Nota de crédito SIN factura asociada (migración 20260813120000).
#   supabase migration up --local && ./scripts/crear-admin-local.sh
#   ./scripts/test-nota-credito-sin-factura.sh
#
# Lo que se prueba no es sólo que la NC suelta se pueda guardar —eso es una
# línea— sino las tres cosas que se rompen si el cambio está mal hecho:
#
#   · que la NC al contado sin ningún pago NO se pueda guardar (antes reponía
#     stock y bajaba el facturado sin devolverle la plata a nadie);
#   · que una NC interna se pueda ANULAR y eso revierta stock, cuenta corriente
#     y caja;
#   · y sobre todo que anular una NC pagada en una caja YA CERRADA no toque el
#     arqueo de ese día: la reversa tiene que entrar en la caja de hoy. Es la
#     regresión más fácil de meter, porque venta_pagos no tiene `estado` y sigue
#     contando en caja_esperado aunque la venta quede ANULADA.
#
# Todo lo que siembra lo borra al principio de la corrida siguiente.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/.."
PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL="docker exec -i $DB psql -U postgres -d postgres -v ON_ERROR_STOP=1"
fallos=0
chequear() {
  if [[ "$2" == "$3" ]]; then echo "  ✓ $1"; else echo "  ✗ $1 — esperaba '$2', obtuvo '$3'"; fallos=$((fallos+1)); fi
}
rechaza() {  # nombre, texto esperado, salida
  if echo "$3" | grep -qi "$2"; then echo "  ✓ $1"; else echo "  ✗ $1 — no dijo '$2'. Dijo: $(echo "$3" | tail -2 | tr '\n' ' ')"; fallos=$((fallos+1)); fi
}
q() { $PSQL -tAc "$1"; }
# Igual que q() pero con el usuario puesto. Lo necesitan las funciones que miran
# auth.uid() (caja_esperado, entre otras): set_config vale para la sesión, así
# que las dos cosas tienen que ir en la MISMA invocación de psql.
qa() { $PSQL -tAq -c "$(auth "$MAIL")" -c "$1" | tail -1; }
auth() {
  cat <<SQL
SELECT set_config('request.jwt.claims',
  json_build_object('sub',(SELECT id::text FROM auth.users WHERE email='$1'),
                    'role','authenticated')::text, false);
SQL
}

cleanup() {
  $PSQL <<'SQL' >/dev/null 2>&1 || true
BEGIN;
CREATE TEMP TABLE _ncsf_ventas_cleanup (
  id uuid PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO _ncsf_ventas_cleanup (id)
SELECT id FROM public.ventas WHERE observaciones LIKE 'TEST-NCSF%';

INSERT INTO _ncsf_ventas_cleanup (id)
SELECT venta_anulada_por
  FROM public.ventas
 WHERE observaciones LIKE 'TEST-NCSF%'
   AND venta_anulada_por IS NOT NULL
ON CONFLICT DO NOTHING;

DELETE FROM public.emision_fiscal_intentos
 WHERE venta_id IN (SELECT id FROM _ncsf_ventas_cleanup);
DELETE FROM public.venta_pagos
 WHERE venta_id IN (SELECT id FROM _ncsf_ventas_cleanup);
DELETE FROM public.cuenta_corriente_movimientos
 WHERE venta_id IN (SELECT id FROM _ncsf_ventas_cleanup);
DELETE FROM public.venta_items
 WHERE venta_id IN (SELECT id FROM _ncsf_ventas_cleanup);
UPDATE public.ventas
   SET venta_anulada_por=NULL,afip_cbte_asoc_id=NULL
 WHERE id IN (SELECT id FROM _ncsf_ventas_cleanup);
DELETE FROM public.ventas
 WHERE id IN (SELECT id FROM _ncsf_ventas_cleanup);

DELETE FROM public.stock_movimientos m USING public.productos p
 WHERE p.id=m.producto_id AND p.codigo='NCSF-TEST';
DELETE FROM public.stock_sucursal s USING public.productos p
 WHERE p.id=s.producto_id AND p.codigo='NCSF-TEST';
DELETE FROM public.productos WHERE codigo='NCSF-TEST';
DELETE FROM public.clientes
 WHERE razon_social IN ('CLIENTE NCSF TEST','OTRO CLIENTE NCSF');

DELETE FROM public.caja_movimientos
 WHERE caja_sesion_id IN (
   SELECT id FROM public.caja_sesiones
    WHERE abierta_por='a5000000-0000-0000-0000-000000000002'
       OR cerrada_por='a5000000-0000-0000-0000-000000000002'
 );
DELETE FROM public.caja_sesiones
 WHERE abierta_por='a5000000-0000-0000-0000-000000000002'
    OR cerrada_por='a5000000-0000-0000-0000-000000000002';
DELETE FROM public.user_roles
 WHERE user_id='a5000000-0000-0000-0000-000000000002';
DELETE FROM public.profiles
 WHERE id='a5000000-0000-0000-0000-000000000002';
DELETE FROM auth.users
 WHERE id='a5000000-0000-0000-0000-000000000002';
COMMIT;
SQL
}

trap cleanup EXIT
cleanup

$PSQL <<'SQL' >/dev/null
INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
)
SELECT
  'a5000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'ncsf-admin@local.test','x',now(),now(),now()
WHERE NOT EXISTS (SELECT 1 FROM auth.users WHERE email='ncsf-admin@local.test');
UPDATE public.profiles
   SET username='ncsf-admin',nombre_completo='Admin NCSF',
       sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),activo=true
 WHERE id='a5000000-0000-0000-0000-000000000002';
INSERT INTO public.user_roles(user_id,role)
VALUES ('a5000000-0000-0000-0000-000000000002','admin')
ON CONFLICT DO NOTHING;
SQL
MAIL=$(q "select u.email from auth.users u join public.user_roles r on r.user_id=u.id where u.id='a5000000-0000-0000-0000-000000000002' and r.role='admin'")
[ -n "$MAIL" ] || { echo "No hay ningún admin en la base local. Corré ./scripts/crear-admin-local.sh"; exit 1; }

echo "── Sembrando ─────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
INSERT INTO public.clientes (razon_social, condicion_cta_cte)
VALUES ('CLIENTE NCSF TEST', true), ('OTRO CLIENTE NCSF', true);
INSERT INTO public.productos (codigo,nombre,precio_sin_iva,iva_porcentaje)
VALUES ('NCSF-TEST','PRODUCTO NCSF TEST',1000,21);
INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
SELECT p.id, (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1), 100
  FROM public.productos p WHERE p.codigo = 'NCSF-TEST'
ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET cantidad = 100;
SQL

SUC=$(q "select id::text from public.sucursales order by numero limit 1")
CLI=$(q "select id::text from public.clientes where razon_social='CLIENTE NCSF TEST'")
OTRO=$(q "select id::text from public.clientes where razon_social='OTRO CLIENTE NCSF'")
PROD=$(q "select id::text from public.productos where codigo='NCSF-TEST'")
stock() { q "select cantidad::text from public.stock_sucursal where producto_id='$PROD' and sucursal_id='$SUC'"; }

ITEM="'[{\"producto_id\":\"$PROD\",\"cantidad\":2}]'::jsonb"

echo
echo "── 1. La NC sin factura se puede guardar (cuenta corriente) ──────────"
S0=$(stock)
OUT=$( { $PSQL <<SQL
$(auth "$MAIL")
SELECT * FROM public.crear_venta(
  '$SUC','$CLI','NOTA_CREDITO','CTA_CTE',$ITEM,'[]'::jsonb,0,'TEST-NCSF-CC');
SQL
} 2>&1 )
if echo "$OUT" | grep -qi "ERROR"; then
  echo "  ✗ no dejó guardar: $(echo "$OUT" | grep -i error | head -1)"; fallos=$((fallos+1))
else
  echo "  ✓ guardó"
fi
NC_CC=$(q "select id::text from public.ventas where observaciones='TEST-NCSF-CC'")
chequear "queda sin comprobante asociado (documento interno)" "true" \
  "$(q "select (afip_cbte_asoc_id is null)::text from public.ventas where id='$NC_CC'")"
chequear "repone stock (2 unidades)" "$(echo "$S0 + 2" | bc)" "$(stock)"
chequear "acredita la cuenta corriente" "CREDITO" \
  "$(q "select tipo::text from public.cuenta_corriente_movimientos where venta_id='$NC_CC' and estado='CONFIRMADO'")"

echo
echo "── 2. Al contado sin ningún pago NO se puede ─────────────────────────"
OUT=$( { $PSQL <<SQL
$(auth "$MAIL")
SELECT * FROM public.crear_venta(
  '$SUC','$CLI','NOTA_CREDITO','CONTADO',$ITEM,'[]'::jsonb,0,'TEST-NCSF-SINPAGO');
SQL
} 2>&1 )
rechaza "avisa que hay que indicar con qué se devuelve" "devuelve la plata al cliente" "$OUT"
chequear "no quedó nada guardado" "0" \
  "$(q "select count(*)::text from public.ventas where observaciones='TEST-NCSF-SINPAGO'")"

echo
echo "── 3. Al contado con pago sí, y la plata sale de la caja ─────────────"
S1=$(stock)
OUT=$( { $PSQL <<SQL
$(auth "$MAIL")
SELECT * FROM public.crear_venta(
  '$SUC','$CLI','NOTA_CREDITO','CONTADO',$ITEM,
  '[{"forma_pago":"TRANSFERENCIA","monto":2420}]'::jsonb,0,'TEST-NCSF-CONTADO');
SQL
} 2>&1 )
if echo "$OUT" | grep -qi "ERROR"; then
  echo "  ✗ no dejó guardar: $(echo "$OUT" | grep -i error | head -1)"; fallos=$((fallos+1))
else
  echo "  ✓ guardó"
fi
NC_CO=$(q "select id::text from public.ventas where observaciones='TEST-NCSF-CONTADO'")
chequear "el pago queda en negativo (sale de la caja)" "true" \
  "$(q "select (monto < 0)::text from public.venta_pagos where venta_id='$NC_CO'")"
chequear "repone stock" "$(echo "$S1 + 2" | bc)" "$(stock)"

echo
echo "── 4. La nota de DÉBITO sigue exigiendo factura ──────────────────────"
OUT=$( { $PSQL <<SQL
$(auth "$MAIL")
SELECT * FROM public.crear_venta(
  '$SUC','$CLI','NOTA_DEBITO','CTA_CTE',$ITEM,'[]'::jsonb,0,'TEST-NCSF-ND');
SQL
} 2>&1 )
rechaza "la rechaza" "nota de débito tiene que indicar la factura" "$OUT"

echo
echo "── 5. Si SÍ se informa factura, sigue validándose que sea del cliente ─"
$PSQL <<SQL > /dev/null 2>&1
$(auth "$MAIL")
SELECT * FROM public.crear_venta(
  '$SUC','$OTRO','FACTURA_B','CONTADO',$ITEM,
  '[{"forma_pago":"TRANSFERENCIA","monto":2420}]'::jsonb,0,'TEST-NCSF-FACT-OTRO');
SQL
FACT_OTRO=$(q "select id::text from public.ventas where observaciones='TEST-NCSF-FACT-OTRO'")
OUT=$( { $PSQL <<SQL
$(auth "$MAIL")
SELECT * FROM public.crear_venta(
  '$SUC','$CLI','NOTA_CREDITO','CTA_CTE',$ITEM,'[]'::jsonb,0,'TEST-NCSF-CRUZADA',
  NULL,NULL,'$FACT_OTRO');
SQL
} 2>&1 )
rechaza "no deja acreditar contra la factura de otro cliente" "no existe o no es una factura de este cliente" "$OUT"

echo
echo "── 6. Anular una NC interna revierte stock y cuenta corriente ────────"
S2=$(stock)
OUT=$( { $PSQL <<SQL
$(auth "$MAIL")
SELECT * FROM public.anular_venta('$NC_CC');
SQL
} 2>&1 )
if echo "$OUT" | grep -qi "ERROR"; then
  echo "  ✗ no dejó anular: $(echo "$OUT" | grep -i error | head -1)"; fallos=$((fallos+1))
else
  echo "  ✓ anuló"
fi
chequear "la nota queda ANULADA" "ANULADA" "$(q "select estado::text from public.ventas where id='$NC_CC'")"
chequear "saca el stock que había repuesto" "$(echo "$S2 - 2" | bc)" "$(stock)"
chequear "el crédito de cuenta corriente deja de contar" "ANULADO" \
  "$(q "select estado::text from public.cuenta_corriente_movimientos where venta_id='$NC_CC'")"
chequear "no crea ninguna nota compensatoria" "0" \
  "$(q "select count(*)::text from public.ventas where afip_cbte_asoc_id='$NC_CC'")"

echo
echo "── 7. Anular una NC pagada NO toca el arqueo de su caja ──────────────"
# El caso que importa: la NC se pagó en una sesión que después se cerró. Anular
# hoy no puede modificar el egreso histórico (rompería el arqueo de ese día):
# tiene que entrar plata NUEVA en la caja de hoy.
SES_NC=$(q "select caja_sesion_id::text from public.ventas where id='$NC_CO'")
ESPERADO_ANTES=$(qa "select (public.caja_esperado('$SES_NC')->'TRANSFERENCIA'->>'neto')")
$PSQL -tAc "update public.caja_sesiones set estado='CERRADA', cerrada_en=now() where id='$SES_NC'" > /dev/null
OUT=$( { $PSQL <<SQL
$(auth "$MAIL")
SELECT * FROM public.anular_venta('$NC_CO');
SQL
} 2>&1 )
if echo "$OUT" | grep -qi "ERROR"; then
  echo "  ✗ no dejó anular: $(echo "$OUT" | grep -i error | head -1)"; fallos=$((fallos+1))
else
  echo "  ✓ anuló"
fi
chequear "el arqueo de la caja cerrada queda igual" "$ESPERADO_ANTES" \
  "$(qa "select (public.caja_esperado('$SES_NC')->'TRANSFERENCIA'->>'neto')")"
SES_HOY=$(q "select id::text from public.caja_sesiones where sucursal_id='$SUC' and estado='ABIERTA'")
NUM_CO=$(q "select numero_comprobante from public.ventas where id='$NC_CO'")
chequear "la reversa entra en una caja distinta de la original" "false" \
  "$(q "select ('$SES_HOY'='$SES_NC')::text")"
chequear "la plata vuelve como INGRESO en la caja de hoy" "2420.00" \
  "$(q "select coalesce(sum(monto),0)::text from public.caja_movimientos where caja_sesion_id='$SES_HOY' and tipo='INGRESO' and descripcion='Reversa de nota de crédito anulada '||'$NUM_CO'")"

echo
echo "── 8. Una NC FISCAL sigue sin poder anularse ─────────────────────────"
$PSQL <<SQL > /dev/null 2>&1
$(auth "$MAIL")
SELECT * FROM public.crear_venta(
  '$SUC','$CLI','FACTURA_B','CTA_CTE',$ITEM,'[]'::jsonb,0,'TEST-NCSF-FACT');
SQL
FACT=$(q "select id::text from public.ventas where observaciones='TEST-NCSF-FACT'")
$PSQL <<SQL > /dev/null 2>&1
$(auth "$MAIL")
SELECT * FROM public.crear_venta(
  '$SUC','$CLI','NOTA_CREDITO','CTA_CTE',$ITEM,'[]'::jsonb,0,'TEST-NCSF-NCFISCAL',
  NULL,NULL,'$FACT');
SQL
NC_FIS=$(q "select id::text from public.ventas where observaciones='TEST-NCSF-NCFISCAL'")
chequear "la NC con factura sí guarda el asociado" "true" \
  "$(q "select (afip_cbte_asoc_id='$FACT')::text from public.ventas where id='$NC_FIS'")"
OUT=$( { $PSQL <<SQL
$(auth "$MAIL")
SELECT * FROM public.anular_venta('$NC_FIS');
SQL
} 2>&1 )
rechaza "no se puede anular (se corrige con otra nota)" "no se anula" "$OUT"

echo
echo "── 9. La NC que genera una ANULACIÓN no se puede anular ──────────────"
# Cumple las dos condiciones obvias (sin CAE, sin asociado) pero NO es un
# documento independiente: es la mitad de una anulación que ya devolvió el stock
# y ya resolvió la plata. Anularla descontaría el stock de nuevo y haría volver a
# la caja plata que ya volvió, con la venta original igual en ANULADA.
$PSQL <<SQL > /dev/null 2>&1
$(auth "$MAIL")
SELECT * FROM public.crear_venta(
  '$SUC','$CLI','REMITO','CTA_CTE',$ITEM,'[]'::jsonb,0,'TEST-NCSF-REMITO');
SQL
REM=$(q "select id::text from public.ventas where observaciones='TEST-NCSF-REMITO'")
NC_AUTO=$( { $PSQL -tAq -c "$(auth "$MAIL")" -c "SELECT nc_id::text FROM public.anular_venta('$REM');" | tail -1; } 2>&1 )
chequear "la anulación generó una nota interna" "true" \
  "$(q "select (cae is null and afip_cbte_asoc_id is null)::text from public.ventas where id='$NC_AUTO'")"
S9=$(stock)
OUT=$( { $PSQL <<SQL
$(auth "$MAIL")
SELECT * FROM public.anular_venta('$NC_AUTO');
SQL
} 2>&1 )
rechaza "no se puede anular la nota de una anulación" "no se anula" "$OUT"
chequear "y el stock quedó intacto" "$S9" "$(stock)"

echo
if [[ $fallos -eq 0 ]]; then echo "Todo bien."; else echo "$fallos fallo(s)."; fi
exit $((fallos > 0))
