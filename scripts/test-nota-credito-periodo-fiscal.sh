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
 ('c2400000-0000-4000-8000-000000000002','NC-PER-02','PRODUCTO NC INACTIVO',50,10.5,false,false);
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
SELECT 'c2400000-0000-4000-8000-000000000001',id,20
  FROM public.sucursales ORDER BY numero LIMIT 1;

UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false,
       nota_credito_periodo_enabled=false
 WHERE id=true;

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
SELECT pg_temp.assert_true(
  (SELECT p.venta_id=r.venta_id AND p.numero=r.numero FROM t_producto p CROSS JOIN t_replay r)
  AND (SELECT count(*)=1 FROM public.ventas WHERE idempotency_key='e2400000-0000-4000-8000-000000000020'),
  'el payload canónico idéntico devuelve la misma venta'
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

-- La misma validación autoritativa admite la ruta C cuando el emisor de la
-- sucursal es monotributista; la identidad/número fiscal siguen diferidos.
SELECT pg_temp.actor('a2400000-0000-4000-8000-000000000001');
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

SELECT pg_temp.assert_true(
  NOT has_function_privilege('anon','public.crear_nota_credito_periodo_fiscal(uuid,uuid,public.modalidad_nc_periodo,date,date,text,public.resolucion_nc_periodo,jsonb,jsonb,uuid)','execute')
  AND has_function_privilege('authenticated','public.crear_nota_credito_periodo_fiscal(uuid,uuid,public.modalidad_nc_periodo,date,date,text,public.resolucion_nc_periodo,jsonb,jsonb,uuid)','execute')
  AND has_function_privilege('service_role','public.crear_nota_credito_periodo_fiscal(uuid,uuid,public.modalidad_nc_periodo,date,date,text,public.resolucion_nc_periodo,jsonb,jsonb,uuid)','execute'),
  'la RPC sólo se expone a authenticated y service_role'
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
cleanup() {
  "${PSQL[@]}" >/dev/null <<'SQL' || true
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
INSERT INTO public.productos(id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado)
VALUES ('c2400000-0000-4000-8000-000000000099','NC-PER-RACE','PRODUCTO CARRERA NC',100,21,true,false);
UPDATE public.settings SET facturacion_receptor_v2_enabled=true,facturacion_legacy_writer_enabled=false,nota_credito_periodo_enabled=true WHERE id=true;
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

# La reversión puntual y la NC interna conservan sus contratos completos en la
# suite fiscal existente; se ejecuta como regresión obligatoria tras este script.
