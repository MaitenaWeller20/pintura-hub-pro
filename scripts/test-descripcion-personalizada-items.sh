#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
LOCAL_DB_CONTAINER="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(
  docker exec -i "$LOCAL_DB_CONTAINER" psql -U postgres -d postgres
  -v ON_ERROR_STOP=1
)

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

CREATE TEMP TABLE t_context ON COMMIT DROP AS
SELECT
  'a5100000-0000-4000-8000-000000000001'::uuid AS usuario_id,
  (SELECT s.id FROM public.sucursales AS s WHERE s.activa ORDER BY s.numero LIMIT 1)
    AS sucursal_id;

SELECT pg_temp.assert_true(
  (SELECT sucursal_id IS NOT NULL FROM t_context),
  'hay una sucursal activa para los escenarios locales'
);

INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
)
SELECT
  usuario_id,'00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','t1-descripcion@test.local','x',
  pg_catalog.now(),pg_catalog.now(),pg_catalog.now()
FROM t_context;

UPDATE public.profiles AS p
   SET username='t1_descripcion',nombre_completo='T1 Descripción',activo=true,
       sucursal_id=c.sucursal_id
  FROM t_context AS c
 WHERE p.id=c.usuario_id;
INSERT INTO public.user_roles(user_id,role)
SELECT usuario_id,'admin' FROM t_context;
INSERT INTO public.profile_sucursales(profile_id,sucursal_id)
SELECT usuario_id,sucursal_id FROM t_context;
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object('sub',usuario_id,'role','authenticated')::text,
  true
)
FROM t_context;

UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;

INSERT INTO public.clientes (
  id,razon_social,tipo,condicion_cta_cte,limite_credito,activo
) VALUES (
  'b5100000-0000-4000-8000-000000000001','T1 CLIENTE DESCRIPCIÓN',
  'CONSUMIDOR_FINAL',true,99999999,true
);

INSERT INTO public.productos (
  id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado
) VALUES
  (
    'c5100000-0000-4000-8000-000000000001','T1-COLOR-A',
    'Producto T1 Color A',1000,21,true,false
  ),
  (
    'c5100000-0000-4000-8000-000000000002','T1-COLOR-B',
    'Producto T1 Color B',500,21,true,false
  );
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
SELECT p.id,c.sucursal_id,100
  FROM public.productos AS p
 CROSS JOIN t_context AS c
 WHERE p.id IN (
   'c5100000-0000-4000-8000-000000000001',
   'c5100000-0000-4000-8000-000000000002'
 );

-- Alta: congela el texto normalizado sin tocar catálogo ni importes.
CREATE TEMP TABLE t_presupuesto_personalizado ON COMMIT DROP AS
SELECT * FROM public.crear_presupuesto(
  (SELECT sucursal_id FROM t_context),
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'producto_id','c5100000-0000-4000-8000-000000000001',
    'cantidad',2,
    'descuento_porcentaje',10,
    'descripcion','  Base 10 L   (Código 1234)  '
  )),
  NULL,NULL,NULL,'T1 presupuesto personalizado'
);
SELECT pg_temp.assert_true(
  (SELECT i.descripcion='Base 10 L (Código 1234)'
       AND i.precio_lista_sin_iva=1000
       AND i.descuento_porcentaje=10
       AND i.precio_sin_iva=900
       AND i.iva_porcentaje=21
       AND i.subtotal_sin_iva=1800
       AND i.iva_monto=378
       AND i.subtotal_con_iva=2178
     FROM public.presupuesto_items AS i
     JOIN t_presupuesto_personalizado AS t ON t.presupuesto_id=i.presupuesto_id),
  'crear_presupuesto congela la descripción normalizada sin cambiar cálculos'
);
SELECT pg_temp.assert_true(
  (SELECT nombre='Producto T1 Color A' AND precio_sin_iva=1000 AND iva_porcentaje=21
     FROM public.productos
    WHERE id='c5100000-0000-4000-8000-000000000001'),
  'crear_presupuesto no renombra ni repricia el catálogo'
);

