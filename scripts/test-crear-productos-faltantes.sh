#!/usr/bin/env bash
# ============================================================
# crear_productos_faltantes: que entren para contar, y NO para vender.
#
# El riesgo de esta función no es que falle, es que ande de más: da de alta
# productos SIN PRECIO. Si quedaran vendibles, alguien los factura en $0 y se
# entera al cerrar el mes.
#
# Por eso el test central no es "los crea", es la asimetría:
#   aparece en `stock_inventario` (se puede contar)  ✔
#   NO aparece en la búsqueda de venta (activo=false) ✔
#
# Uso:  ./scripts/test-crear-productos-faltantes.sh
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

pre() {
cat <<SQL
BEGIN;
SET LOCAL request.jwt.claims TO '{"sub":"$ADMIN","role":"authenticated"}';
SET LOCAL client_min_messages TO WARNING;
DELETE FROM public.productos WHERE codigo LIKE 'ZZ-FALT%';
SQL
}
corre() {
  local nombre="$1" cuerpo="$2" esperado="$3" real
  real=$(printf '%s\n%s\nROLLBACK;\n' "$(pre)" "$cuerpo" | psql_run 2>&1 | tail -1)
  real=$(tr -d ' ' <<<"$real")
  if [ "$real" = "$esperado" ]; then paso "$nombre"
  else fallo "$nombre — esperaba «${esperado}», dio «${real}»"; fi
}
rechaza() {
  local nombre="$1" cuerpo="$2" frag="$3" salida
  salida=$(printf '%s\n%s\nROLLBACK;\n' "$(pre)" "$cuerpo" | psql_run 2>&1)
  if grep -qi -- "$frag" <<<"$salida"; then paso "$nombre"
  else fallo "$nombre — no dijo «${frag}». Dijo: $(tail -2 <<<"$salida" | tr '\n' ' ')"; fi
}

DOS="jsonb_build_array(
  jsonb_build_object('codigo','ZZ-FALT-1','nombre','HIDROMEX x 1'),
  jsonb_build_object('codigo','ZZ-FALT-2','nombre','HIDROMEX x 5'))"

echo "== Los crea =="

corre "crea los que no estaban (creados, ya_estaban, rechazados)" "
SELECT creados||','||ya_estaban||','||rechazados FROM public.crear_productos_faltantes($DOS);" "2,0,0"

corre "apretar dos veces no duplica" "
SELECT * FROM public.crear_productos_faltantes($DOS);
SELECT creados||','||ya_estaban||','||rechazados FROM public.crear_productos_faltantes($DOS);" "0,2,0"

corre "no pisa un producto que ya existe con precio puesto" "
INSERT INTO public.productos (codigo, nombre, precio_sin_iva, activo) VALUES ('ZZ-FALT-1','Nombre de antes',9999,true);
SELECT * FROM public.crear_productos_faltantes($DOS);
SELECT nombre||'/'||precio_sin_iva||'/'||activo FROM public.productos WHERE codigo='ZZ-FALT-1';" "Nombredeantes/9999.00/true"

echo
echo "== La asimetría: se cuentan, no se venden =="

corre "quedan INACTIVOS (no vendibles) y SIN archivar (contables)" "
SELECT * FROM public.crear_productos_faltantes($DOS);
SELECT string_agg(activo::text||'/'||archivado::text, ',' ORDER BY codigo) FROM public.productos WHERE codigo LIKE 'ZZ-FALT%';" "false/false,false/false"

# LA PRUEBA QUE IMPORTA. Si esto se rompe, el conteo no los ve y todo el
# ejercicio no sirvió para nada.
corre "SÍ aparecen en el inventario, listos para contar" "
SELECT * FROM public.crear_productos_faltantes($DOS);
SELECT count(*) FROM public.stock_inventario WHERE codigo LIKE 'ZZ-FALT%'
  AND sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');" "2"

# El espejo: la búsqueda de /ventas/nueva filtra por activo.
corre "NO aparecen en la búsqueda de venta" "
SELECT * FROM public.crear_productos_faltantes($DOS);
SELECT count(*) FROM public.productos WHERE codigo LIKE 'ZZ-FALT%' AND activo=true AND archivado=false;" "0"

corre "y se venden recién cuando alguien les pone precio y los activa" "
SELECT * FROM public.crear_productos_faltantes($DOS);
UPDATE public.productos SET precio_sin_iva=1500, activo=true WHERE codigo='ZZ-FALT-1';
SELECT count(*) FROM public.productos WHERE codigo LIKE 'ZZ-FALT%' AND activo=true AND archivado=false;" "1"

echo
echo "== Lo que rechaza =="

corre "la fila fantasma del reporte de 3C (código «-»)" "
SELECT creados||','||ya_estaban||','||rechazados FROM public.crear_productos_faltantes(
  jsonb_build_array(jsonb_build_object('codigo','-','nombre','-')));" "0,0,1"

corre "código o nombre vacíos" "
SELECT creados||','||ya_estaban||','||rechazados FROM public.crear_productos_faltantes(
  jsonb_build_array(
    jsonb_build_object('codigo','','nombre','Algo'),
    jsonb_build_object('codigo','ZZ-FALT-9','nombre','   '),
    jsonb_build_object('codigo','ZZ-FALT-8','nombre','Bien')));" "1,0,2"

rechaza "una lista vacía" "
SELECT * FROM public.crear_productos_faltantes('[]'::jsonb);" "ningún producto"

if [ -n "$EMPLE" ]; then
  salida=$(printf 'BEGIN;\nSET LOCAL request.jwt.claims TO %s;\nSELECT * FROM public.crear_productos_faltantes(%s);\nROLLBACK;\n' \
    "'{\"sub\":\"$EMPLE\",\"role\":\"authenticated\"}'" "$DOS" | psql_run 2>&1)
  if grep -qi "administrador" <<<"$salida"; then paso "un empleado no puede dar de alta en lote"
  else fallo "un EMPLEADO pudo dar de alta productos en lote"; fi
else
  echo "  (sin empleado en la base local: se saltea la prueba de permisos)"
fi

echo
echo "── resumen ──────────────────"
printf 'ok: %d   fallas: %d\n' "$ok" "$fallas"
[ "$fallas" -eq 0 ] || exit 1
