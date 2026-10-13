#!/usr/bin/env bash
# Corrección de precios de remitos comerciales ya grabados.
# El fixture entero vive en una transacción que termina en ROLLBACK.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL client_min_messages TO WARNING;

DO $rpc_existe$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.corregir_precios_remito(uuid,jsonb,text,integer)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Falta la RPC corregir_precios_remito';
  END IF;
END;
$rpc_existe$;

INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES
  ('a5000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','empleado-remito@test.local','x',now(),now(),now()),
  ('a5000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','empleado-ajeno-remito@test.local','x',now(),now(),now()),
  ('a5000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','admin-remito@test.local','x',now(),now(),now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles(id,username,nombre_completo,activo,sucursal_id)
VALUES
  ('a5000000-0000-0000-0000-000000000001','empleado_remito_test','Empleado remito',true,(SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1)),
  ('a5000000-0000-0000-0000-000000000002','empleado_ajeno_remito_test','Empleado ajeno',true,(SELECT id FROM public.sucursales ORDER BY created_at,id OFFSET 1 LIMIT 1)),
  ('a5000000-0000-0000-0000-000000000003','admin_remito_test','Admin remito',true,(SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1))
ON CONFLICT (id) DO UPDATE
SET username=EXCLUDED.username,
    nombre_completo=EXCLUDED.nombre_completo,
    sucursal_id=EXCLUDED.sucursal_id,
    activo=true;

INSERT INTO public.user_roles(user_id,role)
VALUES ('a5000000-0000-0000-0000-000000000003','admin')
ON CONFLICT DO NOTHING;

INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
  estado_pago,estado,afip_estado
) VALUES
  (
    'e5000000-0000-0000-0000-000000000001',
    (SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1),
    (SELECT id FROM public.clientes ORDER BY created_at,id LIMIT 1),
    'a5000000-0000-0000-0000-000000000001','CORR-PRECIO-REM-1','REMITO',
    'CTA_CTE',250,47.25,0,297.25,0,'PENDIENTE','ACTIVA','NO_APLICA'
  ),
  (
    'e5000000-0000-0000-0000-000000000002',
    (SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1),
    (SELECT id FROM public.clientes ORDER BY created_at,id LIMIT 1),
    'a5000000-0000-0000-0000-000000000001','CORR-PRECIO-VENTA-1','VENTA',
    'CONTADO',100,21,0,121,121,'PAGADO','ACTIVA','NO_APLICA'
  ),
  (
    'e5000000-0000-0000-0000-000000000003',
    (SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1),
    (SELECT id FROM public.clientes ORDER BY created_at,id LIMIT 1),
    'a5000000-0000-0000-0000-000000000001','CORR-PRECIO-REM-ANULADO','REMITO',
    'CTA_CTE',100,21,0,121,0,'PENDIENTE','ANULADA','NO_APLICA'
  ),
  (
    'e5000000-0000-0000-0000-000000000004',
    (SELECT id FROM public.sucursales ORDER BY created_at,id OFFSET 1 LIMIT 1),
    (SELECT id FROM public.clientes ORDER BY created_at,id LIMIT 1),
    'a5000000-0000-0000-0000-000000000002','CORR-PRECIO-ROBR-AJENO','REMITO_OBRA',
    'CTA_CTE',100,21,0,121,0,'PENDIENTE','ACTIVA','NO_APLICA'
  );

INSERT INTO public.venta_items(
  id,venta_id,producto_id,codigo,descripcion,cantidad,
  precio_unitario_sin_iva,precio_lista_sin_iva,iva_porcentaje,
  descuento_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
) VALUES
  (
    'f5000000-0000-0000-0000-000000000001',
    'e5000000-0000-0000-0000-000000000001',
    (SELECT id FROM public.productos ORDER BY created_at,id LIMIT 1),
    'CORR-1','Producto corregible 21%',2,100,100,21,0,200,42,242
  ),
  (
    'f5000000-0000-0000-0000-000000000002',
    'e5000000-0000-0000-0000-000000000001',
    (SELECT id FROM public.productos ORDER BY created_at,id LIMIT 1),
    'CORR-2','Producto corregible 10,5%',1,50,50,10.5,0,50,5.25,55.25
  ),
  (
    'f5000000-0000-0000-0000-000000000003',
    'e5000000-0000-0000-0000-000000000002',
    (SELECT id FROM public.productos ORDER BY created_at,id LIMIT 1),
    'VENTA-1','Venta no corregible',1,100,100,21,0,100,21,121
  ),
  (
    'f5000000-0000-0000-0000-000000000004',
    'e5000000-0000-0000-0000-000000000003',
    (SELECT id FROM public.productos ORDER BY created_at,id LIMIT 1),
    'ANULADO-1','Remito anulado',1,100,100,21,0,100,21,121
  ),
  (
    'f5000000-0000-0000-0000-000000000005',
    'e5000000-0000-0000-0000-000000000004',
    (SELECT id FROM public.productos ORDER BY created_at,id LIMIT 1),
    'ROBR-1','Remito de obra ajeno',1,100,100,21,0,100,21,121
  );

