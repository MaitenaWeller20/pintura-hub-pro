\set ON_ERROR_STOP on

DO $$ BEGIN
  IF current_database() <> 'quimex_remito_test' THEN
    RAISE EXCEPTION 'Ejecutar sólo en la base descartable quimex_remito_test';
  END IF;
END $$;

DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('test.uid', true), '')::uuid
$$;
CREATE FUNCTION public.is_admin(_uid uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT _uid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
$$;
CREATE FUNCTION public.puede_facturar(_uid uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT _uid IN (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid
  )
$$;
CREATE FUNCTION public.current_sucursal_id() RETURNS uuid LANGUAGE sql AS $$
  SELECT '11111111-1111-1111-1111-111111111111'::uuid
$$;
CREATE TABLE public.profiles (id uuid PRIMARY KEY, activo boolean NOT NULL);
CREATE TABLE public.settings (id boolean PRIMARY KEY, facturacion_receptor_v2_enabled boolean);
CREATE TABLE public.ventas (
  id uuid PRIMARY KEY, sucursal_id uuid, cliente_id uuid, fecha timestamptz,
  numero_comprobante text UNIQUE, tipo_comprobante text, condicion_venta text,
  estado text, total numeric(14,2), afip_estado text, cae text, afip_numero integer,
  afip_snapshot jsonb, afip_claim_token uuid, afip_fase text, afip_intentos integer
);
CREATE TABLE public.cuenta_corriente_movimientos (
  id uuid PRIMARY KEY, venta_id uuid UNIQUE, sucursal_id uuid, cliente_id uuid,
  tipo text, estado text, monto numeric(14,2)
);
CREATE TABLE public.venta_items (id uuid PRIMARY KEY, venta_id uuid);
CREATE TABLE public.stock_movimientos (id uuid PRIMARY KEY, referencia_id uuid, cantidad numeric);

INSERT INTO auth.users VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
INSERT INTO auth.users VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
INSERT INTO public.profiles VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
INSERT INTO public.profiles VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);
INSERT INTO public.settings VALUES (true, true);
INSERT INTO public.ventas VALUES
  ('10000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-10-14 16:55:00-03',
   'GPZ-REM-0058', 'REMITO', 'CTA_CTE', 'ACTIVA', 583218.37, 'NO_APLICA',
   NULL, NULL, NULL, NULL, NULL, 0),
  ('10000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', now(),
   'OHI-REM-0001', 'REMITO', 'CTA_CTE', 'ACTIVA', 10, 'NO_APLICA',
   NULL, NULL, NULL, NULL, NULL, 0);
INSERT INTO public.cuenta_corriente_movimientos VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'DEBITO', 'CONFIRMADO', 583218.37),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002',
   '22222222-2222-2222-2222-222222222222', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'DEBITO', 'CONFIRMADO', 10);
INSERT INTO public.venta_items VALUES
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002');
INSERT INTO public.stock_movimientos VALUES
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', -10);

\i /src/supabase/migrations/20261103110000_facturar_remito_cta_cte.sql

SET test.uid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DO $$
DECLARE
  v_primero jsonb;
  v_segundo jsonb;
  v_fecha timestamptz := '2026-10-14 16:55:00-03';
BEGIN
  v_primero := public.convertir_remito_a_venta('10000000-0000-0000-0000-000000000001');
  v_segundo := public.convertir_remito_a_venta('10000000-0000-0000-0000-000000000001');
  IF v_primero <> v_segundo OR v_primero->>'afip_estado' <> 'SIN_FACTURAR' THEN
    RAISE EXCEPTION 'La conversión no es idempotente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ventas
     WHERE id = '10000000-0000-0000-0000-000000000001'
       AND numero_comprobante = 'GPZ-REM-0058' AND fecha = v_fecha
       AND tipo_comprobante = 'VENTA' AND afip_estado = 'SIN_FACTURAR'
       AND remito_facturado_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'Se perdieron número, fecha o identidad del remito'; END IF;
  IF (SELECT count(*) FROM public.ventas) <> 2
     OR (SELECT count(*) FROM public.stock_movimientos) <> 1
     OR (SELECT count(*) FROM public.cuenta_corriente_movimientos) <> 2
     OR (SELECT sum(monto) FROM public.cuenta_corriente_movimientos) <> 583228.37 THEN
    RAISE EXCEPTION 'La conversión duplicó venta, stock o deuda';
  END IF;
  PERFORM set_config('test.uid', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);
  BEGIN
    PERFORM public.convertir_remito_a_venta('10000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'Un usuario no administrador convirtió un remito';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'Solo un administrador puede facturar remitos existentes' THEN RAISE; END IF;
  END;
END $$;

DO $$ BEGIN
  IF has_function_privilege('anon', 'public.convertir_remito_a_venta(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'La RPC quedó expuesta a anon';
  END IF;
END $$;

SET ROLE authenticated;
DO $$ BEGIN
  IF public.convertir_remito_a_venta('10000000-0000-0000-0000-000000000001')->>'numero_remito'
     <> 'GPZ-REM-0058' THEN
    RAISE EXCEPTION 'El rol autenticado no puede recuperar su conversión';
  END IF;
END $$;
RESET ROLE;
