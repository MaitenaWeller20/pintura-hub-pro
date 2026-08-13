#!/usr/bin/env bash
# ============================================================
# e2e de la migración 20260724160000 (conteo físico) contra la base LOCAL.
#
# Requisito: migración aplicada y usuarios de test creados
#   supabase db reset && ./scripts/crear-admin-local.sh
#                     && ./scripts/crear-admin-local.sh empleado@local.test empleado1234
#
# Cubre la tabla de escenarios de la §9 del spec
# (docs/superpowers/specs/2026-07-24-conteo-fisico-design.md).
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL="docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1"

echo "── Precondición ──────────────────────────────────────────"
$PSQL <<'SQL'
DO $pre$
BEGIN
  IF to_regclass('public.stock_conteos') IS NULL THEN
    RAISE EXCEPTION 'Falta la migración del conteo. Corré: supabase db reset';
  END IF;
  IF to_regclass('public.stock_inventario') IS NULL THEN
    RAISE EXCEPTION 'Falta la vista stock_inventario.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email='admin@local.test') THEN
    RAISE EXCEPTION 'Falta admin@local.test. Corré ./scripts/crear-admin-local.sh';
  END IF;
  RAISE NOTICE 'OK: migración y usuarios listos.';
END $pre$;
SQL

echo "── Sembrando productos de prueba ─────────────────────────"
$PSQL <<'SQL'
DELETE FROM public.stock_conteo_items i USING public.productos p
 WHERE p.id = i.producto_id AND p.codigo LIKE 'CNT-%';
DELETE FROM public.stock_movimientos m USING public.productos p
 WHERE p.id = m.producto_id AND p.codigo LIKE 'CNT-%';
DELETE FROM public.stock_sucursal s USING public.productos p
 WHERE p.id = s.producto_id AND p.codigo LIKE 'CNT-%';
DELETE FROM public.productos WHERE codigo LIKE 'CNT-%';

INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,tamano_envase,archivado)
VALUES ('CNT-A','Sin fila de stock','litro',100,21,20,false),
       ('CNT-B','Con stock previo','litro',100,21,20,false),
       ('CNT-C','Coincide con lo contado','litro',100,21,20,false),
       ('CNT-D','Cero contado','litro',100,21,20,false),
       ('CNT-E','Con venta durante el conteo','litro',100,21,20,false),
       ('CNT-Z','Archivado','litro',100,21,20,true);

-- CNT-B ya tiene stock cargado por una vía legítima (con kardex).
DO $s$
DECLARE
  sid uuid := (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');
  pid uuid := (SELECT id FROM public.productos WHERE codigo='CNT-B');
BEGIN
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad) VALUES (pid,sid,5);
  INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo)
  VALUES (pid,sid,'AJUSTE',5,0,5,'carga previa');
END $s$;
SQL

echo "── (s) la vista distingue 'sin contar' de 'sin stock' ────"
$PSQL <<'SQL'
DO $v$
DECLARE r record;
BEGIN
  -- Una fila en 0 SIN kardex (como las que dejó la corrección del envase) tiene
  -- que seguir contando como "sin contar".
  INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
  SELECT p.id, s.id, 0 FROM public.productos p, public.sucursales s
   WHERE p.codigo='CNT-C' AND s.codigo='OHIGGINS';

  SELECT * INTO r FROM public.stock_inventario
   WHERE codigo='CNT-C' AND sucursal_codigo='OHIGGINS';
  IF r.tiene_fila IS NOT TRUE THEN RAISE EXCEPTION 'FALLA (s): tiene_fila debería ser true'; END IF;
  IF r.tiene_movimientos IS NOT FALSE THEN RAISE EXCEPTION 'FALLA (s): sin kardex debería dar tiene_movimientos=false'; END IF;

  SELECT * INTO r FROM public.stock_inventario WHERE codigo='CNT-A' AND sucursal_codigo='OHIGGINS';
  IF r.tiene_fila IS NOT FALSE OR r.cantidad <> 0 THEN
    RAISE EXCEPTION 'FALLA (s): un producto sin fila debe aparecer igual, con cantidad 0';
  END IF;

  SELECT * INTO r FROM public.stock_inventario WHERE codigo='CNT-B' AND sucursal_codigo='OHIGGINS';
  IF r.tiene_movimientos IS NOT TRUE THEN RAISE EXCEPTION 'FALLA (s): CNT-B tiene kardex'; END IF;

  IF EXISTS (SELECT 1 FROM public.stock_inventario WHERE codigo='CNT-Z') THEN
    RAISE EXCEPTION 'FALLA (s): un producto archivado no debe aparecer en el inventario';
  END IF;

  RAISE NOTICE 'OK (s): la vista clasifica bien.';
