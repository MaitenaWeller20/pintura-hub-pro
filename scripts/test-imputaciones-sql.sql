\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'quimex_imputacion_test' THEN
    RAISE EXCEPTION 'Ejecutar sólo en quimex_imputacion_test descartable';
  END IF;
END $$;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('test.uid', true), '')::uuid
$$;
CREATE FUNCTION public.is_admin(_uid uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT _uid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
$$;
CREATE FUNCTION public.current_sucursal_id() RETURNS uuid LANGUAGE sql AS $$
  SELECT '11111111-1111-1111-1111-111111111111'::uuid
$$;
CREATE TABLE public.profiles(id uuid PRIMARY KEY, activo boolean);
CREATE TABLE public.emisores(id uuid PRIMARY KEY, razon_social text, cuit text,
  domicilio_fiscal text, condicion_iva text, ingresos_brutos text,
  inicio_actividades date, logo text);
CREATE TABLE public.sucursales(id uuid PRIMARY KEY, emisor_id uuid,
  nombre text, numero text, direccion text, telefono text);
CREATE TABLE public.clientes(id uuid PRIMARY KEY, razon_social text, cuit_dni text,
  direccion text, tipo text);
CREATE TABLE public.ventas(id uuid PRIMARY KEY, cliente_id uuid, sucursal_id uuid,
  fecha timestamptz, numero_comprobante text, tipo_comprobante text,
  condicion_venta text, estado text, total numeric(14,2),
  afip_cbte_asoc_id uuid, afip_numero integer, afip_punto_venta integer,
  afip_cbte_tipo integer, afip_estado text, afip_modo text, afip_simulado boolean);
CREATE TABLE public.cobranzas_cta_cte(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid, sucursal_id uuid, fecha timestamptz DEFAULT now(),
  monto numeric(14,2), forma_pago text, detalle jsonb, observaciones text);
GRANT SELECT ON public.cobranzas_cta_cte TO authenticated;
CREATE TABLE public.cuenta_corriente_movimientos(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_id uuid UNIQUE, cobranza_id uuid UNIQUE, cliente_id uuid, sucursal_id uuid,
  tipo text, estado text DEFAULT 'CONFIRMADO', monto numeric(14,2));
CREATE TABLE public.documento_secuencias(sucursal_id uuid, tipo text,
  ultimo_numero integer NOT NULL, PRIMARY KEY(sucursal_id,tipo));
CREATE FUNCTION public.next_documento_numero(_sucursal_id uuid, _tipo text, _prefijo text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_next integer;
BEGIN
  INSERT INTO public.documento_secuencias VALUES (_sucursal_id, _tipo, 1)
  ON CONFLICT (sucursal_id,tipo) DO UPDATE
    SET ultimo_numero = documento_secuencias.ultimo_numero + 1
  RETURNING ultimo_numero INTO v_next;
  RETURN 'GPZ-' || _prefijo || '-' || lpad(v_next::text, 4, '0');
END $$;
CREATE FUNCTION public.cc_saldo(_cliente_id uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(CASE WHEN tipo = 'DEBITO' THEN monto ELSE -monto END), 0)
  FROM public.cuenta_corriente_movimientos
  WHERE cliente_id = _cliente_id AND estado = 'CONFIRMADO'
$$;
CREATE FUNCTION public.registrar_cobranza(p_cliente_id uuid, p_sucursal_id uuid,
  p_monto numeric, p_forma_pago text, p_detalle jsonb, p_observaciones text)
RETURNS TABLE(cobranza_id uuid, saldo numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  INSERT INTO public.cobranzas_cta_cte(cliente_id,sucursal_id,monto,forma_pago,detalle,observaciones)
  VALUES(p_cliente_id,p_sucursal_id,p_monto,p_forma_pago,p_detalle,p_observaciones)
  RETURNING id INTO v_id;
  INSERT INTO public.cuenta_corriente_movimientos(cobranza_id,cliente_id,sucursal_id,tipo,monto)
  VALUES(v_id,p_cliente_id,p_sucursal_id,'CREDITO',p_monto);
  RETURN QUERY SELECT v_id, public.cc_saldo(p_cliente_id);
END $$;

INSERT INTO auth.users VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
INSERT INTO public.profiles VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',true);
INSERT INTO public.emisores VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  'CasaForma','30714199664','Córdoba','RESPONSABLE_INSCRIPTO',null,null,null);
INSERT INTO public.sucursales VALUES
  ('11111111-1111-1111-1111-111111111111','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
   'General Paz','0003','Córdoba',null),
  ('22222222-2222-2222-2222-222222222222','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
   'Otra','0004','Córdoba',null);
INSERT INTO public.clientes VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','Cliente uno',null,null,'CONSUMIDOR_FINAL'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','Cliente dos',null,null,'CONSUMIDOR_FINAL');
INSERT INTO public.ventas VALUES
  ('30000000-0000-0000-0000-000000000001','cccccccc-cccc-cccc-cccc-cccccccccccc',
   '11111111-1111-1111-1111-111111111111',now(),'GPZ-FAIV-0001',
   'FAC_INTERNA_CTA_CTE','CTA_CTE','ACTIVA',150,null,null,null,null,'NO_APLICA',null,false),
  ('30000000-0000-0000-0000-000000000002','cccccccc-cccc-cccc-cccc-cccccccccccc',
   '11111111-1111-1111-1111-111111111111',now(),'GPZ-REM-0058',
   'REMITO','CTA_CTE','ACTIVA',100,null,null,null,null,'NO_APLICA',null,false),
  ('30000000-0000-0000-0000-000000000003','dddddddd-dddd-dddd-dddd-dddddddddddd',
   '11111111-1111-1111-1111-111111111111',now(),'GPZ-FAIV-0002',
   'FAC_INTERNA_CTA_CTE','CTA_CTE','ACTIVA',100,null,null,null,null,'NO_APLICA',null,false),
  ('30000000-0000-0000-0000-000000000004','cccccccc-cccc-cccc-cccc-cccccccccccc',
   '22222222-2222-2222-2222-222222222222',now(),'OHI-FAIV-0001',
   'FAC_INTERNA_CTA_CTE','CTA_CTE','ACTIVA',100,null,null,null,null,'NO_APLICA',null,false);
INSERT INTO public.cuenta_corriente_movimientos(venta_id,cliente_id,sucursal_id,tipo,monto)
SELECT id,cliente_id,sucursal_id,'DEBITO',total FROM public.ventas;
INSERT INTO public.cobranzas_cta_cte(id,cliente_id,sucursal_id,monto,forma_pago,detalle)
VALUES ('10000000-0000-0000-0000-000000000001',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  '11111111-1111-1111-1111-111111111111',200,'EFECTIVO','{}');
INSERT INTO public.cuenta_corriente_movimientos(cobranza_id,cliente_id,sucursal_id,tipo,monto)
VALUES ('10000000-0000-0000-0000-000000000001',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  '11111111-1111-1111-1111-111111111111','CREDITO',200);

\ir ../supabase/migrations/20261103100000_recibos_cobranza_x.sql
\ir ../supabase/migrations/20261103120000_imputaciones_cobranza_recibo.sql

DO $$
DECLARE v_uid uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_id uuid := '10000000-0000-0000-0000-000000000001';
  v_recibo jsonb;
  v_saldo numeric;
BEGIN
  PERFORM set_config('test.uid', v_uid::text, true);
  v_saldo := public.cc_saldo('cccccccc-cccc-cccc-cccc-cccccccccccc');
  PERFORM public.imputar_cobranza(v_id, '[
    {"venta_id":"30000000-0000-0000-0000-000000000001","monto":100},
    {"venta_id":"30000000-0000-0000-0000-000000000002","monto":50}
  ]');
  IF public.cc_saldo('cccccccc-cccc-cccc-cccc-cccccccccccc') <> v_saldo
    OR (SELECT count(*) FROM public.cuenta_corriente_movimientos) <> 5
    OR (SELECT count(*) FROM public.cobranza_imputaciones) <> 2 THEN
    RAISE EXCEPTION 'La imputación alteró saldo o libro';
  END IF;
  IF (SELECT disponible FROM public.cc_comprobantes_imputables(
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      '11111111-1111-1111-1111-111111111111') WHERE numero='GPZ-FAIV-0001') <> 50 THEN
    RAISE EXCEPTION 'El comprobante no reflejó la aplicación';
  END IF;
  v_recibo := public.emitir_recibo_cobranza(v_id);
  IF jsonb_array_length(v_recibo#>'{datos,imputaciones}') <> 2
     OR (v_recibo#>>'{datos,a_cuenta}')::numeric <> 50
     OR public.emitir_recibo_cobranza(v_id) <> v_recibo THEN
    RAISE EXCEPTION 'El recibo no conservó la copia de imputaciones';
  END IF;
  BEGIN
    PERFORM public.imputar_cobranza(v_id,
      '[{"venta_id":"30000000-0000-0000-0000-000000000001","monto":1}]');
    RAISE EXCEPTION 'Permitió cambiar un recibo emitido';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'El cobro ya tiene recibo%' THEN RAISE; END IF;
  END;
  UPDATE public.cuenta_corriente_movimientos SET estado='ANULADO' WHERE cobranza_id=v_id;
  IF (SELECT disponible FROM public.cc_comprobantes_imputables(
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      '11111111-1111-1111-1111-111111111111') WHERE numero='GPZ-FAIV-0001') <> 150
    OR (public.emitir_recibo_cobranza(v_id)->>'anulado')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'La anulación no liberó la imputación o alteró el recibo';
  END IF;
END $$;

DO $$
DECLARE v_id uuid := '10000000-0000-0000-0000-000000000002';
  v_cobros integer;
BEGIN
  PERFORM set_config('test.uid', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
  INSERT INTO public.cobranzas_cta_cte(id,cliente_id,sucursal_id,monto,forma_pago,detalle)
  VALUES(v_id,'cccccccc-cccc-cccc-cccc-cccccccccccc',
    '11111111-1111-1111-1111-111111111111',100,'EFECTIVO','{}');
  INSERT INTO public.cuenta_corriente_movimientos(cobranza_id,cliente_id,sucursal_id,tipo,monto)
  VALUES(v_id,'cccccccc-cccc-cccc-cccc-cccccccccccc',
    '11111111-1111-1111-1111-111111111111','CREDITO',100);
  BEGIN
    PERFORM public.imputar_cobranza(v_id,
      '[{"venta_id":"30000000-0000-0000-0000-000000000003","monto":10}]');
    RAISE EXCEPTION 'Permitió imputar a otro cliente';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'El comprobante no corresponde%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.imputar_cobranza(v_id,
      '[{"venta_id":"30000000-0000-0000-0000-000000000004","monto":10}]');
    RAISE EXCEPTION 'Permitió imputar a otra sucursal';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'El comprobante no corresponde%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.imputar_cobranza(v_id,
      '[{"venta_id":"30000000-0000-0000-0000-000000000001","monto":151}]');
    RAISE EXCEPTION 'Permitió sobreimputar el comprobante';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'La imputación supera el importe disponible%' THEN RAISE; END IF;
  END;
  v_cobros := (SELECT count(*) FROM public.cobranzas_cta_cte);
  BEGIN
    PERFORM public.registrar_cobranza_imputada(
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      '11111111-1111-1111-1111-111111111111', 10,'EFECTIVO','{}',null,
      '[{"venta_id":"30000000-0000-0000-0000-000000000003","monto":10}]');
    RAISE EXCEPTION 'Permitió registrar un cobro mal imputado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'El comprobante no corresponde%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.cobranzas_cta_cte) <> v_cobros THEN
    RAISE EXCEPTION 'La operación fallida dejó un cobro en caja';
  END IF;
  UPDATE public.ventas SET estado='ANULADA' WHERE id='30000000-0000-0000-0000-000000000002';
  UPDATE public.cuenta_corriente_movimientos SET estado='ANULADO'
    WHERE venta_id='30000000-0000-0000-0000-000000000002';
  PERFORM public.imputar_cobranza(v_id,
    '[{"venta_id":"30000000-0000-0000-0000-000000000001","monto":100}]');
  IF (SELECT count(*) FROM public.cobranza_imputaciones WHERE cobranza_id=v_id) <> 1 THEN
    RAISE EXCEPTION 'No se imputó el cobro válido';
  END IF;
END $$;
DO $$ BEGIN
  PERFORM set_config('test.uid', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
  INSERT INTO public.cobranzas_cta_cte(id,cliente_id,sucursal_id,monto,forma_pago,detalle)
  VALUES('10000000-0000-0000-0000-000000000005',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    '22222222-2222-2222-2222-222222222222',10,'EFECTIVO','{}');
  INSERT INTO public.cuenta_corriente_movimientos(cobranza_id,cliente_id,sucursal_id,tipo,monto)
  VALUES('10000000-0000-0000-0000-000000000005',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    '22222222-2222-2222-2222-222222222222','CREDITO',10);
  PERFORM public.imputar_cobranza('10000000-0000-0000-0000-000000000005',
    '[{"venta_id":"30000000-0000-0000-0000-000000000004","monto":10}]');
END $$;
SET LOCAL test.uid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF has_function_privilege('authenticated','public._imputar_cobranza(uuid,jsonb)','EXECUTE')
     OR has_table_privilege('authenticated','public.cobranza_imputaciones','INSERT') THEN
    RAISE EXCEPTION 'La escritura de imputaciones quedó abierta';
  END IF;
  IF (SELECT count(*) FROM public.cobranza_imputaciones) <> 3 THEN
    RAISE EXCEPTION 'El cajero no pudo leer imputaciones de su sucursal';
  END IF;
  BEGIN
    PERFORM public.cc_comprobantes_imputables(
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      '22222222-2222-2222-2222-222222222222');
    RAISE EXCEPTION 'El cajero vio comprobantes de otra sucursal';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'No podés consultar comprobantes%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.imputar_cobranza('10000000-0000-0000-0000-000000000002',
      '[{"venta_id":"30000000-0000-0000-0000-000000000001","monto":1}]');
    RAISE EXCEPTION 'El cajero imputó un cobro anterior';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Solo un administrador%' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;
\if :{?conservar_fixture}
COMMIT;
\else
ROLLBACK;
\endif