INSERT INTO public.cuenta_corriente_movimientos(
  cliente_id,sucursal_id,tipo,monto,estado,venta_id,descripcion,usuario_id
)
SELECT v.cliente_id,v.sucursal_id,'DEBITO',v.total,'CONFIRMADO',v.id,
       v.tipo_comprobante::text||' '||v.numero_comprobante,v.usuario_id
FROM public.ventas AS v
WHERE v.id IN (
  'e5000000-0000-0000-0000-000000000001',
  'e5000000-0000-0000-0000-000000000003',
  'e5000000-0000-0000-0000-000000000004'
);

DO $acl$
BEGIN
  IF pg_catalog.has_function_privilege(
       'anon','public.corregir_precios_remito(uuid,jsonb,text,integer)','EXECUTE'
     ) THEN
    RAISE EXCEPTION 'anon puede ejecutar la corrección de precios';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'authenticated','public.corregir_precios_remito(uuid,jsonb,text,integer)','EXECUTE'
     ) THEN
    RAISE EXCEPTION 'authenticated no puede ejecutar la corrección de precios';
  END IF;
END;
$acl$;

CREATE TEMP TABLE remito_precio_test_antes AS
SELECT
  (
    SELECT cantidad
    FROM public.stock_sucursal
    WHERE producto_id=(SELECT id FROM public.productos ORDER BY created_at,id LIMIT 1)
      AND sucursal_id=(SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1)
  ) AS stock,
  (SELECT count(*) FROM public.stock_movimientos) AS movimientos;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"a5000000-0000-0000-0000-000000000001","role":"authenticated"}';

DO $corrige_remito$
DECLARE
  v_resultado record;
BEGIN
  SELECT * INTO v_resultado
  FROM public.corregir_precios_remito(
    'e5000000-0000-0000-0000-000000000001',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'item_id','f5000000-0000-0000-0000-000000000001',
        'precio_unitario_sin_iva',200,
        'descuento_porcentaje',10
      ),
      pg_catalog.jsonb_build_object(
        'item_id','f5000000-0000-0000-0000-000000000002',
        'precio_unitario_sin_iva',60,
        'descuento_porcentaje',5
      )
    ),
    'Se acordaron precios finales nuevos con el cliente',
    0
  );

  IF v_resultado.total<>498.59 OR v_resultado.correccion_precios_version<>1 THEN
    RAISE EXCEPTION 'La RPC devolvió totales/version incorrectos: %',row_to_json(v_resultado);
  END IF;
END;
$corrige_remito$;

RESET ROLE;

DO $assert_corrige_remito$
DECLARE
  v_stock_despues numeric;
  v_movimientos_despues bigint;
  v_venta public.ventas%ROWTYPE;
  v_item_1 public.venta_items%ROWTYPE;
  v_item_2 public.venta_items%ROWTYPE;
  v_movimiento public.cuenta_corriente_movimientos%ROWTYPE;
  v_auditoria public.remito_precio_correcciones%ROWTYPE;
  v_antes remito_precio_test_antes%ROWTYPE;
