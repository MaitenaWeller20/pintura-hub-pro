#!/usr/bin/env bash
# ============================================================
# La caja no puede quedar en rojo, y el saldo de una venta se cobra.
#
# Ver docs/superpowers/specs/2026-08-04-caja-negativa-y-saldos-de-venta-design.md
#
# Todo corre en TRANSACCIONES QUE SE ABORTAN: cada caso arma su escenario y hace
# ROLLBACK, así el orden de los tests no importa y correrlo dos veces da lo mismo.
#
# Uso:  ./scripts/test-caja-y-saldos.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL="docker exec -i $DB psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAq"

ok=0; fallas=0
paso()  { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
fallo() { printf '  \033[31m✗\033[0m %s\n' "$1"; fallas=$((fallas+1)); }

# Corre SQL que DEBE fallar con un mensaje que contenga $patron.
rechaza() {
  local desc="$1" sql="$2" patron="$3" salida
  if salida=$(printf '%s' "$sql" | $PSQL 2>&1); then
    fallo "$desc — NO fue rechazado"
    return
  fi
  if grep -q "$patron" <<<"$salida"; then paso "$desc"
  else fallo "$desc — rechazado por otro motivo: $(head -1 <<<"$salida")"; fi
}

acepta() {
  local desc="$1" sql="$2" salida
  if salida=$(printf '%s' "$sql" | $PSQL 2>&1); then paso "$desc"
  else fallo "$desc — debería haber pasado: $(head -1 <<<"$salida")"; fi
}

# Devuelve el valor de una consulta y lo compara.
vale() {
  local desc="$1" sql="$2" esperado="$3" got
  got=$(printf '%s' "$sql" | $PSQL 2>&1 | tail -1 | tr -d ' ' || true)
  if [ "$got" = "$esperado" ]; then paso "$desc"
  else fallo "$desc — esperaba '$esperado', dio '$got'"; fi
}

# ------------------------------------------------------------------
# Escenario: un admin, una sucursal, una caja abierta con $10.000.
# Se define una vez y cada test lo arma dentro de su transacción.
# ------------------------------------------------------------------
ESCENARIO=$(cat <<'SQL'
BEGIN;
SET LOCAL ROLE postgres;
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','caja@test.local','x',now(),now(),now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, username, activo, sucursal_id)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','caja_test', true, (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'))
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('aaaaaaaa-0000-0000-0000-000000000001','admin') ON CONFLICT DO NOTHING;
SET LOCAL request.jwt.claims TO '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';

-- Cualquier caja abierta que haya quedado de otra prueba se cierra: hay un
-- UNIQUE de una sola caja ABIERTA por sucursal. Va dentro de la transacción,
-- así que el ROLLBACK lo deshace.
UPDATE public.caja_sesiones SET estado='CERRADA', cerrada_en=now()
 WHERE sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS') AND estado='ABIERTA';

-- Caja abierta con $10.000 de fondo.
INSERT INTO public.caja_sesiones (id, sucursal_id, estado, abierta_por, fondo_inicial)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001',
        (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'), 'ABIERTA',
        'aaaaaaaa-0000-0000-0000-000000000001', 10000);
INSERT INTO public.caja_movimientos (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001','INICIAL','EFECTIVO',10000,'Fondo','aaaaaaaa-0000-0000-0000-000000000001');
SQL
)
SUC="(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS')"
SES="'bbbbbbbb-0000-0000-0000-000000000001'"

echo "== Cuánto hay en la caja =="
vale "efectivo_en_caja ve el fondo inicial" \
  "$ESCENARIO SELECT public.efectivo_en_caja($SES); ROLLBACK;" "10000.00"

vale "coincide con el EFECTIVO de caja_esperado" \
  "$ESCENARIO
   SELECT (public.efectivo_en_caja($SES) = ROUND(((public.caja_esperado($SES)->'EFECTIVO'->>'neto')::numeric), 2));
   ROLLBACK;" "t"

echo
echo "== El guard: gastos =="
rechaza "un gasto en efectivo MAYOR que la caja se rechaza" \
  "$ESCENARIO SELECT public.registrar_gasto($SUC, 15000, 'EFECTIVO', 'flete'); ROLLBACK;" \
  "No hay suficiente efectivo"

acepta "el MISMO gasto por transferencia pasa" \
  "$ESCENARIO SELECT public.registrar_gasto($SUC, 15000, 'TRANSFERENCIA', 'flete'); ROLLBACK;"

acepta "un gasto igual al efectivo disponible pasa (deja la caja en 0)" \
  "$ESCENARIO SELECT public.registrar_gasto($SUC, 10000, 'EFECTIVO', 'flete'); ROLLBACK;"

rechaza "un peso más que eso, no" \
  "$ESCENARIO SELECT public.registrar_gasto($SUC, 10001, 'EFECTIVO', 'flete'); ROLLBACK;" \
  "No hay suficiente efectivo"

vale "después del gasto la caja queda en 0, no en negativo" \
  "$ESCENARIO
   SELECT public.registrar_gasto($SUC, 10000, 'EFECTIVO', 'flete');
   SELECT public.efectivo_en_caja($SES); ROLLBACK;" "0.00"

echo
echo "== El guard: retiros de caja =="
rechaza "un RETIRO en efectivo mayor que la caja se rechaza" \
  "$ESCENARIO SELECT public.registrar_movimiento_caja($SES, 'RETIRO', 'EFECTIVO', 20000, 'retiro'); ROLLBACK;" \
  "No hay suficiente efectivo"

acepta "un RETIRO dentro de lo que hay pasa" \
  "$ESCENARIO SELECT public.registrar_movimiento_caja($SES, 'RETIRO', 'EFECTIVO', 5000, 'retiro'); ROLLBACK;"

acepta "un INGRESO nunca se bloquea (suma)" \
  "$ESCENARIO SELECT public.registrar_movimiento_caja($SES, 'INGRESO', 'EFECTIVO', 999999, 'aporte'); ROLLBACK;"

echo
echo "== El guard: pagos a proveedor =="
PROV="INSERT INTO public.proveedores (id, razon_social, activo, condicion_cta_cte)
      VALUES ('cccccccc-0000-0000-0000-000000000001','PROV TEST', true, true) ON CONFLICT DO NOTHING;"

rechaza "pagarle al proveedor en efectivo más de lo que hay se rechaza" \
  "$ESCENARIO $PROV
   SELECT public.registrar_pago_proveedor('cccccccc-0000-0000-0000-000000000001', $SUC, 50000, 'EFECTIVO');
   ROLLBACK;" "No hay suficiente efectivo"

acepta "el mismo pago por transferencia pasa" \
  "$ESCENARIO $PROV
   SELECT public.registrar_pago_proveedor('cccccccc-0000-0000-0000-000000000001', $SUC, 50000, 'TRANSFERENCIA');
   ROLLBACK;"

echo
echo "== El guard: compras al contado =="
rechaza "una compra contado en efectivo mayor que la caja se rechaza" \
  "$ESCENARIO $PROV
   SELECT * FROM public.crear_compra('cccccccc-0000-0000-0000-000000000001', $SUC, 'FACTURA_A', '0001-1',
     current_date, NULL, 50000, 10500, 0,
     '[{\"forma_pago\":\"EFECTIVO\",\"monto\":60500}]'::jsonb, 'CONTADO', NULL);
   ROLLBACK;" "No hay suficiente efectivo"

acepta "una compra mitad efectivo (dentro de lo que hay) y mitad transferencia pasa" \
  "$ESCENARIO $PROV
   SELECT * FROM public.crear_compra('cccccccc-0000-0000-0000-000000000001', $SUC, 'FACTURA_A', '0001-2',
     current_date, NULL, 50000, 10500, 0,
     '[{\"forma_pago\":\"EFECTIVO\",\"monto\":9000},{\"forma_pago\":\"TRANSFERENCIA\",\"monto\":51500}]'::jsonb,
     'CONTADO', NULL);
   ROLLBACK;"

rechaza "la misma compra pero con la parte en efectivo pasada por un peso" \
  "$ESCENARIO $PROV
   SELECT * FROM public.crear_compra('cccccccc-0000-0000-0000-000000000001', $SUC, 'FACTURA_A', '0001-3',
     current_date, NULL, 50000, 10500, 0,
     '[{\"forma_pago\":\"EFECTIVO\",\"monto\":10001},{\"forma_pago\":\"TRANSFERENCIA\",\"monto\":50499}]'::jsonb,
     'CONTADO', NULL);
   ROLLBACK;" "No hay suficiente efectivo"

echo
echo "== Cobrar el saldo de una venta =="

# Venta al contado de $12.100 (10.000 + IVA) cobrada a medias con $2.000.
VENTA="INSERT INTO public.productos (id, codigo, nombre, precio_sin_iva, iva_porcentaje)
       VALUES ('dddddddd-0000-0000-0000-000000000001','TEST-SALDO','Producto de prueba',10000,21)
       ON CONFLICT (id) DO NOTHING;
       INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
       VALUES ('dddddddd-0000-0000-0000-000000000001', $SUC, 50)
       ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET cantidad = 50;
       CREATE TEMP TABLE t_venta AS
       SELECT venta_id FROM public.crear_venta($SUC, (SELECT id FROM public.clientes WHERE es_generico AND activo ORDER BY razon_social LIMIT 1), 'FACTURA_B', 'CONTADO',
         '[{\"producto_id\":\"dddddddd-0000-0000-0000-000000000001\",\"cantidad\":1,\"precio_unitario_sin_iva\":10000,\"iva_porcentaje\":21}]'::jsonb,
         '[{\"forma_pago\":\"EFECTIVO\",\"monto\":2000}]'::jsonb);"

vale "la venta arranca en PARCIAL con \$10.100 de saldo" \
  "$ESCENARIO $VENTA
   SELECT (SELECT estado_pago FROM public.ventas WHERE id=(SELECT venta_id FROM t_venta))::text
       || '/' || (SELECT ROUND(total - total_pagado,2) FROM public.ventas WHERE id=(SELECT venta_id FROM t_venta))::text;
   ROLLBACK;" "PARCIAL/10100.00"

vale "cobrar el saldo exacto la deja PAGADO" \
  "$ESCENARIO $VENTA
   SELECT estado FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'EFECTIVO', 10100);
   ROLLBACK;" "PAGADO"

vale "cobrar una parte la deja PARCIAL con el saldo bien" \
  "$ESCENARIO $VENTA
   SELECT saldo::text || '/' || estado FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'EFECTIVO', 100);
   ROLLBACK;" "10000.00/PARCIAL"

rechaza "cobrar MÁS que el saldo se rechaza" \
  "$ESCENARIO $VENTA
   SELECT * FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'EFECTIVO', 99999);
   ROLLBACK;" "El vuelto se da en el mostrador"

