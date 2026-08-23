#!/usr/bin/env bash
# ============================================================
# Permisos por sección — pruebas contra la base LOCAL.
#
# Lo que se prueba acá es lo ÚNICO que esta feature tiene de seguridad de verdad:
# que un empleado no se pueda auto-otorgar secciones. El resto (menú, guard de
# ruta) es visibilidad y se prueba en Playwright.
#
# Uso:  ./scripts/test-permisos-seccion.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${DB:-supabase_db_local}"
PSQL="docker exec -i $DB psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAq"

ok=0; fallas=0
paso() { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
fallo() { printf '  \033[31m✗\033[0m %s\n' "$1"; fallas=$((fallas+1)); }

# Corre SQL que DEBE fallar. Si no falla, es un bug.
# El centinela NO puede contener ninguna palabra que busquemos después: ya nos
# pasó que un mensaje de "FALLA" contuviera la palabra del guard y 4 tests
# dieran verde por el motivo equivocado.
rechaza() {
  local desc="$1" sql="$2" patron="$3"
  local salida
  if salida=$(echo "$sql" | $PSQL 2>&1); then
    fallo "$desc — NO fue rechazado (debería haber explotado)"
    return
  fi
  if echo "$salida" | grep -q "$patron"; then paso "$desc"
  else fallo "$desc — rechazado, pero por otro motivo: $(echo "$salida" | head -1)"; fi
}

acepta() {
  local desc="$1" sql="$2"
  if echo "$sql" | $PSQL >/dev/null 2>&1; then paso "$desc"
  else fallo "$desc — debería haber pasado"; fi
}

echo "== Preparación =="
$PSQL <<'SQL' >/dev/null
-- Dos usuarios de juguete, sin pasar por auth (sólo se testea el trigger).
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
VALUES ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
        'authenticated','authenticated','emp.secciones@test.local','x', now(), now(), now()),
       ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
        'authenticated','authenticated','adm.secciones@test.local','x', now(), now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, activo)