END $v$;
SQL

echo "── (a,b,c,l,o) el conteo escribe lo que tiene que escribir ──"
$PSQL <<'SQL'
DO $t$
DECLARE
  uid  uuid := (SELECT id FROM auth.users WHERE email='admin@local.test');
  sid  uuid := (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');
  a uuid := (SELECT id FROM public.productos WHERE codigo='CNT-A');
  b uuid := (SELECT id FROM public.productos WHERE codigo='CNT-B');
  c uuid := (SELECT id FROM public.productos WHERE codigo='CNT-C');
  d uuid := (SELECT id FROM public.productos WHERE codigo='CNT-D');
  res jsonb; v numeric; n int; m record;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);

  res := public.ajustar_stock_masivo(
    sid,
    jsonb_build_array(
      jsonb_build_object('producto_id', a, 'cantidad', 7),    -- (a) sin fila -> la crea
      jsonb_build_object('producto_id', b, 'cantidad', 9),    -- cambia de 5 a 9
      jsonb_build_object('producto_id', c, 'cantidad', 0),    -- (b) ya estaba en 0: sin cambio
      jsonb_build_object('producto_id', d, 'cantidad', 0)     -- (o) cero sobre producto sin fila
    ),
    'Conteo físico', NULL, gen_random_uuid());

  IF (res->>'ajustados')::int <> 2 THEN RAISE EXCEPTION 'FALLA (c): ajustados debía ser 2, fue %', res->>'ajustados'; END IF;
  IF (res->>'sin_cambio')::int <> 2 THEN RAISE EXCEPTION 'FALLA (c): sin_cambio debía ser 2, fue %', res->>'sin_cambio'; END IF;

  SELECT cantidad INTO v FROM public.stock_sucursal WHERE producto_id=a AND sucursal_id=sid;
  IF v <> 7 THEN RAISE EXCEPTION 'FALLA (a): CNT-A debía quedar en 7, quedó %', v; END IF;

  SELECT cantidad INTO v FROM public.stock_sucursal WHERE producto_id=d AND sucursal_id=sid;
  IF v IS NULL THEN RAISE EXCEPTION 'FALLA (o): contar 0 debe crear igual la fila (es el dato "lo conté y no hay")'; END IF;
  IF v <> 0 THEN RAISE EXCEPTION 'FALLA (o): CNT-D debía quedar en 0, quedó %', v; END IF;

  -- (b) el que coincidía NO deja kardex...
  SELECT count(*) INTO n FROM public.stock_movimientos WHERE producto_id=c;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA (b): un ítem sin cambio no debe escribir kardex (hay %)', n; END IF;
  -- ...pero SÍ queda registrado como contado.
  SELECT count(*) INTO n FROM public.stock_conteo_items WHERE producto_id=c;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA (b): el ítem sin cambio igual debe quedar en stock_conteo_items'; END IF;

  -- (l) el kardex queda completo
  SELECT * INTO m FROM public.stock_movimientos WHERE producto_id=a AND sucursal_id=sid;
  IF m.tipo <> 'AJUSTE' OR m.cantidad <> 7 OR m.cantidad_anterior <> 0 OR m.cantidad_nueva <> 7
     OR m.usuario_id <> uid OR m.motivo <> 'Conteo físico' OR m.referencia_id IS NULL THEN
    RAISE EXCEPTION 'FALLA (l): el movimiento quedó incompleto: %', to_jsonb(m);
  END IF;

  -- Después del conteo, la vista ya no los marca como "sin contar".
  IF (SELECT cargado FROM public.stock_inventario WHERE codigo='CNT-A' AND sucursal_codigo='OHIGGINS') IS NOT TRUE THEN
    RAISE EXCEPTION 'FALLA: tras contarlo, CNT-A debería figurar como cargado';
  END IF;

  -- (o, la parte que importa) contar CERO no deja kardex —no hay nada que
  -- mover— pero igual tiene que dejar de figurar como "sin contar". Si no,
  -- ella lo contaría una y otra vez sin que el sistema se entere.
  IF (SELECT tiene_movimientos FROM public.stock_inventario WHERE codigo='CNT-D' AND sucursal_codigo='OHIGGINS') IS NOT FALSE THEN
    RAISE EXCEPTION 'FALLA (o): contar 0 no debería escribir kardex';
  END IF;
  IF (SELECT cargado FROM public.stock_inventario WHERE codigo='CNT-D' AND sucursal_codigo='OHIGGINS') IS NOT TRUE THEN
    RAISE EXCEPTION 'FALLA (o): un producto contado en 0 tiene que dejar de figurar como "sin contar"';
  END IF;
  -- ...y sólo en la sucursal donde se contó.
  IF (SELECT cargado FROM public.stock_inventario WHERE codigo='CNT-D' AND sucursal_codigo='GENERALPAZ') IS NOT FALSE THEN
    RAISE EXCEPTION 'FALLA (o): contar en una sucursal no puede marcar la otra';
  END IF;

  RAISE NOTICE 'OK (a,b,c,l,o).';
