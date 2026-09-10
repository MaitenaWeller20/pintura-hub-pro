#!/usr/bin/env bash
# ============================================================
# e2e SQL de cambiar_precios_masivo (migración 20260729110000) contra la base LOCAL.
#
# Requisito: migración aplicada y usuarios de test creados
#   supabase migration up --local
#   ./scripts/crear-admin-local.sh
#   ./scripts/crear-admin-local.sh empleado@local.test empleado1234
#
# Cubre la §8 del spec 2026-07-29-proveedor-en-productos-design.md.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL="docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1"

echo "── Precondición ──────────────────────────────────────────"
$PSQL <<'SQL'
DO $pre$
BEGIN
  IF to_regprocedure('public.cambiar_precios_masivo(uuid[],text,numeric,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Falta la migración 20260729110000.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email='admin@local.test') THEN
    RAISE EXCEPTION 'Falta admin@local.test. Corré ./scripts/crear-admin-local.sh';
  END IF;
  RAISE NOTICE 'OK.';
END $pre$;
SQL

echo "── Sembrando ─────────────────────────────────────────────"
$PSQL <<'SQL'
DELETE FROM public.productos WHERE codigo LIKE 'MAS-%';
DELETE FROM public.proveedores WHERE razon_social IN ('TEST KUM','TEST QUIMEX');
-- Todas las claves del test, para que el script sea repetible. Sin esto, la
-- segunda corrida recibe ya_aplicado y los checks miden otra cosa.
DELETE FROM public.precio_operaciones
 WHERE idempotency_key::text ~ '^(1{8}|2{8}|3{8}|4{8}|5{8}|6{8}|7{8})-';

INSERT INTO public.proveedores (razon_social, descuento_porcentaje) VALUES ('TEST KUM', 35);
INSERT INTO public.proveedores (razon_social, descuento_porcentaje) VALUES ('TEST QUIMEX', NULL);

-- Descuento global (el que hereda TEST QUIMEX) = 42, markup default = 30.
UPDATE public.settings SET descuento_proveedor_porcentaje = 42, markup_default_porcentaje = 30;

INSERT INTO public.productos
  (codigo, nombre, proveedor_id, precio_lista, precio_fabrica, precio_sugerido_publico,
   precio_sin_iva, iva_porcentaje, markup_porcentaje)
VALUES
  -- A: con lista + sugerido, precio DERIVADO del sugerido (34370.60*1.3/1.21)
  ('MAS-A','con sugerido',(SELECT id FROM public.proveedores WHERE razon_social='TEST QUIMEX'),
   30774.40, 17849.15, 34370.60, 36927.09, 21, NULL),
  -- B: con lista, sin sugerido, precio DERIVADO del costo (17849.15*1.3)
  ('MAS-B','sin sugerido',(SELECT id FROM public.proveedores WHERE razon_social='TEST QUIMEX'),
   30774.40, 17849.15, NULL, 23203.90, 21, NULL),
  -- C: precio puesto A MANO (no coincide con ninguna fórmula)
  ('MAS-C','precio a mano',(SELECT id FROM public.proveedores WHERE razon_social='TEST QUIMEX'),
   30774.40, 17849.15, NULL, 99999.00, 21, NULL),
  -- D: sin ninguna base
  ('MAS-D','sin base', NULL, 0, 0, NULL, 5000.00, 21, NULL),
  -- E: proveedor con descuento PROPIO del 35%
  ('MAS-E','de kum',(SELECT id FROM public.proveedores WHERE razon_social='TEST KUM'),
   10000.00, 6500.00, NULL, 8450.00, 21, NULL);
SQL

# Corre la RPC como el admin (auth.uid() sale del JWT; en SQL directo se simula con SET).
rpc() {
  local op="$1" pct="$2" key="$3"
  $PSQL <<SQL
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT id::text FROM auth.users WHERE email='admin@local.test'),
                    'role','authenticated')::text, false);
