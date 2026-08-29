#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -X -v ON_ERROR_STOP=1)

"${PSQL[@]}" <<'SQL'
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_ok boolean,p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FALLO: %',p_message;
  END IF;
  RAISE NOTICE '✓ %',p_message;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.actor(p_uid uuid)
RETURNS void LANGUAGE sql AS $$
  SELECT pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub',p_uid,'role','authenticated')::text,
    true
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_sql text,p_pattern text,p_message text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'la operación fue aceptada' USING ERRCODE='ZX001';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
    IF SQLSTATE='ZX001' OR v_message NOT ILIKE '%'||p_pattern||'%' THEN
      RAISE EXCEPTION 'FALLO: % (error recibido: %)',p_message,v_message;
    END IF;
  END;
  RAISE NOTICE '✓ %',p_message;
END;
$$;

INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES
 ('a2400000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nc-periodo-admin@test.local','x',now(),now(),now()),
 ('a2400000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nc-periodo-full@test.local','x',now(),now(),now()),
 ('a2400000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nc-periodo-no-factura@test.local','x',now(),now(),now()),
 ('a2400000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nc-periodo-no-nc@test.local','x',now(),now(),now()),
 ('a2400000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nc-periodo-inactivo@test.local','x',now(),now(),now()),
 ('a2400000-0000-4000-8000-000000000006','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nc-periodo-otro-actor@test.local','x',now(),now(),now());

INSERT INTO public.user_roles(user_id,role)
VALUES ('a2400000-0000-4000-8000-000000000001','admin');
SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000001');

UPDATE public.profiles
   SET sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
       activo=true,puede_facturar=false,puede_emitir_nc_periodo=false
 WHERE id BETWEEN 'a2400000-0000-4000-8000-000000000001'
              AND 'a2400000-0000-4000-8000-000000000006';
UPDATE public.profiles SET puede_facturar=true,puede_emitir_nc_periodo=true
 WHERE id IN ('a2400000-0000-4000-8000-000000000002','a2400000-0000-4000-8000-000000000006');
UPDATE public.profiles SET puede_emitir_nc_periodo=true
 WHERE id='a2400000-0000-4000-8000-000000000003';
UPDATE public.profiles SET puede_facturar=true
 WHERE id='a2400000-0000-4000-8000-000000000004';
UPDATE public.profiles SET puede_facturar=true,puede_emitir_nc_periodo=true
 WHERE id='a2400000-0000-4000-8000-000000000005';
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"a2400000-0000-4000-8000-000000000001","role":"service_role"}',
  true
);
SELECT public.iniciar_transicion_usuario_activo(
  'a2400000-0000-4000-8000-000000000001',
  'a2400000-0000-4000-8000-000000000005',false,
  'f2400000-0000-4000-8000-000000000005'
);
SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000001');

INSERT INTO public.profile_sucursales(profile_id,sucursal_id)
SELECT p.id,s.id
  FROM public.profiles p
 CROSS JOIN LATERAL (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1) s
 WHERE p.id BETWEEN 'a2400000-0000-4000-8000-000000000001'
                AND 'a2400000-0000-4000-8000-000000000006';

INSERT INTO public.clientes(id,razon_social,tipo,condicion_cta_cte,limite_credito,activo,es_generico)
VALUES
 ('b2400000-0000-4000-8000-000000000001','CLIENTE NC PERIODO','CONSUMIDOR_FINAL',true,99999999,true,false),
 ('b2400000-0000-4000-8000-000000000002','CLIENTE NC INACTIVO','RESPONSABLE_INSCRIPTO',true,99999999,false,false),
 ('b2400000-0000-4000-8000-000000000003','CLIENTE GENERICO','CONSUMIDOR_FINAL',false,NULL,true,true),
 ('b2400000-0000-4000-8000-000000000004','CLIENTE RI','RESPONSABLE_INSCRIPTO',true,99999999,true,false),
 ('b2400000-0000-4000-8000-000000000005','CLIENTE MONO','MONOTRIBUTISTA',true,99999999,true,false);

INSERT INTO public.productos(id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado)
VALUES
 ('c2400000-0000-4000-8000-000000000001','NC-PER-01','PRODUCTO NC PERIODO',100,21,true,false),
 ('c2400000-0000-4000-8000-000000000002','NC-PER-02','PRODUCTO NC INACTIVO',50,10.5,false,false),
 ('c2400000-0000-4000-8000-000000000003','NC-PER-03','PRODUCTO NC PERIODO 2',50,10.5,true,false);
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
SELECT 'c2400000-0000-4000-8000-000000000001',id,20
  FROM public.sucursales ORDER BY numero LIMIT 1;
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
SELECT 'c2400000-0000-4000-8000-000000000003',id,30
  FROM public.sucursales ORDER BY numero LIMIT 1;

UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false,
       nota_credito_periodo_enabled=false
 WHERE id=true;
UPDATE public.emisores AS e
   SET inicio_actividades=COALESCE(e.inicio_actividades,'2020-01-01'::date)
  FROM public.sucursales AS s
 WHERE s.emisor_id=e.id
   AND s.id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1);

-- Este primer escenario es el RED deliberado: sin la migración la firma no existe.
SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000001');
SELECT pg_temp.assert_raises($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
    'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Devolución de productos','REINTEGRO',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":2,"precio_unitario_sin_iva":90,"iva_porcentaje":21}]',
    '[{"forma_pago":"TRANSFERENCIA","monto_centavos":21780}]',
    'e2400000-0000-4000-8000-000000000001'
  )
$sql$,'deshabilitada','el flag apagado rechaza al administrador');

SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000002');
SELECT pg_temp.assert_raises($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
    'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Devolución de productos','REINTEGRO',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":2,"precio_unitario_sin_iva":90,"iva_porcentaje":21}]',
    '[{"forma_pago":"TRANSFERENCIA","monto_centavos":21780}]',
    'e2400000-0000-4000-8000-000000000002'
  )
$sql$,'deshabilitada','el flag apagado rechaza al empleado autorizado');

UPDATE public.settings SET nota_credito_periodo_enabled=true WHERE id=true;

SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000005');
SELECT pg_temp.assert_raises($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
    'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Perfil inactivo','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000003'
  )
$sql$,'inactivo','un perfil inactivo no crea');

SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000002');
SELECT pg_temp.assert_raises($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    (SELECT id FROM public.sucursales ORDER BY numero OFFSET 1 LIMIT 1),
    'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Sucursal incorrecta','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000004'
  )
$sql$,'sucursal','un empleado no crea en otra sucursal');

SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000003');
SELECT pg_temp.assert_raises($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
    'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Falta facturar','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000005'
  )
$sql$,'permiso','se requieren ambas capacidades');
SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000004');
SELECT pg_temp.assert_raises($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
    'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Falta permiso NC','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000006'
  )
$sql$,'permiso','facturar sin capacidad específica no alcanza');

-- El wrapper público no debe recorrer/copiar inputs que el core rechazará.
-- Los JSON se construyen antes de acotar el statement_timeout para medir sólo
-- la llamada real. Un caller sin capacidad debe alcanzar rápido el rechazo de
-- autorización aun cuando mande cualquiera de los dos arrays sobredimensionado.
CREATE TEMP TABLE t_inputs_sobredimensionados AS
SELECT
  (
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'producto_id','c2400000-0000-4000-8000-000000000001',
      'cantidad',1,'precio_unitario_sin_iva',100,'iva_porcentaje',21
    ) ORDER BY g.n)
    FROM pg_catalog.generate_series(1,10000) AS g(n)
  ) AS items,
  (
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'forma_pago','EFECTIVO','monto_centavos',12100
    ) ORDER BY g.n)
    FROM pg_catalog.generate_series(1,10000) AS g(n)
  ) AS reintegros;

CREATE OR REPLACE FUNCTION pg_temp.invocar_input_sobredimensionado(p_caso text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_items jsonb;
  v_reintegros jsonb;
BEGIN
  SELECT
    CASE WHEN p_caso='items' THEN t.items ELSE pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'producto_id','c2400000-0000-4000-8000-000000000001',
        'cantidad',1,'precio_unitario_sin_iva',100,'iva_porcentaje',21
      )
    ) END,
    CASE WHEN p_caso='reintegros' THEN t.reintegros ELSE '[]'::jsonb END
    INTO v_items,v_reintegros
    FROM t_inputs_sobredimensionados AS t;

  PERFORM * FROM public.crear_nota_credito_periodo_fiscal(
    (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
    'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Input sobredimensionado','SALDO_FAVOR',
    v_items,v_reintegros,
    CASE p_caso
      WHEN 'items' THEN 'e2400000-0000-4000-8000-000000000024'::uuid
      ELSE 'e2400000-0000-4000-8000-000000000025'::uuid
    END
  );
END;
$$;

SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000003');
SET LOCAL statement_timeout='250ms';
SELECT pg_temp.assert_raises(
  'SELECT pg_temp.invocar_input_sobredimensionado(''items'')',
  'permiso','los ítems sobredimensionados alcanzan rápido la autorización'
);
SELECT pg_temp.assert_raises(
  'SELECT pg_temp.invocar_input_sobredimensionado(''reintegros'')',
  'permiso','los reintegros sobredimensionados alcanzan rápido la autorización'
);
SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000001');
SELECT pg_temp.assert_raises(
  'SELECT pg_temp.invocar_input_sobredimensionado(''items'')',
  'hasta 500','el core rechaza rápido más de 500 ítems para un caller autorizado'
);
SELECT pg_temp.assert_raises(
  'SELECT pg_temp.invocar_input_sobredimensionado(''reintegros'')',
  'hasta 20','el core rechaza rápido más de 20 reintegros para un caller autorizado'
);
SET LOCAL statement_timeout=0;

SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Items no array','SALDO_FAVOR',
    '{}'::jsonb,'[]'::jsonb,'e2400000-0000-4000-8000-000000000026')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),
  'arreglo no vacío','un tipo no-array llega a la validación estable del core'
);
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Reintegros nulos','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]'::jsonb,
    NULL,'e2400000-0000-4000-8000-000000000027')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),
  'arreglo de hasta 20','NULL llega a la validación estable de reintegros del core'
);