rechaza "cobrar una venta ya pagada se rechaza" \
  "$ESCENARIO $VENTA
   SELECT * FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'EFECTIVO', 10100);
   SELECT * FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'EFECTIVO', 1);
   ROLLBACK;" "ya está cobrada"

rechaza "CTA_CTE no es forma de pago acá" \
  "$ESCENARIO $VENTA
   SELECT * FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'CTA_CTE', 100);
   ROLLBACK;" "CTA_CTE no es una forma de pago"

# Reintentar con la MISMA clave no puede cobrar dos veces, y tampoco puede
# devolver un error: ante un timeout de red el cliente reintenta, y si le
# contestáramos "error" volvería a intentar una operación que sí había entrado.
vale "la misma clave dos veces cobra UNA sola vez" \
  "$ESCENARIO $VENTA
   SELECT * FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'EFECTIVO', 100, '{}'::jsonb, '11111111-2222-3333-4444-555555555555');
   SELECT * FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'EFECTIVO', 100, '{}'::jsonb, '11111111-2222-3333-4444-555555555555');
   SELECT (SELECT count(*) FROM public.venta_pagos WHERE cobro_idempotency_key='11111111-2222-3333-4444-555555555555')::text
       || '/' || (SELECT total_pagado FROM public.ventas WHERE id=(SELECT venta_id FROM t_venta))::text;
   ROLLBACK;" "1/2100.00"

