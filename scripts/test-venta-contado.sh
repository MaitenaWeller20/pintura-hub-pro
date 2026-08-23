#!/usr/bin/env bash
# ============================================================
# "Al contado se cobra algo" (migraciones 20260729220000 y 20260729230000).
#   supabase migration up --local && ./scripts/crear-admin-local.sh
#   ./scripts/test-venta-contado.sh
#
# Antes, una venta CONTADO sin pagos quedaba PENDIENTE con el stock ya
# descontado: la plata no entraba a la caja ni quedaba como deuda de nadie.
# El pago PARCIAL sí se permite: es el fiado del mostrador, y el saldo se ve.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL="docker exec -i $DB psql -U postgres -d postgres -v ON_ERROR_STOP=1"
fallos=0
chequear() {
  if [[ "$2" == "$3" ]]; then echo "  ✓ $1"; else echo "  ✗ $1 — esperaba '$2', obtuvo '$3'"; fallos=$((fallos+1)); fi
}
rechaza() {  # nombre, texto esperado, salida
  if echo "$3" | grep -qi "$2"; then echo "  ✓ $1"; else echo "  ✗ $1 — no dijo '$2'"; fallos=$((fallos+1)); fi
}
q() { $PSQL -tAc "$1"; }
auth() {
  cat <<SQL
SELECT set_config('request.jwt.claims',
  json_build_object('sub',(SELECT id::text FROM auth.users WHERE email='$1'),
                    'role','authenticated')::text, false);
SQL
}
stock() { q "select cantidad::text from public.stock_sucursal s join public.productos p on p.id=s.producto_id where p.codigo='CONT-TEST'"; }

echo "── Sembrando ─────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.venta_pagos vp USING public.ventas v
 WHERE v.id=vp.venta_id AND v.observaciones = 'TEST-CONTADO';
DELETE FROM public.cuenta_corriente_movimientos c USING public.ventas v
 WHERE v.id=c.venta_id AND v.observaciones = 'TEST-CONTADO';
DELETE FROM public.venta_items vi USING public.ventas v
 WHERE v.id=vi.venta_id AND v.observaciones = 'TEST-CONTADO';
DELETE FROM public.ventas WHERE observaciones = 'TEST-CONTADO';
DELETE FROM public.stock_movimientos m USING public.productos p
 WHERE p.id=m.producto_id AND p.codigo IN ('CONT-TEST','CONT-CERO');
DELETE FROM public.stock_sucursal s USING public.productos p
 WHERE p.id=s.producto_id AND p.codigo IN ('CONT-TEST','CONT-CERO');
DELETE FROM public.productos WHERE codigo IN ('CONT-TEST','CONT-CERO');
DELETE FROM public.clientes WHERE razon_social = 'CLIENTE CONTADO TEST';
DELETE FROM public.caja_movimientos WHERE caja_sesion_id IN (
  SELECT id FROM public.caja_sesiones WHERE abierta_por='a5000000-0000-0000-0000-000000000001'
);
DELETE FROM public.caja_sesiones WHERE abierta_por='a5000000-0000-0000-0000-000000000001';
DELETE FROM public.user_roles WHERE user_id='a5000000-0000-0000-0000-000000000001';
DELETE FROM public.profiles WHERE id='a5000000-0000-0000-0000-000000000001';
DELETE FROM auth.users WHERE id='a5000000-0000-0000-0000-000000000001';

INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  'a5000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'contado-admin@local.test','x',now(),now(),now()
);
UPDATE public.profiles
   SET username='t5-admin',nombre_completo='Admin test',
       sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),activo=true
 WHERE id='a5000000-0000-0000-0000-000000000001';
INSERT INTO public.user_roles(user_id,role)
VALUES ('a5000000-0000-0000-0000-000000000001','admin');

INSERT INTO public.clientes (razon_social, condicion_cta_cte) VALUES ('CLIENTE CONTADO TEST', true);
INSERT INTO public.productos (codigo,nombre,precio_sin_iva,iva_porcentaje)
VALUES ('CONT-TEST','PRODUCTO CONTADO TEST',1000,21),
       ('CONT-CERO','PRODUCTO REGALO TEST',0,21);
INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
SELECT p.id, (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1), 100
  FROM public.productos p WHERE p.codigo IN ('CONT-TEST','CONT-CERO')
ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET cantidad = 100;
SQL

SUC=$(q "select id::text from public.sucursales order by numero limit 1")
CLI=$(q "select id::text from public.clientes where razon_social='CLIENTE CONTADO TEST'")
PROD=$(q "select id::text from public.productos where codigo='CONT-TEST'")
CERO=$(q "select id::text from public.productos where codigo='CONT-CERO'")
ITEMS="jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',2))"
# 2 × 1000 + 21% = 2420

