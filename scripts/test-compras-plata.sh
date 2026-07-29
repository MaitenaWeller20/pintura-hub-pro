#!/usr/bin/env bash
# ============================================================
# e2e SQL de "compras registra plata" (migración 20260729120000).
#
#   supabase migration up --local && ./scripts/crear-admin-local.sh
#   ./scripts/test-compras-plata.sh
#
# Cubre la §7 del spec 2026-07-29-compras-plata-ingresos-mano-design.md.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL="docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1"
fallos=0
chequear() {
  if [[ "$2" == "$3" ]]; then echo "  ✓ $1"; else echo "  ✗ $1 — esperaba '$2', obtuvo '$3'"; fallos=$((fallos+1)); fi
}
q() { $PSQL -tAc "$1"; }

echo "── Sembrando ─────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.proveedor_cc_movimientos pcm USING public.proveedores p
 WHERE p.id = pcm.proveedor_id AND p.razon_social = 'PROV COMPRAS TEST';
DELETE FROM public.proveedor_pagos pp USING public.proveedores p
 WHERE p.id = pp.proveedor_id AND p.razon_social = 'PROV COMPRAS TEST';
DELETE FROM public.compra_items ci USING public.compras c JOIN public.proveedores p ON p.id=c.proveedor_id
 WHERE ci.compra_id = c.id AND p.razon_social = 'PROV COMPRAS TEST';
DELETE FROM public.compras c USING public.proveedores p
 WHERE p.id = c.proveedor_id AND p.razon_social = 'PROV COMPRAS TEST';
DELETE FROM public.proveedores WHERE razon_social = 'PROV COMPRAS TEST';
INSERT INTO public.proveedores (razon_social, condicion_cta_cte) VALUES ('PROV COMPRAS TEST', true);

DELETE FROM public.stock_movimientos m USING public.productos p
 WHERE p.id = m.producto_id AND p.codigo = 'CMP-TEST';
DELETE FROM public.stock_sucursal s USING public.productos p
 WHERE p.id = s.producto_id AND p.codigo = 'CMP-TEST';
DELETE FROM public.productos WHERE codigo = 'CMP-TEST';
INSERT INTO public.productos (codigo, nombre, precio_fabrica, precio_sin_iva, iva_porcentaje)
VALUES ('CMP-TEST', 'PRODUCTO COMPRA TEST', 100, 130, 21);
SQL

auth() {
  cat <<SQL
SELECT set_config('request.jwt.claims',
  json_build_object('sub',(SELECT id::text FROM auth.users WHERE email='$1'),
                    'role','authenticated')::text, false);
SQL
}
suc() { q "select id::text from public.sucursales order by numero limit 1"; }
prov() { q "select id::text from public.proveedores where razon_social='PROV COMPRAS TEST'"; }
SUC=$(suc); PROV=$(prov)

echo "── 1. Compra a CTA_CTE con montos escritos ───────────────"
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.crear_compra(
  '$PROV'::uuid, '$SUC'::uuid, 'FACTURA_A', 'A-0001-CMP1',
  current_date, NULL, 100000, 21000, 500, '[]'::jsonb, 'CTA_CTE', NULL);
SQL
chequear "guarda el comprobante" "1" "$(q "select count(*)::text from public.compras where numero_comprobante='A-0001-CMP1'")"
chequear "total = subtotal + iva + percepciones" "121500.00" \
  "$(q "select total::text from public.compras where numero_comprobante='A-0001-CMP1'")"
chequear "NO escribe compra_items" "0" \
  "$(q "select count(*)::text from public.compra_items ci join public.compras c on c.id=ci.compra_id where c.numero_comprobante='A-0001-CMP1'")"
chequear "NO mueve stock" "0" \
  "$(q "select count(*)::text from public.stock_movimientos m join public.productos p on p.id=m.producto_id where p.codigo='CMP-TEST'")"
chequear "genera la deuda por el total" "121500.00" \
  "$(q "select monto::text from public.proveedor_cc_movimientos where compra_id=(select id from public.compras where numero_comprobante='A-0001-CMP1')")"