-- Validaciones autoritativas de cliente, período, motivo y JSON estricto.
SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000001');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000002','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Cliente inactivo','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000007')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'Cliente','el cliente inactivo se rechaza');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000099','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Cliente ausente','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000008')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'Cliente','el cliente inexistente se rechaza');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000003','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Cliente genérico','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000009')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'comercial','el cliente genérico no reemplaza al cliente comercial');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    NULL,'2026-07-31','Fecha ausente','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000010')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'fechas','ambas fechas son obligatorias');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    current_date,current_date+1,'Fecha futura','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000011')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'futuro','la fecha fiscal de Córdoba limita el período');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31',' 123 ','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000012')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'motivo','el motivo usa longitud ajustada');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Entrada estricta','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21,"percepciones":1}]','[]',
    'e2400000-0000-4000-8000-000000000013')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'únicamente','el servidor rechaza percepciones y cualquier clave extra');

-- Reglas excluyentes de líneas y liquidación.
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Concepto en devolución','SALDO_FAVOR',
    '[{"producto_id":null,"descripcion":"Concepto","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000014')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'producto','la devolución no admite conceptos libres');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Producto inactivo','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000002","cantidad":1,"precio_unitario_sin_iva":50,"iva_porcentaje":10.5}]','[]',
    'e2400000-0000-4000-8000-000000000015')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'activo','sólo se reservan productos activos');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','BONIFICACION_AJUSTE',
    '2026-07-01','2026-07-31','Producto en ajuste','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000016')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'concepto','el ajuste exige producto nulo');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','BONIFICACION_AJUSTE',
    '2026-07-01','2026-07-31','Dos conceptos','SALDO_FAVOR',
    '[{"producto_id":null,"descripcion":"Uno","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21},{"producto_id":null,"descripcion":"Dos","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000017')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'exactamente una','el ajuste admite exactamente un concepto');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Reintegro parcial','REINTEGRO',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":2,"precio_unitario_sin_iva":90,"iva_porcentaje":21}]',
    '[{"forma_pago":"TRANSFERENCIA","monto_centavos":21779}]',
    'e2400000-0000-4000-8000-000000000018')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'coincidir','el reintegro debe coincidir al centavo');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Precio fraccionario','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":90.001,"iva_porcentaje":21}]','[]',
    'e2400000-0000-4000-8000-000000000022')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'centavos','los importes persistibles no admiten fracciones de centavo');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Saldo con pago','SALDO_FAVOR',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":2,"precio_unitario_sin_iva":90,"iva_porcentaje":21}]',
    '[{"forma_pago":"TRANSFERENCIA","monto_centavos":21780}]',
    'e2400000-0000-4000-8000-000000000019')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'no admite','el saldo a favor no planifica pagos');

-- La creación no abre caja ni aplica ningún efecto comercial.
UPDATE public.caja_sesiones SET estado='CERRADA',cerrada_en=COALESCE(cerrada_en,now())
 WHERE sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)
   AND estado='ABIERTA';
CREATE TEMP TABLE t_before AS
SELECT
  (SELECT count(*) FROM public.caja_sesiones WHERE estado='ABIERTA') cajas,
  (SELECT count(*) FROM public.caja_movimientos) caja_movs,
  (SELECT count(*) FROM public.stock_movimientos) stock_movs,
  (SELECT cantidad FROM public.stock_sucursal WHERE producto_id='c2400000-0000-4000-8000-000000000001' AND sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)) stock_qty,
  (SELECT count(*) FROM public.venta_pagos) pagos,
  (SELECT count(*) FROM public.cuenta_corriente_movimientos) cc;

CREATE TEMP TABLE t_producto AS
SELECT * FROM public.crear_nota_credito_periodo_fiscal(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
  '2026-07-01','2026-07-31','  Devolución con override  ','REINTEGRO',
  '[{"iva_porcentaje":21,"precio_unitario_sin_iva":90,"cantidad":2,"producto_id":"c2400000-0000-4000-8000-000000000001"}]',
  '[{"monto_centavos":21780,"forma_pago":"TRANSFERENCIA"}]',
  'e2400000-0000-4000-8000-000000000020'
);
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM t_producto),'el administrador crea una devolución pendiente');
SELECT pg_temp.assert_true((
  SELECT v.tipo_comprobante='NOTA_CREDITO'
     AND v.condicion_venta='CONTADO'
     AND v.estado='PENDIENTE_FISCAL'
     AND v.afip_estado='SIN_FACTURAR'
     AND v.subtotal_sin_iva=-180.00 AND v.iva_total=-37.80 AND v.total=-217.80
     AND v.percepciones=0 AND v.total_pagado=0
     AND v.afip_punto_venta IS NULL AND v.afip_numero IS NULL
     AND v.cae IS NULL AND v.afip_snapshot IS NULL AND v.afip_snapshot_hash IS NULL
     AND v.caja_sesion_id IS NULL
     AND v.motivo_nota_credito='Devolución con override'
    FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_producto)
),'la ruta B crea una cabecera fiscal pendiente, negativa, sin numeración ARCA ni evidencia');
SELECT pg_temp.assert_true((
  SELECT i.producto_id='c2400000-0000-4000-8000-000000000001'
     AND i.cantidad=2 AND i.precio_lista_sin_iva=100
     AND i.precio_unitario_sin_iva=90 AND i.descuento_porcentaje=0
     AND i.subtotal_sin_iva=-180 AND i.iva_monto=-37.80 AND i.subtotal_con_iva=-217.80
    FROM public.venta_items i WHERE i.venta_id=(SELECT venta_id FROM t_producto)
),'el precio histórico queda auditado contra la lista bloqueada');
SELECT pg_temp.assert_true((
  SELECT count(*)=1 AND min(forma_pago)='TRANSFERENCIA' AND sum(monto)=217.80
    FROM public.nota_credito_periodo_reintegros
   WHERE venta_id=(SELECT venta_id FROM t_producto)
),'el reintegro queda como intención positiva exacta');
SELECT pg_temp.assert_true((
  SELECT b.cajas=(SELECT count(*) FROM public.caja_sesiones WHERE estado='ABIERTA')
     AND b.caja_movs=(SELECT count(*) FROM public.caja_movimientos)
     AND b.stock_movs=(SELECT count(*) FROM public.stock_movimientos)
     AND b.stock_qty=(SELECT cantidad FROM public.stock_sucursal WHERE producto_id='c2400000-0000-4000-8000-000000000001' AND sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1))
     AND b.pagos=(SELECT count(*) FROM public.venta_pagos)
     AND b.cc=(SELECT count(*) FROM public.cuenta_corriente_movimientos)
    FROM t_before b
),'crear la reserva no abre caja ni toca stock, pagos, caja o cuenta corriente');

CREATE TEMP TABLE t_replay AS
SELECT * FROM public.crear_nota_credito_periodo_fiscal(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
  '2026-07-01','2026-07-31','Devolución con override','REINTEGRO',
  '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":2,"precio_unitario_sin_iva":90,"iva_porcentaje":21}]',
  '[{"forma_pago":"TRANSFERENCIA","monto_centavos":21780}]',
  'e2400000-0000-4000-8000-000000000020'
);
CREATE TEMP TABLE t_replay_escala AS
SELECT * FROM public.crear_nota_credito_periodo_fiscal(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
  '2026-07-01','2026-07-31','Devolución con override','REINTEGRO',
  '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":2.0,"precio_unitario_sin_iva":90.0,"iva_porcentaje":21.0}]',
  '[{"forma_pago":"TRANSFERENCIA","monto_centavos":21780.0}]',
  'e2400000-0000-4000-8000-000000000020'
);
SELECT pg_temp.assert_true(
  (SELECT p.venta_id=r.venta_id AND p.numero=r.numero FROM t_producto p CROSS JOIN t_replay r)
  AND (SELECT p.venta_id=r.venta_id FROM t_producto p CROSS JOIN t_replay_escala r)
  AND (SELECT count(*)=1 FROM public.ventas WHERE idempotency_key='e2400000-0000-4000-8000-000000000020'),
  'el payload canónico idéntico devuelve la misma venta aunque cambie la escala numérica'
);
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Motivo cambiado','REINTEGRO',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":2,"precio_unitario_sin_iva":90,"iva_porcentaje":21}]',
    '[{"forma_pago":"TRANSFERENCIA","monto_centavos":21780}]',
    'e2400000-0000-4000-8000-000000000020')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'idempotencia','la clave no acepta otro payload');
SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000006');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.crear_nota_credito_periodo_fiscal(
    %L,'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
    '2026-07-01','2026-07-31','Devolución con override','REINTEGRO',
    '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":2,"precio_unitario_sin_iva":90,"iva_porcentaje":21}]',
    '[{"forma_pago":"TRANSFERENCIA","monto_centavos":21780}]',
    'e2400000-0000-4000-8000-000000000020')
$sql$,(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),'idempotencia','la clave no funciona como oráculo entre actores');

SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000002');
CREATE TEMP TABLE t_ajuste AS
SELECT * FROM public.crear_nota_credito_periodo_fiscal(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2400000-0000-4000-8000-000000000004','BONIFICACION_AJUSTE',
  '2026-06-01','2026-06-30','Bonificación comercial','SALDO_FAVOR',
  '[{"producto_id":null,"descripcion":"Bonificación acordada","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":10.5}]','[]',
  'e2400000-0000-4000-8000-000000000021'
);
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM t_ajuste),'el empleado con ambas capacidades crea por la ruta A');
SELECT pg_temp.assert_true((
  SELECT v.condicion_venta='CTA_CTE' AND v.total=-110.50 AND v.percepciones=0
     AND NOT EXISTS (SELECT 1 FROM public.nota_credito_periodo_reintegros r WHERE r.venta_id=v.id)
     AND NOT EXISTS (SELECT 1 FROM public.venta_pagos p WHERE p.venta_id=v.id)
     AND EXISTS (
       SELECT 1 FROM public.venta_items i WHERE i.venta_id=v.id
         AND i.producto_id IS NULL AND i.codigo='AJUSTE' AND i.cantidad=1
         AND i.precio_lista_sin_iva=i.precio_unitario_sin_iva
         AND i.descuento_porcentaje=0
     )
    FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_ajuste)
),'el ajuste reserva un concepto y saldo a favor sin pagos');

-- Tarea 8: snapshot v3 real y efectos comerciales exclusivamente post-CAE.
-- El helper de test construye la misma intención congelada que consume ARCA;
-- las expectativas de stock/caja/cuenta corriente se derivan por separado.
CREATE OR REPLACE FUNCTION pg_temp.snapshot_nc_periodo(
  p_venta_id uuid,p_punto_venta integer,p_numero integer
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_venta public.ventas%ROWTYPE;
  v_sucursal public.sucursales%ROWTYPE;
  v_emisor public.emisores%ROWTYPE;
  v_items jsonb;
  v_alicuotas jsonb;
  v_body jsonb;
  v_hash text;
BEGIN
  SELECT v.* INTO STRICT v_venta FROM public.ventas v WHERE v.id=p_venta_id;
  SELECT s.* INTO STRICT v_sucursal FROM public.sucursales s WHERE s.id=v_venta.sucursal_id;
  SELECT e.* INTO STRICT v_emisor FROM public.emisores e WHERE e.id=v_sucursal.emisor_id;

  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',i.id,'productoId',i.producto_id,'codigo',i.codigo,
    'descripcion',i.descripcion,
    'cantidad',pg_catalog.to_char(pg_catalog.abs(i.cantidad),'FM999999999999990.00'),
    'precioUnitarioSinIva',pg_catalog.to_char(pg_catalog.abs(i.precio_unitario_sin_iva),'FM999999999999990.00'),
    'descuentoPorcentaje',pg_catalog.to_char(i.descuento_porcentaje,'FM990.00'),
    'ivaPorcentaje',pg_catalog.to_char(i.iva_porcentaje,'FM990.00'),
    'subtotalNeto',pg_catalog.to_char(pg_catalog.abs(i.subtotal_sin_iva),'FM999999999999990.00'),
    'importeIva',pg_catalog.to_char(pg_catalog.abs(i.iva_monto),'FM999999999999990.00'),
    'subtotalTotal',pg_catalog.to_char(pg_catalog.abs(i.subtotal_con_iva),'FM999999999999990.00')
  ) ORDER BY i.id)
  INTO v_items
  FROM public.venta_items i WHERE i.venta_id=p_venta_id;

  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',a.arca_id,
    'baseImponible',pg_catalog.to_char(a.base,'FM999999999999990.00'),
    'importe',pg_catalog.to_char(a.iva,'FM999999999999990.00')
  ) ORDER BY a.arca_id)
  INTO v_alicuotas
  FROM (
    SELECT CASE i.iva_porcentaje
             WHEN 0 THEN 3 WHEN 10.5 THEN 4 WHEN 21 THEN 5
             WHEN 27 THEN 6 WHEN 5 THEN 8 WHEN 2.5 THEN 9
           END AS arca_id,
           pg_catalog.sum(pg_catalog.abs(i.subtotal_sin_iva)) AS base,
           pg_catalog.sum(pg_catalog.abs(i.iva_monto)) AS iva
      FROM public.venta_items i
     WHERE i.venta_id=p_venta_id
     GROUP BY i.iva_porcentaje
  ) a;

  v_body := pg_catalog.jsonb_build_object(
    'version',3,
    'venta',pg_catalog.jsonb_build_object(
      'id',v_venta.id,'numeroComercial',v_venta.numero_comprobante,
      'tipoComprobante','NOTA_CREDITO',
      'fechaComercial',pg_catalog.to_char(
        v_venta.fecha AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    ),
    'items',v_items,
    'emisor',pg_catalog.jsonb_build_object(
      'id',v_emisor.id,'razonSocial',v_emisor.razon_social,
      'nombreFantasia',v_emisor.nombre_fantasia,'cuit',v_emisor.cuit,
      'domicilioFiscal',COALESCE(v_emisor.domicilio_fiscal,''),
      'condicionIva',v_emisor.condicion_iva,
      'ingresosBrutos',v_emisor.ingresos_brutos::text,
      'inicioActividades',v_emisor.inicio_actividades::text,'telefono',NULL
    ),
    'sucursal',pg_catalog.jsonb_build_object(
      'id',v_sucursal.id,'nombre',v_sucursal.nombre,
      'direccion',v_sucursal.direccion,'telefono',v_sucursal.telefono
    ),
    -- El receptor fiscal es deliberadamente otra persona: la resolución
    -- comercial debe seguir aplicándose al cliente_id de la venta.
    'receptor',pg_catalog.jsonb_build_object(
      'razonSocial','RECEPTOR FISCAL DISTINTO','domicilio','Domicilio fiscal 123',
      'tipoDocumento','DNI','numeroDocumento','30111222',
      'docTipoArca',96,'docNroArca','30111222',
      'condicionIva','CONSUMIDOR_FINAL','origen','MANUAL','origenId',NULL,
      'verificadoArcaAt',NULL,'condicionIvaReceptorId',5
    ),
    'identidad',pg_catalog.jsonb_build_object(
      'numero',p_numero,'emisorCuit',v_emisor.cuit,
      'puntoVenta',p_punto_venta,'cbteTipo',8,'modo','PRODUCCION',
      'simulado',false,'validez','PRODUCCION'
    ),
    'letra','B','concepto',1,'fechaComprobante',current_date::text,
    'importeNeto',pg_catalog.to_char(pg_catalog.abs(v_venta.subtotal_sin_iva),'FM999999999999990.00'),
    'importeExento','0.00','importeNoGravado','0.00',
    'importeIva',pg_catalog.to_char(pg_catalog.abs(v_venta.iva_total),'FM999999999999990.00'),
    'importeTributos','0.00',
    'importeTotal',pg_catalog.to_char(pg_catalog.abs(v_venta.total),'FM999999999999990.00'),
    'alicuotasIva',v_alicuotas,'tributos','[]'::jsonb,
    'moneda','PES','cotizacion','1.000000',
    'ivaContenido',pg_catalog.to_char(pg_catalog.abs(v_venta.iva_total),'FM999999999999990.00'),
    'otrosImpuestosNacionalesIndirectos','0.00',
    'origen','PERIODO_ASOCIADO','comprobanteOriginalId',NULL,'cbtesAsoc','[]'::jsonb,
    'periodoAsoc',pg_catalog.jsonb_build_object(
      'desde',v_venta.periodo_asoc_desde::text,'hasta',v_venta.periodo_asoc_hasta::text
    ),
    'notaCredito',pg_catalog.jsonb_build_object(
      'modalidad',v_venta.nc_periodo_modalidad::text,'motivo',v_venta.motivo_nota_credito
    )
  );
  v_hash := public.fiscal_snapshot_hash(v_body);
  RETURN v_body||pg_catalog.jsonb_build_object('hash',v_hash);
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.reservar_nc_periodo(
  p_venta_id uuid,p_token uuid,p_punto_venta integer,p_expected integer DEFAULT 1
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE v_snapshot jsonb;
BEGIN
  v_snapshot := pg_temp.snapshot_nc_periodo(p_venta_id,p_punto_venta,1);
  PERFORM public.validar_snapshot_fiscal_v3(v_snapshot);
  PERFORM * FROM public.transicionar_emision_fiscal(
    p_venta_id,'RESERVAR',p_token,
    pg_catalog.jsonb_build_object(
      'expected_version',p_expected,'snapshot',v_snapshot,
      'snapshot_hash',v_snapshot->>'hash','numero_propuesto',1,
      'fecha_comprobante',current_date::text,
      'emisor_cuit',v_snapshot#>>'{identidad,emisorCuit}',
      'punto_venta',p_punto_venta,'cbte_tipo',8,'modo','PRODUCCION',
      'simulado',false,'validez','PRODUCCION',
      'ultimo_remoto',0,'ultimo_local_observado',0
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.responder_aprobado(
  p_venta_id uuid,p_token uuid,p_expected integer
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM * FROM public.transicionar_emision_fiscal(
    p_venta_id,'RESPUESTA_RECIBIDA',p_token,
    pg_catalog.jsonb_build_object(
      'expected_version',p_expected,
      'respuesta_resumen',pg_catalog.jsonb_build_object(
        'tipo','EMISION','resultado','A','fuente','FECAESolicitar',
        'rechazo_confirmado',false,'observaciones','[]'::jsonb
      )
    )
  );
END;
$$;

-- La barrera de permisos vive dentro de la transición y se evalúa antes de
-- estado/token: un empleado con puede_facturar pero sin el permiso específico
-- no puede invocar ninguna etapa directamente.
SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000004');
SELECT pg_temp.assert_raises(format(
  'SELECT * FROM public.transicionar_emision_fiscal(%L,''RECLAMAR'',%L,''{"expected_version":0,"lease_segundos":300}'')',
  (SELECT venta_id FROM t_producto),'f2400000-0000-4000-8000-000000000041'
),'permiso','sin permiso NC no reclama por RPC');
SELECT pg_temp.assert_raises(format(
  'SELECT * FROM public.transicionar_emision_fiscal(%L,''REQUEST_INICIADO'',%L,''{"expected_version":0}'')',
  (SELECT venta_id FROM t_producto),'f2400000-0000-4000-8000-000000000041'
),'permiso','sin permiso NC no emite por RPC');
SELECT pg_temp.assert_raises(format(
  'SELECT * FROM public.transicionar_emision_fiscal(%L,''RECONCILIAR'',%L,''{"expected_version":0,"error_clase":"X","error_codigo":"X","error_fase":"X","mensaje_mascarado":"X"}'')',
  (SELECT venta_id FROM t_producto),'f2400000-0000-4000-8000-000000000041'
),'permiso','sin permiso NC no reconcilia por RPC');
SELECT pg_temp.assert_raises(format(
  'SELECT * FROM public.transicionar_emision_fiscal(%L,''CANCELAR'',NULL,''{"expected_version":0}'')',
  (SELECT venta_id FROM t_producto)
),'permiso','sin permiso NC no cancela por RPC');

SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000001');
UPDATE public.settings SET nota_credito_periodo_enabled=false WHERE id=true;
SELECT pg_temp.assert_raises(format(
  'SELECT * FROM public.transicionar_emision_fiscal(%L,''RECLAMAR'',%L,''{"expected_version":0,"lease_segundos":300}'')',
  (SELECT venta_id FROM t_producto),'f2400000-0000-4000-8000-000000000042'
),'deshabilitada','el flag apagado bloquea un reclamo fresco');
UPDATE public.settings SET nota_credito_periodo_enabled=true WHERE id=true;
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_producto),'RECLAMAR',
  'f2400000-0000-4000-8000-000000000042',
  '{"expected_version":0,"lease_segundos":300}'::jsonb
);
UPDATE public.settings SET nota_credito_periodo_enabled=false WHERE id=true;
SELECT pg_temp.assert_raises(format(
  'SELECT pg_temp.reservar_nc_periodo(%L,%L,941,1)',
  (SELECT venta_id FROM t_producto),'f2400000-0000-4000-8000-000000000042'
),'deshabilitada','el flag apagado bloquea RESERVAR no iniciado');
UPDATE public.settings SET nota_credito_periodo_enabled=true WHERE id=true;
SELECT pg_temp.reservar_nc_periodo(
  (SELECT venta_id FROM t_producto),'f2400000-0000-4000-8000-000000000042',941
);
SELECT pg_temp.assert_true((
  SELECT v.afip_snapshot->>'version'='3' AND i.snapshot_version=3
    FROM public.ventas v JOIN public.emision_fiscal_intentos i ON i.venta_id=v.id
   WHERE v.id=(SELECT venta_id FROM t_producto)
     AND i.claim_token='f2400000-0000-4000-8000-000000000042'
),'RESERVAR valida v3 y persiste snapshot_version real');
UPDATE public.settings SET nota_credito_periodo_enabled=false WHERE id=true;
SELECT pg_temp.assert_raises(format(
  'SELECT * FROM public.transicionar_emision_fiscal(%L,''REQUEST_INICIADO'',%L,''{"expected_version":2}'')',
  (SELECT venta_id FROM t_producto),'f2400000-0000-4000-8000-000000000042'
),'deshabilitada','el flag apagado bloquea REQUEST_INICIADO fresco');
UPDATE public.settings SET nota_credito_periodo_enabled=true WHERE id=true;
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_producto),'REQUEST_INICIADO',
  'f2400000-0000-4000-8000-000000000042','{"expected_version":2}'::jsonb
);

-- Hasta la respuesta de ARCA no hay ningún efecto comercial.
SELECT pg_temp.assert_true((
  SELECT v.estado='PENDIENTE_FISCAL' AND v.nc_efectos_aplicados_at IS NULL
     AND b.stock_qty=(SELECT cantidad FROM public.stock_sucursal
                       WHERE producto_id='c2400000-0000-4000-8000-000000000001'
                         AND sucursal_id=v.sucursal_id)
     AND b.stock_movs=(SELECT count(*) FROM public.stock_movimientos)
     AND b.pagos=(SELECT count(*) FROM public.venta_pagos)
     AND b.cc=(SELECT count(*) FROM public.cuenta_corriente_movimientos)
    FROM public.ventas v CROSS JOIN t_before b
   WHERE v.id=(SELECT venta_id FROM t_producto)
),'crear, reclamar, reservar e iniciar request no aplican efectos');

-- Con el request durable, apagar el flag no impide persistir la respuesta ni
-- cerrar la aprobación. El CAE y los efectos pertenecen a una transacción.
UPDATE public.settings SET nota_credito_periodo_enabled=false WHERE id=true;
SELECT pg_temp.responder_aprobado(
  (SELECT venta_id FROM t_producto),'f2400000-0000-4000-8000-000000000042',3
);
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_producto),'APROBAR',
  'f2400000-0000-4000-8000-000000000042',
  '{"expected_version":4,"cae":"74123456789041","cae_vencimiento":"2026-09-30","emitido_at":"2026-08-29T15:00:00Z"}'::jsonb
);
SELECT pg_temp.assert_true((
  SELECT v.estado='ACTIVA' AND v.afip_estado='APROBADO' AND v.afip_fase='PERSISTIDO'
     AND v.cae='74123456789041' AND v.nc_efectos_aplicados_at IS NOT NULL
     AND v.total_pagado=v.total AND v.estado_pago='PAGADO'
     AND (SELECT cantidad FROM public.stock_sucursal
           WHERE producto_id='c2400000-0000-4000-8000-000000000001'
             AND sucursal_id=v.sucursal_id)=22
     AND (SELECT count(*) FROM public.stock_movimientos m
           WHERE m.tipo='DEVOLUCION' AND m.producto_id='c2400000-0000-4000-8000-000000000001'
             AND m.sucursal_id=v.sucursal_id AND m.referencia_id=v.id)=1
     AND (SELECT count(*)=1 AND min(p.monto)=-217.80
                 AND bool_and(p.caja_sesion_id IS NOT NULL)
                 AND bool_and(p.cobro_idempotency_key=r.id)
            FROM public.venta_pagos p
            JOIN public.nota_credito_periodo_reintegros r
              ON r.venta_id=p.venta_id AND r.forma_pago=p.forma_pago
           WHERE p.venta_id=v.id)
    FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_producto)
),'APROBAR aplica stock y reintegro una vez y activa la NC');

