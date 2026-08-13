#!/usr/bin/env bash
# ============================================================
# Escenarios (m) y (n) del spec del conteo físico: concurrencia REAL, con dos
# sesiones de psql a la vez.
#
# Lo que se prueba es la afirmación central de §5.3: el LOCK TABLE ... SHARE ROW
# EXCLUSIVE hace imposible el deadlock contra las otras RPC de stock, que
# bloquean sus filas en el orden de su payload. Un conteo que tomara las filas
# una por una en orden de producto_id, contra una venta que las toma al revés,
# daría "deadlock detected" (SQLSTATE 40P01).
#
# La otra sesión escribe stock en orden INVERSO al del conteo, a propósito.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL="docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1"

limpiar() {
  $PSQL >/dev/null 2>&1 <<'SQL'
DELETE FROM public.stock_conteo_items i USING public.productos p WHERE p.id=i.producto_id AND p.codigo LIKE 'CCC-%';
DELETE FROM public.stock_conteos c WHERE NOT EXISTS (SELECT 1 FROM public.stock_conteo_items i WHERE i.conteo_id=c.id);
DELETE FROM public.stock_movimientos m USING public.productos p WHERE p.id=m.producto_id AND p.codigo LIKE 'CCC-%';
DELETE FROM public.stock_sucursal s USING public.productos p WHERE p.id=s.producto_id AND p.codigo LIKE 'CCC-%';
DELETE FROM public.productos WHERE codigo LIKE 'CCC-%';
SQL
}

echo "── Sembrando 60 productos con stock ──────────────────────"
limpiar
$PSQL <<'SQL'
INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje)
SELECT 'CCC-'||lpad(g::text,3,'0'), 'Concurrencia '||g, 'unidad', 100, 21 FROM generate_series(1,60) g;

INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
SELECT p.id, s.id, 100 FROM public.productos p, public.sucursales s
 WHERE p.codigo LIKE 'CCC-%' AND s.codigo='OHIGGINS';
SQL

echo "── (n) conteo vs escritura de stock en orden INVERSO ─────"
# Sesión B: descuenta stock producto por producto, en orden inverso al del
# conteo, dentro de una sola transacción y con una pausa en el medio: es el
# peor caso para un deadlock.
$PSQL >/tmp/conc-b.log 2>&1 <<'SQL' &
BEGIN;
DO $b$
DECLARE
  sid uuid := (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');
  r record;
BEGIN
  FOR r IN SELECT p.id FROM public.productos p WHERE p.codigo LIKE 'CCC-%' ORDER BY p.codigo DESC
  LOOP
    UPDATE public.stock_sucursal SET cantidad = cantidad - 1
     WHERE producto_id = r.id AND sucursal_id = sid;
    INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo)
    VALUES (r.id, sid, 'VENTA', -1, 100, 99, 'venta concurrente');
    PERFORM pg_sleep(0.01);
  END LOOP;
END $b$;
COMMIT;
SQL
PID_B=$!

sleep 0.15   # que la sesión B ya tenga filas bloqueadas cuando arranca el conteo

$PSQL >/tmp/conc-a.log 2>&1 <<'SQL'
DO $a$
DECLARE
  uid uuid := (SELECT id FROM auth.users WHERE email='admin@local.test');
  sid uuid := (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');
  items jsonb; res jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);
  SELECT jsonb_agg(jsonb_build_object('producto_id', p.id, 'cantidad', 50) ORDER BY p.codigo)
    INTO items FROM public.productos p WHERE p.codigo LIKE 'CCC-%';
  res := public.ajustar_stock_masivo(sid, items, 'Conteo concurrente', NULL, gen_random_uuid());
  RAISE NOTICE 'conteo ok: %', res;
END $a$;
SQL
EST_A=$?
wait $PID_B; EST_B=$?

echo "  sesión conteo -> exit $EST_A ; sesión escritura -> exit $EST_B"
if grep -qi "deadlock" /tmp/conc-a.log /tmp/conc-b.log; then
  echo "❌ FALLA (n): hubo deadlock"; cat /tmp/conc-a.log /tmp/conc-b.log; exit 1
fi
if [ "$EST_A" -ne 0 ] || [ "$EST_B" -ne 0 ]; then
  echo "❌ FALLA (n): alguna sesión falló"; cat /tmp/conc-a.log /tmp/conc-b.log; exit 1
fi

$PSQL <<'SQL'
DO $chk$
DECLARE n int;
BEGIN
  -- Las dos transacciones se serializaron: todas las filas terminan en el valor
  -- del conteo (que corrió después) o en 99 (si el conteo corrió antes).
  SELECT count(*) INTO n FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id
   WHERE p.codigo LIKE 'CCC-%' AND s.cantidad NOT IN (50, 49, 99);
  IF n > 0 THEN RAISE EXCEPTION 'FALLA (n): % filas con un valor inconsistente', n; END IF;
  RAISE NOTICE 'OK (n): conteo y escritura concurrente se serializaron, sin deadlock.';
END $chk$;
SQL

echo "── (m) dos conteos simultáneos sobre los mismos productos ─"
for i in 1 2; do
  $PSQL >/tmp/conc-m$i.log 2>&1 <<SQL &
DO \$m\$
DECLARE
  uid uuid := (SELECT id FROM auth.users WHERE email='admin@local.test');
  sid uuid := (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');
  items jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);
  SELECT jsonb_agg(jsonb_build_object('producto_id', p.id, 'cantidad', $((i * 7))) ORDER BY p.codigo $([ $i = 2 ] && echo DESC))
    INTO items FROM public.productos p WHERE p.codigo LIKE 'CCC-%';
  PERFORM public.ajustar_stock_masivo(sid, items, 'Conteo simultaneo $i', NULL, gen_random_uuid());
END \$m\$;
SQL
done
wait
if grep -qi "deadlock\|ERROR" /tmp/conc-m1.log /tmp/conc-m2.log; then
  echo "❌ FALLA (m)"; cat /tmp/conc-m1.log /tmp/conc-m2.log; exit 1
fi
$PSQL <<'SQL'
DO $chk$
DECLARE n int;
BEGIN
  -- Uno de los dos ganó, entero: no puede haber una mezcla de 7 y 14.
  SELECT count(DISTINCT cantidad) INTO n FROM public.stock_sucursal s
    JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo LIKE 'CCC-%';
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA (m): los dos conteos se entreveraron (% valores distintos)', n; END IF;
  RAISE NOTICE 'OK (m): dos conteos simultáneos se serializaron enteros.';
END $chk$;
SQL

limpiar
echo ""
echo "✅ CONCURRENCIA OK"