VALUES ('11111111-1111-1111-1111-111111111111','emp_secciones', true),
       ('22222222-2222-2222-2222-222222222222','adm_secciones', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.user_roles (user_id, role)
VALUES ('11111111-1111-1111-1111-111111111111','empleado'),
       ('22222222-2222-2222-2222-222222222222','admin')
ON CONFLICT DO NOTHING;
SQL
paso "usuarios de prueba creados"

echo
echo "== El CHECK de sanidad =="

rechaza "una key con mayúsculas no entra" "
  UPDATE public.profiles SET secciones = '{VENTAS}'
  WHERE id = '11111111-1111-1111-1111-111111111111';" "profiles_secciones_sanas"

rechaza "una key con barras no entra" "
  UPDATE public.profiles SET secciones = '{\"../../etc\"}'
  WHERE id = '11111111-1111-1111-1111-111111111111';" "profiles_secciones_sanas"

rechaza "un NULL suelto adentro del array no entra" "
  UPDATE public.profiles SET secciones = ARRAY['ventas', NULL]
  WHERE id = '11111111-1111-1111-1111-111111111111';" "profiles_secciones_sanas"

# El regex sobre array_to_string pierde la frontera entre elementos: un solo
# elemento con una coma adentro produce la misma cadena que dos elementos, y se
# colaba. Lo ataja el conteo de pedazos vs elementos.
rechaza "un elemento con una coma adentro no entra" "
  UPDATE public.profiles SET secciones = ARRAY['ventas,stock']
  WHERE id = '11111111-1111-1111-1111-111111111111';" "profiles_secciones_sanas"

rechaza "un profile creado de cero por un empleado no pasa" "
  BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims TO '{\"sub\":\"11111111-1111-1111-1111-111111111111\",\"role\":\"authenticated\"}';
  INSERT INTO public.profiles (id, username, secciones)
  VALUES ('33333333-3333-3333-3333-333333333333','colado','{compras,pagos}');
  COMMIT;" "row-level security"

acepta "NULL (las de siempre) sí" "
  UPDATE public.profiles SET secciones = NULL
  WHERE id = '11111111-1111-1111-1111-111111111111';"

acepta "el array vacío (ninguna sección) sí" "
  UPDATE public.profiles SET secciones = '{}'
  WHERE id = '11111111-1111-1111-1111-111111111111';"

acepta "una lista normal sí" "
  UPDATE public.profiles SET secciones = '{ventas,stock}'
  WHERE id = '11111111-1111-1111-1111-111111111111';"

echo
echo "== El guard: quién puede cambiarlas =="

# `auth.uid()` sale del claim `sub` del JWT. Poniendo el request.jwt.claims a
# mano se simula estar logueado como ese usuario, con su rol de PostgREST.
como() {
  echo "SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claims TO '{\"sub\":\"$1\",\"role\":\"authenticated\"}';"
}

rechaza "un EMPLEADO no puede auto-otorgarse secciones" "
  BEGIN;
  $(como 11111111-1111-1111-1111-111111111111)
  UPDATE public.profiles SET secciones = '{ventas,stock,compras,reportes}'
  WHERE id = '11111111-1111-1111-1111-111111111111';
  COMMIT;" "Sólo un administrador puede cambiar las secciones"

# Sobre OTRO usuario no explota: la policy "user update own profile" hace que el
# UPDATE matchee CERO filas, así que no llega a correr el trigger. El resultado
# es el mismo (no cambia nada) pero la forma es distinta, y un test que espere
# una excepción acá estaría comprobando lo que no es.
$PSQL <<'SQL' >/dev/null
UPDATE public.profiles SET secciones = '{ventas,stock}'
WHERE id = '22222222-2222-2222-2222-222222222222';
SQL
echo "BEGIN;
      $(como 11111111-1111-1111-1111-111111111111)
      UPDATE public.profiles SET secciones = '{compras}'
      WHERE id = '22222222-2222-2222-2222-222222222222';
      COMMIT;" | $PSQL >/dev/null 2>&1 || true
quedo=$($PSQL <<'SQL'
SELECT array_to_string(secciones, ',') FROM public.profiles
WHERE id = '22222222-2222-2222-2222-222222222222';
SQL
)
if [ "$quedo" = "ventas,stock" ]; then
  paso "un EMPLEADO tampoco le cambia las secciones a otro (RLS: 0 filas)"
else
  fallo "un EMPLEADO le cambió las secciones a otro — quedó '$quedo'"
fi

# `acepta` a secas NO alcanza para "un admin puede": la policy de profiles sólo
# permite el UPDATE del perfil PROPIO, así que un admin tocando a otro matchea
# cero filas y el UPDATE "sale bien" sin cambiar nada. Un test que sólo mire el
# código de salida daría verde probando lo contrario de lo que dice.
#
# Por eso el admin se edita a SÍ MISMO (el único camino donde el trigger deja
# pasar a un usuario autenticado) y después se comprueba el valor.
$PSQL <<'SQL' >/dev/null
UPDATE public.profiles SET secciones = NULL
WHERE id = '22222222-2222-2222-2222-222222222222';
SQL
echo "BEGIN;
      $(como 22222222-2222-2222-2222-222222222222)
      UPDATE public.profiles SET secciones = '{ventas,pagos}'
      WHERE id = '22222222-2222-2222-2222-222222222222';
      COMMIT;" | $PSQL >/dev/null 2>&1 || true
quedo=$($PSQL <<'SQL'
SELECT coalesce(array_to_string(secciones, ','), '<null>') FROM public.profiles
WHERE id = '22222222-2222-2222-2222-222222222222';
SQL
)
if [ "$quedo" = "ventas,pagos" ]; then
  paso "un ADMIN sí puede (y el valor cambió de verdad)"
else
  fallo "un ADMIN no pudo cambiar sus secciones — quedó '$quedo'"
fi

# El service_role es el canal de la server function. Acá sí se verifica el valor.
$PSQL <<'SQL' >/dev/null 2>&1 || true
UPDATE public.profiles SET secciones = '{gastos}'
WHERE id = '11111111-1111-1111-1111-111111111111';
SQL
quedo=$($PSQL <<'SQL'
SELECT coalesce(array_to_string(secciones, ','), '<null>') FROM public.profiles
WHERE id = '11111111-1111-1111-1111-111111111111';
SQL
)
if [ "$quedo" = "gastos" ]; then
  paso "el service_role (el backend) sí puede, sobre cualquier usuario"
else
  fallo "el service_role no pudo — quedó '$quedo'"
fi

echo
echo "== Que no se hayan roto los guards viejos =="

rechaza "un empleado sigue sin poder cambiarse de sucursal" "
  BEGIN;
  $(como 11111111-1111-1111-1111-111111111111)
  UPDATE public.profiles SET sucursal_id = (SELECT id FROM public.sucursales LIMIT 1)
  WHERE id = '11111111-1111-1111-1111-111111111111';
  COMMIT;" "Sólo un administrador puede cambiar la sucursal"

rechaza "un empleado sigue sin poder auto-activarse" "
  BEGIN;
  $(como 11111111-1111-1111-1111-111111111111)
  UPDATE public.profiles SET activo = false
  WHERE id = '11111111-1111-1111-1111-111111111111';
  COMMIT;" "transición versionada"

rechaza "un empleado sigue sin poder darse venta sin stock" "
  BEGIN;
  $(como 11111111-1111-1111-1111-111111111111)
  UPDATE public.profiles SET permite_venta_sin_stock = true
  WHERE id = '11111111-1111-1111-1111-111111111111';
  COMMIT;" "Sólo un administrador puede cambiar el permiso de venta sin stock"

rechaza "un empleado sigue sin poder cambiarse el username" "
  BEGIN;
  $(como 11111111-1111-1111-1111-111111111111)
  UPDATE public.profiles SET username = 'otro'
  WHERE id = '11111111-1111-1111-1111-111111111111';
  COMMIT;" "El nombre de usuario no se puede cambiar"

acepta "un empleado SÍ puede seguir editándose el nombre completo" "
  BEGIN;
  $(como 11111111-1111-1111-1111-111111111111)
  UPDATE public.profiles SET nombre_completo = 'Empleado Probado'
  WHERE id = '11111111-1111-1111-1111-111111111111';
  COMMIT;"

echo
echo "== Meta-test: los rechazos son de verdad =="
# Si `rechaza` estuviera roto, todo lo de arriba daría verde sin probar nada. Ya
# pasó en este repo: un centinela que contenía la palabra buscada dio 4 falsos
# verdes seguidos.
#
# La llamada va dentro de $( ), o sea en una SUBSHELL: los contadores que toque
# adentro NO afectan a los de acá. Eso es justo lo que se quiere (la falla es
# esperada y no debe sumar), pero hay que decirlo, porque la primera versión de
# esto restaba 1 "para compensar" y esa resta terminó tapando una falla real.
salida=$(rechaza "un UPDATE que no debería fallar" "
  UPDATE public.profiles SET nombre_completo = 'x'
  WHERE id = '11111111-1111-1111-1111-111111111111';" "cualquier-cosa")
if echo "$salida" | grep -q "✗"; then
  paso "el helper detecta cuando algo NO fue rechazado"
else
  fallo "el helper NO detecta los falsos verdes — todos los rechazos de arriba son sospechosos"
fi

echo
$PSQL <<'SQL' >/dev/null
DELETE FROM public.user_roles WHERE user_id IN
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');
DELETE FROM public.profiles WHERE id IN
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');
DELETE FROM auth.users WHERE id IN
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');
SQL

echo "──────────────────────────────"
printf 'ok: %d   fallas: %d\n' "$ok" "$fallas"
[ "$fallas" -eq 0 ] || exit 1