CREATE TEMP TABLE t_aprobada_vector AS
SELECT
  (SELECT cantidad FROM public.stock_sucursal WHERE producto_id='c2400000-0000-4000-8000-000000000001' AND sucursal_id=v.sucursal_id) stock,
  (SELECT count(*) FROM public.stock_movimientos WHERE referencia_id=v.id) stock_movs,
  (SELECT count(*) FROM public.venta_pagos WHERE venta_id=v.id) pagos,
  (SELECT count(*) FROM public.cuenta_corriente_movimientos WHERE venta_id=v.id) cc
FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_producto);
SELECT pg_temp.assert_raises(format(
  'SELECT * FROM public.transicionar_emision_fiscal(%L,''APROBAR'',%L,''{"expected_version":5,"cae":"74123456789041","cae_vencimiento":"2026-09-30","emitido_at":"2026-08-29T15:00:00Z"}'')',
  (SELECT venta_id FROM t_producto),'f2400000-0000-4000-8000-000000000042'
),'token','replay de APROBAR no vuelve a aplicar efectos');
SELECT pg_temp.assert_true((
  SELECT b.stock=(SELECT cantidad FROM public.stock_sucursal WHERE producto_id='c2400000-0000-4000-8000-000000000001' AND sucursal_id=v.sucursal_id)
     AND b.stock_movs=(SELECT count(*) FROM public.stock_movimientos WHERE referencia_id=v.id)
     AND b.pagos=(SELECT count(*) FROM public.venta_pagos WHERE venta_id=v.id)
     AND b.cc=(SELECT count(*) FROM public.cuenta_corriente_movimientos WHERE venta_id=v.id)
    FROM t_aprobada_vector b CROSS JOIN public.ventas v
   WHERE v.id=(SELECT venta_id FROM t_producto)
),'replay de aprobación conserva el vector comercial');
SELECT pg_temp.assert_raises(format(
  'SELECT * FROM public.transicionar_emision_fiscal(%L,''CANCELAR'',NULL,''{"expected_version":5}'')',
  (SELECT venta_id FROM t_producto)
),'prohibido','una NC por período aprobada no se cancela como pendiente');
SELECT pg_temp.assert_raises(format(
  'SELECT * FROM public.anular_venta(%L,%L)',
  (SELECT venta_id FROM t_producto),'e2400000-0000-4000-8000-000000000070'
),'no se anula','anular_venta no trata la NC por período aprobada como documento interno');

