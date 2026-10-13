#!/usr/bin/env bash
# Contrato DB de la correccion auditable de ingresos confirmados.
#
# Requisito para GREEN:
#   supabase db reset
#   ./scripts/test-corregir-ingreso-mercaderia.sh
#
# El fixture corre dentro de una transaccion y termina en ROLLBACK.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" <<'SQL'
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_ok boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FALLO: %', p_message;
  END IF;
  RAISE NOTICE '✓ %', p_message;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.capture_error(p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    RETURN v_message;
  END;
  RETURN '<SIN_ERROR>';
END;
$$;

-- La prueba fija una API pequena: el payload contiene solamente lineas que
-- cambian, identificadas por item_id, y la funcion devuelve el id de auditoria.
SELECT pg_temp.assert_true(
  to_regprocedure(
    'public.corregir_ingreso_mercaderia(uuid,jsonb,text,uuid)'
  ) IS NOT NULL,
  'existe corregir_ingreso_mercaderia(uuid,jsonb,text,uuid)'
);
SELECT pg_temp.assert_true(
  to_regclass('public.ingreso_mercaderia_correcciones') IS NOT NULL
  AND to_regclass('public.ingreso_mercaderia_correccion_items') IS NOT NULL,
  'existen la cabecera y el detalle de auditoria de correcciones'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typnamespace = 'public'::regnamespace
       AND t.typname = 'tipo_movimiento_stock'
       AND e.enumlabel = 'CORRECCION_INGRESO_MERCADERIA'
  ),
  'el kardex reconoce CORRECCION_INGRESO_MERCADERIA'
);
SELECT pg_temp.assert_true(
  has_function_privilege(
    'authenticated',
    'public.corregir_ingreso_mercaderia(uuid,jsonb,text,uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'public.corregir_ingreso_mercaderia(uuid,jsonb,text,uuid)',
    'EXECUTE'
  ),
  'la RPC es ejecutable por authenticated pero no por anon'
);
SELECT pg_temp.assert_true(
  pg_get_functiondef(
    'public.corregir_ingreso_mercaderia(uuid,jsonb,text,uuid)'::regprocedure
  ) NOT LIKE '%LOCK TABLE public.stock_sucursal%'
  AND pg_get_functiondef(
    'public.corregir_ingreso_mercaderia(uuid,jsonb,text,uuid)'::regprocedure
  ) LIKE '%FOR UPDATE NOWAIT%',
  'la correccion cerca filas afectadas sin bloquear globalmente todas las ventas'
);
SELECT pg_temp.assert_true(
  (SELECT relrowsecurity
     FROM pg_class
    WHERE oid = 'public.ingreso_mercaderia_correcciones'::regclass)
  AND
  (SELECT relrowsecurity
     FROM pg_class
    WHERE oid = 'public.ingreso_mercaderia_correccion_items'::regclass),
  'las dos tablas de auditoria tienen RLS habilitado'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'authenticated', 'public.ingreso_mercaderia_correcciones', 'INSERT,UPDATE,DELETE'
  )
  AND NOT has_table_privilege(
    'authenticated', 'public.ingreso_mercaderia_correccion_items', 'INSERT,UPDATE,DELETE'
  ),
  'authenticated no puede alterar la auditoria por fuera de la RPC'
);

-- UUIDs deterministas: una colision indica que el fixture no parte limpio y no
-- se tapa con DELETE porque eso podria ocultar un error de aislamiento.
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM auth.users
     WHERE id IN (
       'a6900000-0000-4000-8000-000000000001',
       'a6900000-0000-4000-8000-000000000002'
     )
        OR email IN ('t19-admin@local.test', 't19-empleado@local.test')
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.productos
     WHERE id IN (
       'c6900000-0000-4000-8000-000000000001',
       'c6900000-0000-4000-8000-000000000002',
       'c6900000-0000-4000-8000-000000000003',
       'c6900000-0000-4000-8000-000000000004',
       'c6900000-0000-4000-8000-000000000005'
     )
        OR codigo LIKE 'T19-%'
  ),
  'el fixture de correcciones parte sin colisiones'
);