SELECT public.cambiar_precios_masivo(
  ARRAY(SELECT id FROM public.productos WHERE codigo LIKE 'MAS-%'),
  '$op', $pct, '$key'::uuid);
SQL
}

verificar() {
  $PSQL -tAc "$1"
}

fallos=0
chequear() {
  local nombre="$1" esperado="$2" obtenido="$3"
  if [[ "$esperado" == "$obtenido" ]]; then
    echo "  ✓ $nombre"
  else
    echo "  ✗ $nombre — esperaba '$esperado', obtuvo '$obtenido'"
    fallos=$((fallos+1))
  fi
}

echo "── 1. AUMENTO 20% ────────────────────────────────────────"
res=$(rpc AUMENTO 20 '11111111-1111-1111-1111-111111111111' | grep -o '{.*}' | tail -1)
echo "     $res"

# A: lista 30774.40 -> 36929.28 ; costo RE-DERIVADO 36929.28*0.58 = 21418.98
#    sugerido 34370.60 -> 41244.72 ; venta = 41244.72*1.3/1.21 = 44312.51
chequear "A: la lista sube 20%"           "36929.28" "$(verificar "select precio_lista from productos where codigo='MAS-A'")"
chequear "A: el costo se RE-DERIVA (no se multiplica)" "21418.98" "$(verificar "select precio_fabrica from productos where codigo='MAS-A'")"
chequear "A: el sugerido sube 20%"        "41244.72" "$(verificar "select precio_sugerido_publico from productos where codigo='MAS-A'")"
chequear "A: la venta se recalcula"       "44312.51" "$(verificar "select precio_sin_iva from productos where codigo='MAS-A'")"

# B: costo re-derivado 21418.98 ; venta = 21418.98*1.3 = 27844.67
chequear "B: la venta sale del costo"     "27844.67" "$(verificar "select precio_sin_iva from productos where codigo='MAS-B'")"

# C: precio a mano -> el costo SÍ se actualiza, la venta NO
chequear "C: el costo se actualiza igual" "21418.98" "$(verificar "select precio_fabrica from productos where codigo='MAS-C'")"
chequear "C: la venta a mano NO se pisa"  "99999.00" "$(verificar "select precio_sin_iva from productos where codigo='MAS-C'")"

# D: sin base -> intacto
chequear "D: sin base, no se toca"        "5000.00"  "$(verificar "select precio_sin_iva from productos where codigo='MAS-D'")"

# E: descuento PROPIO 35% -> lista 12000, costo 12000*0.65 = 7800, venta 7800*1.3 = 10140
chequear "E: usa el descuento del proveedor, no el global" "7800.00" "$(verificar "select precio_fabrica from productos where codigo='MAS-E'")"
chequear "E: la venta sigue la cadena"    "10140.00" "$(verificar "select precio_sin_iva from productos where codigo='MAS-E'")"

echo "── 2. Idempotencia ───────────────────────────────────────"
antes=$(verificar "select precio_lista from productos where codigo='MAS-A'")
res2=$(rpc AUMENTO 20 '11111111-1111-1111-1111-111111111111' | grep -o '{.*}' | tail -1)
chequear "misma clave: no vuelve a aplicar" "$antes" "$(verificar "select precio_lista from productos where codigo='MAS-A'")"
if echo "$res2" | grep -q '"ya_aplicado": true'; then echo "  ✓ informa ya_aplicado"; else echo "  ✗ no informa ya_aplicado — $res2"; fallos=$((fallos+1)); fi

echo "── 3. Clave distinta SÍ vuelve a aplicar (+44% total) ────"
rpc AUMENTO 20 '22222222-2222-2222-2222-222222222222' > /dev/null
chequear "clave nueva: se aplica de nuevo" "44315.14" "$(verificar "select precio_lista from productos where codigo='MAS-A'")"

echo "── 4. MARKUP 40% ─────────────────────────────────────────"
rpc MARKUP 40 '33333333-3333-3333-3333-333333333333' > /dev/null
chequear "guarda el markup en todos"      "40.00" "$(verificar "select markup_porcentaje from productos where codigo='MAS-A'")"
chequear "el precio a mano sigue sin pisarse" "99999.00" "$(verificar "select precio_sin_iva from productos where codigo='MAS-C'")"

