#!/usr/bin/env bash
# ============================================================
# e2e de la migración 20260724150000 ("el stock no es el envase")
# contra la base LOCAL de Supabase.
#
# Requisito: la migración YA tiene que estar aplicada en local
#   supabase db reset      (y después ./scripts/crear-admin-local.sh)
# El script verifica esa precondición: comprueba que existan la tabla de
# respaldo Y el REVOKE, o sea, que se haya corrido el archivo ENTERO y no sólo
# la parte de datos.
#
# Después siembra escenarios y vuelve a ejecutar el bloque de corrección
# extraído de la migración REAL (para que el test no se desincronice del código
# que se va a aplicar en producción).
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL="docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1"

echo "── Precondición: la migración completa está aplicada ─────"
$PSQL <<'SQL'
DO $pre$
BEGIN
  IF to_regclass('public.stock_correccion_envase') IS NULL THEN
    RAISE EXCEPTION 'La migración no está aplicada (falta stock_correccion_envase). Corré: supabase db reset';
  END IF;
  IF has_table_privilege('authenticated', 'public.stock_sucursal', 'UPDATE') THEN
    RAISE EXCEPTION 'La migración no está aplicada entera: authenticated todavía puede UPDATE stock_sucursal.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='public' AND tablename='stock_sucursal'
                AND policyname='admin write stock') THEN
    RAISE EXCEPTION 'La migración no está aplicada entera: sigue existiendo la policy "admin write stock".';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='stock_sucursal'
                    AND policyname='auth read stock') THEN
    RAISE EXCEPTION 'Se perdió la policy de lectura "auth read stock".';
  END IF;
  RAISE NOTICE 'OK: migración aplicada entera (tabla + REVOKE + policies).';
END $pre$;
SQL

# El bloque de corrección, aislado de la migración real. Se exige que haya
# EXACTAMENTE un bloque DO en el archivo: si mañana se agrega otro, el test
# falla en vez de probar en silencio la mitad equivocada.
python3 - > /tmp/bloque-correccion.sql <<'PY'
import io, re, sys
s = io.open("supabase/migrations/20260724150000_corregir_stock_cargado_como_envase.sql",
            encoding="utf-8").read()
bloques = re.findall(r"^DO \$\$.*?^END \$\$;$", s, re.S | re.M)
if len(bloques) != 1:
    sys.exit(f"Se esperaba exactamente 1 bloque DO $$ en la migración, hay {len(bloques)}. "
             "Actualizá scripts/test-correccion-envase.sh.")
sys.stdout.write(bloques[0] + "\n")
PY

echo "── Sembrando escenarios ──────────────────────────────────"
$PSQL <<'SQL'
DELETE FROM public.stock_correccion_envase WHERE producto_codigo LIKE 'TEST-%';
DELETE FROM public.stock_movimientos m USING public.productos p
 WHERE p.id = m.producto_id AND p.codigo LIKE 'TEST-%';
DELETE FROM public.productos WHERE codigo LIKE 'TEST-%';