BEGIN
  SELECT * INTO v_venta
  FROM public.ventas WHERE id='e5000000-0000-0000-0000-000000000001';
  SELECT * INTO v_item_1
  FROM public.venta_items WHERE id='f5000000-0000-0000-0000-000000000001';
  SELECT * INTO v_item_2
  FROM public.venta_items WHERE id='f5000000-0000-0000-0000-000000000002';
  SELECT * INTO v_movimiento
  FROM public.cuenta_corriente_movimientos
  WHERE venta_id='e5000000-0000-0000-0000-000000000001';
  SELECT * INTO v_auditoria
  FROM public.remito_precio_correcciones
  WHERE venta_id='e5000000-0000-0000-0000-000000000001';
  SELECT cantidad INTO v_stock_despues
  FROM public.stock_sucursal
  WHERE producto_id=(SELECT id FROM public.productos ORDER BY created_at,id LIMIT 1)
    AND sucursal_id=(SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1);
  SELECT count(*) INTO v_movimientos_despues FROM public.stock_movimientos;
  SELECT * INTO v_antes FROM remito_precio_test_antes;

  IF v_venta.subtotal_sin_iva<>417 OR v_venta.iva_total<>81.59
     OR v_venta.total<>498.59 OR v_venta.correccion_precios_version<>1 THEN
    RAISE EXCEPTION 'La cabecera quedó desalineada: %',row_to_json(v_venta);
  END IF;
  IF v_item_1.precio_unitario_sin_iva<>200
     OR v_item_1.descuento_porcentaje<>10
     OR v_item_1.subtotal_sin_iva<>360
     OR v_item_1.iva_monto<>75.60
     OR v_item_1.subtotal_con_iva<>435.60 THEN
    RAISE EXCEPTION 'El primer ítem quedó mal: %',row_to_json(v_item_1);
  END IF;
  IF v_item_2.precio_unitario_sin_iva<>60
     OR v_item_2.descuento_porcentaje<>5
     OR v_item_2.subtotal_sin_iva<>57
     OR v_item_2.iva_monto<>5.99
     OR v_item_2.subtotal_con_iva<>62.99 THEN
    RAISE EXCEPTION 'El segundo ítem quedó mal: %',row_to_json(v_item_2);
  END IF;
  IF v_movimiento.monto<>498.59 OR v_movimiento.tipo<>'DEBITO'
     OR v_movimiento.estado<>'CONFIRMADO' THEN
    RAISE EXCEPTION 'La deuda de cuenta corriente quedó mal: %',row_to_json(v_movimiento);
  END IF;
  IF v_antes.stock IS DISTINCT FROM v_stock_despues
     OR v_antes.movimientos<>v_movimientos_despues THEN
    RAISE EXCEPTION 'La corrección de precios alteró el stock';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.venta_pagos
    WHERE venta_id='e5000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'La corrección creó o alteró pagos';
  END IF;
  IF v_auditoria.motivo<>'Se acordaron precios finales nuevos con el cliente'
     OR v_auditoria.version_anterior<>0 OR v_auditoria.version_nueva<>1
     OR pg_catalog.jsonb_array_length(v_auditoria.items_anteriores)<>2
     OR pg_catalog.jsonb_array_length(v_auditoria.items_nuevos)<>2
     OR v_auditoria.total_anterior<>297.25 OR v_auditoria.total_nuevo<>498.59 THEN
    RAISE EXCEPTION 'La auditoría es incompleta: %',row_to_json(v_auditoria);
  END IF;
END;
$assert_corrige_remito$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"a5000000-0000-0000-0000-000000000001","role":"authenticated"}';

DO $rechazos$
DECLARE
  v_error text;
  v_payload jsonb:=pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'item_id','f5000000-0000-0000-0000-000000000001',
      'precio_unitario_sin_iva',200,
      'descuento_porcentaje',10
    ),
    pg_catalog.jsonb_build_object(
      'item_id','f5000000-0000-0000-0000-000000000002',
      'precio_unitario_sin_iva',60,
      'descuento_porcentaje',5
    )
  );