echo "── 5. RECALCULAR_COSTO ───────────────────────────────────"
$PSQL -c "UPDATE public.proveedores SET descuento_porcentaje = 50 WHERE razon_social='TEST KUM';" > /dev/null
lista_e=$(verificar "select precio_lista from productos where codigo='MAS-E'")
rpc RECALCULAR_COSTO 0 '44444444-4444-4444-4444-444444444444' > /dev/null
chequear "E: el costo sigue el descuento nuevo (50%)" \
  "$(verificar "select round($lista_e * 0.5, 2)")" \
  "$(verificar "select precio_fabrica from productos where codigo='MAS-E'")"
chequear "E: la lista NO se toca"         "$lista_e" "$(verificar "select precio_lista from productos where codigo='MAS-E'")"

echo "── 6. Seguridad y validaciones ───────────────────────────"
emp=$($PSQL -tAc "
SELECT set_config('request.jwt.claims',
  json_build_object('sub',(SELECT id::text FROM auth.users WHERE email='empleado@local.test'),
                    'role','authenticated')::text, false);
SELECT public.cambiar_precios_masivo(
  ARRAY(SELECT id FROM public.productos WHERE codigo='MAS-A'),
  'MARKUP', 10, '55555555-5555-5555-5555-555555555555'::uuid);" 2>&1 || true)
if echo "$emp" | grep -q "administrador"; then echo "  ✓ un empleado no puede"; else echo "  ✗ un empleado PUDO — $emp"; fallos=$((fallos+1)); fi

neg=$(rpc MARKUP -5 '66666666-6666-6666-6666-666666666666' 2>&1 || true)
if echo "$neg" | grep -q "fuera de rango"; then echo "  ✓ rechaza porcentaje negativo"; else echo "  ✗ aceptó negativo"; fallos=$((fallos+1)); fi

desc=$($PSQL -c "UPDATE public.settings SET descuento_proveedor_porcentaje = 142;" 2>&1 || true)
if echo "$desc" | grep -q "settings_descuento_valido"; then echo "  ✓ rechaza un descuento global de 142"; else echo "  ✗ aceptó 142 — $desc"; fallos=$((fallos+1)); fi

# guard_proveedores_credito ya va por su TERCERA versión y cada una la reescribe
# entera con CREATE OR REPLACE. La de 20260729110000 se escribió mirando la
# primera y borró en silencio la protección que había agregado la segunda. Este
# test fija las tres para que no vuelva a pasar.
echo "── 7. La clave está atada a la operación ─────────────────"
# Si el servidor aplicó y el cliente no se enteró, cambiar el % y reintentar con
# la misma clave daba un no-op SILENCIOSO: el cliente creía que se había aplicado
# la operación nueva y no se había aplicado nada.
otra=$(rpc MARKUP 55 '33333333-3333-3333-3333-333333333333' 2>&1 || true)
if echo "$otra" | grep -q "ya se usó para otra operación"; then
  echo "  ✓ la misma clave con otro % es un error, no un no-op silencioso"
else
  echo "  ✗ aceptó la misma clave para otra operación:"; echo "$otra" | tail -4; fallos=$((fallos+1))
fi

echo "── 8. Los contadores dicen lo que pasó de verdad ─────────"
# MAS-D no tiene ni lista ni costo -> sin_base.
# RECALCULAR_COSTO sobre un producto SIN precio de lista no cambia nada: antes se
# contaba como "recalculado" igual.
$PSQL <<'SQL' > /dev/null
UPDATE public.productos SET precio_lista = 0, precio_fabrica = 5000, precio_sin_iva = 6500
 WHERE codigo = 'MAS-B';
SQL
out=$(rpc RECALCULAR_COSTO 0 '77777777-7777-7777-7777-777777777777' | grep -o '{.*}' | tail -1)
campo() { echo "$out" | python3 -c "import json,sys;print(json.load(sys.stdin)['$1'])" 2>/dev/null || echo AUSENTE; }
# A esta altura los costos YA están recalculados (paso 5) y MAS-B quedó sin precio
# de lista, así que esta operación no cambia NADA. El bug que esto fija: antes los
# contaba como "recalculados" igual, porque se calculaban a partir de las
# condiciones y no de lo que el UPDATE había hecho de verdad.
chequear "no dice 'recalculado' cuando no cambió nada" "0" "$(campo actualizados)"
chequear "los cuenta como sin cambio"                  "4" "$(campo sin_cambio)"
chequear "y el que no tiene base, aparte"              "1" "$(campo sin_base)"

echo "── 9. El guard de proveedores protege las TRES cosas ─────"
for campo in "condicion_cta_cte = true" \
             "codigos_coinciden_con_los_propios = true" \
             "descuento_porcentaje = 10"; do
  out=$($PSQL -tAc "
SELECT set_config('request.jwt.claims',
  json_build_object('sub',(SELECT id::text FROM auth.users WHERE email='empleado@local.test'),
                    'role','authenticated')::text, false);
UPDATE public.proveedores SET $campo WHERE razon_social='TEST KUM';" 2>&1 || true)
  if echo "$out" | grep -q "administrador"; then
    echo "  ✓ un empleado no puede cambiar ${campo%% *}"
  else
    echo "  ✗ un empleado PUDO cambiar ${campo%% *} — $out"; fallos=$((fallos+1))
  fi
done

echo "── Limpieza ──────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.productos WHERE codigo LIKE 'MAS-%';
DELETE FROM public.proveedores WHERE razon_social IN ('TEST KUM','TEST QUIMEX');
DELETE FROM public.precio_operaciones
 WHERE idempotency_key::text ~ '^(1{8}|2{8}|3{8}|4{8}|5{8}|6{8}|7{8})-';
SQL

# La ficha nueva nace en 0%. El formulario envía ese 0 explícitamente también
# para empleados, así que el guard debe permitir el valor seguro pero seguir
# reservando cualquier descuento comercial real para administradores.
alta_cero=$($PSQL -tAc "
BEGIN;
SELECT set_config('request.jwt.claims',
  json_build_object('sub',(SELECT id::text FROM auth.users WHERE email='empleado@local.test'),
                    'role','authenticated')::text, true);
INSERT INTO public.proveedores (razon_social, descuento_porcentaje)
VALUES ('TEST EMPLEADO CERO', 0);
SELECT descuento_porcentaje FROM public.proveedores
 WHERE razon_social='TEST EMPLEADO CERO';
ROLLBACK;" 2>&1 || true)
if [[ "$(echo "$alta_cero" | grep -E '^[[:space:]]*0([.]00)?[[:space:]]*$' | tail -1 | tr -d ' ')" =~ ^0([.]00)?$ ]]; then
  echo "  ✓ un empleado puede crear un proveedor con 0%"
else
  echo "  ✗ un empleado no pudo crear un proveedor con 0% — $alta_cero"; fallos=$((fallos+1))
fi

alta_descuento=$($PSQL -tAc "
BEGIN;
SELECT set_config('request.jwt.claims',
  json_build_object('sub',(SELECT id::text FROM auth.users WHERE email='empleado@local.test'),
                    'role','authenticated')::text, true);
INSERT INTO public.proveedores (razon_social, descuento_porcentaje)
VALUES ('TEST EMPLEADO DESCUENTO', 1);
ROLLBACK;" 2>&1 || true)
if echo "$alta_descuento" | grep -q "administrador"; then
  echo "  ✓ un empleado no puede crear un proveedor con descuento"
else
  echo "  ✗ un empleado PUDO crear un proveedor con descuento — $alta_descuento"; fallos=$((fallos+1))
fi

if [[ $fallos -eq 0 ]]; then echo -e "\n✅ Todo verde.\n"; else echo -e "\n❌ $fallos fallo(s).\n"; exit 1; fi