DO $seed$
DECLARE
  s_ohi uuid := (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS');
  s_gpz uuid := (SELECT id FROM public.sucursales WHERE codigo = 'GENERALPAZ');
  pid   uuid;
  t0    timestamptz := now() - interval '5 hours';
BEGIN
  -- (a) cantidad = envase, SIN movimientos  -> debe ir a 0
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase)
  VALUES ('TEST-A','Caso A sin kardex','litro',100,21,20) RETURNING id INTO pid;
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at)
  VALUES (pid,s_ohi,20,t0);

  -- (b) cantidad = envase, CON movimientos y la importación DESPUÉS
  --     (updated_at > último mov) -> debe volver a la última cantidad_nueva = 7
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase)
  VALUES ('TEST-B','Caso B pisado despues','litro',100,21,20) RETURNING id INTO pid;
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at)
  VALUES (pid,s_ohi,20,t0 + interval '2 hours');
  INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo,created_at)
  VALUES (pid,s_ohi,'AJUSTE',10,0,10,'carga inicial', t0),
         (pid,s_ohi,'VENTA',-3,10,7,'venta',          t0 + interval '1 hour');

  -- (c) cantidad = envase, pero el último write FUE una RPC (updated_at = último mov)
  --     -> intacta
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase)
  VALUES ('TEST-C','Caso C stock real','litro',100,21,20) RETURNING id INTO pid;
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at)
  VALUES (pid,s_ohi,20,t0 + interval '1 hour');
  INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo,created_at)
  VALUES (pid,s_ohi,'AJUSTE',20,0,20,'conteo fisico', t0 + interval '1 hour');

  -- (d) cantidad <> envase, sin movimientos -> intacta
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase)
  VALUES ('TEST-D','Caso D distinto','litro',100,21,20) RETURNING id INTO pid;
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at)
  VALUES (pid,s_ohi,5,t0);

  -- (e) tamano_envase NULL (productos del seed) -> intacta
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase)
  VALUES ('TEST-E','Caso E sin envase','unidad',100,21,NULL) RETURNING id INTO pid;
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at)
  VALUES (pid,s_ohi,33,t0);

  -- (f) tamano_envase = 0 y stock 0 -> intacta (no debe respaldar nada)
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase)
  VALUES ('TEST-F','Caso F envase cero','unidad',100,21,0) RETURNING id INTO pid;
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at)
  VALUES (pid,s_ohi,0,t0);

  -- (k) EMPATE de timestamps en el último movimiento (una venta con el mismo
  --     producto en dos líneas escribe dos movimientos con el mismo now()):
  --     no hay desempate confiable (el id es un uuid aleatorio) -> se saltea.
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase)
  VALUES ('TEST-K','Caso K empate','litro',100,21,20) RETURNING id INTO pid;
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at)
  VALUES (pid,s_ohi,20,t0 + interval '2 hours');
  INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo,created_at)
  VALUES (pid,s_ohi,'VENTA',-2,10,8,'venta linea 1', t0 + interval '1 hour'),
         (pid,s_ohi,'VENTA',-3,8,5,'venta linea 2',  t0 + interval '1 hour');

  -- (l) DOS SUCURSALES del mismo producto: una contaminada, la otra sana.
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase)
  VALUES ('TEST-L','Caso L dos sucursales','litro',100,21,20) RETURNING id INTO pid;
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at)
  VALUES (pid,s_ohi,20,t0),                        -- contaminada, sin kardex
         (pid,s_gpz,20,t0 + interval '1 hour');    -- sana (write con kardex)
  INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo,created_at)
  VALUES (pid,s_gpz,'AJUSTE',20,0,20,'conteo fisico', t0 + interval '1 hour');

  -- (m) el último movimiento tiene cantidad_nueva NULL: se usa el último NO nulo.
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase)
  VALUES ('TEST-M','Caso M cantidad_nueva nula','litro',100,21,20) RETURNING id INTO pid;
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at)
  VALUES (pid,s_ohi,20,t0 + interval '3 hours');
  INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo,created_at)
  VALUES (pid,s_ohi,'AJUSTE',9,0,9,'carga',              t0),
         (pid,s_ohi,'VENTA',-1,NULL,NULL,'sin snapshot', t0 + interval '1 hour');

  -- (o) el último movimiento NO tiene snapshot, y al caer al anterior hay un
  --     EMPATE. Si la ambigüedad se midiera sobre todos los movimientos (y no
  --     sobre los que tienen snapshot), esta fila pasaría el filtro y el
  --     objetivo saldría al azar entre 10 y 15. Debe saltearse.
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase)
  VALUES ('TEST-O','Caso O empate detras de un nulo','litro',100,21,20) RETURNING id INTO pid;
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at)
  VALUES (pid,s_ohi,20,t0 + interval '4 hours');
  INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo,created_at)
  VALUES (pid,s_ohi,'INGRESO_MERCADERIA',10,0,10,'linea 1',     t0),
         (pid,s_ohi,'INGRESO_MERCADERIA',5,10,15,'linea 2',     t0),
         (pid,s_ohi,'VENTA',-1,NULL,NULL,'sin snapshot',        t0 + interval '1 hour');

  -- (p) tiene kardex pero NINGÚN snapshot: no hay valor al que volver.
  --     Volver a 0 sería inventar. Debe saltearse.
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase)
  VALUES ('TEST-P','Caso P kardex sin snapshot','litro',100,21,20) RETURNING id INTO pid;
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at)
  VALUES (pid,s_ohi,20,t0 + interval '4 hours');
  INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo,created_at)
  VALUES (pid,s_ohi,'VENTA',-1,NULL,NULL,'sin snapshot', t0 + interval '1 hour');