INSERT INTO auth.users(
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES
  (
    'a6900000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 't19-admin@local.test', 'x',
    now(), now(), now()
  ),
  (
    'a6900000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 't19-empleado@local.test', 'x',
    now(), now(), now()
  );

UPDATE public.profiles
   SET username = 't19_admin', nombre_completo = 'T19 Admin',
       sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
       activo = true
 WHERE id = 'a6900000-0000-4000-8000-000000000001';
UPDATE public.profiles
   SET username = 't19_empleado', nombre_completo = 'T19 Empleado',
       sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
       activo = true
 WHERE id = 'a6900000-0000-4000-8000-000000000002';
INSERT INTO public.user_roles(user_id, role) VALUES
  ('a6900000-0000-4000-8000-000000000001', 'admin');

INSERT INTO public.proveedores(id, razon_social, activo)
VALUES ('b6900000-0000-4000-8000-000000000001', 'T19 PROVEEDOR', true);

INSERT INTO public.productos(
  id, codigo, nombre, precio_sin_iva, iva_porcentaje, activo, archivado
) VALUES
  (
    'c6900000-0000-4000-8000-000000000001',
    'T19-A', 'T19 Producto corregible', 100, 21, true, false
  ),
  (
    'c6900000-0000-4000-8000-000000000002',
    'T19-B', 'T19 Producto no modificado', 100, 21, true, false
  ),
  (
    'c6900000-0000-4000-8000-000000000003',
    'T19-C', 'T19 Producto con stock consumido', 100, 21, true, false
  ),
  (
    'c6900000-0000-4000-8000-000000000004',
    'T19-D', 'T19 Producto para anular', 100, 21, true, false
  ),
  (
    'c6900000-0000-4000-8000-000000000005',
    'T19-E', 'T19 Producto repetido en dos lineas', 100, 21, true, false
  );

-- Ingreso principal: A entro por 4 sobre una base de 6; B entro por 3.
INSERT INTO public.ingresos_mercaderia(
  id, proveedor_id, sucursal_id, usuario_id, numero_remito_proveedor,
  numero_normalizado, fecha_remito, fecha_confirmacion, estado, extraccion_estado
) VALUES
  (
    'd6900000-0000-4000-8000-000000000001',
    'b6900000-0000-4000-8000-000000000001',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
    'a6900000-0000-4000-8000-000000000001',
    'T19-001', 'T19001', current_date, now(), 'CONFIRMADO', 'OK'
  ),
  -- Un borrador demuestra que la RPC no sirve como editor general.
  (
    'd6900000-0000-4000-8000-000000000002',
    'b6900000-0000-4000-8000-000000000001',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
    'a6900000-0000-4000-8000-000000000001',
    'T19-002', NULL, current_date, NULL, 'BORRADOR', 'OK'
  ),
  -- Este ingreso sumo 4 y luego se vendieron 3: queda 1, por lo que llevar la
  -- linea a cero produciria stock negativo y debe rechazarse atomicamente.
  (
    'd6900000-0000-4000-8000-000000000003',
    'b6900000-0000-4000-8000-000000000001',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
    'a6900000-0000-4000-8000-000000000001',
    'T19-003', 'T19003', current_date, now(), 'CONFIRMADO', 'OK'
  ),
  -- Ingreso separado para verificar que anular usa la cantidad efectiva (2),
  -- no la cantidad originalmente confirmada (4).
  (
    'd6900000-0000-4000-8000-000000000004',
    'b6900000-0000-4000-8000-000000000001',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
    'a6900000-0000-4000-8000-000000000001',
    'T19-004', 'T19004', current_date, now(), 'CONFIRMADO', 'OK'
  ),
  -- Dos lineas del mismo producto permiten probar una redistribucion con delta
  -- neto cero aun cuando todo el stock disponible ya haya salido.
  (
    'd6900000-0000-4000-8000-000000000005',
    'b6900000-0000-4000-8000-000000000001',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
    'a6900000-0000-4000-8000-000000000001',
    'T19-005', 'T19005', current_date, now(), 'CONFIRMADO', 'OK'
  );

INSERT INTO public.ingreso_mercaderia_items(
  id, ingreso_id, linea, producto_id, codigo, descripcion, cantidad, origen_match
) VALUES
  (
    'e6900000-0000-4000-8000-000000000001',
    'd6900000-0000-4000-8000-000000000001', 1,
    'c6900000-0000-4000-8000-000000000001',
    'T19-A', 'T19 Producto corregible', 4, 'MANUAL'
  ),
  (
    'e6900000-0000-4000-8000-000000000002',
    'd6900000-0000-4000-8000-000000000001', 2,
    'c6900000-0000-4000-8000-000000000002',
    'T19-B', 'T19 Producto no modificado', 3, 'MANUAL'
  ),
  (
    'e6900000-0000-4000-8000-000000000003',
    'd6900000-0000-4000-8000-000000000002', 1,
    'c6900000-0000-4000-8000-000000000001',
    'T19-A', 'T19 Borrador', 1, 'MANUAL'
  ),
  (
    'e6900000-0000-4000-8000-000000000004',
    'd6900000-0000-4000-8000-000000000003', 1,
    'c6900000-0000-4000-8000-000000000003',
    'T19-C', 'T19 Producto con stock consumido', 4, 'MANUAL'
  ),
  (
    'e6900000-0000-4000-8000-000000000005',
    'd6900000-0000-4000-8000-000000000004', 1,
    'c6900000-0000-4000-8000-000000000004',
    'T19-D', 'T19 Producto para anular', 4, 'MANUAL'
  ),
  (
    'e6900000-0000-4000-8000-000000000006',
    'd6900000-0000-4000-8000-000000000005', 1,
    'c6900000-0000-4000-8000-000000000005',
    'T19-E', 'T19 Producto repetido linea uno', 2, 'MANUAL'
  ),
  (
    'e6900000-0000-4000-8000-000000000007',
    'd6900000-0000-4000-8000-000000000005', 2,
    'c6900000-0000-4000-8000-000000000005',
    'T19-E', 'T19 Producto repetido linea dos', 2, 'MANUAL'
  );

INSERT INTO public.stock_sucursal(producto_id, sucursal_id, cantidad) VALUES
  (
    'c6900000-0000-4000-8000-000000000001',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'), 10
  ),
  (
    'c6900000-0000-4000-8000-000000000002',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'), 3
  ),
  (
    'c6900000-0000-4000-8000-000000000003',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'), 1
  ),
  (
    'c6900000-0000-4000-8000-000000000004',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'), 10
  ),
  (
    'c6900000-0000-4000-8000-000000000005',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'), 0
  );

INSERT INTO public.stock_movimientos(
  producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
  motivo, referencia_id, usuario_id
) VALUES
  (
    'c6900000-0000-4000-8000-000000000001',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
    'INGRESO_MERCADERIA', 4, 6, 10, 'T19 ingreso original',
    'd6900000-0000-4000-8000-000000000001',
    'a6900000-0000-4000-8000-000000000001'
  ),
  (
    'c6900000-0000-4000-8000-000000000002',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
    'INGRESO_MERCADERIA', 3, 0, 3, 'T19 ingreso original',
    'd6900000-0000-4000-8000-000000000001',
    'a6900000-0000-4000-8000-000000000001'
  ),
  (
    'c6900000-0000-4000-8000-000000000003',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
    'INGRESO_MERCADERIA', 4, 0, 4, 'T19 ingreso consumido',
    'd6900000-0000-4000-8000-000000000003',
    'a6900000-0000-4000-8000-000000000001'
  ),
  (
    'c6900000-0000-4000-8000-000000000003',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
    'VENTA', -3, 4, 1, 'T19 venta posterior', NULL,
    'a6900000-0000-4000-8000-000000000001'
  ),
  (
    'c6900000-0000-4000-8000-000000000004',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
    'INGRESO_MERCADERIA', 4, 6, 10, 'T19 ingreso para anular',
    'd6900000-0000-4000-8000-000000000004',
    'a6900000-0000-4000-8000-000000000001'
  ),
  (
    'c6900000-0000-4000-8000-000000000005',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
    'INGRESO_MERCADERIA', 4, 0, 4, 'T19 ingreso repetido original',
    'd6900000-0000-4000-8000-000000000005',
    'a6900000-0000-4000-8000-000000000001'
  ),
  (
    'c6900000-0000-4000-8000-000000000005',
    (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'),
    'VENTA', -4, 4, 0, 'T19 venta posterior repetido', NULL,
    'a6900000-0000-4000-8000-000000000001'
  );

CREATE TEMP TABLE t19_errores(tipo text PRIMARY KEY, mensaje text NOT NULL);
CREATE TEMP TABLE t19_resultados(tipo text PRIMARY KEY, correccion_id uuid NOT NULL);
GRANT SELECT, INSERT ON t19_errores, t19_resultados TO authenticated;

-- Admin-only: el empleado no puede corregir ni siquiera un ingreso de su propia
-- sucursal. Se comprueban tambien los efectos, no solamente el mensaje.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a6900000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
INSERT INTO t19_errores(tipo, mensaje)
SELECT 'NO_ADMIN', pg_temp.capture_error($q$
  SELECT public.corregir_ingreso_mercaderia(
    'd6900000-0000-4000-8000-000000000004',
    '[{"item_id":"e6900000-0000-4000-8000-000000000005","cantidad_nueva":2}]',
    'T19 intento empleado',
    'f6900000-0000-4000-8000-000000000008'
  )
$q$);
RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT mensaje <> '<SIN_ERROR>' FROM t19_errores WHERE tipo = 'NO_ADMIN')
  AND (SELECT cantidad = 4 FROM public.ingreso_mercaderia_items
        WHERE id = 'e6900000-0000-4000-8000-000000000005')
  AND (SELECT cantidad = 10 FROM public.stock_sucursal
        WHERE producto_id = 'c6900000-0000-4000-8000-000000000004'
          AND sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS')),
  'un empleado no puede corregir ni deja efectos parciales'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a6900000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

-- Sólo confirmado, motivo no vacio y al menos una diferencia real.
INSERT INTO t19_errores(tipo, mensaje)
SELECT 'BORRADOR', pg_temp.capture_error($q$
  SELECT public.corregir_ingreso_mercaderia(
    'd6900000-0000-4000-8000-000000000002',
    '[{"item_id":"e6900000-0000-4000-8000-000000000003","cantidad_nueva":2}]',
    'T19 no debe editar borrador',
    'f6900000-0000-4000-8000-000000000009'
  )
$q$);
INSERT INTO t19_errores(tipo, mensaje)
SELECT 'MOTIVO', pg_temp.capture_error($q$
  SELECT public.corregir_ingreso_mercaderia(
    'd6900000-0000-4000-8000-000000000001',
    '[{"item_id":"e6900000-0000-4000-8000-000000000001","cantidad_nueva":2}]',
    '   ',
    'f6900000-0000-4000-8000-00000000000a'
  )
$q$);
INSERT INTO t19_errores(tipo, mensaje)
SELECT 'VACIO', pg_temp.capture_error($q$
  SELECT public.corregir_ingreso_mercaderia(
    'd6900000-0000-4000-8000-000000000001',
    '[]',
    'T19 payload vacio',
    'f6900000-0000-4000-8000-00000000000b'
  )
$q$);
INSERT INTO t19_errores(tipo, mensaje)
SELECT 'SIN_CAMBIO', pg_temp.capture_error($q$
  SELECT public.corregir_ingreso_mercaderia(
    'd6900000-0000-4000-8000-000000000001',
    '[{"item_id":"e6900000-0000-4000-8000-000000000001","cantidad_nueva":4}]',
    'T19 sin cambio',
    'f6900000-0000-4000-8000-00000000000c'
  )
$q$);
INSERT INTO t19_errores(tipo, mensaje)
SELECT 'SIN_IDEMPOTENCIA', pg_temp.capture_error($q$
  SELECT public.corregir_ingreso_mercaderia(
    'd6900000-0000-4000-8000-000000000001',
    '[{"item_id":"e6900000-0000-4000-8000-000000000001","cantidad_nueva":2}]',
    'T19 sin idempotencia',
    NULL
  )
$q$);
SELECT pg_temp.assert_true(
  (SELECT bool_and(mensaje <> '<SIN_ERROR>')
     FROM t19_errores
    WHERE tipo IN ('BORRADOR', 'MOTIVO', 'VACIO', 'SIN_CAMBIO', 'SIN_IDEMPOTENCIA'))
  AND NOT EXISTS (SELECT 1 FROM public.ingreso_mercaderia_correcciones),
  'se rechazan borrador, motivo vacio, payload vacio, retry inseguro y solicitud sin cambios'
);

-- 4 -> 2: se descuenta solamente 2. La segunda linea queda intacta porque el
-- payload contiene unicamente la linea cambiada.
INSERT INTO t19_resultados(tipo, correccion_id)
SELECT 'BAJA', public.corregir_ingreso_mercaderia(
  'd6900000-0000-4000-8000-000000000001',
  '[{"item_id":"e6900000-0000-4000-8000-000000000001","cantidad_nueva":2}]',
  'T19 error de conteo',
  'f6900000-0000-4000-8000-000000000001'
);
SELECT pg_temp.assert_true(
  (SELECT cantidad = 2 FROM public.ingreso_mercaderia_items
    WHERE id = 'e6900000-0000-4000-8000-000000000001')
  AND (SELECT cantidad = 3 FROM public.ingreso_mercaderia_items
    WHERE id = 'e6900000-0000-4000-8000-000000000002')
  AND (SELECT cantidad = 8 FROM public.stock_sucursal
    WHERE producto_id = 'c6900000-0000-4000-8000-000000000001'
      AND sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'))
  AND (SELECT cantidad = 3 FROM public.stock_sucursal
    WHERE producto_id = 'c6900000-0000-4000-8000-000000000002'
      AND sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS')),
  'corregir 4 a 2 descuenta sólo 2 y no toca lineas omitidas'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
      FROM public.ingreso_mercaderia_correcciones c
     WHERE c.id = (SELECT correccion_id FROM t19_resultados WHERE tipo = 'BAJA')
       AND c.ingreso_id = 'd6900000-0000-4000-8000-000000000001'
       AND c.usuario_id = 'a6900000-0000-4000-8000-000000000001'
       AND c.motivo = 'T19 error de conteo'
       AND c.idempotency_key = 'f6900000-0000-4000-8000-000000000001'
       AND c.created_at IS NOT NULL
  )
  AND EXISTS (
    SELECT 1
      FROM public.ingreso_mercaderia_correccion_items ci
     WHERE ci.correccion_id = (SELECT correccion_id FROM t19_resultados WHERE tipo = 'BAJA')
       AND ci.ingreso_item_id = 'e6900000-0000-4000-8000-000000000001'
       AND ci.producto_id = 'c6900000-0000-4000-8000-000000000001'
       AND ci.cantidad_anterior = 4
       AND ci.cantidad_nueva = 2
       AND ci.diferencia = -2
  )
  AND EXISTS (
    SELECT 1
      FROM public.stock_movimientos m
     WHERE m.referencia_id = (SELECT correccion_id FROM t19_resultados WHERE tipo = 'BAJA')
       AND m.producto_id = 'c6900000-0000-4000-8000-000000000001'
       AND m.tipo = 'CORRECCION_INGRESO_MERCADERIA'
       AND m.cantidad = -2
       AND m.cantidad_anterior = 10
       AND m.cantidad_nueva = 8
       AND m.usuario_id = 'a6900000-0000-4000-8000-000000000001'
  ),
  'la baja deja cabecera, detalle y kardex enlazados'
);

-- Un empleado de otra sucursal no puede leer ni la cabecera ni el detalle del
-- historial, aunque conozca los UUID. La auditoria no filtra datos cruzados.
RESET ROLE;
UPDATE public.profiles
   SET sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'GENERALPAZ')
 WHERE id = 'a6900000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a6900000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.ingreso_mercaderia_correcciones
     WHERE ingreso_id = 'd6900000-0000-4000-8000-000000000001'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.ingreso_mercaderia_correccion_items
     WHERE correccion_id = (SELECT correccion_id FROM t19_resultados WHERE tipo = 'BAJA')
  ),
  'un empleado de otra sucursal no puede leer el historial de correcciones'
);
RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a6900000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
UPDATE public.profiles
   SET sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS')
 WHERE id = 'a6900000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;