-- Bonificación/saldo: no toca stock y acredita al cliente comercial, aunque el
-- receptor del snapshot sea otra persona.
UPDATE public.settings SET nota_credito_periodo_enabled=true WHERE id=true;
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_ajuste),'RECLAMAR','f2400000-0000-4000-8000-000000000043',
  '{"expected_version":0,"lease_segundos":300}'::jsonb
);
SELECT pg_temp.reservar_nc_periodo(
  (SELECT venta_id FROM t_ajuste),'f2400000-0000-4000-8000-000000000043',942
);
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_ajuste),'REQUEST_INICIADO','f2400000-0000-4000-8000-000000000043',
  '{"expected_version":2}'::jsonb
);
SELECT pg_temp.responder_aprobado(
  (SELECT venta_id FROM t_ajuste),'f2400000-0000-4000-8000-000000000043',3
);
CREATE TEMP TABLE t_ajuste_stock_before AS
SELECT (SELECT sum(cantidad) FROM public.stock_sucursal) stock,
       (SELECT count(*) FROM public.stock_movimientos) movimientos;
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_ajuste),'APROBAR','f2400000-0000-4000-8000-000000000043',
  '{"expected_version":4,"cae":"74123456789042","cae_vencimiento":"2026-09-30","emitido_at":"2026-08-29T15:01:00Z"}'::jsonb
);
SELECT pg_temp.assert_true((
  SELECT b.stock=(SELECT sum(cantidad) FROM public.stock_sucursal)
     AND b.movimientos=(SELECT count(*) FROM public.stock_movimientos)
     AND v.estado='ACTIVA' AND v.total_pagado=0 AND v.estado_pago='PENDIENTE'
     AND (SELECT count(*)=1 AND bool_and(m.tipo='CREDITO')
                 AND bool_and(m.estado='CONFIRMADO') AND bool_and(m.cliente_id=v.cliente_id)
                 AND min(m.monto)=110.50
            FROM public.cuenta_corriente_movimientos m WHERE m.venta_id=v.id)
     AND v.afip_snapshot#>>'{receptor,razonSocial}'='RECEPTOR FISCAL DISTINTO'
    FROM public.ventas v CROSS JOIN t_ajuste_stock_before b
   WHERE v.id=(SELECT venta_id FROM t_ajuste)
),'BONIFICACION_AJUSTE acredita al cliente comercial sin tocar stock');

-- Rechazo confirmado: vuelve a error corregible, mantiene la cabecera pendiente
-- y no aplica ningún efecto comercial.
CREATE TEMP TABLE t_rechazo AS
SELECT * FROM public.crear_nota_credito_periodo_fiscal(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2400000-0000-4000-8000-000000000001','BONIFICACION_AJUSTE',
  '2026-07-01','2026-07-31','Bonificación rechazada','REINTEGRO',
  '[{"producto_id":null,"descripcion":"Ajuste rechazado","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]',
  '[{"forma_pago":"TRANSFERENCIA","monto_centavos":12100}]',
  'e2400000-0000-4000-8000-000000000071'
);
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_rechazo),'RECLAMAR','f2400000-0000-4000-8000-000000000044',
  '{"expected_version":0,"lease_segundos":300}'::jsonb
);
SELECT pg_temp.reservar_nc_periodo(
  (SELECT venta_id FROM t_rechazo),'f2400000-0000-4000-8000-000000000044',943
);
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_rechazo),'REQUEST_INICIADO','f2400000-0000-4000-8000-000000000044',
  '{"expected_version":2}'::jsonb
);
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_rechazo),'RESPUESTA_RECIBIDA','f2400000-0000-4000-8000-000000000044',
  '{"expected_version":3,"respuesta_resumen":{"tipo":"EMISION","resultado":"R","fuente":"FECAESolicitar","rechazo_confirmado":true,"observaciones":[]}}'::jsonb
);
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_rechazo),'ERROR_CORREGIBLE','f2400000-0000-4000-8000-000000000044',
  '{"expected_version":4,"error_clase":"RECHAZO","error_codigo":"100","error_fase":"RESPUESTA_RECIBIDA","mensaje_mascarado":"rechazo confirmado","liberar_identidad":true}'::jsonb
);
SELECT pg_temp.assert_true((
  SELECT v.estado='PENDIENTE_FISCAL' AND v.afip_estado='ERROR_CORREGIBLE'
     AND v.nc_efectos_aplicados_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.venta_pagos p WHERE p.venta_id=v.id)
     AND NOT EXISTS (SELECT 1 FROM public.stock_movimientos m WHERE m.referencia_id=v.id)
     AND NOT EXISTS (SELECT 1 FROM public.cuenta_corriente_movimientos m WHERE m.venta_id=v.id)
    FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_rechazo)
),'rechazo y error corregible no aplican efectos');

-- RECUPERAR_CAE comparte exactamente el helper de APROBAR. El flag apagado no
-- bloquea conciliación/recuperación una vez que REQUEST_INICIADO quedó durable.
CREATE TEMP TABLE t_recuperar AS
SELECT * FROM public.crear_nota_credito_periodo_fiscal(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
  '2026-07-01','2026-07-31','Devolución recuperada','SALDO_FAVOR',
  '[{"producto_id":"c2400000-0000-4000-8000-000000000003","cantidad":1,"precio_unitario_sin_iva":50,"iva_porcentaje":10.5}]','[]',
  'e2400000-0000-4000-8000-000000000072'
);
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_recuperar),'RECLAMAR','f2400000-0000-4000-8000-000000000045',
  '{"expected_version":0,"lease_segundos":300}'::jsonb
);
SELECT pg_temp.reservar_nc_periodo(
  (SELECT venta_id FROM t_recuperar),'f2400000-0000-4000-8000-000000000045',944
);
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_recuperar),'REQUEST_INICIADO','f2400000-0000-4000-8000-000000000045',
  '{"expected_version":2}'::jsonb
);
UPDATE public.settings SET nota_credito_periodo_enabled=false WHERE id=true;
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_recuperar),'RECONCILIAR','f2400000-0000-4000-8000-000000000045',
  '{"expected_version":3,"error_clase":"TRANSPORTE","error_codigo":"TIMEOUT","error_fase":"REQUEST_INICIADO","mensaje_mascarado":"respuesta incierta"}'::jsonb
);
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.transicionar_emision_fiscal(
    %L,'REENVIO_VERIFICADO',%L,
    jsonb_build_object(
      'expected_version',4,'nuevo_claim_token','f2400000-0000-4000-8000-000000000046',
      'ultimo_remoto',0,'payload_hash',(SELECT afip_snapshot_hash FROM public.ventas WHERE id=%L),
      'respuesta_resumen',jsonb_build_object(
        'tipo','CONSULTA_ARCA','resultado','AUSENTE','fuente','FECompConsultar',
        'ausencia_confirmada',true,'observaciones','[]'::jsonb)))
$sql$,(SELECT venta_id FROM t_recuperar),'f2400000-0000-4000-8000-000000000045',(SELECT venta_id FROM t_recuperar)),
  'deshabilitada','el flag apagado bloquea REENVIO_VERIFICADO'
);
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_recuperar),'RECUPERAR_CAE','f2400000-0000-4000-8000-000000000045',
  pg_catalog.jsonb_build_object(
    'expected_version',4,'cae','74123456789043','cae_vencimiento',NULL,
    'payload_hash',(SELECT afip_snapshot_hash FROM public.ventas WHERE id=(SELECT venta_id FROM t_recuperar)),
    'respuesta_resumen',pg_catalog.jsonb_build_object(
      'tipo','CONSULTA_ARCA','resultado','COINCIDE','fuente','FECompConsultar',
      'coincidencia_completa',true,'observaciones','[]'::jsonb
    )
  )
);
SELECT pg_temp.assert_true((
  SELECT v.estado='ACTIVA' AND v.afip_estado='APROBADO' AND v.cae='74123456789043'
     AND v.nc_efectos_aplicados_at IS NOT NULL
     AND (SELECT cantidad FROM public.stock_sucursal
           WHERE producto_id='c2400000-0000-4000-8000-000000000003'
             AND sucursal_id=v.sucursal_id)=31
     AND (SELECT count(*) FROM public.stock_movimientos m
           WHERE m.referencia_id=v.id AND m.producto_id='c2400000-0000-4000-8000-000000000003')=1
     AND (SELECT count(*) FROM public.cuenta_corriente_movimientos m WHERE m.venta_id=v.id)=1
    FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_recuperar)
),'RECUPERAR_CAE aplica una sola vez los mismos efectos post-CAE');
SELECT pg_temp.assert_raises(format($sql$
  SELECT * FROM public.transicionar_emision_fiscal(
    %L,'RECUPERAR_CAE',%L,
    jsonb_build_object(
      'expected_version',5,'cae','74123456789043','cae_vencimiento',NULL,
      'payload_hash',(SELECT afip_snapshot_hash FROM public.ventas WHERE id=%L),
      'respuesta_resumen',jsonb_build_object(
        'tipo','CONSULTA_ARCA','resultado','COINCIDE','fuente','FECompConsultar',
        'coincidencia_completa',true,'observaciones','[]'::jsonb)))
$sql$,(SELECT venta_id FROM t_recuperar),'f2400000-0000-4000-8000-000000000045',(SELECT venta_id FROM t_recuperar)),
  'token','replay de RECUPERAR_CAE no duplica efectos'
);