END $seed$;
SQL

echo "── 1ª corrida de la corrección ───────────────────────────"
$PSQL < /tmp/bloque-correccion.sql

echo "── Estado tras la 1ª corrida ─────────────────────────────"
$PSQL <<'SQL'
SELECT p.codigo, su.codigo AS suc, s.cantidad, p.tamano_envase AS env,
       (SELECT count(*) FROM public.stock_correccion_envase c
         WHERE c.producto_id = p.id AND c.sucursal_id = s.sucursal_id) AS respaldos,
       (SELECT count(*) FROM public.stock_movimientos m
         WHERE m.producto_id = p.id AND m.sucursal_id = s.sucursal_id) AS movs
  FROM public.productos p
  JOIN public.stock_sucursal s ON s.producto_id = p.id
  JOIN public.sucursales su ON su.id = s.sucursal_id
 WHERE p.codigo LIKE 'TEST-%' ORDER BY p.codigo, su.codigo;
SQL

echo "── Aserciones ────────────────────────────────────────────"
$PSQL <<'SQL'
DO $chk$
DECLARE v numeric; n int;
BEGIN
  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo='TEST-A';
  IF v <> 0 THEN RAISE EXCEPTION 'FALLA (a): TEST-A debía quedar en 0, quedó %', v; END IF;

  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo='TEST-B';
  IF v <> 7 THEN RAISE EXCEPTION 'FALLA (b): TEST-B debía volver a 7 (último valor auditado), quedó %', v; END IF;

  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo='TEST-C';
  IF v <> 20 THEN RAISE EXCEPTION 'FALLA (c): TEST-C (último write con kardex) debía quedar intacto en 20, quedó %', v; END IF;

  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo='TEST-D';
  IF v <> 5 THEN RAISE EXCEPTION 'FALLA (d): TEST-D debía quedar en 5, quedó %', v; END IF;

  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo='TEST-E';
  IF v <> 33 THEN RAISE EXCEPTION 'FALLA (e): TEST-E (envase NULL) debía quedar en 33, quedó %', v; END IF;

  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo='TEST-F';
  IF v <> 0 THEN RAISE EXCEPTION 'FALLA (f): TEST-F debía quedar en 0, quedó %', v; END IF;

  -- (k) empate: se saltea, queda como estaba y NO se respalda.
  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo='TEST-K';
  IF v <> 20 THEN RAISE EXCEPTION 'FALLA (k): TEST-K (empate de timestamps) debía saltearse y quedar en 20, quedó %', v; END IF;
  SELECT count(*) INTO n FROM public.stock_correccion_envase WHERE producto_codigo='TEST-K';
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA (k): TEST-K no debía respaldarse'; END IF;

  -- (l) dos sucursales: sólo la contaminada.
  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id
    JOIN public.sucursales su ON su.id=s.sucursal_id WHERE p.codigo='TEST-L' AND su.codigo='OHIGGINS';
  IF v <> 0 THEN RAISE EXCEPTION 'FALLA (l): TEST-L/OHIGGINS debía quedar en 0, quedó %', v; END IF;
  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id
    JOIN public.sucursales su ON su.id=s.sucursal_id WHERE p.codigo='TEST-L' AND su.codigo='GENERALPAZ';
  IF v <> 20 THEN RAISE EXCEPTION 'FALLA (l): TEST-L/GENERALPAZ (sana) debía quedar en 20, quedó %', v; END IF;

  -- (m) cantidad_nueva NULL en el último mov -> se usa el último NO nulo (9).
  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo='TEST-M';
  IF v <> 9 THEN RAISE EXCEPTION 'FALLA (m): TEST-M debía volver a 9, quedó %', v; END IF;

  -- (o) empate escondido detrás de un movimiento sin snapshot -> se saltea.
  --     Si esto falla puede hacerlo de forma intermitente (el valor sale al azar
  --     entre 10 y 15): cualquier resultado distinto de 20 es el bug.
  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo='TEST-O';
  IF v <> 20 THEN RAISE EXCEPTION 'FALLA (o): TEST-O debía saltearse y quedar en 20, quedó % (empate resuelto al azar)', v; END IF;
  SELECT count(*) INTO n FROM public.stock_correccion_envase WHERE producto_codigo='TEST-O';
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA (o): TEST-O no debía respaldarse'; END IF;

  -- (p) kardex sin ningún snapshot -> no hay valor al que volver, se saltea.
  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo='TEST-P';
  IF v <> 20 THEN RAISE EXCEPTION 'FALLA (p): TEST-P debía saltearse y quedar en 20, quedó %', v; END IF;

  SELECT count(*) INTO n FROM public.stock_correccion_envase WHERE producto_codigo LIKE 'TEST-%';
  IF n <> 4 THEN RAISE EXCEPTION 'FALLA: se esperaban 4 respaldos (A, B, L/OHIGGINS, M), hay %', n; END IF;

  -- (h) no se escribió kardex artificial: TEST-A sigue sin movimientos y en 0,
  --     o sea eliminar_productos lo BORRA en vez de archivarlo.
  SELECT count(*) INTO n FROM public.stock_movimientos m JOIN public.productos p ON p.id=m.producto_id WHERE p.codigo='TEST-A';
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA (h): la corrección escribió kardex para TEST-A (%). Eso lo volvería imborrable.', n; END IF;

  -- El respaldo guarda el valor anterior y los datos desnormalizados.
  SELECT c.cantidad_anterior INTO v FROM public.stock_correccion_envase c WHERE c.producto_codigo='TEST-B';
  IF v <> 20 THEN RAISE EXCEPTION 'FALLA: el respaldo de TEST-B debía guardar 20, guardó %', v; END IF;
  SELECT count(*) INTO n FROM public.stock_correccion_envase
   WHERE producto_codigo='TEST-B' AND producto_nombre IS NOT NULL AND sucursal_codigo='OHIGGINS';
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA: el respaldo no desnormalizó código/nombre/sucursal'; END IF;

  RAISE NOTICE 'OK: escenarios a-f, h, k, l, m, o, p correctos.';
