#!/usr/bin/env bash
# ============================================================
# e2e SQL de presupuestos (migración 20260729160000).
#   supabase migration up --local && ./scripts/crear-admin-local.sh
#   ./scripts/test-presupuestos.sh
# Cubre la §8 del spec 2026-07-29-presupuestos-design.md.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL="docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1"
fallos=0
chequear() {
  if [[ "$2" == "$3" ]]; then echo "  ✓ $1"; else echo "  ✗ $1 — esperaba '$2', obtuvo '$3'"; fallos=$((fallos+1)); fi
}
q() { $PSQL -tAc "$1"; }
auth() {
  cat <<SQL
SELECT set_config('request.jwt.claims',
  json_build_object('sub',(SELECT id::text FROM auth.users WHERE email='$1'),
                    'role','authenticated')::text, false);
SQL
}

echo "── Sembrando ─────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.presupuesto_items i USING public.presupuestos p
 WHERE p.id=i.presupuesto_id AND p.observaciones IS NOT DISTINCT FROM 'TEST-PRES';
DELETE FROM public.presupuestos WHERE observaciones IS NOT DISTINCT FROM 'TEST-PRES';
-- La corrida anterior dejó una VENTA que referencia el producto: sin borrarla
-- primero, el DELETE del producto choca contra la FK y el script no es
-- repetible. La segunda corrida mediría otra cosa.
DELETE FROM public.venta_pagos vp USING public.ventas v
 WHERE v.id = vp.venta_id AND v.observaciones LIKE 'Presupuesto %-PRES-%';
DELETE FROM public.cuenta_corriente_movimientos ccm USING public.ventas v
 WHERE v.id = ccm.venta_id AND v.observaciones LIKE 'Presupuesto %-PRES-%';
DELETE FROM public.venta_items vi USING public.ventas v
 WHERE v.id = vi.venta_id AND v.observaciones LIKE 'Presupuesto %-PRES-%';
UPDATE public.presupuestos SET estado='ANULADO', venta_id=NULL
 WHERE venta_id IN (SELECT id FROM public.ventas WHERE observaciones LIKE 'Presupuesto %-PRES-%');
DELETE FROM public.ventas WHERE observaciones LIKE 'Presupuesto %-PRES-%';
DELETE FROM public.stock_movimientos m USING public.productos p
 WHERE p.id=m.producto_id AND p.codigo='PRE-TEST';
DELETE FROM public.stock_sucursal s USING public.productos p
 WHERE p.id=s.producto_id AND p.codigo='PRE-TEST';
DELETE FROM public.productos WHERE codigo='PRE-TEST';
DELETE FROM public.clientes WHERE razon_social='CLIENTE PRES TEST';

INSERT INTO public.productos (codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado)
VALUES ('PRE-TEST','PRODUCTO PRESUPUESTO',10000,21,true,false);
INSERT INTO public.clientes (razon_social, condicion_cta_cte) VALUES ('CLIENTE PRES TEST', true);
INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
VALUES ((SELECT id FROM public.productos WHERE codigo='PRE-TEST'),
        (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1), 100)
ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET cantidad = 100;
SQL

SUC=$(q "select id::text from public.sucursales order by numero limit 1")
PROD=$(q "select id::text from public.productos where codigo='PRE-TEST'")
CLI=$(q "select id::text from public.clientes where razon_social='CLIENTE PRES TEST'")

echo "── 1. Crear un presupuesto no toca nada ──────────────────"
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.crear_presupuesto('$SUC'::uuid,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',3,'descuento_porcentaje',10)),
  NULL, 'Juan de la esquina', NULL, 'TEST-PRES');
SQL
PRES=$(q "select id::text from public.presupuestos where observaciones='TEST-PRES'")
chequear "queda guardado" "1" "$(q "select count(*)::text from public.presupuestos where id='$PRES'")"
chequear "tiene número" "1" "$(q "select count(*)::text from public.presupuestos where id='$PRES' and numero like '%-PRES-%'")"
chequear "NO mueve stock" "100.00" \
  "$(q "select cantidad::text from public.stock_sucursal s join public.productos p on p.id=s.producto_id where p.codigo='PRE-TEST'")"
chequear "NO genera deuda" "0" \
  "$(q "select count(*)::text from public.cuenta_corriente_movimientos where cliente_id='$CLI'")"
# El precio lo pone el SERVIDOR: 10000 − 10% = 9000.
chequear "el precio sale del catálogo con el descuento" "9000.00" \
  "$(q "select precio_sin_iva::text from public.presupuesto_items where presupuesto_id='$PRES'")"
chequear "guarda el precio de lista aparte" "10000.00" \
  "$(q "select precio_lista_sin_iva::text from public.presupuesto_items where presupuesto_id='$PRES'")"
chequear "el total es 3 × 9000 + IVA" "32670.00" \
  "$(q "select total::text from public.presupuestos where id='$PRES'")"

echo "── 2. Un precio inventado en el payload se ignora ────────"
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.crear_presupuesto('$SUC'::uuid,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',1,
    'precio_unitario_sin_iva',1,'precio_sin_iva',1)),
  NULL, 'Truchito', NULL, 'TEST-PRES');