vale "y el reintento devuelve el estado, no un error" \
  "$ESCENARIO $VENTA
   SELECT * FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'EFECTIVO', 100, '{}'::jsonb, '11111111-2222-3333-4444-555555555555');
   SELECT pagado::text || '/' || estado FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'EFECTIVO', 100, '{}'::jsonb, '11111111-2222-3333-4444-555555555555');
   ROLLBACK;" "2100.00/PARCIAL"

rechaza "cobrar una venta ANULADA se rechaza" \
  "$ESCENARIO $VENTA
   SELECT public.anular_venta((SELECT venta_id FROM t_venta));
   SELECT * FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'EFECTIVO', 100);
   ROLLBACK;" "no se puede cobrar"

vale "el pago del saldo trae SU sesión de caja, no la de la venta" \
  "$ESCENARIO $VENTA
   SELECT * FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'EFECTIVO', 100);
   SELECT (caja_sesion_id IS NOT NULL)::text FROM public.venta_pagos
    WHERE venta_id=(SELECT venta_id FROM t_venta) AND monto=100;
   ROLLBACK;" "true"

vale "la venta aparece en ventas_saldo_pendiente" \
  "$ESCENARIO $VENTA
   SELECT saldo::text FROM public.ventas_saldo_pendiente WHERE venta_id=(SELECT venta_id FROM t_venta);
   ROLLBACK;" "10100.00"

vale "y desaparece cuando se termina de cobrar" \
  "$ESCENARIO $VENTA
   SELECT * FROM public.cobrar_saldo_venta((SELECT venta_id FROM t_venta), 'EFECTIVO', 10100);
   SELECT count(*)::text FROM public.ventas_saldo_pendiente WHERE venta_id=(SELECT venta_id FROM t_venta);
   ROLLBACK;" "0"

echo
echo "== Meta-test: los rechazos son de verdad =="
# Si `rechaza` estuviera roto, TODO lo de arriba sería verde sin probar nada.
salida=$(rechaza "un SELECT que no falla" "SELECT 1;" "cualquier-cosa")
if grep -q "✗" <<<"$salida"; then paso "el helper detecta un falso verde"
else fallo "el helper NO detecta falsos verdes — todos los rechazos son sospechosos"; fi

echo
echo "── resumen ──────────────────"
printf 'ok: %d   fallas: %d\n' "$ok" "$fallas"
[ "$fallas" -eq 0 ] || exit 1