echo "── 2. Montos inválidos ───────────────────────────────────"
for caso in "-100,0,0|negativo" "0,0,0|total cero" "999999999,999999999,0|absurdo"; do
  vals="${caso%%|*}"; nombre="${caso##*|}"
  IFS=',' read -r a b c <<< "$vals"
  out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.crear_compra('$PROV'::uuid,'$SUC'::uuid,'FACTURA_A','A-BAD-$nombre',
  current_date, NULL, $a, $b, $c, '[]'::jsonb, 'CTA_CTE', NULL);
SQL
)
  if echo "$out" | grep -qi "ERROR"; then echo "  ✓ rechaza monto $nombre"; else echo "  ✗ aceptó monto $nombre"; fallos=$((fallos+1)); fi
done

echo "── 3. Comprobante duplicado sigue rechazado ──────────────"
out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.crear_compra('$PROV'::uuid,'$SUC'::uuid,'FACTURA_A','A-0001-CMP1',
  current_date, NULL, 100, 21, 0, '[]'::jsonb, 'CTA_CTE', NULL);
SQL
)
if echo "$out" | grep -qi "ERROR"; then echo "  ✓ no deja cargar dos veces la misma factura"; else echo "  ✗ aceptó duplicado"; fallos=$((fallos+1)); fi

echo "── 4. El PUENTE (firma vieja) no mueve stock ─────────────"
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.crear_compra(
  '$PROV'::uuid, '$SUC'::uuid, 'FACTURA_A', 'A-0001-PUENTE',
  current_date, NULL,
  jsonb_build_array(jsonb_build_object(
    'producto_id', (SELECT id FROM public.productos WHERE codigo='CMP-TEST'),
    'cantidad', 10, 'costo_unitario_sin_iva', 100, 'iva_porcentaje', 21)),
  '[]'::jsonb, 0, 'CTA_CTE', NULL);
SQL
chequear "el puente guarda la compra" "1" "$(q "select count(*)::text from public.compras where numero_comprobante='A-0001-PUENTE'")"
chequear "el puente deriva el total (1000 + 210)" "1210.00" \
  "$(q "select total::text from public.compras where numero_comprobante='A-0001-PUENTE'")"
chequear "el puente NO mueve stock" "0" \
  "$(q "select count(*)::text from public.stock_movimientos m join public.productos p on p.id=m.producto_id where p.codigo='CMP-TEST'")"
chequear "el puente NO escribe ítems" "0" \
  "$(q "select count(*)::text from public.compra_items ci join public.compras c on c.id=ci.compra_id where c.numero_comprobante='A-0001-PUENTE'")"

echo "── 5. anular_compra sin ítems: deuda sí, stock no ────────"
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.anular_compra((SELECT id FROM public.compras WHERE numero_comprobante='A-0001-CMP1'));
SQL
chequear "la compra queda ANULADA" "ANULADA" \
  "$(q "select estado from public.compras where numero_comprobante='A-0001-CMP1'")"
chequear "la deuda se anula" "ANULADO" \
  "$(q "select estado from public.proveedor_cc_movimientos where compra_id=(select id from public.compras where numero_comprobante='A-0001-CMP1')")"
chequear "sigue sin tocar stock" "0" \
  "$(q "select count(*)::text from public.stock_movimientos m join public.productos p on p.id=m.producto_id where p.codigo='CMP-TEST'")"

echo "── 6. Pago a proveedor: número y saldo congelado ─────────"
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.registrar_pago_proveedor('$PROV'::uuid, '$SUC'::uuid, 500, 'EFECTIVO');
SQL
saldo1=$(q "select saldo_posterior::text from public.proveedor_pagos where proveedor_id='$PROV' order by created_at limit 1")
num1=$(q "select numero from public.proveedor_pagos where proveedor_id='$PROV' order by created_at limit 1")
if [[ "$num1" == *"-PAGO-"* ]]; then echo "  ✓ el pago tiene número ($num1)"; else echo "  ✗ el pago no tiene número — '$num1'"; fallos=$((fallos+1)); fi
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.registrar_pago_proveedor('$PROV'::uuid, '$SUC'::uuid, 300, 'EFECTIVO');
SQL
chequear "el saldo del primer recibo NO cambió con el segundo pago" "$saldo1" \
  "$(q "select saldo_posterior::text from public.proveedor_pagos where proveedor_id='$PROV' order by created_at limit 1")"