END $chk$;
SQL

echo "── 2ª corrida (idempotencia) ─────────────────────────────"
$PSQL < /tmp/bloque-correccion.sql
$PSQL <<'SQL'
DO $chk2$
DECLARE n int; v numeric;
BEGIN
  SELECT count(*) INTO n FROM public.stock_correccion_envase WHERE producto_codigo LIKE 'TEST-%';
  IF n <> 4 THEN RAISE EXCEPTION 'FALLA (g): la 2ª corrida agregó respaldos (ahora hay %)', n; END IF;
  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo='TEST-B';
  IF v <> 7 THEN RAISE EXCEPTION 'FALLA (g): la 2ª corrida movió TEST-B a %', v; END IF;
  RAISE NOTICE 'OK (g): idempotente.';
END $chk2$;
SQL

echo "── (n) el respaldo sobrevive al borrado del producto ─────"
$PSQL <<'SQL'
DO $surv$
DECLARE pid uuid := (SELECT id FROM public.productos WHERE codigo='TEST-A'); n int;
BEGIN
  DELETE FROM public.productos WHERE id = pid;
  SELECT count(*) INTO n FROM public.stock_correccion_envase WHERE producto_codigo='TEST-A';
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA (n): al borrar el producto se perdió el respaldo de auditoría'; END IF;
  RAISE NOTICE 'OK (n): el respaldo sobrevive (FK ON DELETE SET NULL + datos desnormalizados).';
