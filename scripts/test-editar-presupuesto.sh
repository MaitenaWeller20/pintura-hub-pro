#!/usr/bin/env bash
# ============================================================
# editar_presupuesto: sobre todo, que NO repricie solo.
#
# El riesgo de esta función no es que falle: es que ande y cambie precios que
# nadie pidió cambiar. `convertir_presupuesto_en_venta` factura con
# `presupuesto_items.precio_sin_iva`, así que un reprecio silencioso al corregir
# una cantidad cambia lo que se le cobra al cliente.
#
# Uso:  ./scripts/test-editar-presupuesto.sh
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/.."

DB="${DB:-supabase_db_local}"
psql_run() { docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAq; }

ok=0; fallas=0
paso()  { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
fallo() { printf '  \033[31m✗\033[0m %s\n' "$1"; fallas=$((fallas+1)); }

ADMIN=$(psql_run <<<"SELECT user_id FROM public.user_roles WHERE role='admin' LIMIT 1;")
[ -n "$ADMIN" ] || { echo "No hay ningún admin en la base local."; exit 1; }

A='dddddddd-1111-0000-0000-00000000000a'
B='dddddddd-1111-0000-0000-00000000000b'

# Todo escenario arranca igual: un presupuesto con A a $1.000 y B a $2.000,
# una unidad de cada uno. Y corre adentro de una transacción que se revierte.
preludio() {
cat <<SQL
BEGIN;
SET LOCAL request.jwt.claims TO '{"sub":"$ADMIN","role":"authenticated"}';
SET LOCAL client_min_messages TO WARNING;

INSERT INTO public.productos (id, codigo, nombre, precio_sin_iva, iva_porcentaje, activo, archivado)
VALUES ('$A','ZZ-EDIT-A','Producto A',1000,21,true,false),
       ('$B','ZZ-EDIT-B','Producto B',2000,21,true,false);

CREATE TEMP TABLE _p ON COMMIT DROP AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'),
  jsonb_build_array(
    jsonb_build_object('producto_id','$A','cantidad',1,'descuento_porcentaje',0),
    jsonb_build_object('producto_id','$B','cantidad',1,'descuento_porcentaje',0)),
  NULL, 'Cliente de prueba', NULL, NULL);
SQL
}

# corre <nombre> <sql-del-cuerpo> <esperado>
corre() {
  local nombre="$1" cuerpo="$2" esperado="$3" real
  real=$(printf '%s\n%s\nROLLBACK;\n' "$(preludio)" "$cuerpo" | psql_run 2>&1 | tail -1)
  real=$(tr -d ' ' <<<"$real")
  if [ "$real" = "$esperado" ]; then paso "$nombre"
  else fallo "$nombre — esperaba «${esperado}», dio «${real}»"; fi
}

# rechaza <nombre> <sql-del-cuerpo> <fragmento-del-mensaje>
rechaza() {
  local nombre="$1" cuerpo="$2" frag="$3" salida
  salida=$(printf '%s\n%s\nROLLBACK;\n' "$(preludio)" "$cuerpo" | psql_run 2>&1)
  if grep -qi -- "$frag" <<<"$salida"; then paso "$nombre"
  else fallo "$nombre — no dijo «${frag}». Dijo: $(tail -2 <<<"$salida" | tr '\n' ' ')"; fi
}

EDITAR_A3_B1="SELECT * FROM public.editar_presupuesto(
  (SELECT presupuesto_id FROM _p),
  jsonb_build_array(
    jsonb_build_object('producto_id','$A','cantidad',3,'descuento_porcentaje',0),
    jsonb_build_object('producto_id','$B','cantidad',1,'descuento_porcentaje',0)),
  NULL, 'Cliente de prueba', NULL, NULL"

echo "== Lo que NO se toca =="

corre "conserva el número del presupuesto" "
$EDITAR_A3_B1);
SELECT (SELECT numero FROM _p) = (SELECT numero FROM public.presupuestos WHERE id=(SELECT presupuesto_id FROM _p));" "t"

corre "conserva la fecha y el usuario" "
$EDITAR_A3_B1);
SELECT count(*)=1 FROM public.presupuestos p, _p
 WHERE p.id=_p.presupuesto_id AND p.usuario_id='$ADMIN' AND p.fecha IS NOT NULL;" "t"

echo
echo "== El precio: el caso que puede costar plata =="

# A pasa de \$1.000 a \$5.000 en el catálogo DESPUÉS de hecho el presupuesto.
SUBE_A="UPDATE public.productos SET precio_sin_iva=5000 WHERE id='$A';"

corre "cambiar una cantidad NO repricia lo que ya estaba" "
$SUBE_A
$EDITAR_A3_B1);
SELECT string_agg(precio_lista_sin_iva::text, ',' ORDER BY codigo)
  FROM public.presupuesto_items WHERE presupuesto_id=(SELECT presupuesto_id FROM _p);" "1000.00,2000.00"

corre "y el total sale del precio viejo (3×1000 + 2000)" "
$SUBE_A
$EDITAR_A3_B1);
SELECT subtotal_sin_iva FROM public.presupuestos WHERE id=(SELECT presupuesto_id FROM _p);" "5000.00"

