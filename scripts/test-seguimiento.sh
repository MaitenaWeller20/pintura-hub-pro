#!/usr/bin/env bash
# ============================================================
# e2e SQL de la vista seguimiento_producto (migración 20260729130000).
#   supabase migration up --local && ./scripts/test-seguimiento.sh
# Cubre la §6 del spec 2026-07-29-seguimiento-producto-design.md.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL="docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1"
fallos=0
chequear() {
  if [[ "$2" == "$3" ]]; then echo "  ✓ $1"; else echo "  ✗ $1 — esperaba '$2', obtuvo '$3'"; fallos=$((fallos+1)); fi
}
q() { $PSQL -tAc "$1"; }

echo "── Precondición ──────────────────────────────────────────"
chequear "la vista existe" "1" "$(q "select count(*)::text from pg_views where viewname='seguimiento_producto'")"
# security_invoker NO es opcional: sin eso la vista saltea la RLS de ventas y
# clientes, y un empleado ve los datos de la otra sucursal. Es una fuga.
chequear "la vista tiene security_invoker" "1" \
  "$(q "select count(*)::text from pg_class where relname='seguimiento_producto' and reloptions::text like '%security_invoker=true%'")"
chequear "existe el índice por producto y fecha" "1" \
  "$(q "select count(*)::text from pg_indexes where indexname='idx_stock_mov_producto_fecha'")"

echo "── Sembrando movimientos de los tres tipos ───────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.stock_movimientos m USING public.productos p
 WHERE p.id=m.producto_id AND p.codigo='SEG-TEST';
DELETE FROM public.productos WHERE codigo='SEG-TEST';
DELETE FROM public.clientes WHERE razon_social='CLIENTE SEG TEST';
DELETE FROM public.proveedores WHERE razon_social='PROV SEG TEST';

INSERT INTO public.productos (codigo,nombre,precio_sin_iva,iva_porcentaje)
VALUES ('SEG-TEST','PRODUCTO SEGUIMIENTO',1000,21);
INSERT INTO public.clientes (razon_social) VALUES ('CLIENTE SEG TEST');
INSERT INTO public.proveedores (razon_social) VALUES ('PROV SEG TEST');

-- Una venta a CUENTA CORRIENTE (lo que el cliente nombró específicamente).
INSERT INTO public.ventas (sucursal_id, cliente_id, usuario_id, numero_comprobante,
                           tipo_comprobante, condicion_venta, total)
VALUES ((SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
        (SELECT id FROM public.clientes WHERE razon_social='CLIENTE SEG TEST'),
        (SELECT id FROM auth.users WHERE email='admin@local.test'),
        'SEG-VTA-0001','FACTURA_B','CTA_CTE',1210);

-- Una compra.
INSERT INTO public.compras (proveedor_id, sucursal_id, usuario_id, tipo_comprobante,
                            numero_comprobante, fecha_comprobante, total, condicion)
VALUES ((SELECT id FROM public.proveedores WHERE razon_social='PROV SEG TEST'),
        (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
        (SELECT id FROM auth.users WHERE email='admin@local.test'),
        'FACTURA_A','SEG-CMP-0001',current_date,5000,'CTA_CTE');

INSERT INTO public.stock_movimientos (producto_id, sucursal_id, tipo, cantidad,
                                      cantidad_anterior, cantidad_nueva, referencia_id, created_at)
VALUES
  ((SELECT id FROM public.productos WHERE codigo='SEG-TEST'),
   (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
   'COMPRA', 20, 0, 20,
   (SELECT id FROM public.compras WHERE numero_comprobante='SEG-CMP-0001'), now() - interval '3 days'),
  ((SELECT id FROM public.productos WHERE codigo='SEG-TEST'),
   (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
   'VENTA', -4, 20, 16,
   (SELECT id FROM public.ventas WHERE numero_comprobante='SEG-VTA-0001'), now() - interval '2 days'),
  -- Un ajuste SIN referencia: no puede romper la vista.
  ((SELECT id FROM public.productos WHERE codigo='SEG-TEST'),
   (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
   'AJUSTE', 2, 16, 18, NULL, now() - interval '1 day');
SQL

echo "── La vista resuelve 'con quién' ─────────────────────────"
PID=$(q "select id::text from public.productos where codigo='SEG-TEST'")
chequear "trae los tres movimientos" "3" \
  "$(q "select count(*)::text from public.seguimiento_producto where producto_id='$PID'")"
chequear "la compra dice el proveedor" "PROV SEG TEST" \
  "$(q "select con_quien from public.seguimiento_producto where producto_id='$PID' and tipo='COMPRA'")"
chequear "la venta dice el cliente" "CLIENTE SEG TEST" \
  "$(q "select con_quien from public.seguimiento_producto where producto_id='$PID' and tipo='VENTA'")"
chequear "la venta trae su comprobante" "SEG-VTA-0001" \
  "$(q "select comprobante from public.seguimiento_producto where producto_id='$PID' and tipo='VENTA'")"
chequear "la compra trae su comprobante" "SEG-CMP-0001" \
  "$(q "select comprobante from public.seguimiento_producto where producto_id='$PID' and tipo='COMPRA'")"
chequear "marca la venta a cuenta corriente" "CTA_CTE" \
  "$(q "select condicion_venta from public.seguimiento_producto where producto_id='$PID' and tipo='VENTA'")"

echo "── Un ajuste sin referencia no rompe nada ────────────────"
chequear "el ajuste aparece igual" "1" \
  "$(q "select count(*)::text from public.seguimiento_producto where producto_id='$PID' and tipo='AJUSTE'")"
chequear "el ajuste no inventa un 'con quién'" "" \
  "$(q "select coalesce(con_quien,'') from public.seguimiento_producto where producto_id='$PID' and tipo='AJUSTE'")"

echo "── El saldo de cada línea sale del snapshot ──────────────"
chequear "el saldo del movimiento más nuevo" "18.00" \
  "$(q "select cantidad_nueva::text from public.seguimiento_producto where producto_id='$PID' order by created_at desc, id limit 1")"
chequear "el saldo del más viejo" "20.00" \
  "$(q "select cantidad_nueva::text from public.seguimiento_producto where producto_id='$PID' order by created_at asc, id limit 1")"

echo "── Limpieza ──────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.stock_movimientos m USING public.productos p
 WHERE p.id=m.producto_id AND p.codigo='SEG-TEST';
DELETE FROM public.productos WHERE codigo='SEG-TEST';
DELETE FROM public.ventas WHERE numero_comprobante='SEG-VTA-0001';
DELETE FROM public.compras WHERE numero_comprobante='SEG-CMP-0001';
DELETE FROM public.clientes WHERE razon_social='CLIENTE SEG TEST';
DELETE FROM public.proveedores WHERE razon_social='PROV SEG TEST';
SQL

if [[ $fallos -eq 0 ]]; then echo -e "\n✅ Todo verde.\n"; else echo -e "\n❌ $fallos fallo(s).\n"; exit 1; fi