BEGIN
  BEGIN
    PERFORM * FROM public.corregir_precios_remito(
      'e5000000-0000-0000-0000-000000000001',v_payload,
      'Reintento con una versión anterior',0
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('otra persona' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'Una versión obsoleta no fue rechazada correctamente: %',v_error;
  END IF;

  v_error:=NULL;
  BEGIN
    PERFORM * FROM public.corregir_precios_remito(
      'e5000000-0000-0000-0000-000000000001',
      pg_catalog.jsonb_build_array(v_payload->0),
      'Intento de guardar sólo una parte',1
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('todos los productos' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'Un payload parcial no fue rechazado correctamente: %',v_error;
  END IF;

  v_error:=NULL;
  BEGIN
    PERFORM * FROM public.corregir_precios_remito(
      'e5000000-0000-0000-0000-000000000001',v_payload,
      'Intento sin cambios reales',1
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('ningún precio' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'Un no-op no fue rechazado correctamente: %',v_error;
  END IF;

  v_error:=NULL;
  BEGIN
    PERFORM * FROM public.corregir_precios_remito(
      'e5000000-0000-0000-0000-000000000002',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'item_id','f5000000-0000-0000-0000-000000000003',
          'precio_unitario_sin_iva',200,
          'descuento_porcentaje',0
        )
      ),
      'Intento de modificar una venta común',0
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('sólo se pueden corregir' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'Una venta común pudo corregirse o recibió otro error: %',v_error;
  END IF;

  v_error:=NULL;
  BEGIN
    PERFORM * FROM public.corregir_precios_remito(
      'e5000000-0000-0000-0000-000000000003',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'item_id','f5000000-0000-0000-0000-000000000004',
          'precio_unitario_sin_iva',200,
          'descuento_porcentaje',0
        )
      ),
      'Intento de modificar un remito anulado',0
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('anulado' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'Un remito anulado pudo corregirse o recibió otro error: %',v_error;
  END IF;
END;
$rechazos$;

DO $rechaza_otra_sucursal$
DECLARE v_error text;
BEGIN
  BEGIN
    PERFORM * FROM public.corregir_precios_remito(
      'e5000000-0000-0000-0000-000000000004',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'item_id','f5000000-0000-0000-0000-000000000005',
          'precio_unitario_sin_iva',150,
          'descuento_porcentaje',0
        )
      ),
      'Intento sobre una sucursal ajena',0
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('no está disponible' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'Un empleado corrigió otra sucursal o recibió otro error: %',v_error;
  END IF;
END;
$rechaza_otra_sucursal$;

DO $empleado_ve_auditoria$
BEGIN
  IF (
    SELECT count(*) FROM public.remito_precio_correcciones
    WHERE venta_id='e5000000-0000-0000-0000-000000000001'
  )<>1 THEN
    RAISE EXCEPTION 'El empleado de la sucursal no puede leer la auditoría propia';
  END IF;
END;
$empleado_ve_auditoria$;

DO $sin_escritura_directa$
DECLARE v_error text;
BEGIN
  BEGIN
    INSERT INTO public.remito_precio_correcciones(
      venta_id,corregida_por,motivo,version_anterior,version_nueva,
      items_anteriores,items_nuevos,subtotal_anterior,subtotal_nuevo,
      iva_anterior,iva_nuevo,total_anterior,total_nuevo
    ) VALUES (
      'e5000000-0000-0000-0000-000000000001',
      'a5000000-0000-0000-0000-000000000001',
      'Inserción directa que debe fallar',1,2,'[]','[]',1,1,1,1,2,2
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL THEN
    RAISE EXCEPTION 'authenticated pudo insertar auditoría directamente';
  END IF;
END;
$sin_escritura_directa$;

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"a5000000-0000-0000-0000-000000000003","role":"authenticated"}';

DO $admin_corrige_obra$
DECLARE v_resultado record;
BEGIN
  SELECT * INTO v_resultado
  FROM public.corregir_precios_remito(
    'e5000000-0000-0000-0000-000000000004',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'item_id','f5000000-0000-0000-0000-000000000005',
        'precio_unitario_sin_iva',150,
        'descuento_porcentaje',0
      )
    ),
    'El administrador corrigió el remito de obra',
    0
  );
  IF v_resultado.total<>181.50 OR v_resultado.correccion_precios_version<>1 THEN
    RAISE EXCEPTION 'El admin no pudo corregir el remito de obra: %',row_to_json(v_resultado);
  END IF;
END;
$admin_corrige_obra$;

RESET ROLE;

DO $auditoria_inmutable$
DECLARE v_error text;
BEGIN
  BEGIN
    UPDATE public.remito_precio_correcciones
       SET motivo='Intento de reescritura'
     WHERE venta_id='e5000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('inmutable' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'La auditoría pudo reescribirse o recibió otro error: %',v_error;
  END IF;
END;
$auditoria_inmutable$;

ROLLBACK;
SQL

printf '✓ corrección de precios de remitos: alcance, cuenta corriente, stock, concurrencia y auditoría\n'