venta() {  # condicion, pagos, tipo
  $PSQL <<SQL 2>&1 || true
$(auth contado-admin@local.test)
SELECT public.crear_venta('$SUC'::uuid,'$CLI'::uuid,'${3:-FACTURA_B}'::public.tipo_comprobante,
  '$1'::public.condicion_venta, $ITEMS, $2, 0, 'TEST-CONTADO', NULL, NULL, NULL, gen_random_uuid());
SQL
}

echo "── 1. Contado sin cobrar nada ────────────────────────────"
s0=$(stock)
out=$(venta CONTADO "'[]'::jsonb")
rechaza "rechaza la venta al contado sin cobrar nada" "aunque sea una parte" "$out"
rechaza "y le dice qué hacer" "cuenta corriente" "$out"
chequear "no movió el stock" "$s0" "$(stock)"

echo "── 2. Contado a medio pagar (SÍ se permite) ──────────────"
venta CONTADO "jsonb_build_array(jsonb_build_object('forma_pago','EFECTIVO','monto',1000))" > /dev/null
chequear "la venta parcial entra" "PARCIAL" \
  "$(q "select estado_pago::text from public.ventas where observaciones='TEST-CONTADO'")"
chequear "registra lo que se cobró" "1000.00" \
  "$(q "select total_pagado::text from public.ventas where observaciones='TEST-CONTADO'")"
chequear "el saldo queda a la vista (2420 − 1000)" "1420.00" \
  "$(q "select (total - total_pagado)::text from public.ventas where observaciones='TEST-CONTADO'")"
chequear "y la mercadería salió (100 − 2)" "98.00" "$(stock)"
# La siguiente sección cuenta ventas: dejo la mesa limpia.
$PSQL > /dev/null <<SQL
DELETE FROM public.venta_pagos vp USING public.ventas v
 WHERE v.id=vp.venta_id AND v.observaciones='TEST-CONTADO';
DELETE FROM public.venta_items vi USING public.ventas v
 WHERE v.id=vi.venta_id AND v.observaciones='TEST-CONTADO';
DELETE FROM public.ventas WHERE observaciones='TEST-CONTADO';
UPDATE public.stock_sucursal SET cantidad = 100
 WHERE producto_id = '$PROD';
SQL

echo "── 3. Contado cobrado entero ─────────────────────────────"
venta CONTADO "jsonb_build_array(jsonb_build_object('forma_pago','EFECTIVO','monto',2420))" > /dev/null
chequear "la venta queda PAGADA" "PAGADO" \
  "$(q "select estado_pago::text from public.ventas where observaciones='TEST-CONTADO'")"
chequear "y ahí sí descontó stock (100 − 2)" "98.00" "$(stock)"
chequear "la plata entró a la caja" "2420.00" \
  "$(q "select coalesce(sum(vp.monto),0)::text from public.venta_pagos vp join public.ventas v on v.id=vp.venta_id where v.observaciones='TEST-CONTADO'")"

echo "── 4. Lo que NO se toca ──────────────────────────────────"
# Cuenta corriente sin pagos: es exactamente para lo que está.
$PSQL > /dev/null <<SQL
$(auth contado-admin@local.test)
SELECT public.crear_venta('$SUC'::uuid,'$CLI'::uuid,'FACTURA_B'::public.tipo_comprobante,
  'CTA_CTE'::public.condicion_venta, $ITEMS, '[]'::jsonb, 0, 'TEST-CONTADO', NULL, NULL, NULL, gen_random_uuid());
SQL
chequear "cuenta corriente sin pagos sigue andando" "2" \
  "$(q "select count(*)::text from public.ventas where observaciones='TEST-CONTADO'")"
chequear "y generó la deuda" "1" \
  "$(q "select count(*)::text from public.cuenta_corriente_movimientos c join public.ventas v on v.id=c.venta_id where v.observaciones='TEST-CONTADO'")"

# Un pago de más sigue dando vuelto, no error.
out=$(venta CONTADO "jsonb_build_array(jsonb_build_object('forma_pago','EFECTIVO','monto',3000))")
if echo "$out" | grep -qi "aunque sea una parte"; then echo "  ✗ rechazó un pago con vuelto"; fallos=$((fallos+1)); else echo "  ✓ el pago con vuelto sigue pasando"; fi

# Un comprobante en cero no necesita cobro.
out=$($PSQL <<SQL 2>&1 || true
$(auth contado-admin@local.test)
SELECT public.crear_venta('$SUC'::uuid,'$CLI'::uuid,'FAC_INTERNA_CTA_CTE'::public.tipo_comprobante,
  'CONTADO'::public.condicion_venta,
  jsonb_build_array(jsonb_build_object('producto_id','$CERO','cantidad',1)),
  '[]'::jsonb, 0, 'TEST-CONTADO', NULL, NULL, NULL, gen_random_uuid());
SQL
)
if echo "$out" | grep -qi "aunque sea una parte"; then echo "  ✗ rechazó un comprobante en cero"; fallos=$((fallos+1)); else echo "  ✓ el comprobante en cero no pide cobro"; fi