END $t$;
SQL

echo "── (p) una venta durante el conteo no se pisa ────────────"
$PSQL <<'SQL'
DO $t$
DECLARE
  uid uuid := (SELECT id FROM auth.users WHERE email='admin@local.test');
  sid uuid := (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');
  e   uuid := (SELECT id FROM public.productos WHERE codigo='CNT-E');
  t0  timestamptz := now() - interval '30 minutes';
  res jsonb; v numeric;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);

  -- Estado al abrir el conteo: 10 unidades (cargadas ANTES de t0).
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at)
  VALUES (e,sid,10,t0 - interval '10 minutes');
  INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo,created_at)
  VALUES (e,sid,'AJUSTE',10,0,10,'carga previa', t0 - interval '10 minutes');

  -- Mientras contaba (después de t0) se vendieron 2.
  UPDATE public.stock_sucursal SET cantidad = 8 WHERE producto_id=e AND sucursal_id=sid;
  INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo,created_at)
  VALUES (e,sid,'VENTA',-2,10,8,'venta durante el conteo', t0 + interval '10 minutes');

  -- Ella contó 10 (lo que había al abrir) y guarda ahora.
  res := public.ajustar_stock_masivo(
    sid, jsonb_build_array(jsonb_build_object('producto_id', e, 'cantidad', 10)),
    'Conteo físico', t0, gen_random_uuid());

  SELECT cantidad INTO v FROM public.stock_sucursal WHERE producto_id=e AND sucursal_id=sid;
  IF v <> 8 THEN
    RAISE EXCEPTION 'FALLA (p): contó 10 y se vendieron 2 durante el conteo -> debía quedar 8, quedó %', v;
  END IF;
  IF (res->>'con_movimientos')::int <> 1 THEN
    RAISE EXCEPTION 'FALLA (p): debía informar 1 ítem con movimientos posteriores';
  END IF;
  IF (SELECT movimientos_posteriores FROM public.stock_conteo_items WHERE producto_id=e) <> -2 THEN
    RAISE EXCEPTION 'FALLA (p): el ítem debía guardar el delta -2';
  END IF;
  RAISE NOTICE 'OK (p): la venta hecha durante el conteo sobrevive.';
END $t$;
SQL