-- Un retry exacto devuelve el mismo id y no repite ningún efecto.
INSERT INTO t19_resultados(tipo, correccion_id)
SELECT 'BAJA_RETRY', public.corregir_ingreso_mercaderia(
  'd6900000-0000-4000-8000-000000000001',
  '[{"item_id":"e6900000-0000-4000-8000-000000000001","cantidad_nueva":2}]',
  'T19 error de conteo',
  'f6900000-0000-4000-8000-000000000001'
);
SELECT pg_temp.assert_true(
  (SELECT correccion_id FROM t19_resultados WHERE tipo = 'BAJA')
    = (SELECT correccion_id FROM t19_resultados WHERE tipo = 'BAJA_RETRY')
  AND (SELECT count(*) = 1 FROM public.ingreso_mercaderia_correcciones
        WHERE idempotency_key = 'f6900000-0000-4000-8000-000000000001')
  AND (SELECT count(*) = 1 FROM public.ingreso_mercaderia_correccion_items
        WHERE correccion_id = (SELECT correccion_id FROM t19_resultados WHERE tipo = 'BAJA'))
  AND (SELECT count(*) = 1 FROM public.stock_movimientos
        WHERE referencia_id = (SELECT correccion_id FROM t19_resultados WHERE tipo = 'BAJA'))
  AND (SELECT cantidad = 8 FROM public.stock_sucursal
        WHERE producto_id = 'c6900000-0000-4000-8000-000000000001'
          AND sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS')),
  'el retry exacto es idempotente y no duplica efectos'
);

-- La clave pertenece a la operacion completa, no sólo al UUID de correccion.
INSERT INTO t19_errores(tipo, mensaje)
SELECT 'IDEM_ITEMS', pg_temp.capture_error($q$
  SELECT public.corregir_ingreso_mercaderia(
    'd6900000-0000-4000-8000-000000000001',
    '[{"item_id":"e6900000-0000-4000-8000-000000000001","cantidad_nueva":1}]',
    'T19 error de conteo',
    'f6900000-0000-4000-8000-000000000001'
  )
$q$);
INSERT INTO t19_errores(tipo, mensaje)
SELECT 'IDEM_MOTIVO', pg_temp.capture_error($q$
  SELECT public.corregir_ingreso_mercaderia(
    'd6900000-0000-4000-8000-000000000001',
    '[{"item_id":"e6900000-0000-4000-8000-000000000001","cantidad_nueva":2}]',
    'T19 otro motivo',
    'f6900000-0000-4000-8000-000000000001'
  )
$q$);
INSERT INTO t19_errores(tipo, mensaje)
SELECT 'IDEM_INGRESO', pg_temp.capture_error($q$
  SELECT public.corregir_ingreso_mercaderia(
    'd6900000-0000-4000-8000-000000000004',
    '[{"item_id":"e6900000-0000-4000-8000-000000000005","cantidad_nueva":2}]',
    'T19 error de conteo',
    'f6900000-0000-4000-8000-000000000001'
  )
$q$);
SELECT pg_temp.assert_true(
  (SELECT bool_and(mensaje <> '<SIN_ERROR>' AND lower(mensaje) LIKE '%idempot%')
     FROM t19_errores
    WHERE tipo IN ('IDEM_ITEMS', 'IDEM_MOTIVO', 'IDEM_INGRESO'))
  AND (SELECT count(*) = 1 FROM public.ingreso_mercaderia_correcciones
        WHERE idempotency_key = 'f6900000-0000-4000-8000-000000000001')
  AND (SELECT cantidad = 8 FROM public.stock_sucursal
        WHERE producto_id = 'c6900000-0000-4000-8000-000000000001'
          AND sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS')),
  'reusar una clave con ingreso, items o motivo distintos se rechaza sin mutar'
);

-- Aumentar 2 -> 5 suma sólo 3.
INSERT INTO t19_resultados(tipo, correccion_id)
SELECT 'ALTA', public.corregir_ingreso_mercaderia(
  'd6900000-0000-4000-8000-000000000001',
  '[{"item_id":"e6900000-0000-4000-8000-000000000001","cantidad_nueva":5}]',
  'T19 faltaban unidades',
  'f6900000-0000-4000-8000-000000000002'
);
SELECT pg_temp.assert_true(
  (SELECT cantidad = 5 FROM public.ingreso_mercaderia_items
    WHERE id = 'e6900000-0000-4000-8000-000000000001')
  AND (SELECT cantidad = 11 FROM public.stock_sucursal
    WHERE producto_id = 'c6900000-0000-4000-8000-000000000001'
      AND sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'))
  AND EXISTS (
    SELECT 1 FROM public.ingreso_mercaderia_correccion_items ci
     WHERE ci.correccion_id = (SELECT correccion_id FROM t19_resultados WHERE tipo = 'ALTA')
       AND ci.cantidad_anterior = 2 AND ci.cantidad_nueva = 5 AND ci.diferencia = 3
  )
  AND EXISTS (
    SELECT 1 FROM public.stock_movimientos m
     WHERE m.referencia_id = (SELECT correccion_id FROM t19_resultados WHERE tipo = 'ALTA')
       AND m.cantidad = 3 AND m.cantidad_anterior = 8 AND m.cantidad_nueva = 11
  ),
  'corregir 2 a 5 suma solamente 3 y lo audita'
);

-- Cero representa una linea ingresada por error; se conserva como evidencia.
INSERT INTO t19_resultados(tipo, correccion_id)
SELECT 'CERO', public.corregir_ingreso_mercaderia(
  'd6900000-0000-4000-8000-000000000001',
  '[{"item_id":"e6900000-0000-4000-8000-000000000001","cantidad_nueva":0}]',
  'T19 producto no recibido',
  'f6900000-0000-4000-8000-000000000003'
);
SELECT pg_temp.assert_true(
  (SELECT cantidad = 0 FROM public.ingreso_mercaderia_items
    WHERE id = 'e6900000-0000-4000-8000-000000000001')
  AND (SELECT cantidad = 6 FROM public.stock_sucursal
    WHERE producto_id = 'c6900000-0000-4000-8000-000000000001'
      AND sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'))
  AND EXISTS (
    SELECT 1 FROM public.ingreso_mercaderia_correccion_items ci
     WHERE ci.correccion_id = (SELECT correccion_id FROM t19_resultados WHERE tipo = 'CERO')
       AND ci.cantidad_anterior = 5 AND ci.cantidad_nueva = 0 AND ci.diferencia = -5
  ),
  'una linea puede corregirse a cero sin borrar su historia'
);

-- Si parte de la mercaderia ya salio, bajar la cantidad no puede inventar stock
-- negativo. Toda la llamada debe revertirse, incluida la auditoria.
INSERT INTO t19_errores(tipo, mensaje)
SELECT 'NEGATIVO', pg_temp.capture_error($q$
  SELECT public.corregir_ingreso_mercaderia(
    'd6900000-0000-4000-8000-000000000003',
    '[{"item_id":"e6900000-0000-4000-8000-000000000004","cantidad_nueva":0}]',
    'T19 no alcanza stock',
    'f6900000-0000-4000-8000-000000000004'
  )
$q$);
SELECT pg_temp.assert_true(
  (SELECT mensaje <> '<SIN_ERROR>' FROM t19_errores WHERE tipo = 'NEGATIVO')
  AND (SELECT cantidad = 4 FROM public.ingreso_mercaderia_items
        WHERE id = 'e6900000-0000-4000-8000-000000000004')
  AND (SELECT cantidad = 1 FROM public.stock_sucursal
        WHERE producto_id = 'c6900000-0000-4000-8000-000000000003'
          AND sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'))
  AND NOT EXISTS (
    SELECT 1 FROM public.ingreso_mercaderia_correcciones
     WHERE idempotency_key = 'f6900000-0000-4000-8000-000000000004'
  ),
  'una correccion que dejaria stock negativo falla atomicamente'
);

-- Dos lineas del mismo producto: se aplica primero +2 y luego -2. El stock
-- termina en cero y no se rechaza una redistribucion cuyo delta neto es valido.
INSERT INTO t19_resultados(tipo, correccion_id)
SELECT 'MISMO_PRODUCTO', public.corregir_ingreso_mercaderia(
  'd6900000-0000-4000-8000-000000000005',
  '[
    {"item_id":"e6900000-0000-4000-8000-000000000006","cantidad_nueva":0},
    {"item_id":"e6900000-0000-4000-8000-000000000007","cantidad_nueva":4}
  ]',
  'T19 redistribuir lineas repetidas',
  'f6900000-0000-4000-8000-000000000006'
);
SELECT pg_temp.assert_true(
  (SELECT cantidad = 0 FROM public.ingreso_mercaderia_items
    WHERE id = 'e6900000-0000-4000-8000-000000000006')
  AND (SELECT cantidad = 4 FROM public.ingreso_mercaderia_items
    WHERE id = 'e6900000-0000-4000-8000-000000000007')
  AND (SELECT cantidad = 0 FROM public.stock_sucursal
    WHERE producto_id = 'c6900000-0000-4000-8000-000000000005'
      AND sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'))
  AND EXISTS (
    SELECT 1 FROM public.stock_movimientos
     WHERE referencia_id = (SELECT correccion_id FROM t19_resultados WHERE tipo = 'MISMO_PRODUCTO')
       AND cantidad = 2 AND cantidad_anterior = 0 AND cantidad_nueva = 2
  )
  AND EXISTS (
    SELECT 1 FROM public.stock_movimientos
     WHERE referencia_id = (SELECT correccion_id FROM t19_resultados WHERE tipo = 'MISMO_PRODUCTO')
       AND cantidad = -2 AND cantidad_anterior = 2 AND cantidad_nueva = 0
  ),
  'dos lineas del mismo producto se redistribuyen sin depender del orden de UUID'
);

-- Corregir 4 -> 2 y luego anular debe llevar 10 -> 8 -> 6. Si anular leyera la
-- cantidad original, terminaria incorrectamente en 4.
INSERT INTO t19_resultados(tipo, correccion_id)
SELECT 'ANTES_ANULAR', public.corregir_ingreso_mercaderia(
  'd6900000-0000-4000-8000-000000000004',
  '[{"item_id":"e6900000-0000-4000-8000-000000000005","cantidad_nueva":2}]',
  'T19 corregir antes de anular',
  'f6900000-0000-4000-8000-000000000005'
);
SELECT public.anular_ingreso_mercaderia(
  'd6900000-0000-4000-8000-000000000004',
  'T19 anular cantidad efectiva'
);
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT estado = 'ANULADO' FROM public.ingresos_mercaderia
    WHERE id = 'd6900000-0000-4000-8000-000000000004')
  AND (SELECT cantidad = 2 FROM public.ingreso_mercaderia_items
    WHERE id = 'e6900000-0000-4000-8000-000000000005')
  AND (SELECT cantidad = 6 FROM public.stock_sucursal
    WHERE producto_id = 'c6900000-0000-4000-8000-000000000004'
      AND sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'OHIGGINS'))
  AND EXISTS (
    SELECT 1 FROM public.stock_movimientos
     WHERE referencia_id = 'd6900000-0000-4000-8000-000000000004'
       AND tipo = 'ANULACION_INGRESO_MERCADERIA'
       AND cantidad = -2 AND cantidad_anterior = 8 AND cantidad_nueva = 6
  ),
  'anular despues de corregir revierte la cantidad efectiva y no la original'
);

ROLLBACK;
SQL

echo "Correccion auditable de ingresos: OK"
