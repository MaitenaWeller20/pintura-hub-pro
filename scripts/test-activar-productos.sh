#!/usr/bin/env bash
# ============================================================
# activar_productos: la puerta de vuelta que no existía.
#
# Un producto se da de alta APAGADO cuando entra sin precio (importación de stock
# y alta rápida de ingresos). Hasta el 10/08/2026 nada lo podía prender salvo
# reimportar la lista de precios, y sólo si el precio guardado todavía era 0. La
# clienta les puso precio con "Cambiar precios" (que no toca `activo`) y quedaron
# con precio y apagados: invendibles y sin salida.
#
# El riesgo de esta función es simétrico al de crear_productos_faltantes: no que
# falle, sino que ande de más. Si prende algo sin precio, se vende en $0.
#
# Uso:  ./scripts/test-activar-productos.sh
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/.."

DB="${DB:-supabase_db_local}"
psql_run() { docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAq; }

ok=0; fallas=0
paso()  { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
fallo() { printf '  \033[31m✗\033[0m %s\n' "$1"; fallas=$((fallas+1)); }

ADMIN=$(psql_run <<<"SELECT user_id FROM public.user_roles WHERE role='admin' LIMIT 1;")
EMPLE=$(psql_run <<<"SELECT user_id FROM public.user_roles WHERE role='empleado' LIMIT 1;")
[ -n "$ADMIN" ] || { echo "No hay ningún admin en la base local."; exit 1; }

# Cuatro productos, uno por cada caso que la función tiene que distinguir.
pre() {
cat <<SQL
BEGIN;
SET LOCAL request.jwt.claims TO '{"sub":"$ADMIN","role":"authenticated"}';
SET LOCAL client_min_messages TO WARNING;
DELETE FROM public.productos WHERE codigo LIKE 'ZZ-ACT%';
INSERT INTO public.productos (codigo, nombre, precio_sin_iva, activo, archivado) VALUES
  ('ZZ-ACT-CON',  'Apagado con precio',  6573.34, false, false),
  ('ZZ-ACT-SIN',  'Apagado sin precio',        0, false, false),
  ('ZZ-ACT-ARCH', 'Archivado con precio',  1500, false, true),
  ('ZZ-ACT-YA',   'Ya estaba activo',      1500, true,  false);
SQL
}
IDS="ARRAY(SELECT id FROM public.productos WHERE codigo LIKE 'ZZ-ACT%')"
RES="SELECT (r->>'activados')||','||(r->>'sin_precio')||','||(r->>'archivados')
       FROM public.activar_productos($IDS) r;"

corre() {
  local nombre="$1" cuerpo="$2" esperado="$3" real
  real=$(printf '%s\n%s\nROLLBACK;\n' "$(pre)" "$cuerpo" | psql_run 2>&1 | tail -1)
  real=$(tr -d ' ' <<<"$real")
  if [ "$real" = "$esperado" ]; then paso "$nombre"
  else fallo "$nombre — esperaba «${esperado}», dio «${real}»"; fi
}

echo "== Prende lo que corresponde y sólo eso =="

# LA PRUEBA QUE IMPORTA: de los cuatro, se prende UNO. El sin precio y el
# archivado se cuentan aparte, y el que ya estaba activo no se cuenta en ningún lado.
corre "los cuatro casos de una: 1 activado, 1 sin precio, 1 archivado" "$RES" "1,1,1"

corre "el que se prendió es el que tenía precio" "
SELECT * FROM public.activar_productos($IDS);
SELECT string_agg(codigo||':'||activo, ',' ORDER BY codigo) FROM public.productos WHERE codigo LIKE 'ZZ-ACT%';" \
"ZZ-ACT-ARCH:false,ZZ-ACT-CON:true,ZZ-ACT-SIN:false,ZZ-ACT-YA:true"

corre "no toca el precio ni el archivado de nadie" "
SELECT * FROM public.activar_productos($IDS);
SELECT string_agg(codigo||':'||precio_sin_iva||':'||archivado, ',' ORDER BY codigo) FROM public.productos WHERE codigo LIKE 'ZZ-ACT%';" \
"ZZ-ACT-ARCH:1500.00:true,ZZ-ACT-CON:6573.34:false,ZZ-ACT-SIN:0.00:false,ZZ-ACT-YA:1500.00:false"

# Un centavo ya es precio: el corte es > 0, no >= 1.
corre "un producto a \$0,01 se prende (el corte es mayor a cero)" "
UPDATE public.productos SET precio_sin_iva=0.01 WHERE codigo='ZZ-ACT-SIN';
$RES" "2,0,1"

echo
echo "== Apretar dos veces, ids que no existen, listas vacías =="

corre "la segunda vez ya no hay nada para prender" "
SELECT * FROM public.activar_productos($IDS);
$RES" "0,1,1"

corre "un id que no existe no rompe ni cuenta" "
SELECT (r->>'activados')||','||(r->>'sin_precio')||','||(r->>'archivados')
  FROM public.activar_productos(ARRAY['00000000-0000-0000-0000-000000000000'::uuid]) r;" "0,0,0"

corre "una lista vacía no rompe" "
SELECT (r->>'activados')||','||(r->>'sin_precio')||','||(r->>'archivados')
  FROM public.activar_productos(ARRAY[]::uuid[]) r;" "0,0,0"

corre "NULL no rompe" "
SELECT (r->>'activados')||','||(r->>'sin_precio')||','||(r->>'archivados')
  FROM public.activar_productos(NULL) r;" "0,0,0"

echo
echo "== Lo que se vuelve vendible =="

# El espejo del test de crear_productos_faltantes: ahí se comprueba que NO
# aparezcan en la búsqueda de venta; acá, que después de prenderlos SÍ aparezcan.
corre "el prendido pasa a estar en la búsqueda de /ventas/nueva" "
SELECT * FROM public.activar_productos($IDS);
SELECT count(*) FROM public.productos WHERE codigo LIKE 'ZZ-ACT%' AND activo AND NOT archivado;" "2"

echo
echo "== Permisos =="

if [ -n "$EMPLE" ]; then
  salida=$(printf '%s\nSET LOCAL request.jwt.claims TO %s;\nSELECT * FROM public.activar_productos(%s);\nROLLBACK;\n' \
    "$(pre)" "'{\"sub\":\"$EMPLE\",\"role\":\"authenticated\"}'" "$IDS" | psql_run 2>&1)
  if grep -qi "administrador" <<<"$salida"; then paso "un empleado no puede prender productos"
  else fallo "un EMPLEADO pudo prender productos"; fi

  # Sin sesión no hay auth.uid(): la función es SECURITY DEFINER, o sea que se
  # saltea la RLS. Si no chequeara adentro, un anónimo prendería el catálogo.
  salida=$(printf '%s\nRESET request.jwt.claims;\nSELECT * FROM public.activar_productos(%s);\nROLLBACK;\n' \
    "$(pre)" "$IDS" | psql_run 2>&1)
  if grep -qi "autenticado" <<<"$salida"; then paso "sin sesión tampoco"
  else fallo "SIN SESIÓN se pudieron prender productos"; fi
else
  echo "  (sin empleado en la base local: se saltean las pruebas de permisos)"
fi

echo
echo "── resumen ──────────────────"
printf 'ok: %d   fallas: %d\n' "$ok" "$fallas"
[ "$fallas" -eq 0 ] || exit 1
