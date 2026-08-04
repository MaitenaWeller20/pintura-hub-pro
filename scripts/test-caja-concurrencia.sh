#!/usr/bin/env bash
# ============================================================
# Concurrencia de la caja: lo que los tests secuenciales NO pueden probar.
#
# El bug que el guard viene a cerrar es un TOCTOU — verificar y después
# descontar. Un test secuencial nunca lo reproduce: hacen falta DOS sesiones de
# verdad, arrancando a la vez contra la misma caja.
#
# Y de paso prueba el orden de locks. `registrar_movimiento_caja` tomaba la fila
# de la caja y DESPUÉS el advisory de la sucursal, al revés que
# caja_sesion_actual() — un ABBA de manual. Con el orden mal, este script
# deadlockea; con el orden bien, pasa.
#
# Uso:  ./scripts/test-caja-concurrencia.sh
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/.."

DB="${DB:-supabase_db_local}"
psql_run() { docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAq; }

ok=0; fallas=0
paso()  { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
fallo() { printf '  \033[31m✗\033[0m %s\n' "$1"; fallas=$((fallas+1)); }

UID_TEST='aaaaaaaa-0000-0000-0000-000000000009'
SES='dddddddd-9999-0000-0000-000000000001'

preparar() {
  psql_run <<SQL
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
VALUES ('$UID_TEST','00000000-0000-0000-0000-000000000000','authenticated','authenticated','conc@test.local','x',now(),now(),now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, username, activo, sucursal_id)
VALUES ('$UID_TEST','conc_test', true, (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'))
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('$UID_TEST','admin') ON CONFLICT DO NOTHING;

DELETE FROM public.caja_movimientos WHERE caja_sesion_id = '$SES';
DELETE FROM public.caja_sesiones WHERE id = '$SES';
UPDATE public.caja_sesiones SET estado='CERRADA', cerrada_en=now()
 WHERE sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS') AND estado='ABIERTA';
INSERT INTO public.caja_sesiones (id, sucursal_id, estado, abierta_por, fondo_inicial)
VALUES ('$SES', (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'), 'ABIERTA', '$UID_TEST', 10000);
INSERT INTO public.caja_movimientos (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
VALUES ('$SES','INICIAL','EFECTIVO',10000,'Fondo','$UID_TEST');
SQL
}

limpiar() {
  psql_run <<SQL >/dev/null 2>&1
DELETE FROM public.caja_movimientos WHERE caja_sesion_id = '$SES';
DELETE FROM public.caja_sesiones WHERE id = '$SES';
DELETE FROM public.user_roles WHERE user_id = '$UID_TEST';
DELETE FROM public.profiles WHERE id = '$UID_TEST';
DELETE FROM auth.users WHERE id = '$UID_TEST';
SQL
}

# Un gasto de $7.000 que se toma su tiempo adentro de la transacción, para que
# las dos sesiones se pisen de verdad.
gasto_lento() {
  local espera="$1" salida
  salida=$(psql_run <<SQL 2>&1
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"$UID_TEST","role":"authenticated"}';
SELECT pg_sleep($espera);
SELECT public.registrar_gasto(
  (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'), 7000, 'EFECTIVO', 'gasto concurrente');
SELECT pg_sleep(1);
COMMIT;
SQL
)
  if grep -qi "error" <<<"$salida"; then echo "RECHAZADO"; else echo "OK"; fi
}

echo "== Dos gastos simultáneos de \$7.000 contra una caja de \$10.000 =="
echo "   (sólo uno puede entrar: 7.000 + 7.000 = 14.000 > 10.000)"
preparar >/dev/null

gasto_lento 0    > /tmp/conc_a 2>&1 &
pa=$!
gasto_lento 0.15 > /tmp/conc_b 2>&1 &
pb=$!
wait $pa || true
wait $pb || true
echo "   sesión A: $(cat /tmp/conc_a)   ·   sesión B: $(cat /tmp/conc_b)"

# Lo que se mide es el RESULTADO en la base, no lo que dijo cada sesión.
efectivo=$(psql_run <<SQL
SELECT public.efectivo_en_caja('$SES');
SQL
)
gastos=$(psql_run <<SQL
SELECT count(*) FROM public.caja_movimientos WHERE caja_sesion_id='$SES' AND tipo='GASTO';
SQL
)

efectivo=$(tr -d ' ' <<<"$efectivo"); gastos=$(tr -d ' ' <<<"$gastos")
echo "   gastos que entraron: $gastos   ·   efectivo final: $efectivo"

if [ "$gastos" -le 1 ]; then paso "no entraron los dos gastos"
else fallo "entraron $gastos gastos: el TOCTOU sigue abierto"; fi

# Lo que de verdad importa: la caja NUNCA queda negativa.
if awk "BEGIN{exit !($efectivo >= 0)}"; then paso "la caja no quedó en negativo (quedó $efectivo)"
else fallo "la caja quedó NEGATIVA en $efectivo"; fi

echo
echo "== Orden de locks: gasto + movimiento de caja a la vez =="
preparar >/dev/null

# registrar_movimiento_caja toma la fila; registrar_gasto va por caja_sesion_actual
# (advisory). Si el orden no fuera uniforme, esto deadlockea.
(psql_run <<SQL >/tmp/conc_mov 2>&1
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"$UID_TEST","role":"authenticated"}';
SELECT public.registrar_movimiento_caja('$SES','RETIRO','EFECTIVO', 1000, 'retiro concurrente');
SELECT pg_sleep(1.5);
COMMIT;
SQL
) &
pidm=$!
sleep 0.3
psql_run <<SQL >/tmp/conc_gasto 2>&1
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"$UID_TEST","role":"authenticated"}';
SELECT public.registrar_gasto(
  (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'), 500, 'EFECTIVO', 'gasto concurrente 2');
COMMIT;
SQL
wait $pidm 2>/dev/null || true

if grep -qi "deadlock" /tmp/conc_mov /tmp/conc_gasto 2>/dev/null; then
  fallo "DEADLOCK detectado — el orden de locks no es uniforme"
  grep -i "deadlock" /tmp/conc_mov /tmp/conc_gasto | head -2
else
  paso "sin deadlock entre registrar_movimiento_caja y registrar_gasto"
fi

limpiar
rm -f /tmp/conc_mov /tmp/conc_gasto /tmp/conc_a /tmp/conc_b
echo
echo "── resumen ──────────────────"
printf 'ok: %d   fallas: %d\n' "$ok" "$fallas"
[ "$fallas" -eq 0 ] || exit 1