-- Compatibilidad: omitir el campo conserva el nombre del catálogo.
CREATE TEMP TABLE t_presupuesto_fallback ON COMMIT DROP AS
SELECT * FROM public.crear_presupuesto(
  (SELECT sucursal_id FROM t_context),
  '[{"producto_id":"c5100000-0000-4000-8000-000000000002","cantidad":1,"descuento_porcentaje":0}]'::jsonb,
  NULL,NULL,NULL,'T1 presupuesto fallback'
);
SELECT pg_temp.assert_true(
  (SELECT i.descripcion='Producto T1 Color B'
     FROM public.presupuesto_items AS i
     JOIN t_presupuesto_fallback AS t ON t.presupuesto_id=i.presupuesto_id),
  'crear_presupuesto usa el catálogo cuando descripción está ausente'
);

-- Vacío y 161 caracteres se rechazan sin encabezado, ítem ni renumeración durable.
CREATE TEMP TABLE t_alta_invalida_antes ON COMMIT DROP AS
SELECT
  (SELECT pg_catalog.count(*) FROM public.presupuestos) AS presupuestos,
  (SELECT pg_catalog.count(*) FROM public.presupuesto_items) AS items;
DO $$
DECLARE
  v_sucursal uuid := (SELECT sucursal_id FROM t_context);
BEGIN
  BEGIN
    PERFORM * FROM public.crear_presupuesto(
      v_sucursal,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'producto_id','c5100000-0000-4000-8000-000000000001',
        'cantidad',1,'descripcion',E' \n\t '
      )),
      NULL,NULL,NULL,'T1 vacío no debe persistir'
    );
    RAISE EXCEPTION 'crear_presupuesto aceptó descripción vacía';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='crear_presupuesto aceptó descripción vacía'
       OR SQLERRM NOT ILIKE '%descripción%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM * FROM public.crear_presupuesto(
      v_sucursal,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'producto_id','c5100000-0000-4000-8000-000000000001',
        'cantidad',1,'descripcion',pg_catalog.repeat('x',161)
      )),
      NULL,NULL,NULL,'T1 larga no debe persistir'
    );
    RAISE EXCEPTION 'crear_presupuesto aceptó 161 caracteres';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='crear_presupuesto aceptó 161 caracteres'
       OR SQLERRM NOT LIKE '%160%' THEN
      RAISE;
    END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT b.presupuestos=(SELECT pg_catalog.count(*) FROM public.presupuestos)
       AND b.items=(SELECT pg_catalog.count(*) FROM public.presupuesto_items)
     FROM t_alta_invalida_antes AS b),
  'descripciones inválidas revierten por completo crear_presupuesto'
);

-- Edición: la ausencia conserva el snapshot; el reprecio no cambia esa decisión.
UPDATE public.presupuesto_items AS i
   SET descripcion='Descripción histórica 4321'
  FROM t_presupuesto_personalizado AS t
 WHERE i.presupuesto_id=t.presupuesto_id
   AND i.producto_id='c5100000-0000-4000-8000-000000000001';
SELECT * FROM public.editar_presupuesto(
  (SELECT presupuesto_id FROM t_presupuesto_personalizado),
  '[{"producto_id":"c5100000-0000-4000-8000-000000000001","cantidad":3,"descuento_porcentaje":0}]'::jsonb,
  NULL,NULL,NULL,'T1 edición conserva descripción',false
);
SELECT pg_temp.assert_true(
  (SELECT i.descripcion='Descripción histórica 4321'
     FROM public.presupuesto_items AS i
     JOIN t_presupuesto_personalizado AS t ON t.presupuesto_id=i.presupuesto_id),
  'editar_presupuesto conserva la descripción histórica cuando el campo se omite'
);

UPDATE public.productos
   SET precio_sin_iva=1250,iva_porcentaje=10.5
 WHERE id='c5100000-0000-4000-8000-000000000001';