echo "── (u) se vendió MÁS de lo contado -> conflicto, no negativo ──"
$PSQL <<'SQL'
DO $t$
DECLARE
  uid uuid := (SELECT id FROM auth.users WHERE email='admin@local.test');
  sid uuid := (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');
  pid uuid;
  t0  timestamptz := now() - interval '30 minutes';
  res jsonb; v numeric;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje)
  VALUES ('CNT-CONF','Conflicto de conteo','unidad',100,21) RETURNING id INTO pid;
  INSERT INTO public.stock_sucursal (producto_id,sucursal_id,cantidad,updated_at) VALUES (pid,sid,5,t0);
  -- Contó 0, pero después se vendieron 3: 0 + (-3) = -3, imposible. Debe quedar
  -- en 0 y contar como conflicto, no dejar stock negativo ni silenciarlo.
  INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo,created_at)
  VALUES (pid,sid,'VENTA',-3,5,2,'venta grande', t0 + interval '5 minutes');

  res := public.ajustar_stock_masivo(sid, jsonb_build_array(jsonb_build_object('producto_id', pid, 'cantidad', 0)),
                                     'Conteo físico', t0, gen_random_uuid());

  IF (res->>'conflictos')::int <> 1 THEN RAISE EXCEPTION 'FALLA (u): debía informar 1 conflicto, informó %', res->>'conflictos'; END IF;
  SELECT cantidad INTO v FROM public.stock_sucursal WHERE producto_id=pid AND sucursal_id=sid;
  IF v <> 0 THEN RAISE EXCEPTION 'FALLA (u): debía quedar en 0 (no negativo), quedó %', v; END IF;
  DELETE FROM public.stock_conteo_items WHERE producto_codigo='CNT-CONF';
  RAISE NOTICE 'OK (u): conflicto informado, sin stock negativo.';
END $t$;
SQL

echo "── (d,q) idempotencia ────────────────────────────────────"
$PSQL <<'SQL'
DO $t$
DECLARE
  uid uuid := (SELECT id FROM auth.users WHERE email='admin@local.test');
  sid uuid := (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');
  b   uuid := (SELECT id FROM public.productos WHERE codigo='CNT-B');
  k   uuid := gen_random_uuid();
  r1 jsonb; r2 jsonb; n1 int; n2 int; v numeric;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);
  SELECT count(*) INTO n1 FROM public.stock_movimientos WHERE producto_id=b;

  r1 := public.ajustar_stock_masivo(sid, jsonb_build_array(jsonb_build_object('producto_id', b, 'cantidad', 25)),
                                    'Conteo físico', NULL, k);
  -- Entre medio se vende 1: el retry NO debe volver a poner 25.
  UPDATE public.stock_sucursal SET cantidad = 24 WHERE producto_id=b AND sucursal_id=sid;
  INSERT INTO public.stock_movimientos (producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,motivo)
  VALUES (b,sid,'VENTA',-1,25,24,'venta');

  r2 := public.ajustar_stock_masivo(sid, jsonb_build_array(jsonb_build_object('producto_id', b, 'cantidad', 25)),
                                    'Conteo físico', NULL, k);

  IF (r2->>'repetido')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FALLA (q): el retry debía marcarse repetido'; END IF;
  IF (r2->>'conteo_id') <> (r1->>'conteo_id') THEN RAISE EXCEPTION 'FALLA (q): el retry debía devolver el mismo conteo'; END IF;

  SELECT cantidad INTO v FROM public.stock_sucursal WHERE producto_id=b AND sucursal_id=sid;
  IF v <> 24 THEN RAISE EXCEPTION 'FALLA (d): el retry pisó el stock (quedó % en vez de 24)', v; END IF;
  RAISE NOTICE 'OK (d,q): idempotente aun con una venta en el medio.';
END $t$;
SQL