chequear "los dos pagos tienen números distintos" "2" \
  "$(q "select count(distinct numero)::text from public.proveedor_pagos where proveedor_id='$PROV'")"

echo "── 7. Validaciones del proveedor (se habían perdido) ─────"
# La reescritura de crear_compra perdió estas dos. Sin ellas se podía generar
# deuda contra un proveedor inactivo o sin cuenta corriente habilitada — y
# habilitarla es una decisión de admin protegida por un trigger, así que
# saltearla por acá la volvía decorativa.
$PSQL -c "INSERT INTO public.proveedores (razon_social, activo, condicion_cta_cte) VALUES ('PROV INACTIVO TEST', false, true), ('PROV SIN CC TEST', true, false);" > /dev/null
INACT=$(q "select id::text from public.proveedores where razon_social='PROV INACTIVO TEST'")
SINCC=$(q "select id::text from public.proveedores where razon_social='PROV SIN CC TEST'")

out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.crear_compra('$INACT'::uuid,'$SUC'::uuid,'FACTURA_A','A-INACT',
  current_date, NULL, 100, 21, 0, '[]'::jsonb, 'CTA_CTE', NULL);
SQL
)
if echo "$out" | grep -qi "inactivo"; then echo "  ✓ rechaza un proveedor inactivo"; else echo "  ✗ aceptó proveedor inactivo"; fallos=$((fallos+1)); fi

out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.crear_compra('$SINCC'::uuid,'$SUC'::uuid,'FACTURA_A','A-SINCC',
  current_date, NULL, 100, 21, 0, '[]'::jsonb, 'CTA_CTE', NULL);
SQL
)
if echo "$out" | grep -qi "cuenta corriente habilitada"; then echo "  ✓ rechaza CTA_CTE sin cuenta corriente habilitada"; else echo "  ✗ aceptó CTA_CTE sin habilitar"; fallos=$((fallos+1)); fi

echo "── 8. El pago escribe la forma de pago en el libro ───────"
# La reescritura también había perdido esto, y Cuentas Corrientes lo muestra.
chequear "el movimiento de cuenta corriente guarda la forma de pago" "EFECTIVO" \
  "$(q "select forma_pago from public.proveedor_cc_movimientos where proveedor_id='$PROV' and tipo='CREDITO' order by created_at limit 1")"

echo "── 9. Un empleado no puede anular ────────────────────────"
out=$($PSQL <<SQL 2>&1 || true
$(auth empleado@local.test)
SELECT public.anular_compra((SELECT id FROM public.compras WHERE numero_comprobante='A-0001-PUENTE'));
SQL
)
if echo "$out" | grep -qi "ERROR"; then echo "  ✓ un empleado no puede anular"; else echo "  ✗ un empleado PUDO anular"; fallos=$((fallos+1)); fi

echo "── Limpieza ──────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.proveedor_cc_movimientos pcm USING public.proveedores p
 WHERE p.id = pcm.proveedor_id AND p.razon_social = 'PROV COMPRAS TEST';
DELETE FROM public.proveedor_pagos pp USING public.proveedores p
 WHERE p.id = pp.proveedor_id AND p.razon_social = 'PROV COMPRAS TEST';
DELETE FROM public.compras c USING public.proveedores p
 WHERE p.id = c.proveedor_id AND p.razon_social = 'PROV COMPRAS TEST';
DELETE FROM public.proveedores WHERE razon_social IN
  ('PROV COMPRAS TEST','PROV INACTIVO TEST','PROV SIN CC TEST');
DELETE FROM public.productos WHERE codigo = 'CMP-TEST';
SQL

if [[ $fallos -eq 0 ]]; then echo -e "\n✅ Todo verde.\n"; else echo -e "\n❌ $fallos fallo(s).\n"; exit 1; fi