-- El efectivo usa una sesión abierta explícita y caja_esperado refleja la
-- salida una vez. No se inserta ningún caja_movimiento compensatorio manual.
UPDATE public.settings SET nota_credito_periodo_enabled=true WHERE id=true;
CREATE TEMP TABLE t_caja AS
SELECT public.caja_sesion_actual((SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)) AS id;
INSERT INTO public.caja_movimientos(caja_sesion_id,tipo,forma_pago,monto,descripcion,usuario_id)
SELECT id,'INICIAL','EFECTIVO',1000,'Fondo T8','a2400000-0000-4000-8000-000000000001' FROM t_caja;
CREATE TEMP TABLE t_efectivo AS
SELECT * FROM public.crear_nota_credito_periodo_fiscal(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
  '2026-07-01','2026-07-31','Devolución en efectivo','REINTEGRO',
  '[{"producto_id":"c2400000-0000-4000-8000-000000000003","cantidad":2,"precio_unitario_sin_iva":50,"iva_porcentaje":10.5}]',
  '[{"forma_pago":"EFECTIVO","monto_centavos":11050}]',
  'e2400000-0000-4000-8000-000000000073'
);
SELECT * FROM public.transicionar_emision_fiscal((SELECT venta_id FROM t_efectivo),'RECLAMAR','f2400000-0000-4000-8000-000000000047','{"expected_version":0,"lease_segundos":300}');
SELECT pg_temp.reservar_nc_periodo((SELECT venta_id FROM t_efectivo),'f2400000-0000-4000-8000-000000000047',945);
SELECT * FROM public.transicionar_emision_fiscal((SELECT venta_id FROM t_efectivo),'REQUEST_INICIADO','f2400000-0000-4000-8000-000000000047','{"expected_version":2}');
SELECT pg_temp.responder_aprobado((SELECT venta_id FROM t_efectivo),'f2400000-0000-4000-8000-000000000047',3);
CREATE TEMP TABLE t_caja_before AS
SELECT (public.caja_esperado(id)#>>'{EFECTIVO,neto}')::numeric neto,
       (SELECT count(*) FROM public.caja_movimientos) movimientos FROM t_caja;
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_efectivo),'APROBAR','f2400000-0000-4000-8000-000000000047',
  '{"expected_version":4,"cae":"74123456789044","cae_vencimiento":"2026-09-30","emitido_at":"2026-08-29T15:02:00Z"}'
);
SELECT pg_temp.assert_true((
  SELECT b.neto-(public.caja_esperado(c.id)#>>'{EFECTIVO,neto}')::numeric=110.50
     AND b.movimientos=(SELECT count(*) FROM public.caja_movimientos)
     AND (SELECT count(*)=1 AND min(p.monto)=-110.50
                 AND bool_and(p.caja_sesion_id=c.id)
                 AND bool_and(p.cobro_idempotency_key=r.id)
            FROM public.venta_pagos p
            JOIN public.nota_credito_periodo_reintegros r
              ON r.venta_id=p.venta_id AND r.forma_pago=p.forma_pago
           WHERE p.venta_id=v.id)
    FROM public.ventas v CROSS JOIN t_caja c CROSS JOIN t_caja_before b
   WHERE v.id=(SELECT venta_id FROM t_efectivo)
),'el reintegro efectivo usa sesión explícita y cambia caja_esperado una vez');

-- Si caja/stock/libro fallan, la excepción revierte CAE y cualquier efecto.
CREATE TEMP TABLE t_sin_efectivo AS
SELECT * FROM public.crear_nota_credito_periodo_fiscal(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
  '2026-07-01','2026-07-31','Devolución sin efectivo','REINTEGRO',
  '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":1000,"iva_porcentaje":21}]',
  '[{"forma_pago":"EFECTIVO","monto_centavos":121000}]',
  'e2400000-0000-4000-8000-000000000074'
);
SELECT * FROM public.transicionar_emision_fiscal((SELECT venta_id FROM t_sin_efectivo),'RECLAMAR','f2400000-0000-4000-8000-000000000048','{"expected_version":0,"lease_segundos":300}');
SELECT pg_temp.reservar_nc_periodo((SELECT venta_id FROM t_sin_efectivo),'f2400000-0000-4000-8000-000000000048',946);
SELECT * FROM public.transicionar_emision_fiscal((SELECT venta_id FROM t_sin_efectivo),'REQUEST_INICIADO','f2400000-0000-4000-8000-000000000048','{"expected_version":2}');
SELECT pg_temp.responder_aprobado((SELECT venta_id FROM t_sin_efectivo),'f2400000-0000-4000-8000-000000000048',3);
CREATE TEMP TABLE t_fallo_before AS
SELECT (SELECT cantidad FROM public.stock_sucursal WHERE producto_id='c2400000-0000-4000-8000-000000000001' AND sucursal_id=v.sucursal_id) stock,
       (SELECT count(*) FROM public.stock_movimientos WHERE referencia_id=v.id) stock_movs,
       (SELECT count(*) FROM public.venta_pagos WHERE venta_id=v.id) pagos
  FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_sin_efectivo);
SELECT pg_temp.assert_raises(format(
  'SELECT * FROM public.transicionar_emision_fiscal(%L,''APROBAR'',%L,''{"expected_version":4,"cae":"74123456789045","cae_vencimiento":"2026-09-30","emitido_at":"2026-08-29T15:03:00Z"}'')',
  (SELECT venta_id FROM t_sin_efectivo),'f2400000-0000-4000-8000-000000000048'
),'efectivo','efectivo insuficiente rechaza la aplicación atómica');
SELECT pg_temp.assert_true((
  SELECT v.afip_estado='EMITIENDO' AND v.afip_fase='RESPUESTA_RECIBIDA'
     AND v.cae IS NULL AND v.nc_efectos_aplicados_at IS NULL
     AND b.stock=(SELECT cantidad FROM public.stock_sucursal WHERE producto_id='c2400000-0000-4000-8000-000000000001' AND sucursal_id=v.sucursal_id)
     AND b.stock_movs=(SELECT count(*) FROM public.stock_movimientos WHERE referencia_id=v.id)
     AND b.pagos=(SELECT count(*) FROM public.venta_pagos WHERE venta_id=v.id)
    FROM public.ventas v CROSS JOIN t_fallo_before b
   WHERE v.id=(SELECT venta_id FROM t_sin_efectivo)
),'un fallo de efectos revierte CAE, stock y pagos juntos');
UPDATE public.settings SET nota_credito_periodo_enabled=false WHERE id=true;
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_sin_efectivo),'RECONCILIAR','f2400000-0000-4000-8000-000000000048',
  '{"expected_version":4,"error_clase":"CAJA","error_codigo":"SIN_EFECTIVO","error_fase":"RESPUESTA_RECIBIDA","mensaje_mascarado":"requiere resolución"}'
);
SELECT pg_temp.assert_true((
  SELECT afip_estado='RECONCILIAR' AND cae IS NULL AND nc_efectos_aplicados_at IS NULL
    FROM public.ventas WHERE id=(SELECT venta_id FROM t_sin_efectivo)
),'la fila que falló queda reconciliable y no medio aprobada');

-- Sólo una intención completamente intacta puede cancelarse comercialmente.
UPDATE public.settings SET nota_credito_periodo_enabled=true WHERE id=true;
CREATE TEMP TABLE t_cancelar AS
SELECT * FROM public.crear_nota_credito_periodo_fiscal(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2400000-0000-4000-8000-000000000001','DEVOLUCION_PRODUCTOS',
  '2026-07-01','2026-07-31','Cancelación segura','REINTEGRO',
  '[{"producto_id":"c2400000-0000-4000-8000-000000000001","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]',
  '[{"forma_pago":"TRANSFERENCIA","monto_centavos":12100}]',
  'e2400000-0000-4000-8000-000000000075'
);
UPDATE public.settings SET nota_credito_periodo_enabled=false WHERE id=true;
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_cancelar),'CANCELAR',NULL,'{"expected_version":0}'
);
SELECT pg_temp.assert_true((
  SELECT v.estado='ANULADA' AND v.afip_estado='CANCELADO'
     AND v.nc_efectos_aplicados_at IS NULL
     AND (SELECT count(*) FROM public.nota_credito_periodo_reintegros r WHERE r.venta_id=v.id)=1
    FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_cancelar)
),'CANCELAR anula sólo la intención intacta y conserva el plan de reintegro');

UPDATE public.settings SET nota_credito_periodo_enabled=true WHERE id=true;
CREATE TEMP TABLE t_cancelar_reservada AS
SELECT * FROM public.crear_nota_credito_periodo_fiscal(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2400000-0000-4000-8000-000000000001','BONIFICACION_AJUSTE',
  '2026-07-01','2026-07-31','Cancelación reservada','SALDO_FAVOR',
  '[{"producto_id":null,"descripcion":"No cancelar","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]','[]',
  'e2400000-0000-4000-8000-000000000076'
);
SELECT * FROM public.transicionar_emision_fiscal((SELECT venta_id FROM t_cancelar_reservada),'RECLAMAR','f2400000-0000-4000-8000-000000000049','{"expected_version":0,"lease_segundos":300}');
SELECT pg_temp.reservar_nc_periodo((SELECT venta_id FROM t_cancelar_reservada),'f2400000-0000-4000-8000-000000000049',947);
UPDATE public.settings SET nota_credito_periodo_enabled=false WHERE id=true;
SELECT pg_temp.assert_raises(format(
  'SELECT * FROM public.transicionar_emision_fiscal(%L,''CANCELAR'',NULL,''{"expected_version":2}'')',
  (SELECT venta_id FROM t_cancelar_reservada)
),'prohibido','CANCELAR rechaza una NC ya reservada');

SELECT pg_temp.assert_true((
  SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proowner='postgres'::regrole)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='aplicar_efectos_nc_periodo'
     AND pg_get_function_identity_arguments(p.oid)='p_venta_id uuid'
),'el helper post-CAE es único, owner y SECURITY DEFINER');
SELECT pg_temp.assert_true(
  NOT has_function_privilege('public','public.aplicar_efectos_nc_periodo(uuid)','execute')
  AND NOT has_function_privilege('anon','public.aplicar_efectos_nc_periodo(uuid)','execute')
  AND NOT has_function_privilege('authenticated','public.aplicar_efectos_nc_periodo(uuid)','execute')
  AND NOT has_function_privilege('service_role','public.aplicar_efectos_nc_periodo(uuid)','execute'),
  'ningún rol API puede invocar directamente los efectos'
);

-- La misma validación autoritativa admite la ruta C cuando el emisor de la
-- sucursal es monotributista; la identidad/número fiscal siguen diferidos.
SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000001');
UPDATE public.settings SET nota_credito_periodo_enabled=true WHERE id=true;
UPDATE public.emisores e SET condicion_iva='MONOTRIBUTO'
  FROM public.sucursales s
 WHERE s.emisor_id=e.id
   AND s.id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1);