echo "── (e,f,g,h,i,j,k) rechazos ──────────────────────────────"
$PSQL <<'SQL'
DO $t$
DECLARE
  uid  uuid := (SELECT id FROM auth.users WHERE email='admin@local.test');
  emp  uuid := (SELECT id FROM auth.users WHERE email='empleado@local.test');
  sid  uuid := (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');
  a uuid := (SELECT id FROM public.productos WHERE codigo='CNT-A');
  z uuid := (SELECT id FROM public.productos WHERE codigo='CNT-Z');
  items jsonb;

  PROCEDURE_placeholder int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);

  -- IMPORTANTE: el centinela ('NO-RECHAZO...') NO comparte texto con la palabra
  -- que busca el guard. Si compartiera (p.ej. "FALLA: aceptó un repetido" contra
  -- LIKE '%repetido%'), un caso donde la RPC NO rechaza se tragaría a sí mismo y
  -- daría falso verde. El guard re-lanza si es el centinela O si el error no es
  -- el esperado.

  -- (e) producto repetido
  BEGIN
    PERFORM public.ajustar_stock_masivo(sid, jsonb_build_array(
      jsonb_build_object('producto_id', a, 'cantidad', 1),
      jsonb_build_object('producto_id', a, 'cantidad', 2)), 'x', NULL, NULL);
    RAISE EXCEPTION 'NO-RECHAZO (e): aceptó un producto duplicado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NO-RECHAZO%' OR SQLERRM NOT LIKE '%repetido%' THEN RAISE; END IF;
  END;

  -- (f) cantidad negativa
  BEGIN
    PERFORM public.ajustar_stock_masivo(sid, jsonb_build_array(
      jsonb_build_object('producto_id', a, 'cantidad', -1)), 'x', NULL, NULL);
    RAISE EXCEPTION 'NO-RECHAZO (f): aceptó una cantidad menor a cero';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NO-RECHAZO%' OR SQLERRM NOT LIKE '%negativa%' THEN RAISE; END IF;
  END;

  -- (f) cantidad no numérica
  BEGIN
    PERFORM public.ajustar_stock_masivo(sid, jsonb_build_array(
      jsonb_build_object('producto_id', a, 'cantidad', 'diez')), 'x', NULL, NULL);
    RAISE EXCEPTION 'NO-RECHAZO (f): aceptó una cantidad no numeral';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NO-RECHAZO%' OR SQLERRM NOT LIKE '%inválida%' THEN RAISE; END IF;
  END;

  -- (g) producto archivado
  BEGIN
    PERFORM public.ajustar_stock_masivo(sid, jsonb_build_array(
      jsonb_build_object('producto_id', z, 'cantidad', 1)), 'x', NULL, NULL);
    RAISE EXCEPTION 'NO-RECHAZO (g): aceptó un producto dado de baja';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NO-RECHAZO%' OR SQLERRM NOT LIKE '%archivado%' THEN RAISE; END IF;
  END;

  -- (h) sucursal inexistente
  BEGIN
    PERFORM public.ajustar_stock_masivo(gen_random_uuid(), jsonb_build_array(
      jsonb_build_object('producto_id', a, 'cantidad', 1)), 'x', NULL, NULL);
    RAISE EXCEPTION 'NO-RECHAZO (h): aceptó una sucursal que no existe';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NO-RECHAZO%' OR SQLERRM NOT LIKE '%Sucursal inexistente%' THEN RAISE; END IF;
  END;

  -- (i) motivo vacío
  BEGIN
    PERFORM public.ajustar_stock_masivo(sid, jsonb_build_array(
      jsonb_build_object('producto_id', a, 'cantidad', 1)), '   ', NULL, NULL);
    RAISE EXCEPTION 'NO-RECHAZO (i): aceptó sin explicación';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NO-RECHAZO%' OR SQLERRM NOT LIKE '%motivo%' THEN RAISE; END IF;
  END;

  -- (j) payload vacío
  BEGIN
    PERFORM public.ajustar_stock_masivo(sid, '[]'::jsonb, 'x', NULL, NULL);
    RAISE EXCEPTION 'NO-RECHAZO (j): aceptó un conteo sin filas';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NO-RECHAZO%' OR SQLERRM NOT LIKE '%no tiene ítems%' THEN RAISE; END IF;
  END;

  -- (j) por encima del tope
  SELECT jsonb_agg(jsonb_build_object('producto_id', gen_random_uuid(), 'cantidad', 1))
    INTO items FROM generate_series(1, 2001);
  BEGIN
    PERFORM public.ajustar_stock_masivo(sid, items, 'x', NULL, NULL);
    RAISE EXCEPTION 'NO-RECHAZO (j): aceptó más filas que el máximo';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NO-RECHAZO%' OR SQLERRM NOT LIKE '%demasiados ítems%' THEN RAISE; END IF;
  END;

  -- (k) no admin
  PERFORM set_config('request.jwt.claims', json_build_object('sub', emp)::text, true);
  BEGIN
    PERFORM public.ajustar_stock_masivo(sid, jsonb_build_array(
      jsonb_build_object('producto_id', a, 'cantidad', 1)), 'x', NULL, NULL);
    RAISE EXCEPTION 'NO-RECHAZO (k): un empleado pudo cargar el conteo';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NO-RECHAZO%' OR SQLERRM NOT LIKE '%administrador%' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'OK (e,f,g,h,i,j,k): todos los rechazos.';
END $t$;
SQL