SELECT * FROM public.editar_presupuesto(
  (SELECT presupuesto_id FROM t_presupuesto_personalizado),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'producto_id','c5100000-0000-4000-8000-000000000001',
      'cantidad',3,'descuento_porcentaje',0
    ),
    pg_catalog.jsonb_build_object(
      'producto_id','c5100000-0000-4000-8000-000000000002',
      'cantidad',1,'descuento_porcentaje',0
    )
  ),
  NULL,NULL,NULL,'T1 edición repricia sin redescribir',true
);
SELECT pg_temp.assert_true(
  (SELECT i.descripcion='Descripción histórica 4321'
       AND i.precio_lista_sin_iva=1250
       AND i.iva_porcentaje=10.5
     FROM public.presupuesto_items AS i
     JOIN t_presupuesto_personalizado AS t ON t.presupuesto_id=i.presupuesto_id
    WHERE i.producto_id='c5100000-0000-4000-8000-000000000001'),
  'p_repreciar=true actualiza precio e IVA pero conserva la descripción histórica'
);
SELECT pg_temp.assert_true(
  (SELECT i.descripcion='Producto T1 Color B'
     FROM public.presupuesto_items AS i
     JOIN t_presupuesto_personalizado AS t ON t.presupuesto_id=i.presupuesto_id
    WHERE i.producto_id='c5100000-0000-4000-8000-000000000002'),
  'una línea nueva editada sin descripción usa el catálogo'
);

SELECT * FROM public.editar_presupuesto(
  (SELECT presupuesto_id FROM t_presupuesto_personalizado),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'producto_id','c5100000-0000-4000-8000-000000000001',
      'cantidad',3,'descuento_porcentaje',0,
      'descripcion','  Base histórica   (Código 5678) '
    ),
    pg_catalog.jsonb_build_object(
      'producto_id','c5100000-0000-4000-8000-000000000002',
      'cantidad',1,'descuento_porcentaje',0
    )
  ),
  NULL,NULL,NULL,'T1 edición descripción explícita',false
);
SELECT pg_temp.assert_true(
  (SELECT i.descripcion='Base histórica (Código 5678)'
     FROM public.presupuesto_items AS i
     JOIN t_presupuesto_personalizado AS t ON t.presupuesto_id=i.presupuesto_id
    WHERE i.producto_id='c5100000-0000-4000-8000-000000000001'),
  'editar_presupuesto normaliza una descripción explícita'
);

CREATE TEMP TABLE t_edicion_invalida_antes ON COMMIT DROP AS
SELECT
  (SELECT pg_catalog.to_jsonb(p)
     FROM public.presupuestos AS p
     JOIN t_presupuesto_personalizado AS t ON t.presupuesto_id=p.id) AS cabecera,
  (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) ORDER BY i.id)
     FROM public.presupuesto_items AS i
     JOIN t_presupuesto_personalizado AS t ON t.presupuesto_id=i.presupuesto_id) AS items;
DO $$
DECLARE
  v_presupuesto uuid := (SELECT presupuesto_id FROM t_presupuesto_personalizado);
BEGIN
  BEGIN
    PERFORM * FROM public.editar_presupuesto(
      v_presupuesto,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'producto_id','c5100000-0000-4000-8000-000000000001',
        'cantidad',9,'descripcion','   '
      ))
    );
    RAISE EXCEPTION 'editar_presupuesto aceptó descripción vacía';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='editar_presupuesto aceptó descripción vacía'
       OR SQLERRM NOT ILIKE '%descripción%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM * FROM public.editar_presupuesto(
      v_presupuesto,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'producto_id','c5100000-0000-4000-8000-000000000001',
        'cantidad',9,'descripcion',pg_catalog.repeat('x',161)
      ))
    );
    RAISE EXCEPTION 'editar_presupuesto aceptó 161 caracteres';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='editar_presupuesto aceptó 161 caracteres'
       OR SQLERRM NOT LIKE '%160%' THEN
      RAISE;
    END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT b.cabecera IS NOT DISTINCT FROM (
            SELECT pg_catalog.to_jsonb(p)
              FROM public.presupuestos AS p
              JOIN t_presupuesto_personalizado AS t ON t.presupuesto_id=p.id
          )
       AND b.items IS NOT DISTINCT FROM (
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) ORDER BY i.id)
              FROM public.presupuesto_items AS i
              JOIN t_presupuesto_personalizado AS t ON t.presupuesto_id=i.presupuesto_id
          )
     FROM t_edicion_invalida_antes AS b),
  'descripciones inválidas revierten por completo editar_presupuesto'
);

-- Venta directa: congela el texto y conserva montos, catálogo y stock esperados.
UPDATE public.productos
   SET precio_sin_iva=1000,iva_porcentaje=21
 WHERE id='c5100000-0000-4000-8000-000000000001';