CREATE TEMP TABLE t_ruta_c AS
SELECT * FROM public.crear_nota_credito_periodo_fiscal(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2400000-0000-4000-8000-000000000005','BONIFICACION_AJUSTE',
  '2026-05-01','2026-05-31','Bonificación monotributo','SALDO_FAVOR',
  '[{"producto_id":null,"descripcion":"Ajuste C","cantidad":1,"precio_unitario_sin_iva":50,"iva_porcentaje":21}]','[]',
  'e2400000-0000-4000-8000-000000000023'
);
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM t_ruta_c),'la semántica fiscal C también se acepta');

-- Ni service_role puede fabricar por DML una reserva fiscal incompleta. El
-- owner, que es el writer de las RPC, queda además sujeto al CHECK durable.
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.ventas(
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
      condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
      estado_pago,estado,afip_estado
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2400000-0000-4000-8000-000000000001',
      'a2400000-0000-4000-8000-000000000001',
      'NC-PER-INCOMPLETA-SERVICE','NOTA_CREDITO','CONTADO',
      -100,-21,0,-121,0,'PENDIENTE','PENDIENTE_FISCAL','SIN_FACTURAR'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '✓ service_role no puede insertar una reserva fiscal incompleta';
    RETURN;
  END;
  RAISE EXCEPTION 'FALLO: service_role insertó una reserva fiscal incompleta';
END;
$$;

-- La guarda nueva debe ser específica: una venta común legítima sigue siendo
-- escribible por service_role.
INSERT INTO public.ventas(
  sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
  estado_pago,estado,afip_estado
) VALUES (
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2400000-0000-4000-8000-000000000001',
  'a2400000-0000-4000-8000-000000000001',
  'VENTA-SERVICE-LEGITIMA','VENTA','CONTADO',100,21,0,121,121,
  'PAGADO','ACTIVA','SIN_FACTURAR'
);
RESET ROLE;
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM public.ventas
     WHERE numero_comprobante='VENTA-SERVICE-LEGITIMA'
       AND estado='ACTIVA' AND nc_periodo_modalidad IS NULL
  ),
  'la guarda conserva otros estados y flujos legítimos'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.ventas(
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
      condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
      estado_pago,estado,afip_estado
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2400000-0000-4000-8000-000000000001',
      'a2400000-0000-4000-8000-000000000001',
      'NC-PER-INCOMPLETA-OWNER','NOTA_CREDITO','CONTADO',
      -100,-21,0,-121,0,'PENDIENTE','PENDIENTE_FISCAL','SIN_FACTURAR'
    );
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✓ el CHECK durable rechaza una reserva fiscal incompleta aun para el owner';
    RETURN;
  END;
  RAISE EXCEPTION 'FALLO: el owner insertó una reserva fiscal incompleta';
END;
$$;

SELECT pg_temp.assert_true(
  NOT has_function_privilege('anon','public.crear_nota_credito_periodo_fiscal(uuid,uuid,public.modalidad_nc_periodo,date,date,text,public.resolucion_nc_periodo,jsonb,jsonb,uuid)','execute')
  AND has_function_privilege('authenticated','public.crear_nota_credito_periodo_fiscal(uuid,uuid,public.modalidad_nc_periodo,date,date,text,public.resolucion_nc_periodo,jsonb,jsonb,uuid)','execute')
  AND has_function_privilege('service_role','public.crear_nota_credito_periodo_fiscal(uuid,uuid,public.modalidad_nc_periodo,date,date,text,public.resolucion_nc_periodo,jsonb,jsonb,uuid)','execute')
  AND NOT has_function_privilege('authenticated','public._crear_nota_credito_periodo_fiscal_core_20260828(uuid,uuid,public.modalidad_nc_periodo,date,date,text,public.resolucion_nc_periodo,jsonb,jsonb,uuid)','execute')
  AND NOT has_function_privilege('service_role','public._crear_nota_credito_periodo_fiscal_core_20260828(uuid,uuid,public.modalidad_nc_periodo,date,date,text,public.resolucion_nc_periodo,jsonb,jsonb,uuid)','execute'),
  'la RPC sólo expone el wrapper y mantiene el core reservado al owner'
);
SELECT pg_temp.assert_true((
  SELECT p.prosecdef AND p.proowner='postgres'::regrole
     AND pg_catalog.array_to_string(p.proconfig,',')='search_path=""'
    FROM pg_proc p
   WHERE p.oid='public.crear_nota_credito_periodo_fiscal(uuid,uuid,public.modalidad_nc_periodo,date,date,text,public.resolucion_nc_periodo,jsonb,jsonb,uuid)'::regprocedure
),'la RPC es definer del owner con search_path vacío');

ROLLBACK;
SQL

# La carrera necesita dos transacciones reales. El fixture se elimina incluso si
# una aserción falla, para que el contrato sea repetible sin otro reset.
out1=""
out2=""
effects_out1=""
effects_out2=""
cleanup() {
  "${PSQL[@]}" >/dev/null <<'SQL' || true
DELETE FROM public.stock_movimientos
 WHERE producto_id='c2400000-0000-4000-8000-000000000099'
    OR referencia_id IN (
      SELECT id FROM public.ventas
       WHERE idempotency_key='e2400000-0000-4000-8000-000000000099'
    );
DELETE FROM public.ventas WHERE idempotency_key='e2400000-0000-4000-8000-000000000099';
DELETE FROM public.stock_sucursal WHERE producto_id='c2400000-0000-4000-8000-000000000099';
DELETE FROM public.productos WHERE id='c2400000-0000-4000-8000-000000000099';
DELETE FROM public.clientes WHERE id='b2400000-0000-4000-8000-000000000099';
DELETE FROM auth.users WHERE id='a2400000-0000-4000-8000-000000000099';
UPDATE public.settings
   SET facturacion_receptor_v2_enabled=false,
       facturacion_legacy_writer_enabled=false,
       nota_credito_periodo_enabled=false
 WHERE id=true;
SQL
  if [[ -n "$out1" ]]; then
    rm -f -- "$out1"
  fi
  if [[ -n "$out2" ]]; then
    rm -f -- "$out2"
  fi
  if [[ -n "$effects_out1" ]]; then
    rm -f -- "$effects_out1"
  fi
  if [[ -n "$effects_out2" ]]; then
    rm -f -- "$effects_out2"
  fi
}
trap cleanup EXIT

"${PSQL[@]}" >/dev/null <<'SQL'
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
VALUES ('a2400000-0000-4000-8000-000000000099','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nc-periodo-race@test.local','x',now(),now(),now());
INSERT INTO public.user_roles(user_id,role) VALUES ('a2400000-0000-4000-8000-000000000099','admin');
SELECT set_config('request.jwt.claims','{"sub":"a2400000-0000-4000-8000-000000000099","role":"authenticated"}',false);
UPDATE public.profiles SET sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),activo=true WHERE id='a2400000-0000-4000-8000-000000000099';
INSERT INTO public.profile_sucursales(profile_id,sucursal_id)
SELECT 'a2400000-0000-4000-8000-000000000099',id FROM public.sucursales ORDER BY numero LIMIT 1;
INSERT INTO public.clientes(id,razon_social,tipo,activo,es_generico)
VALUES ('b2400000-0000-4000-8000-000000000099','CLIENTE CARRERA NC','CONSUMIDOR_FINAL',true,false);
UPDATE public.clientes SET condicion_cta_cte=true,limite_credito=99999999
 WHERE id='b2400000-0000-4000-8000-000000000099';
INSERT INTO public.productos(id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado)
VALUES ('c2400000-0000-4000-8000-000000000099','NC-PER-RACE','PRODUCTO CARRERA NC',100,21,true,false);
UPDATE public.settings SET facturacion_receptor_v2_enabled=true,facturacion_legacy_writer_enabled=false,nota_credito_periodo_enabled=true WHERE id=true;
UPDATE public.emisores AS e
   SET condicion_iva='RESPONSABLE_INSCRIPTO',
       inicio_actividades=COALESCE(e.inicio_actividades,'2020-01-01'::date)
  FROM public.sucursales AS s
 WHERE s.emisor_id=e.id
   AND s.id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1);
SQL

race_sql="SELECT set_config('request.jwt.claims','{\"sub\":\"a2400000-0000-4000-8000-000000000099\",\"role\":\"authenticated\"}',false); SELECT venta_id FROM public.crear_nota_credito_periodo_fiscal((SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),'b2400000-0000-4000-8000-000000000099','DEVOLUCION_PRODUCTOS','2026-07-01','2026-07-31','Carrera idempotente','SALDO_FAVOR','[{\"producto_id\":\"c2400000-0000-4000-8000-000000000099\",\"cantidad\":1,\"precio_unitario_sin_iva\":100,\"iva_porcentaje\":21}]','[]','e2400000-0000-4000-8000-000000000099');"
out1="$(mktemp)"
out2="$(mktemp)"
"${PSQL[@]}" -tAqc "$race_sql" >"$out1" &
pid1=$!
"${PSQL[@]}" -tAqc "$race_sql" >"$out2" &
pid2=$!
wait "$pid1"
wait "$pid2"
id1="$(tail -n1 "$out1")"
id2="$(tail -n1 "$out2")"
if [[ -z "$id1" || "$id1" != "$id2" ]]; then
  echo "✗ las llamadas concurrentes no devolvieron la misma venta" >&2
  exit 1
fi
count="$("${PSQL[@]}" -tAqc "SELECT count(*) FROM public.ventas WHERE idempotency_key='e2400000-0000-4000-8000-000000000099'")"
if [[ "$count" != "1" ]]; then
  echo "✗ las llamadas concurrentes crearon $count filas" >&2
  exit 1
fi
echo "✓ llamadas concurrentes idénticas crean una sola venta"