corre "repreciar SÍ los mueve" "
$SUBE_A
$EDITAR_A3_B1, true);
SELECT string_agg(precio_lista_sin_iva::text, ',' ORDER BY codigo)
  FROM public.presupuesto_items WHERE presupuesto_id=(SELECT presupuesto_id FROM _p);" "5000.00,2000.00"

corre "una línea NUEVA toma el precio de hoy" "
DELETE FROM public.presupuesto_items WHERE presupuesto_id=(SELECT presupuesto_id FROM _p) AND producto_id='$B';
UPDATE public.productos SET precio_sin_iva=7777 WHERE id='$B';
$EDITAR_A3_B1);
SELECT precio_lista_sin_iva FROM public.presupuesto_items
 WHERE presupuesto_id=(SELECT presupuesto_id FROM _p) AND producto_id='$B';" "7777.00"

corre "el IVA viaja con el precio, no mezclado" "
UPDATE public.productos SET precio_sin_iva=5000, iva_porcentaje=10.5 WHERE id='$A';
$EDITAR_A3_B1);
SELECT precio_lista_sin_iva::text||'/'||iva_porcentaje::text FROM public.presupuesto_items
 WHERE presupuesto_id=(SELECT presupuesto_id FROM _p) AND producto_id='$A';" "1000.00/21.00"

echo
echo "== Lo que tiene que rechazar =="

rechaza "un presupuesto ya convertido" "
UPDATE public.presupuestos SET estado='CONVERTIDO',
       venta_id=(SELECT id FROM public.ventas LIMIT 1) WHERE id=(SELECT presupuesto_id FROM _p);
$EDITAR_A3_B1);" "ya se convirtió"

rechaza "un presupuesto anulado" "
UPDATE public.presupuestos SET estado='ANULADO' WHERE id=(SELECT presupuesto_id FROM _p);
$EDITAR_A3_B1);" "anulado"

rechaza "el mismo producto en dos líneas" "
SELECT * FROM public.editar_presupuesto((SELECT presupuesto_id FROM _p),
  jsonb_build_array(
    jsonb_build_object('producto_id','$A','cantidad',1,'descuento_porcentaje',0),
    jsonb_build_object('producto_id','$A','cantidad',2,'descuento_porcentaje',0)));" "repetido"

rechaza "un presupuesto sin ninguna línea" "
SELECT * FROM public.editar_presupuesto((SELECT presupuesto_id FROM _p), '[]'::jsonb);" "al menos un producto"

rechaza "una cantidad de cero" "
SELECT * FROM public.editar_presupuesto((SELECT presupuesto_id FROM _p),
  jsonb_build_array(jsonb_build_object('producto_id','$A','cantidad',0,'descuento_porcentaje',0)));" "Cantidad inválida"

rechaza "AGREGAR un producto archivado" "
UPDATE public.productos SET archivado=true WHERE id='$B';
DELETE FROM public.presupuesto_items WHERE presupuesto_id=(SELECT presupuesto_id FROM _p) AND producto_id='$B';
$EDITAR_A3_B1);" "archivado"

echo
echo "== Lo que NO tiene que rechazar =="

# Si esto fallara, un presupuesto con un producto discontinuado quedaría
# imposible de editar para siempre, ni siquiera para sacarle esa línea.
corre "un producto archivado que YA ESTABA se conserva" "
UPDATE public.productos SET archivado=true WHERE id='$B';
$EDITAR_A3_B1);
SELECT count(*) FROM public.presupuesto_items WHERE presupuesto_id=(SELECT presupuesto_id FROM _p);" "2"

corre "y se lo puede SACAR" "
UPDATE public.productos SET archivado=true WHERE id='$B';
SELECT * FROM public.editar_presupuesto((SELECT presupuesto_id FROM _p),
  jsonb_build_array(jsonb_build_object('producto_id','$A','cantidad',1,'descuento_porcentaje',0)));
SELECT count(*) FROM public.presupuesto_items WHERE presupuesto_id=(SELECT presupuesto_id FROM _p);" "1"

echo
echo "== Permisos =="

# Los escenarios de arriba corren como postgres (necesitan tocar tablas directo
# para armar el caso). Este es el único que corre como un `authenticated` pelado,
# que es como llega el pedido de verdad: prueba el SECURITY DEFINER y el GRANT.
# Sin eso, `authenticated` no tiene DELETE sobre presupuesto_items y la función
# muere en producción aunque todos los tests de lógica pasen.
corre "un authenticated pelado puede editar" "
GRANT SELECT ON _p TO authenticated;  -- la tabla temporal del test, no del sistema
SET LOCAL ROLE authenticated;
$EDITAR_A3_B1);
RESET ROLE;
SELECT count(*) FROM public.presupuesto_items WHERE presupuesto_id=(SELECT presupuesto_id FROM _p);" "2"

echo
echo "── resumen ──────────────────"
printf 'ok: %d   fallas: %d\n' "$ok" "$fallas"
[ "$fallas" -eq 0 ] || exit 1