CREATE TEMP TABLE t_venta_personalizada ON COMMIT DROP AS
SELECT * FROM public.crear_venta(
  (SELECT sucursal_id FROM t_context),
  'b5100000-0000-4000-8000-000000000001','VENTA','CTA_CTE',
  '[{"producto_id":"c5100000-0000-4000-8000-000000000001","cantidad":2,"descuento_porcentaje":10,"descripcion":"  Base 10 L   (Código 1234)  "}]'::jsonb,
  '[]'::jsonb,0,'T1 venta personalizada',NULL,NULL,NULL,
  'e5100000-0000-4000-8000-000000000001'
);
SELECT pg_temp.assert_true(
  (SELECT i.descripcion='Base 10 L (Código 1234)'
       AND i.precio_unitario_sin_iva=1000
       AND i.precio_lista_sin_iva=1000
       AND i.descuento_porcentaje=10
       AND i.iva_porcentaje=21
       AND i.subtotal_sin_iva=1800
       AND i.iva_monto=378
       AND i.subtotal_con_iva=2178
     FROM public.venta_items AS i
     JOIN t_venta_personalizada AS t ON t.venta_id=i.venta_id),
  'crear_venta congela la descripción normalizada sin cambiar cálculos'
);
SELECT pg_temp.assert_true(
  (SELECT v.subtotal_sin_iva=1800 AND v.iva_total=378 AND v.total=2178
     FROM public.ventas AS v
     JOIN t_venta_personalizada AS t ON t.venta_id=v.id)
  AND (SELECT nombre='Producto T1 Color A' AND precio_sin_iva=1000 AND iva_porcentaje=21
         FROM public.productos
        WHERE id='c5100000-0000-4000-8000-000000000001')
  AND (SELECT cantidad=98
         FROM public.stock_sucursal AS s
         JOIN t_context AS c ON c.sucursal_id=s.sucursal_id
        WHERE s.producto_id='c5100000-0000-4000-8000-000000000001')
  AND (SELECT pg_catalog.count(*)=1
         FROM public.stock_movimientos AS m
         JOIN t_venta_personalizada AS t ON t.venta_id=m.referencia_id),
  'la descripción de venta no cambia catálogo, totales ni efecto de stock'
);

CREATE TEMP TABLE t_venta_fallback ON COMMIT DROP AS
SELECT * FROM public.crear_venta(
  (SELECT sucursal_id FROM t_context),
  'b5100000-0000-4000-8000-000000000001','VENTA','CTA_CTE',
  '[{"producto_id":"c5100000-0000-4000-8000-000000000001","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'T1 venta fallback',NULL,NULL,NULL,
  'e5100000-0000-4000-8000-000000000002'
);
SELECT pg_temp.assert_true(
  (SELECT i.descripcion='Producto T1 Color A'
     FROM public.venta_items AS i
     JOIN t_venta_fallback AS t ON t.venta_id=i.venta_id),
  'crear_venta usa el catálogo cuando descripción está ausente'
);

CREATE TEMP TABLE t_venta_invalida_antes ON COMMIT DROP AS
SELECT
  (SELECT pg_catalog.count(*) FROM public.ventas) AS ventas,
  (SELECT pg_catalog.count(*) FROM public.venta_items) AS items,
  (SELECT pg_catalog.count(*) FROM public.stock_movimientos) AS movimientos,
  (SELECT cantidad
     FROM public.stock_sucursal AS s
     JOIN t_context AS c ON c.sucursal_id=s.sucursal_id
    WHERE s.producto_id='c5100000-0000-4000-8000-000000000001') AS stock;
DO $$
DECLARE
  v_sucursal uuid := (SELECT sucursal_id FROM t_context);