SQL
TRUCHO=$(q "select id::text from public.presupuestos where observaciones='TEST-PRES' and nombre_cliente='Truchito'")
chequear "el servidor pone el precio real, no el del payload" "10000.00" \
  "$(q "select precio_sin_iva::text from public.presupuesto_items where presupuesto_id='$TRUCHO'")"

echo "── 3. EL PUNTO: convertir usa el precio PRESUPUESTADO ────"
# Se presupuestó a 9000. Ahora el producto sube a 15000.
$PSQL -c "UPDATE public.productos SET precio_sin_iva = 15000 WHERE codigo='PRE-TEST';" > /dev/null
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.convertir_presupuesto_en_venta('$PRES'::uuid, '$CLI'::uuid,
  'FACTURA_B'::public.tipo_comprobante, 'CTA_CTE'::public.condicion_venta,
  '[]'::jsonb, gen_random_uuid());
SQL
VENTA=$(q "select venta_id::text from public.presupuestos where id='$PRES'")
chequear "la venta usa el precio del presupuesto, no el de hoy" "9000.00" \
  "$(q "select precio_unitario_sin_iva::text from public.venta_items where venta_id='$VENTA'")"
chequear "el presupuesto queda CONVERTIDO" "CONVERTIDO" \
  "$(q "select estado from public.presupuestos where id='$PRES'")"
chequear "y apunta a su venta" "1" \
  "$(q "select count(*)::text from public.presupuestos where id='$PRES' and venta_id is not null")"
echo "── 4. La conversión SÍ es una venta normal ───────────────"
chequear "descuenta stock (100 − 3)" "97.00" \
  "$(q "select cantidad::text from public.stock_sucursal s join public.productos p on p.id=s.producto_id where p.codigo='PRE-TEST'")"
chequear "genera la deuda de cuenta corriente" "1" \
  "$(q "select count(*)::text from public.cuenta_corriente_movimientos where cliente_id='$CLI'")"
chequear "deja kardex de VENTA" "1" \
  "$(q "select count(*)::text from public.stock_movimientos m join public.productos p on p.id=m.producto_id where p.codigo='PRE-TEST' and m.tipo='VENTA'")"

echo "── 5. No se puede convertir dos veces ────────────────────"
out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.convertir_presupuesto_en_venta('$PRES'::uuid, '$CLI'::uuid,
  'FACTURA_B'::public.tipo_comprobante, 'CTA_CTE'::public.condicion_venta, '[]'::jsonb, gen_random_uuid());
SQL
)
if echo "$out" | grep -qi "ya está convertido"; then echo "  ✓ rechaza la segunda conversión"; else echo "  ✗ dejó convertir dos veces"; fallos=$((fallos+1)); fi

echo "── 6. Validaciones y estados ─────────────────────────────"
out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.convertir_presupuesto_en_venta('$TRUCHO'::uuid, NULL,
  'FACTURA_B'::public.tipo_comprobante, 'CONTADO'::public.condicion_venta, '[]'::jsonb, gen_random_uuid());
SQL
)
if echo "$out" | grep -qi "elegir el cliente"; then echo "  ✓ exige cliente al convertir"; else echo "  ✗ convirtió sin cliente"; fallos=$((fallos+1)); fi

out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.anular_presupuesto('$PRES'::uuid);
SQL
)
if echo "$out" | grep -qi "ya se convirtió"; then echo "  ✓ no deja anular uno convertido"; else echo "  ✗ anuló uno convertido"; fallos=$((fallos+1)); fi

$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.anular_presupuesto('$TRUCHO'::uuid);
SQL
chequear "anular uno abierto sí anda" "ANULADO" "$(q "select estado from public.presupuestos where id='$TRUCHO'")"

# El CHECK que hace imposible "convertido pero no se sabe en qué venta".
out=$($PSQL -c "UPDATE public.presupuestos SET estado='CONVERTIDO' WHERE id='$TRUCHO';" 2>&1 || true)
if echo "$out" | grep -qi "presupuesto_convertido_tiene_venta"; then
  echo "  ✓ no se puede quedar CONVERTIDO sin venta"
else echo "  ✗ aceptó CONVERTIDO sin venta"; fallos=$((fallos+1)); fi

echo "── 7. Un empleado no ve los de otra sucursal ─────────────"
otra=$(q "select count(*)::text from public.sucursales")
if [[ "$otra" -gt 1 ]]; then
  emp=$($PSQL -tAc "
$(auth empleado@local.test)
SELECT count(*) FROM public.presupuestos WHERE sucursal_id <> public.current_sucursal_id();" 2>&1 | tail -1)
  chequear "no ve presupuestos de otra sucursal" "0" "$emp"
else
  echo "  · (una sola sucursal en la base local, se saltea)"
fi

echo "── Limpieza ──────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.presupuesto_items i USING public.presupuestos p
 WHERE p.id=i.presupuesto_id AND p.observaciones IS NOT DISTINCT FROM 'TEST-PRES';
DELETE FROM public.presupuestos WHERE observaciones IS NOT DISTINCT FROM 'TEST-PRES';
UPDATE public.productos SET precio_sin_iva = 10000 WHERE codigo='PRE-TEST';
SQL

if [[ $fallos -eq 0 ]]; then echo -e "\n✅ Todo verde.\n"; else echo -e "\n❌ $fallos fallo(s).\n"; exit 1; fi