END $surv$;
SQL

echo "── (i) authenticated no puede escribir stock_sucursal ────"
# OJO: usar $PSQL (con ON_ERROR_STOP=1). Con psql crudo, un RAISE EXCEPTION acá
# no cambia el exit code y el script terminaría imprimiendo "TODOS OK" con este
# escenario —el único que verifica el REVOKE— en rojo.
$PSQL <<'SQL'
DO $perm$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE public.stock_sucursal SET cantidad = 999
     WHERE producto_id = (SELECT id FROM public.productos WHERE codigo='TEST-B');
  EXCEPTION WHEN insufficient_privilege THEN
    ok := true;
  END;
  RESET ROLE;
  IF NOT ok THEN RAISE EXCEPTION 'FALLA (i): authenticated pudo escribir stock_sucursal directo'; END IF;
  RAISE NOTICE 'OK (i): escritura directa rechazada.';
END $perm$;
SQL

echo "── (j) la premisa, con una RPC DE VERDAD ─────────────────"
$PSQL <<'SQL'
DO $adj$
DECLARE
  uid uuid := (SELECT u.id FROM auth.users u WHERE u.email='admin@local.test');
  pid uuid;
  sid uuid := (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');
  u timestamptz; c timestamptz; v numeric; n int;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Falta el usuario admin@local.test. Corré ./scripts/crear-admin-local.sh';
  END IF;
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase)
  VALUES ('TEST-RPC','Premisa con RPC real','litro',100,21,20) RETURNING id INTO pid;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);
  PERFORM public.ajustar_stock(pid, sid, 20, 'conteo fisico');

  SELECT cantidad, updated_at INTO v, u FROM public.stock_sucursal WHERE producto_id=pid AND sucursal_id=sid;
  SELECT max(created_at) INTO c FROM public.stock_movimientos WHERE producto_id=pid AND sucursal_id=sid;
  IF v <> 20 THEN RAISE EXCEPTION 'FALLA (j): ajustar_stock no dejó 20, dejó %', v; END IF;
  SELECT count(*) INTO n FROM public.stock_movimientos WHERE producto_id=pid;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA (j): ajustar_stock no dejó kardex (movs=%)', n; END IF;

  -- LA PREMISA de la migración: una RPC deja updated_at = created_at, así que la
  -- corrección no puede confundir un stock real (20) con el envase (20).
  IF u > c THEN
    RAISE EXCEPTION 'PREMISA ROTA: ajustar_stock dejó updated_at (%) > created_at (%). La corrección destruiría stock real.', u, c;
  END IF;
  RAISE NOTICE 'OK (j): ajustar_stock funciona, audita, y deja updated_at = created_at (premisa verificada con RPC real).';
END $adj$;
SQL

echo "── (j2) esa fila real NO la toca la corrección ───────────"
$PSQL < /tmp/bloque-correccion.sql
$PSQL <<'SQL'
DO $chk3$
DECLARE v numeric; n int;
BEGIN
  SELECT s.cantidad INTO v FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id WHERE p.codigo='TEST-RPC';
  IF v <> 20 THEN RAISE EXCEPTION 'FALLA (j2): la corrección tocó stock REAL cargado por RPC (quedó en %)', v; END IF;
  SELECT count(*) INTO n FROM public.stock_correccion_envase WHERE producto_codigo='TEST-RPC';
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA (j2): la corrección respaldó una fila sana'; END IF;
  RAISE NOTICE 'OK (j2): el stock real cargado por RPC quedó intacto.';
END $chk3$;
SQL

echo "── Limpieza ──────────────────────────────────────────────"
$PSQL <<'SQL'
DELETE FROM public.stock_correccion_envase WHERE producto_codigo LIKE 'TEST-%';
DELETE FROM public.stock_movimientos m USING public.productos p WHERE p.id=m.producto_id AND p.codigo LIKE 'TEST-%';
DELETE FROM public.productos WHERE codigo LIKE 'TEST-%';
SQL

echo ""
echo "✅ TODOS LOS ESCENARIOS OK"