BEGIN
  BEGIN
    PERFORM * FROM public.crear_venta(
      v_sucursal,
      'b5100000-0000-4000-8000-000000000001','VENTA','CTA_CTE',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'producto_id','c5100000-0000-4000-8000-000000000001',
        'cantidad',4,'descripcion','  '
      )),
      '[]'::jsonb,0,'T1 venta vacía',NULL,NULL,NULL,
      'e5100000-0000-4000-8000-000000000003'
    );
    RAISE EXCEPTION 'crear_venta aceptó descripción vacía';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='crear_venta aceptó descripción vacía'
       OR SQLERRM NOT ILIKE '%descripción%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM * FROM public.crear_venta(
      v_sucursal,
      'b5100000-0000-4000-8000-000000000001','VENTA','CTA_CTE',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'producto_id','c5100000-0000-4000-8000-000000000001',
        'cantidad',4,'descripcion',pg_catalog.repeat('x',161)
      )),
      '[]'::jsonb,0,'T1 venta larga',NULL,NULL,NULL,
      'e5100000-0000-4000-8000-000000000004'
    );
    RAISE EXCEPTION 'crear_venta aceptó 161 caracteres';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='crear_venta aceptó 161 caracteres'
       OR SQLERRM NOT LIKE '%160%' THEN
      RAISE;
    END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT b.ventas=(SELECT pg_catalog.count(*) FROM public.ventas)
       AND b.items=(SELECT pg_catalog.count(*) FROM public.venta_items)
       AND b.movimientos=(SELECT pg_catalog.count(*) FROM public.stock_movimientos)
       AND b.stock=(
         SELECT cantidad
           FROM public.stock_sucursal AS s
           JOIN t_context AS c ON c.sucursal_id=s.sucursal_id
          WHERE s.producto_id='c5100000-0000-4000-8000-000000000001'
       )
     FROM t_venta_invalida_antes AS b),
  'descripciones inválidas revierten venta, ítems y stock'
);

-- La descripción forma parte del payload idempotente y no duplica efectos.
CREATE TEMP TABLE t_replay_antes ON COMMIT DROP AS
SELECT
  (SELECT pg_catalog.count(*) FROM public.ventas) AS ventas,
  (SELECT pg_catalog.count(*) FROM public.venta_items) AS items,
  (SELECT pg_catalog.count(*) FROM public.stock_movimientos) AS movimientos,
  (SELECT pg_catalog.count(*) FROM public.cuenta_corriente_movimientos) AS cuenta_corriente,
  (SELECT cantidad
     FROM public.stock_sucursal AS s
     JOIN t_context AS c ON c.sucursal_id=s.sucursal_id
    WHERE s.producto_id='c5100000-0000-4000-8000-000000000001') AS stock;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.crear_venta(
      (SELECT sucursal_id FROM t_context),
      'b5100000-0000-4000-8000-000000000001','VENTA','CTA_CTE',
      '[{"producto_id":"c5100000-0000-4000-8000-000000000001","cantidad":2,"descuento_porcentaje":10,"descripcion":"Base 10 L (Código 9999)"}]'::jsonb,
      '[]'::jsonb,0,'T1 venta personalizada',NULL,NULL,NULL,
      'e5100000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'el replay aceptó otra descripción';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='el replay aceptó otra descripción'
       OR SQLERRM NOT LIKE '%no corresponde a esta operación%' THEN
      RAISE;
    END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT b.ventas=(SELECT pg_catalog.count(*) FROM public.ventas)
       AND b.items=(SELECT pg_catalog.count(*) FROM public.venta_items)
       AND b.movimientos=(SELECT pg_catalog.count(*) FROM public.stock_movimientos)
       AND b.cuenta_corriente=(SELECT pg_catalog.count(*) FROM public.cuenta_corriente_movimientos)
       AND b.stock=(
         SELECT cantidad
           FROM public.stock_sucursal AS s
           JOIN t_context AS c ON c.sucursal_id=s.sucursal_id
          WHERE s.producto_id='c5100000-0000-4000-8000-000000000001'
       )
     FROM t_replay_antes AS b),
  'otra descripción con la misma idempotency key falla sin duplicar efectos'
);

SELECT pg_temp.assert_true(
  NOT pg_catalog.has_function_privilege(
    'anon','public._normalizar_descripcion_item_20260830(text,text,boolean)','EXECUTE'
  )
  AND NOT pg_catalog.has_function_privilege(
    'authenticated','public._normalizar_descripcion_item_20260830(text,text,boolean)','EXECUTE'
  )
  AND NOT pg_catalog.has_function_privilege(
    'service_role','public._normalizar_descripcion_item_20260830(text,text,boolean)','EXECUTE'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))
     ) AS a
     WHERE p.oid='public._normalizar_descripcion_item_20260830(text,text,boolean)'::regprocedure
       AND a.grantee=0
       AND a.privilege_type='EXECUTE'
  ),
  'el normalizador SQL es owner-only y PUBLIC no hereda EXECUTE'
);

ROLLBACK;
SQL

printf '✓ descripción personalizada: contrato SQL y persistencia verificados\n'
