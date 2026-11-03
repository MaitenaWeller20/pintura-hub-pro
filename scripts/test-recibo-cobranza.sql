\set ON_ERROR_STOP on

DO $$ BEGIN
  IF current_database() <> 'quimex_recibo_test' THEN
    RAISE EXCEPTION 'Ejecutar sólo en la base descartable quimex_recibo_test';
  END IF;
END $$;

DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('test.uid', true), '')::uuid
$$;
CREATE FUNCTION public.is_admin(_uid uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT _uid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
$$;
CREATE FUNCTION public.current_sucursal_id() RETURNS uuid LANGUAGE sql AS $$
  SELECT '11111111-1111-1111-1111-111111111111'::uuid
$$;

CREATE TABLE public.emisores (
  id uuid PRIMARY KEY, razon_social text, cuit text, domicilio_fiscal text,
  condicion_iva text, ingresos_brutos text, inicio_actividades date, logo text
);
CREATE TABLE public.sucursales (
  id uuid PRIMARY KEY, emisor_id uuid, nombre text, numero text, direccion text, telefono text
);
CREATE TABLE public.clientes (
  id uuid PRIMARY KEY, razon_social text, cuit_dni text, direccion text, tipo text
);
CREATE TABLE public.cobranzas_cta_cte (
  id uuid PRIMARY KEY, cliente_id uuid, sucursal_id uuid, fecha timestamptz,
  monto numeric(14,2), forma_pago text, detalle jsonb, observaciones text
);
CREATE TABLE public.cuenta_corriente_movimientos (
  id uuid PRIMARY KEY, cobranza_id uuid, cliente_id uuid, sucursal_id uuid,
  tipo text, estado text, monto numeric(14,2)
);
CREATE TABLE public.documento_secuencias (
  sucursal_id uuid, tipo text, ultimo_numero integer NOT NULL, PRIMARY KEY(sucursal_id,tipo)
);
CREATE FUNCTION public.next_documento_numero(_sucursal_id uuid, _tipo text, _prefijo text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_next integer;
BEGIN
  INSERT INTO public.documento_secuencias VALUES (_sucursal_id, _tipo, 1)
  ON CONFLICT (sucursal_id,tipo) DO UPDATE
    SET ultimo_numero = documento_secuencias.ultimo_numero + 1
  RETURNING ultimo_numero INTO v_next;
  RETURN (CASE WHEN _sucursal_id = '11111111-1111-1111-1111-111111111111'::uuid
            THEN 'GPZ' ELSE 'OHI' END)
         || '-' || _prefijo || '-' || lpad(v_next::text, 4, '0');
END $$;

INSERT INTO public.emisores VALUES (
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Aplicaciones y Servicios SRL',
  '30-71419966-4', 'Córdoba', 'RESPONSABLE_INSCRIPTO', NULL, NULL, NULL
);
INSERT INTO public.sucursales VALUES
  ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'General Paz', '0003', 'General Paz', NULL),
  ('22222222-2222-2222-2222-222222222222', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Otras', '0004', 'Otra', NULL);
INSERT INTO public.clientes VALUES (
  'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Juan Atala', NULL, NULL, 'CONSUMIDOR_FINAL'
);
INSERT INTO public.cobranzas_cta_cte VALUES
  ('10000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', now(), 200000.64, 'TRANSFERENCIA', '{"banco":"Macro"}', NULL),
  ('10000000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', now(), 100, 'EFECTIVO', '{}', NULL),
  ('10000000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', now(), 50, 'EFECTIVO', '{}', NULL);
INSERT INTO public.cuenta_corriente_movimientos VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'CREDITO', 'CONFIRMADO', 200000.64),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'CREDITO', 'ANULADO', 100),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', 'CREDITO', 'CONFIRMADO', 50);

\i /src/supabase/migrations/20261103100000_recibos_cobranza_x.sql

DO $$
DECLARE
  v_primero jsonb;
  v_segundo jsonb;
BEGIN
  PERFORM set_config('test.uid', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);
  v_primero := public.emitir_recibo_cobranza('10000000-0000-0000-0000-000000000001');
  v_segundo := public.emitir_recibo_cobranza('10000000-0000-0000-0000-000000000001');
  IF v_primero <> v_segundo OR v_primero->>'numero' <> 'GPZ-RX-0001' THEN
    RAISE EXCEPTION 'La reimpresión cambió el recibo o su número';
  END IF;
  IF (SELECT count(*) FROM public.recibos_cobranza) <> 1
     OR (SELECT ultimo_numero FROM public.documento_secuencias) <> 1
     OR (SELECT count(*) FROM public.cuenta_corriente_movimientos) <> 3 THEN
    RAISE EXCEPTION 'Se duplicó el recibo o se alteró el libro de cuenta corriente';
  END IF;

  BEGIN
    PERFORM public.emitir_recibo_cobranza('10000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'Se emitió un recibo nuevo de un cobro anulado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'No se emite un recibo nuevo%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.emitir_recibo_cobranza('10000000-0000-0000-0000-000000000003');
    RAISE EXCEPTION 'Se leyó un cobro de otra sucursal';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'No podés emitir recibos%' THEN RAISE; END IF;
  END;
  UPDATE public.cobranzas_cta_cte SET monto = 1000000000
   WHERE id = '10000000-0000-0000-0000-000000000002';
  UPDATE public.cuenta_corriente_movimientos SET monto = 1000000000
   WHERE cobranza_id = '10000000-0000-0000-0000-000000000002';
  BEGIN
    PERFORM public.emitir_recibo_cobranza('10000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'Se numeró un importe que el PDF no puede imprimir';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'El importe supera el máximo imprimible%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.recibos_cobranza) <> 1
     OR (SELECT ultimo_numero FROM public.documento_secuencias) <> 1 THEN
    RAISE EXCEPTION 'La emisión rechazada consumió un número';
  END IF;

  UPDATE public.cuenta_corriente_movimientos SET estado = 'ANULADO'
   WHERE cobranza_id = '10000000-0000-0000-0000-000000000001';
  IF (public.emitir_recibo_cobranza('10000000-0000-0000-0000-000000000001')->>'anulado')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'La reimpresión no marcó el cobro anulado';
  END IF;
  PERFORM set_config('test.uid', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
  PERFORM public.emitir_recibo_cobranza('10000000-0000-0000-0000-000000000003');
  PERFORM set_config('test.uid', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);
  IF (SELECT count(*) FROM public.recibos_cobranza_emitidos(ARRAY[
      '10000000-0000-0000-0000-000000000001'::uuid,
      '10000000-0000-0000-0000-000000000002'::uuid,
      '10000000-0000-0000-0000-000000000003'::uuid
    ])) <> 1 THEN
    RAISE EXCEPTION 'La lista de reimpresión incluyó cobros ajenos o sin recibo';
  END IF;
END $$;

DO $$ BEGIN
  IF has_function_privilege('anon', 'public.emitir_recibo_cobranza(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.recibos_cobranza_emitidos(uuid[])', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.recibos_cobranza', 'SELECT') THEN
    RAISE EXCEPTION 'El recibo quedó expuesto fuera de la RPC autorizada';
  END IF;
END $$;

SET test.uid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
SET ROLE authenticated;
DO $$ BEGIN
  IF (public.emitir_recibo_cobranza('10000000-0000-0000-0000-000000000001')->>'anulado')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'El usuario autenticado no pudo reimprimir el recibo anulado';
  END IF;
END $$;
RESET ROLE;