# Dos recuperaciones reales compiten por la misma fila. El fixture anterior ya
# dejó una única intención durable; ahora se completa hasta RECONCILIAR y cada
# conexión intenta persistir el CAE y aplicar stock/cuenta corriente.
race_lectura="$(${PSQL[@]} -qAtc "SELECT public.leer_venta_fiscal_exacta('$id1')")"
race_contexto="$(${PSQL[@]} -qAtc "
  SELECT jsonb_build_object(
    'emisor',jsonb_build_object(
      'id',e.id,'razonSocial',e.razon_social,'nombreFantasia',e.nombre_fantasia,
      'cuit',e.cuit,'domicilioFiscal',coalesce(e.domicilio_fiscal,''),
      'condicionIva',e.condicion_iva,'ingresosBrutos',e.ingresos_brutos::text,
      'inicioActividades',e.inicio_actividades::text,'telefono',NULL),
    'sucursal',jsonb_build_object(
      'id',s.id,'nombre',s.nombre,'direccion',s.direccion,'telefono',s.telefono))
  FROM public.sucursales s JOIN public.emisores e ON e.id=s.emisor_id
  WHERE s.id=(SELECT sucursal_id FROM public.ventas WHERE id='$id1')")"
race_fecha="$(${PSQL[@]} -qAtc 'SELECT current_date::text')"
race_snapshot="$(
  T8_LECTURA_JSON="$race_lectura" \
  T8_CONTEXTO_JSON="$race_contexto" \
  T8_FECHA="$race_fecha" \
  ./node_modules/.bin/tsx --eval '
    import { crearSnapshotFiscalV3 } from "./src/lib/fiscal/snapshot.ts";
    const lectura = JSON.parse(process.env.T8_LECTURA_JSON!);
    const contexto = JSON.parse(process.env.T8_CONTEXTO_JSON!);
    const fecha = process.env.T8_FECHA!;
    const porIva = new Map<number, { base: number; iva: number }>();
    for (const item of lectura.items) {
      const tasa = Number(item.ivaPorcentaje);
      const previo = porIva.get(tasa) ?? { base: 0, iva: 0 };
      previo.base += Number(item.subtotalNeto);
      previo.iva += Number(item.importeIva);
      porIva.set(tasa, previo);
    }
    const ids = new Map([[0, 3], [10.5, 4], [21, 5], [27, 6], [5, 8], [2.5, 9]]);
    const alicuotasIva = [...porIva.entries()].map(([tasa, monto]) => ({
      id: ids.get(tasa)!,
      baseImponible: monto.base.toFixed(2),
      importe: monto.iva.toFixed(2),
    })).sort((a, b) => a.id - b.id);
    const venta = lectura.venta;
    process.stdout.write(JSON.stringify(crearSnapshotFiscalV3({
      venta: {
        id: venta.id, numeroComercial: venta.numeroComercial,
        tipoComprobante: "NOTA_CREDITO", fechaComercial: venta.fechaComercial,
      },
      items: lectura.items,
      emisor: contexto.emisor,
      sucursal: contexto.sucursal,
      receptor: {
        razonSocial: "RECEPTOR CARRERA", domicilio: "Domicilio fiscal 123",
        tipoDocumento: "DNI", numeroDocumento: "30111222", docTipoArca: 96,
        docNroArca: "30111222", condicionIva: "CONSUMIDOR_FINAL",
        origen: "MANUAL", origenId: null, verificadoArcaAt: null,
        condicionIvaReceptorId: 5,
      },
      identidad: {
        numero: 1, emisorCuit: contexto.emisor.cuit, puntoVenta: 948,
        cbteTipo: 8, modo: "PRODUCCION", simulado: false, validez: "PRODUCCION",
      },
      letra: "B", concepto: 1, fechaComprobante: fecha,
      importeNeto: venta.subtotalSinIva, importeExento: "0.00",
      importeNoGravado: "0.00", importeIva: venta.ivaTotal,
      importeTributos: "0.00", importeTotal: venta.total,
      alicuotasIva, tributos: [], moneda: "PES", cotizacion: "1.000000",
      ivaContenido: venta.ivaTotal, otrosImpuestosNacionalesIndirectos: "0.00",
      periodoAsoc: { desde: venta.periodoAsocDesde, hasta: venta.periodoAsocHasta },
      notaCredito: { modalidad: venta.ncPeriodoModalidad, motivo: venta.motivoNotaCredito },
    } as never)));
  '
)"
race_hash="$(jq -r '.hash' <<<"$race_snapshot")"
race_emisor="$(jq -r '.identidad.emisorCuit' <<<"$race_snapshot")"

"${PSQL[@]}" -qAt \
  -v venta="$id1" -v snapshot="$race_snapshot" -v hash="$race_hash" \
  -v emisor="$race_emisor" -v fecha="$race_fecha" >/dev/null <<'SQL'
SET ROLE service_role;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a2400000-0000-4000-8000-000000000099","role":"authenticated"}',false
);
SELECT * FROM public.transicionar_emision_fiscal(
  :'venta','RECLAMAR','f2400000-0000-4000-8000-000000000099',
  '{"expected_version":0,"lease_segundos":300}'::jsonb);
SELECT * FROM public.transicionar_emision_fiscal(
  :'venta','RESERVAR','f2400000-0000-4000-8000-000000000099',
  jsonb_build_object(
    'expected_version',1,'snapshot',:'snapshot'::jsonb,'snapshot_hash',:'hash',
    'numero_propuesto',1,'fecha_comprobante',:'fecha','emisor_cuit',:'emisor',
    'punto_venta',948,'cbte_tipo',8,'modo','PRODUCCION','simulado',false,
    'validez','PRODUCCION','ultimo_remoto',0,'ultimo_local_observado',0));
SELECT * FROM public.transicionar_emision_fiscal(
  :'venta','REQUEST_INICIADO','f2400000-0000-4000-8000-000000000099',
  '{"expected_version":2}'::jsonb);
SELECT * FROM public.transicionar_emision_fiscal(
  :'venta','RECONCILIAR','f2400000-0000-4000-8000-000000000099',
  '{"expected_version":3,"error_clase":"TRANSPORTE","error_codigo":"TIMEOUT","error_fase":"REQUEST_INICIADO","mensaje_mascarado":"respuesta incierta"}'::jsonb);
SQL

effects_out1="$(mktemp)"
effects_out2="$(mktemp)"
set +e
"${PSQL[@]}" -qAt -v venta="$id1" -v hash="$race_hash" >"$effects_out1" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT set_config('request.jwt.claims','{"sub":"a2400000-0000-4000-8000-000000000099","role":"authenticated"}',false);
SELECT * FROM public.transicionar_emision_fiscal(
  :'venta','RECUPERAR_CAE','f2400000-0000-4000-8000-000000000099',
  jsonb_build_object(
    'expected_version',4,'cae','74123456789099','cae_vencimiento',NULL,
    'payload_hash',:'hash','respuesta_resumen',jsonb_build_object(
      'tipo','CONSULTA_ARCA','resultado','COINCIDE','fuente','FECompConsultar',
      'coincidencia_completa',true,'observaciones','[]'::jsonb)));
SQL
effects_pid1=$!
"${PSQL[@]}" -qAt -v venta="$id1" -v hash="$race_hash" >"$effects_out2" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT set_config('request.jwt.claims','{"sub":"a2400000-0000-4000-8000-000000000099","role":"authenticated"}',false);
SELECT * FROM public.transicionar_emision_fiscal(
  :'venta','RECUPERAR_CAE','f2400000-0000-4000-8000-000000000099',
  jsonb_build_object(
    'expected_version',4,'cae','74123456789099','cae_vencimiento',NULL,
    'payload_hash',:'hash','respuesta_resumen',jsonb_build_object(
      'tipo','CONSULTA_ARCA','resultado','COINCIDE','fuente','FECompConsultar',
      'coincidencia_completa',true,'observaciones','[]'::jsonb)));
SQL
effects_pid2=$!
wait "$effects_pid1"
effects_status1=$?
wait "$effects_pid2"
effects_status2=$?
set -e
if ! { [[ "$effects_status1" -eq 0 && "$effects_status2" -ne 0 ]] || [[ "$effects_status1" -ne 0 && "$effects_status2" -eq 0 ]]; }; then
  sed -n '1,30p' "$effects_out1" >&2
  sed -n '1,30p' "$effects_out2" >&2
  echo "✗ la carrera RECUPERAR_CAE no produjo exactamente un ganador" >&2
  exit 1
fi

effects_state="$(${PSQL[@]} -qAtc "
  SELECT v.afip_estado||'|'||v.afip_fase||'|'||(v.nc_efectos_aplicados_at IS NOT NULL)::text||'|'||
         (SELECT count(*) FROM public.stock_movimientos m WHERE m.referencia_id=v.id)||'|'||
         (SELECT count(*) FROM public.cuenta_corriente_movimientos c WHERE c.venta_id=v.id)||'|'||
         (SELECT count(*) FROM public.venta_pagos p WHERE p.venta_id=v.id)||'|'||
         (SELECT count(*) FROM public.emision_fiscal_intentos i
           WHERE i.venta_id=v.id AND i.resultado='RECUPERADO_CAE')
    FROM public.ventas v WHERE v.id='$id1'")"
if [[ "$effects_state" != "APROBADO|PERSISTIDO|true|1|1|0|1" ]]; then
  echo "✗ la carrera post-CAE duplicó o perdió efectos: $effects_state" >&2
  exit 1
fi
echo "✓ dos RECUPERAR_CAE concurrentes persisten un CAE y un solo vector de efectos"

# La reversión total fiscal vinculada vive en
# test-anulacion-fiscal-vinculada.sh para no depender del orden de la suite
# legacy. La NC interna conserva además su contrato en su script específico.