# Una nota de crédito a CUENTA CORRIENTE se acredita al saldo: no se paga en el
# momento y no pide cobro.
FAC=$($PSQL -tA <<SQL 2>&1 | tail -1
$(auth contado-admin@local.test)
SELECT venta_id::text FROM public.crear_venta('$SUC'::uuid,'$CLI'::uuid,'FACTURA_B'::public.tipo_comprobante,
  'CONTADO'::public.condicion_venta,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',1)),
  jsonb_build_array(jsonb_build_object('forma_pago','EFECTIVO','monto',1210)), 0,
  'TEST-CONTADO', NULL, NULL, NULL, gen_random_uuid());
SQL
)
out=$($PSQL <<SQL 2>&1 || true
$(auth contado-admin@local.test)
SELECT public.crear_venta('$SUC'::uuid,'$CLI'::uuid,'NOTA_CREDITO'::public.tipo_comprobante,
  'CTA_CTE'::public.condicion_venta,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',1)),
  '[]'::jsonb, 0, 'TEST-CONTADO', NULL, NULL, '$FAC'::uuid, gen_random_uuid());
SQL
)
if echo "$out" | grep -qi "ERROR"; then echo "  ✗ rechazó una nota de crédito a cuenta corriente"; fallos=$((fallos+1)); else echo "  ✓ la nota de crédito a cuenta corriente no pide cobro"; fi

# Pero AL CONTADO sí: es el espejo de la regla de arriba (migración 20260813120000).
# Sin ningún pago no le devuelve la plata al cliente ni le acredita saldo — repone
# stock y baja el facturado, y la plata no queda en ningún lado.
#
# Ojo con cómo se chequea: antes esto buscaba sólo "aunque sea una parte" y, al
# cambiar la regla, el mensaje nuevo no matcheaba y el test seguía en verde
# afirmando lo contrario de lo que pasaba. Ahora se busca el mensaje que
# corresponde.
out=$($PSQL <<SQL 2>&1 || true
$(auth contado-admin@local.test)
SELECT public.crear_venta('$SUC'::uuid,'$CLI'::uuid,'NOTA_CREDITO'::public.tipo_comprobante,
  'CONTADO'::public.condicion_venta,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',1)),
  '[]'::jsonb, 0, 'TEST-CONTADO', NULL, NULL, '$FAC'::uuid, gen_random_uuid());
SQL
)
if echo "$out" | grep -qi "devuelve la plata al cliente"; then echo "  ✓ la nota de crédito al contado pide con qué devolver"; else echo "  ✗ dejó pasar una nota al contado sin devolver nada"; fallos=$((fallos+1)); fi

echo "── 5. Limpieza ───────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.venta_pagos vp USING public.ventas v
 WHERE v.id=vp.venta_id AND v.observaciones = 'TEST-CONTADO';
DELETE FROM public.cuenta_corriente_movimientos c USING public.ventas v
 WHERE v.id=c.venta_id AND v.observaciones = 'TEST-CONTADO';
DELETE FROM public.venta_items vi USING public.ventas v
 WHERE v.id=vi.venta_id AND v.observaciones = 'TEST-CONTADO';
DELETE FROM public.ventas WHERE observaciones = 'TEST-CONTADO';
DELETE FROM public.stock_movimientos m USING public.productos p
 WHERE p.id=m.producto_id AND p.codigo IN ('CONT-TEST','CONT-CERO');
DELETE FROM public.stock_sucursal s USING public.productos p
 WHERE p.id=s.producto_id AND p.codigo IN ('CONT-TEST','CONT-CERO');
DELETE FROM public.productos WHERE codigo IN ('CONT-TEST','CONT-CERO');
DELETE FROM public.clientes WHERE razon_social = 'CLIENTE CONTADO TEST';
DELETE FROM public.caja_movimientos WHERE caja_sesion_id IN (
  SELECT id FROM public.caja_sesiones WHERE abierta_por='a5000000-0000-0000-0000-000000000001'
);
DELETE FROM public.caja_sesiones WHERE abierta_por='a5000000-0000-0000-0000-000000000001';
DELETE FROM public.user_roles WHERE user_id='a5000000-0000-0000-0000-000000000001';
DELETE FROM public.profiles WHERE id='a5000000-0000-0000-0000-000000000001';
DELETE FROM auth.users WHERE id='a5000000-0000-0000-0000-000000000001';
SQL

if [[ $fallos -eq 0 ]]; then echo "✅ Todo verde."; else echo "❌ $fallos fallo(s)."; exit 1; fi
