#!/usr/bin/env bash
# ============================================================
# activar_productos con dos sesiones a la vez: el caso que encontró la revisión.
#
# La función decide en UNA sentencia: un CTE (`cand`) que lista los apagados de la
# selección con su precio y su archivado, y un UPDATE que usa esa lista. El CTE es
# un SNAPSHOT: no bloquea nada. Entonces, si otra sesión archiva la fila o le pone
# el precio en 0 justo en el medio, el UPDATE se queda esperando el lock y después
# REEVALÚA su WHERE contra la versión nueva.
#
# Ahí está el filo: si ese WHERE preguntara por los valores del CTE (los viejos),
# la reevaluación pasaría igual y quedaría un producto ACTIVO Y ARCHIVADO, o
# ACTIVO A $0 — exactamente lo que la función existe para evitar. Por eso las tres
# condiciones se preguntan sobre la fila viva y no sobre el snapshot.
#
# Estos tests COMMITEAN (no se puede probar concurrencia con ROLLBACK), así que
# usan códigos ZZ-CONC-% y limpian al final.
#
# Uso:  ./scripts/test-activar-concurrencia.sh
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/.."

DB="${DB:-supabase_db_local}"
PSQL="docker exec -i $DB psql -U postgres -d postgres -v ON_ERROR_STOP=1"
q() { $PSQL -tAq; }

ok=0; fallas=0
paso()  { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
fallo() { printf '  \033[31m✗\033[0m %s\n' "$1"; fallas=$((fallas+1)); }

ADMIN=$(q <<<"SELECT user_id FROM public.user_roles WHERE role='admin' LIMIT 1;")
[ -n "$ADMIN" ] || { echo "No hay ningún admin en la base local."; exit 1; }

limpiar() { q >/dev/null <<<"DELETE FROM public.productos WHERE codigo LIKE 'ZZ-CONC-%';"; }
sembrar() {
  limpiar
  q >/dev/null <<SQL
INSERT INTO public.productos (codigo, nombre, precio_sin_iva, activo, archivado)
VALUES ('ZZ-CONC-1', 'Apagado con precio', 5000, false, false);
SQL
}

# Llama a la RPC como admin y devuelve "activados,sin_precio,archivados".
activar() {
  q <<SQL
BEGIN;
SET LOCAL request.jwt.claims TO '{"sub":"$ADMIN","role":"authenticated"}';
SELECT (r->>'activados')||','||(r->>'sin_precio')||','||(r->>'archivados')
  FROM public.activar_productos(
    ARRAY(SELECT id FROM public.productos WHERE codigo='ZZ-CONC-1')) r;
COMMIT;
SQL
}
estado() { q <<<"SELECT activo||'/'||archivado||'/'||precio_sin_iva FROM public.productos WHERE codigo='ZZ-CONC-1';"; }

# La otra sesión: cambia la fila y se queda 1s con el lock tomado sin commitear.
# El UPDATE de la RPC va a encontrarla bloqueada y esperar.
en_paralelo() {
  $PSQL >/dev/null 2>&1 <<SQL &
BEGIN;
UPDATE public.productos SET $1 WHERE codigo='ZZ-CONC-1';
SELECT pg_sleep(1);
COMMIT;
SQL
  sleep 0.3   # que el lock ya esté tomado cuando arranca la RPC
}

echo "== Control: sin nadie en el medio, se prende =="
sembrar
[ "$(activar)" = "1,0,0" ] && paso "activados=1" || fallo "el caso simple dejó de andar"
[ "$(estado)" = "true/false/5000.00" ] && paso "queda activo, sin archivar, con su precio" \
  || fallo "estado raro: $(estado)"

# En los dos casos que siguen el número NO es "0,0,0" sino el bucket correcto: el
# prelock (FOR UPDATE antes de contar) hace que la función lea la fila DESPUÉS de
# que la otra sesión commitea, así que la cuenta como archivada / sin precio en vez
# de perderla. Sin el prelock, los conteos saldrían del snapshot viejo y la fila no
# caería en ninguno de los tres números.
echo
echo "== Otra sesión ARCHIVA la fila en el medio =="
sembrar
en_paralelo "archivado = true"
res=$(activar)
[ "$res" = "0,0,1" ] && paso "no la prende y la reporta como archivada (0,0,1)" \
  || fallo "esperaba 0,0,1 y dio ${res} — prendió (o perdió) una fila archivada por otra sesión"
est=$(estado)
[ "$est" = "false/true/5000.00" ] && paso "no quedó activo+archivado" \
  || fallo "quedó en un estado inválido: $est"
wait

echo
echo "== Otra sesión le pone el PRECIO EN 0 en el medio =="
sembrar
en_paralelo "precio_sin_iva = 0"
res=$(activar)
[ "$res" = "0,1,0" ] && paso "no la prende y la reporta sin precio (0,1,0)" \
  || fallo "esperaba 0,1,0 y dio ${res} — prendió (o perdió) un producto a \$0"
est=$(estado)
[ "$est" = "false/false/0.00" ] && paso "no quedó activo a \$0 (el bug que se vendería gratis)" \
  || fallo "quedó en un estado inválido: $est"
wait

echo
echo "== Otra sesión la PRENDE primero: no se cuenta dos veces =="
sembrar
en_paralelo "activo = true"
res=$(activar)
[ "$res" = "0,0,0" ] && paso "activados=0, no la vuelve a contar" \
  || fallo "esperaba 0,0,0 y dio ${res} — contó como propia una fila que prendió otro"
wait

limpiar
echo
echo "── resumen ──────────────────"
printf 'ok: %d   fallas: %d\n' "$ok" "$fallas"
[ "$fallas" -eq 0 ] || exit 1
