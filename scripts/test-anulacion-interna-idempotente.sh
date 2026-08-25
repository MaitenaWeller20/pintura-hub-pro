#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  'a5250000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'anulacion-interna@test.local','x',now(),now(),now()
);

UPDATE public.profiles
   SET username='test-anulacion-interna',
       nombre_completo='Test anulación interna',
       sucursal_id=(SELECT id FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1),
       activo=true
 WHERE id='a5250000-0000-4000-8000-000000000001';

INSERT INTO public.user_roles(user_id,role)
VALUES ('a5250000-0000-4000-8000-000000000001','admin');

INSERT INTO public.clientes(id,razon_social,condicion_cta_cte,limite_credito)
VALUES ('a5250000-0000-4000-8000-000000000002','Cliente anulación interna',true,100000);

INSERT INTO public.productos(id,codigo,nombre,precio_sin_iva,iva_porcentaje)
VALUES ('a5250000-0000-4000-8000-000000000003','TEST-NC-INTERNA','Producto NC interna',1000,21);

INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
SELECT 'a5250000-0000-4000-8000-000000000003',s.id,10
  FROM public.sucursales AS s
 WHERE s.activa
 ORDER BY s.numero
 LIMIT 1;

SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub','a5250000-0000-4000-8000-000000000001',
    'role','authenticated'
  )::text,
  true
);

DO $$
DECLARE
  v_sucursal uuid;
  v_venta uuid := 'a5250000-0000-4000-8000-000000000006';
  v_nc uuid;
  v_nc_reintento uuid;
  v_key uuid := 'a5250000-0000-4000-8000-000000000004';
  v_stock numeric;
  v_original public.ventas%ROWTYPE;
  v_nota public.ventas%ROWTYPE;
  v_cantidad_notas integer;
BEGIN
  SELECT id INTO v_sucursal
    FROM public.sucursales
   WHERE activa
   ORDER BY numero
   LIMIT 1;

  -- Este tipo quedó en producción desde el flujo comercial anterior. Se arma
  -- la misma fila ya confirmada porque el creador vigente la normaliza a una
  -- venta neutra nueva; la regresión que importa es poder anular el histórico.
  INSERT INTO public.ventas(
    id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
    condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
    estado_pago,estado,observaciones,afip_estado
  ) VALUES (
    v_venta,v_sucursal,
    'a5250000-0000-4000-8000-000000000002',
    'a5250000-0000-4000-8000-000000000001',
    'TEST-FICC-0001','FAC_INTERNA_CTA_CTE','CTA_CTE',
    2000,420,0,2420,0,'PENDIENTE','ACTIVA','TEST-NC-INTERNA','NO_APLICA'
  );

  INSERT INTO public.venta_items(
    venta_id,producto_id,codigo,descripcion,cantidad,
    precio_unitario_sin_iva,precio_lista_sin_iva,iva_porcentaje,
    descuento_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
  ) VALUES (
    v_venta,'a5250000-0000-4000-8000-000000000003',
    'TEST-NC-INTERNA','Producto NC interna',2,
    1000,1000,21,0,2000,420,2420
  );

  UPDATE public.stock_sucursal
     SET cantidad=8
   WHERE producto_id='a5250000-0000-4000-8000-000000000003'
     AND sucursal_id=v_sucursal;

  SELECT nc_id INTO v_nc
    FROM public.anular_venta(v_venta,v_key);
  SELECT nc_id INTO v_nc_reintento
    FROM public.anular_venta(v_venta,v_key);

  IF v_nc_reintento IS DISTINCT FROM v_nc THEN
    RAISE EXCEPTION 'El reintento devolvió otra nota de crédito';
  END IF;

  SELECT * INTO v_original FROM public.ventas WHERE id=v_venta;
  SELECT * INTO v_nota FROM public.ventas WHERE id=v_nc;

  IF v_original.estado IS DISTINCT FROM 'ANULADA'
     OR v_original.venta_anulada_por IS DISTINCT FROM v_nc THEN
    RAISE EXCEPTION 'La venta original no quedó vinculada a la nota interna';
  END IF;
  IF v_nota.tipo_comprobante IS DISTINCT FROM 'NOTA_CREDITO'
     OR v_nota.afip_estado IS DISTINCT FROM 'NO_APLICA'
     OR v_nota.afip_cbte_asoc_id IS NOT NULL
     OR v_nota.idempotency_key IS DISTINCT FROM v_key THEN
    RAISE EXCEPTION 'La nota interna no conservó su identidad e idempotencia';
  END IF;

  SELECT count(*) INTO v_cantidad_notas
    FROM public.ventas
   WHERE idempotency_key=v_key;
  IF v_cantidad_notas IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'La anulación creó % notas para una misma clave',v_cantidad_notas;
  END IF;

  SELECT cantidad INTO v_stock
    FROM public.stock_sucursal
   WHERE producto_id='a5250000-0000-4000-8000-000000000003'
     AND sucursal_id=v_sucursal;
  IF v_stock IS DISTINCT FROM 10::numeric THEN
    RAISE EXCEPTION 'El reintento duplicó la reposición de stock: quedó %',v_stock;
  END IF;
END;
$$;

ROLLBACK;
SQL

echo "✅ Anulación interna idempotente verificada."