echo "── (t) un producto contado se puede BORRAR igual ────────"
$PSQL <<'SQL'
DO $t$
DECLARE
  uid uuid := (SELECT id FROM auth.users WHERE email='admin@local.test');
  sid uuid := (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');
  pid uuid;
  res jsonb; n int; nulo boolean;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);
  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje)
  VALUES ('CNT-DEL','Contado y despues borrado','unidad',100,21) RETURNING id INTO pid;

  -- Contado en 0: no deja kardex, pero sí un stock_conteo_items que referencia
  -- al producto. Con la FK restrictiva, eliminar_productos tiraba
  -- foreign_key_violation y no se podía borrar NADA.
  PERFORM public.ajustar_stock_masivo(sid, jsonb_build_array(jsonb_build_object('producto_id', pid, 'cantidad', 0)),
                                      'Conteo físico', NULL, gen_random_uuid());

  res := public.eliminar_productos(ARRAY[pid]);
  IF NOT (res->'borrados' @> to_jsonb(ARRAY[jsonb_build_object('codigo','CNT-DEL')])) THEN
    RAISE EXCEPTION 'FALLA (t): el producto contado no se borró: %', res;
  END IF;
  SELECT count(*) INTO n FROM public.productos WHERE id=pid;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA (t): el producto sigue existiendo'; END IF;

  -- El registro de auditoría del conteo SOBREVIVE, con el producto desnormalizado.
  SELECT producto_id IS NULL INTO nulo FROM public.stock_conteo_items WHERE producto_codigo='CNT-DEL';
  IF nulo IS NOT TRUE THEN RAISE EXCEPTION 'FALLA (t): el conteo_item no quedó con producto_id NULL'; END IF;

  RAISE NOTICE 'OK (t): un producto contado se borra, y su conteo sobrevive como auditoría.';
END $t$;
SQL

echo "── (r) 1200 ítems: cuánto tarda con el LOCK tomado ───────"
$PSQL <<'SQL'
DO $t$
DECLARE
  uid uuid := (SELECT id FROM auth.users WHERE email='admin@local.test');
  sid uuid := (SELECT id FROM public.sucursales WHERE codigo='GENERALPAZ');
  items jsonb;
  t0 timestamptz; ms numeric; res jsonb; n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);

  INSERT INTO public.productos (codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje)
  SELECT 'CNT-M'||g, 'Masivo '||g, 'unidad', 100, 21 FROM generate_series(1,1200) g;

  SELECT jsonb_agg(jsonb_build_object('producto_id', p.id, 'cantidad', 3))
    INTO items FROM public.productos p WHERE p.codigo LIKE 'CNT-M%';

  t0 := clock_timestamp();
  res := public.ajustar_stock_masivo(sid, items, 'Conteo físico masivo', NULL, gen_random_uuid());
  ms := EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000;

  IF (res->>'ajustados')::int <> 1200 THEN
    RAISE EXCEPTION 'FALLA (r): debía ajustar 1200, ajustó %', res->>'ajustados';
  END IF;
  SELECT count(*) INTO n FROM public.stock_sucursal s JOIN public.productos p ON p.id=s.producto_id
   WHERE p.codigo LIKE 'CNT-M%' AND s.cantidad = 3;
  IF n <> 1200 THEN RAISE EXCEPTION 'FALLA (r): quedaron % filas en 3', n; END IF;

  RAISE NOTICE 'OK (r): 1200 ítems en % ms (con LOCK TABLE tomado).', round(ms);
  IF ms > 5000 THEN
    RAISE EXCEPTION 'FALLA (r): tardó % ms con la escritura de stock bloqueada. Demasiado.', round(ms);
  END IF;
END $t$;
SQL

echo "── Limpieza ──────────────────────────────────────────────"
$PSQL <<'SQL'
DELETE FROM public.stock_conteo_items WHERE producto_codigo LIKE 'CNT-%';
DELETE FROM public.stock_conteos c WHERE NOT EXISTS (SELECT 1 FROM public.stock_conteo_items i WHERE i.conteo_id=c.id);
DELETE FROM public.stock_movimientos m USING public.productos p WHERE p.id=m.producto_id AND p.codigo LIKE 'CNT-%';
DELETE FROM public.stock_sucursal s USING public.productos p WHERE p.id=s.producto_id AND p.codigo LIKE 'CNT-%';
DELETE FROM public.productos WHERE codigo LIKE 'CNT-%';
SQL

echo ""
echo "✅ TODOS LOS ESCENARIOS OK"
