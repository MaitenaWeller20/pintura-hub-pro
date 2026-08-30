#!/usr/bin/env bash
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
    RAISE EXCEPTION 'FALLO: %',p_message;
  END IF;
  RAISE NOTICE '✓ %',p_message;
END;
$$;

INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES
  ('a5200000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','t2-presupuesto-admin@test.local','x',now(),now(),now()),
  ('a5200000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','t2-presupuesto-gp@test.local','x',now(),now(),now()),
  ('a5200000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','t2-presupuesto-oh@test.local','x',now(),now(),now());

UPDATE public.profiles
   SET username='t2_presupuesto_admin',activo=true,
       sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS')
 WHERE id='a5200000-0000-4000-8000-000000000001';
UPDATE public.profiles
   SET username='t2_presupuesto_gp',activo=true,
       sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='GENERALPAZ')
 WHERE id='a5200000-0000-4000-8000-000000000002';
UPDATE public.profiles
   SET username='t2_presupuesto_oh',activo=true,
       sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS')
 WHERE id='a5200000-0000-4000-8000-000000000003';
INSERT INTO public.user_roles(user_id,role)
VALUES ('a5200000-0000-4000-8000-000000000001','admin');
INSERT INTO public.profile_sucursales(profile_id,sucursal_id)
SELECT 'a5200000-0000-4000-8000-000000000001'::uuid,id
  FROM public.sucursales WHERE codigo IN ('OHIGGINS','GENERALPAZ')
UNION ALL
SELECT 'a5200000-0000-4000-8000-000000000002'::uuid,id
  FROM public.sucursales WHERE codigo='GENERALPAZ'
UNION ALL
SELECT 'a5200000-0000-4000-8000-000000000003'::uuid,id
  FROM public.sucursales WHERE codigo='OHIGGINS';

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5200000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;

INSERT INTO public.clientes(
  id,razon_social,tipo,condicion_cta_cte,limite_credito,activo,
  es_generico,sucursal_habitual_id,es_obra
) VALUES
  ('b5200000-0000-4000-8000-000000000001','T2 CLIENTE IDENTIFICADO',
   'CONSUMIDOR_FINAL',true,999999,true,false,NULL,false),
  ('b5200000-0000-4000-8000-000000000002','T2 C.F. DE SUCURSAL',
   'CONSUMIDOR_FINAL',false,NULL,true,true,
   (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'),false),
  ('b5200000-0000-4000-8000-000000000003','T2 GENÉRICO NO C.F.',
   'MONOTRIBUTISTA',false,NULL,true,true,NULL,false),
  ('b5200000-0000-4000-8000-000000000004','T2 C.F. OBRA',
   'CONSUMIDOR_FINAL',false,NULL,true,true,NULL,true);

INSERT INTO public.productos(
  id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado
) VALUES (
  'c5200000-0000-4000-8000-000000000001','T2-COLOR',
  'Base 10 L',100,21,true,false
);
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
SELECT 'c5200000-0000-4000-8000-000000000001',id,100
  FROM public.sucursales;

UPDATE public.caja_sesiones
   SET estado='CERRADA',cerrada_en=now(),
       cerrada_por='a5200000-0000-4000-8000-000000000001'
 WHERE estado='ABIERTA';
INSERT INTO public.caja_sesiones(id,sucursal_id,estado,abierta_por,fondo_inicial)
SELECT 'd5200000-0000-4000-8000-000000000001'::uuid,id,'ABIERTA'::public.caja_sesion_estado,
       'a5200000-0000-4000-8000-000000000001'::uuid,0::numeric
  FROM public.sucursales WHERE codigo='OHIGGINS'
UNION ALL
SELECT 'd5200000-0000-4000-8000-000000000002'::uuid,id,'ABIERTA'::public.caja_sesion_estado,
       'a5200000-0000-4000-8000-000000000001'::uuid,0::numeric
  FROM public.sucursales WHERE codigo='GENERALPAZ';

CREATE TEMP TABLE t_global AS
SELECT c.id
  FROM public.clientes AS c
 WHERE c.activo
   AND c.es_generico
   AND c.tipo='CONSUMIDOR_FINAL'
   AND c.sucursal_habitual_id IS NULL
   AND NOT COALESCE(c.es_obra,false);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM t_global),
  'hay exactamente un Consumidor Final global activo elegible'
);

CREATE TEMP TABLE t_anon AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'),
  '[{"producto_id":"c5200000-0000-4000-8000-000000000001","cantidad":1,"descripcion":"  Base 10 L   (Código 1234)  "}]'::jsonb,
  NULL,NULL,NULL,'T2-ANONIMO'
);
CREATE TEMP TABLE t_cta_anon AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'),
  '[{"producto_id":"c5200000-0000-4000-8000-000000000001","cantidad":1}]'::jsonb,
  NULL,NULL,NULL,'T2-CTA-ANONIMO'
);
CREATE TEMP TABLE t_generico_explicito AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'),
  '[{"producto_id":"c5200000-0000-4000-8000-000000000001","cantidad":1}]'::jsonb,
  NULL,NULL,NULL,'T2-GENERICO-EXPLICITO'
);
CREATE TEMP TABLE t_sin_caja AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales WHERE codigo='GENERALPAZ'),
  '[{"producto_id":"c5200000-0000-4000-8000-000000000001","cantidad":1}]'::jsonb,
  NULL,NULL,NULL,'T2-SIN-CAJA'
);
CREATE TEMP TABLE t_sin_candidato AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'),
  '[{"producto_id":"c5200000-0000-4000-8000-000000000001","cantidad":1}]'::jsonb,
  NULL,NULL,NULL,'T2-SIN-CANDIDATO'
);
CREATE TEMP TABLE t_admin_gp AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales WHERE codigo='GENERALPAZ'),
  '[{"producto_id":"c5200000-0000-4000-8000-000000000001","cantidad":1}]'::jsonb,
  NULL,NULL,NULL,'T2-ADMIN-GP'
);
CREATE TEMP TABLE t_employee_gp AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales WHERE codigo='GENERALPAZ'),
  '[{"producto_id":"c5200000-0000-4000-8000-000000000001","cantidad":1}]'::jsonb,
  NULL,NULL,NULL,'T2-EMPLEADO-GP'
);
CREATE TEMP TABLE t_identificado AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'),
  '[{"producto_id":"c5200000-0000-4000-8000-000000000001","cantidad":1}]'::jsonb,
  NULL,NULL,NULL,'T2-IDENTIFICADO'
);
CREATE TEMP TABLE t_bola AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales WHERE codigo='GENERALPAZ'),
  '[{"producto_id":"c5200000-0000-4000-8000-000000000001","cantidad":1}]'::jsonb,
  NULL,NULL,NULL,'T2-BOLA'
);

-- RED principal: el escritor vigente todavía rechaza cliente NULL.
CREATE TEMP TABLE t_anon_sale AS
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  (SELECT presupuesto_id FROM t_anon),NULL,'CONTADO',
  '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,
  'e5200000-0000-4000-8000-000000000001'
);
SELECT pg_temp.assert_true(
  (SELECT s.cliente_id=g.id
     FROM t_anon_sale AS s CROSS JOIN t_global AS g),
  'la conversión anónima devuelve el cliente global efectivo'
);
SELECT pg_temp.assert_true(
  (SELECT p.cliente_id IS NULL
       AND p.estado='CONVERTIDO'
       AND p.venta_id=s.venta_id
       AND p.conversion_payload_hash~'^[0-9a-f]{64}$'
       AND v.cliente_id=g.id
       AND v.sucursal_id=p.sucursal_id
       AND v.caja_sesion_id='d5200000-0000-4000-8000-000000000001'
       AND i.descripcion='Base 10 L (Código 1234)'
     FROM public.presupuestos AS p
     CROSS JOIN t_anon_sale AS s
     CROSS JOIN t_global AS g
     JOIN public.ventas AS v ON v.id=s.venta_id
     JOIN public.venta_items AS i ON i.venta_id=v.id
    WHERE p.id=(SELECT presupuesto_id FROM t_anon)),
  'la venta conserva presupuesto, sucursal, caja y descripción sin identificar el presupuesto'
);

CREATE TEMP TABLE t_effects_before_replay AS
SELECT
  (SELECT count(*) FROM public.ventas) AS ventas,
  (SELECT count(*) FROM public.venta_items) AS items,
  (SELECT count(*) FROM public.venta_pagos) AS pagos,
  (SELECT count(*) FROM public.stock_movimientos) AS stock_movimientos,
  (SELECT count(*) FROM public.caja_movimientos) AS caja_movimientos,
  (SELECT cantidad FROM public.stock_sucursal
    WHERE producto_id='c5200000-0000-4000-8000-000000000001'
      AND sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS')) AS stock;

UPDATE public.clientes SET activo=false WHERE id=(SELECT id FROM t_global);
UPDATE public.caja_sesiones
   SET estado='CERRADA',cerrada_en=now(),
       cerrada_por='a5200000-0000-4000-8000-000000000001'
 WHERE id='d5200000-0000-4000-8000-000000000001';
CREATE TEMP TABLE t_anon_replay AS
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  (SELECT presupuesto_id FROM t_anon),NULL,'CONTADO',
  '[{"monto":121.00,"forma_pago":"EFECTIVO"}]'::jsonb,
  'e5200000-0000-4000-8000-000000000099'
);
SELECT pg_temp.assert_true(
  (SELECT r.venta_id=s.venta_id AND r.cliente_id=s.cliente_id
     FROM t_anon_replay AS r CROSS JOIN t_anon_sale AS s),
  'el replay canónico no depende de la key recibida, la caja ni el candidato actual'
);
SELECT pg_temp.assert_true(
  (SELECT b IS NOT DISTINCT FROM a
     FROM t_effects_before_replay AS b
     CROSS JOIN LATERAL (
       SELECT
         (SELECT count(*) FROM public.ventas) AS ventas,
         (SELECT count(*) FROM public.venta_items) AS items,
         (SELECT count(*) FROM public.venta_pagos) AS pagos,
         (SELECT count(*) FROM public.stock_movimientos) AS stock_movimientos,
         (SELECT count(*) FROM public.caja_movimientos) AS caja_movimientos,
         (SELECT cantidad FROM public.stock_sucursal
           WHERE producto_id='c5200000-0000-4000-8000-000000000001'
             AND sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS')) AS stock
     ) AS a),
  'el replay exacto no duplica venta, pago, caja ni stock'
);

DO $$
DECLARE
  v_marker constant text := 'T2_CONFLICTO_NO_FALLO';
BEGIN
  BEGIN
    PERFORM * FROM public.convertir_presupuesto_en_venta_neutral(
      (SELECT presupuesto_id FROM t_anon),NULL,'CONTADO',
      '[{"forma_pago":"EFECTIVO","monto":120}]'::jsonb,NULL
    );
    RAISE EXCEPTION '%',v_marker;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM=v_marker OR SQLERRM NOT LIKE '%ya fue convertido con otros datos%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM * FROM public.convertir_presupuesto_en_venta_neutral(
      (SELECT presupuesto_id FROM t_anon),NULL,'CTA_CTE','[]'::jsonb,NULL
    );
    RAISE EXCEPTION '%',v_marker;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM=v_marker OR SQLERRM NOT LIKE '%ya fue convertido con otros datos%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM * FROM public.convertir_presupuesto_en_venta_neutral(
      (SELECT presupuesto_id FROM t_anon),
      'b5200000-0000-4000-8000-000000000001','CONTADO',
      '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,NULL
    );
    RAISE EXCEPTION '%',v_marker;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM=v_marker OR SQLERRM NOT LIKE '%ya fue convertido con otros datos%' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(true,'cliente, condición y pagos distintos chocan con la huella de conversión');

UPDATE public.clientes SET activo=true WHERE id=(SELECT id FROM t_global);
UPDATE public.caja_sesiones
   SET estado='ABIERTA',cerrada_en=NULL,cerrada_por=NULL
 WHERE id='d5200000-0000-4000-8000-000000000001';

DO $$
DECLARE v_marker constant text := 'T2_CTA_ANON_NO_FALLO';
BEGIN
  BEGIN
    PERFORM * FROM public.convertir_presupuesto_en_venta_neutral(
      (SELECT presupuesto_id FROM t_cta_anon),NULL,'CTA_CTE','[]'::jsonb,NULL
    );
    RAISE EXCEPTION '%',v_marker;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM=v_marker OR SQLERRM NOT LIKE '%cuenta corriente%identific%' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT estado='ABIERTO' AND venta_id IS NULL
     FROM public.presupuestos WHERE id=(SELECT presupuesto_id FROM t_cta_anon)),
  'cuenta corriente anónima falla sin convertir el presupuesto'
);

DO $$
DECLARE v_marker constant text := 'T2_GENERICO_NO_FALLO';
BEGIN
  BEGIN
    PERFORM * FROM public.convertir_presupuesto_en_venta_neutral(
      (SELECT presupuesto_id FROM t_generico_explicito),
      'b5200000-0000-4000-8000-000000000002','CONTADO',
      '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,NULL
    );
    RAISE EXCEPTION '%',v_marker;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM=v_marker OR SQLERRM NOT LIKE '%Consumidor Final%sin cliente%' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT estado='ABIERTO' AND venta_id IS NULL
     FROM public.presupuestos WHERE id=(SELECT presupuesto_id FROM t_generico_explicito)),
  'un UUID genérico explícito se rechaza sin efectos'
);

UPDATE public.clientes SET activo=false WHERE id=(SELECT id FROM t_global);
DO $$
DECLARE v_marker constant text := 'T2_CANDIDATO_NO_FALLO';
BEGIN
  BEGIN
    PERFORM * FROM public.convertir_presupuesto_en_venta_neutral(
      (SELECT presupuesto_id FROM t_sin_candidato),NULL,'CONTADO',
      '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,NULL
    );
    RAISE EXCEPTION '%',v_marker;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM=v_marker OR SQLERRM NOT LIKE '%Consumidor Final global activo%' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT estado='ABIERTO' AND venta_id IS NULL
     FROM public.presupuestos WHERE id=(SELECT presupuesto_id FROM t_sin_candidato)),
  'candidato ausente falla cerrado y no convierte'
);
UPDATE public.clientes SET activo=true WHERE id=(SELECT id FROM t_global);

UPDATE public.caja_sesiones
   SET estado='CERRADA',cerrada_en=now(),
       cerrada_por='a5200000-0000-4000-8000-000000000001'
 WHERE id='d5200000-0000-4000-8000-000000000002';
DO $$
DECLARE v_marker constant text := 'T2_CAJA_NO_FALLO';
BEGIN
  BEGIN
    PERFORM * FROM public.convertir_presupuesto_en_venta_neutral(
      (SELECT presupuesto_id FROM t_sin_caja),NULL,'CONTADO',
      '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,NULL
    );
    RAISE EXCEPTION '%',v_marker;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM=v_marker OR SQLERRM NOT LIKE '%caja abierta%sucursal del presupuesto%' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT count(*)=0 FROM public.caja_sesiones AS cs
    JOIN public.sucursales AS s ON s.id=cs.sucursal_id
   WHERE s.codigo='GENERALPAZ' AND cs.estado='ABIERTA')
  AND (SELECT count(*)=1 FROM public.caja_sesiones AS cs
       JOIN public.sucursales AS s ON s.id=cs.sucursal_id
      WHERE s.codigo='OHIGGINS' AND cs.estado='ABIERTA')
  AND (SELECT estado='ABIERTO' AND venta_id IS NULL
       FROM public.presupuestos WHERE id=(SELECT presupuesto_id FROM t_sin_caja)),
  'una caja de otra sucursal no sirve y la conversión no autoabre la correcta'
);
UPDATE public.caja_sesiones
   SET estado='ABIERTA',cerrada_en=NULL,cerrada_por=NULL
 WHERE id='d5200000-0000-4000-8000-000000000002';

CREATE TEMP TABLE t_admin_gp_sale AS
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  (SELECT presupuesto_id FROM t_admin_gp),NULL,'CONTADO',
  '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,NULL
);
SELECT pg_temp.assert_true(
  (SELECT v.sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='GENERALPAZ')
       AND v.caja_sesion_id='d5200000-0000-4000-8000-000000000002'
     FROM public.ventas AS v JOIN t_admin_gp_sale AS s ON s.venta_id=v.id),
  'un admin usa sucursal y caja del presupuesto, no su sucursal de perfil'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5200000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
GRANT SELECT ON t_employee_gp TO authenticated;
SET LOCAL ROLE authenticated;
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  (SELECT presupuesto_id FROM t_employee_gp),NULL,'CONTADO',
  '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,NULL
);
RESET ROLE;
CREATE TEMP TABLE t_employee_gp_sale AS
SELECT p.venta_id,v.cliente_id
  FROM public.presupuestos AS p
  JOIN public.ventas AS v ON v.id=p.venta_id
 WHERE p.id=(SELECT presupuesto_id FROM t_employee_gp);
SELECT pg_temp.assert_true(
  (SELECT v.sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='GENERALPAZ')
       AND v.caja_sesion_id='d5200000-0000-4000-8000-000000000002'
       AND v.usuario_id='a5200000-0000-4000-8000-000000000002'
     FROM public.ventas AS v JOIN t_employee_gp_sale AS s ON s.venta_id=v.id),
  'un empleado autorizado convierte en la caja de su sucursal'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5200000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
CREATE TEMP TABLE t_identificado_sale AS
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  (SELECT presupuesto_id FROM t_identificado),
  'b5200000-0000-4000-8000-000000000001','CTA_CTE','[]'::jsonb,NULL
);
SELECT pg_temp.assert_true(
  (SELECT s.cliente_id='b5200000-0000-4000-8000-000000000001'
       AND v.cliente_id=s.cliente_id
       AND v.condicion_venta='CTA_CTE'
       AND p.cliente_id IS NULL
     FROM t_identificado_sale AS s
     JOIN public.ventas AS v ON v.id=s.venta_id
     JOIN public.presupuestos AS p ON p.id=(SELECT presupuesto_id FROM t_identificado)),
  'cuenta corriente admite sólo el cliente real y conserva el receptor original del presupuesto'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5200000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
DO $$
DECLARE
  v_inexistente text;
  v_fuera_alcance text;
BEGIN
  BEGIN
    PERFORM * FROM public.convertir_presupuesto_en_venta_neutral(
      'f5200000-0000-4000-8000-000000000099',NULL,'CONTADO','[]'::jsonb,NULL
    );
  EXCEPTION WHEN OTHERS THEN v_inexistente:=SQLERRM;
  END;
  BEGIN
    PERFORM * FROM public.convertir_presupuesto_en_venta_neutral(
      (SELECT presupuesto_id FROM t_bola),NULL,'CONTADO','[]'::jsonb,NULL
    );
  EXCEPTION WHEN OTHERS THEN v_fuera_alcance:=SQLERRM;
  END;
  IF v_inexistente IS DISTINCT FROM 'Presupuesto inexistente o sin acceso'
     OR v_fuera_alcance IS DISTINCT FROM v_inexistente THEN
    RAISE EXCEPTION 'FALLO BOLA: inexistente=%, fuera_de_alcance=%',v_inexistente,v_fuera_alcance;
  END IF;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT estado='ABIERTO' AND venta_id IS NULL
     FROM public.presupuestos WHERE id=(SELECT presupuesto_id FROM t_bola)),
  'BOLA usa un mensaje opaco único y no muta el presupuesto'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5200000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
DO $$
DECLARE v_marker constant text := 'T2_UNICIDAD_NO_FALLO';
BEGIN
  BEGIN
    INSERT INTO public.clientes(
      id,razon_social,tipo,activo,es_generico,sucursal_habitual_id,es_obra
    ) VALUES (
      'b5200000-0000-4000-8000-000000000099','T2 SEGUNDO GLOBAL',
      'CONSUMIDOR_FINAL',true,true,NULL,false
    );
    RAISE EXCEPTION '%',v_marker;
  EXCEPTION
    WHEN unique_violation THEN NULL;
    WHEN OTHERS THEN
      IF SQLERRM=v_marker THEN RAISE; END IF;
      RAISE;
  END;
END;
$$;
SELECT pg_temp.assert_true(true,'el índice impide un segundo Consumidor Final global activo');

SELECT pg_temp.assert_true(
  (SELECT count(*)=1
       AND bool_and(p.prosecdef)
       AND bool_and(p.proowner='postgres'::regrole)
       AND bool_and(p.proconfig='{"search_path=\"\""}'::text[])
       AND bool_and(pg_get_function_result(p.oid)=
         'TABLE(venta_id uuid, numero text, es_cta_cte boolean, cliente_id uuid)')
     FROM pg_catalog.pg_proc AS p
     JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='convertir_presupuesto_en_venta_neutral'),
  'la RPC v2 conserva firma única, owner, SECURITY DEFINER, search_path vacío y retorno cerrado'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege('public','public.convertir_presupuesto_en_venta_neutral(uuid,uuid,condicion_venta,jsonb,uuid)','execute')
  AND NOT has_function_privilege('anon','public.convertir_presupuesto_en_venta_neutral(uuid,uuid,condicion_venta,jsonb,uuid)','execute')
  AND has_function_privilege('authenticated','public.convertir_presupuesto_en_venta_neutral(uuid,uuid,condicion_venta,jsonb,uuid)','execute')
  AND has_function_privilege('service_role','public.convertir_presupuesto_en_venta_neutral(uuid,uuid,condicion_venta,jsonb,uuid)','execute'),
  'la RPC revoca PUBLIC/anon y concede sólo authenticated/service_role'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege('public','public._crear_venta_core_20260823(uuid,uuid,tipo_comprobante,condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)','execute')
  AND NOT has_function_privilege('anon','public._crear_venta_core_20260823(uuid,uuid,tipo_comprobante,condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)','execute')
  AND NOT has_function_privilege('authenticated','public._crear_venta_core_20260823(uuid,uuid,tipo_comprobante,condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)','execute')
  AND NOT has_function_privilege('service_role','public._crear_venta_core_20260823(uuid,uuid,tipo_comprobante,condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)','execute')
  AND NOT has_function_privilege('public','public._normalizar_descripcion_item_20260830(text,text,boolean)','execute')
  AND NOT has_function_privilege('anon','public._normalizar_descripcion_item_20260830(text,text,boolean)','execute')
  AND NOT has_function_privilege('authenticated','public._normalizar_descripcion_item_20260830(text,text,boolean)','execute')
  AND NOT has_function_privilege('service_role','public._normalizar_descripcion_item_20260830(text,text,boolean)','execute'),
  'core comercial y normalizador permanecen owner-only'
);
SELECT pg_temp.assert_true(
  to_regprocedure('public.convertir_presupuesto_en_venta(uuid,uuid,tipo_comprobante,condicion_venta,jsonb,uuid)') IS NULL,
  'el conversor legacy sigue retirado'
);

ROLLBACK;
SQL

# Carrera real: el cierre obtiene FOR UPDATE primero. La conversión debe esperar,
# observar la caja cerrada y fallar sin autoabrir una sesión distinta.
LOCK_DIR="$(mktemp -d)"
LOCK_PID=""
cleanup() {
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    kill "$LOCK_PID"
    wait "$LOCK_PID" 2>/dev/null || true
    LOCK_PID=""
  fi
  "${PSQL[@]}" >/dev/null <<'SQL'
BEGIN;
DELETE FROM public.venta_pagos WHERE venta_id IN (
  SELECT venta_id FROM public.presupuestos WHERE id='f5200000-0000-4000-8000-000000000201'
);
DELETE FROM public.stock_movimientos WHERE referencia_id IN (
  SELECT venta_id FROM public.presupuestos WHERE id='f5200000-0000-4000-8000-000000000201'
);
DELETE FROM public.venta_items WHERE venta_id IN (
  SELECT venta_id FROM public.presupuestos WHERE id='f5200000-0000-4000-8000-000000000201'
);
UPDATE public.presupuestos SET estado='ABIERTO',venta_id=NULL
 WHERE id='f5200000-0000-4000-8000-000000000201';
DELETE FROM public.ventas WHERE observaciones='Presupuesto T2-CONC-0001';
DELETE FROM public.presupuesto_items WHERE presupuesto_id='f5200000-0000-4000-8000-000000000201';
DELETE FROM public.presupuestos WHERE id='f5200000-0000-4000-8000-000000000201';
DELETE FROM public.caja_movimientos WHERE caja_sesion_id='d5200000-0000-4000-8000-000000000201';
DELETE FROM public.caja_sesiones WHERE id='d5200000-0000-4000-8000-000000000201';
DELETE FROM public.stock_sucursal WHERE producto_id='c5200000-0000-4000-8000-000000000201';
DELETE FROM public.productos WHERE id='c5200000-0000-4000-8000-000000000201';
UPDATE public.profiles SET sucursal_id=NULL
 WHERE id='a5200000-0000-4000-8000-000000000201';
DELETE FROM public.profile_sucursales WHERE profile_id='a5200000-0000-4000-8000-000000000201';
DELETE FROM public.user_roles WHERE user_id='a5200000-0000-4000-8000-000000000201';
DELETE FROM auth.users WHERE id='a5200000-0000-4000-8000-000000000201';
COMMIT;
SQL
  rm -rf -- "$LOCK_DIR"
}
trap cleanup EXIT

"${PSQL[@]}" <<'SQL'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.caja_sesiones AS cs
    JOIN public.sucursales AS s ON s.id=cs.sucursal_id
    WHERE s.codigo='OHIGGINS' AND cs.estado='ABIERTA'
  ) THEN
    RAISE EXCEPTION 'La prueba concurrente necesita O''Higgins sin caja abierta; ejecutá db reset local';
  END IF;
END;
$$;
INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  'a5200000-0000-4000-8000-000000000201','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','t2-presupuesto-concurrencia@test.local','x',now(),now(),now()
);
UPDATE public.profiles
   SET username='t2_presupuesto_concurrencia',activo=true,
       sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS')
 WHERE id='a5200000-0000-4000-8000-000000000201';
INSERT INTO public.user_roles(user_id,role)
VALUES ('a5200000-0000-4000-8000-000000000201','admin');
INSERT INTO public.profile_sucursales(profile_id,sucursal_id)
SELECT 'a5200000-0000-4000-8000-000000000201',id
  FROM public.sucursales WHERE codigo='OHIGGINS';
INSERT INTO public.productos(id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado)
VALUES ('c5200000-0000-4000-8000-000000000201','T2-CONC','T2 Producto concurrencia',100,21,true,false);
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
SELECT 'c5200000-0000-4000-8000-000000000201',id,10
  FROM public.sucursales WHERE codigo='OHIGGINS';
INSERT INTO public.caja_sesiones(id,sucursal_id,estado,abierta_por,fondo_inicial)
SELECT 'd5200000-0000-4000-8000-000000000201',id,'ABIERTA',
       'a5200000-0000-4000-8000-000000000201',0
  FROM public.sucursales WHERE codigo='OHIGGINS';
INSERT INTO public.presupuestos(
  id,sucursal_id,usuario_id,numero,cliente_id,nombre_cliente,
  subtotal_sin_iva,iva_total,total,estado,observaciones
)
SELECT 'f5200000-0000-4000-8000-000000000201',id,
       'a5200000-0000-4000-8000-000000000201','T2-CONC-0001',NULL,NULL,
       100,21,121,'ABIERTO','T2-CONCURRENCIA'
  FROM public.sucursales WHERE codigo='OHIGGINS';
INSERT INTO public.presupuesto_items(
  presupuesto_id,producto_id,codigo,descripcion,cantidad,
  precio_lista_sin_iva,descuento_porcentaje,precio_sin_iva,
  iva_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
) VALUES (
  'f5200000-0000-4000-8000-000000000201',
  'c5200000-0000-4000-8000-000000000201','T2-CONC','T2 Producto concurrencia',1,
  100,0,100,21,100,21,121
);
SQL

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq \
  >"$LOCK_DIR/cierre.out" 2>"$LOCK_DIR/cierre.err" <<'SQL' &
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5200000-0000-4000-8000-000000000201","role":"authenticated"}',
  true
);
SELECT * FROM public.cerrar_caja(
  'd5200000-0000-4000-8000-000000000201','{"EFECTIVO":0}'::jsonb,
  'T2 cierre concurrente',0
);
SELECT 'T2_CIERRE_LISTO';
SELECT pg_sleep(3);
COMMIT;
SQL
LOCK_PID=$!

for _ in {1..100}; do
  if rg -q 'T2_CIERRE_LISTO' "$LOCK_DIR/cierre.out"; then break; fi
  if ! kill -0 "$LOCK_PID" 2>/dev/null; then
    sed -n '1,120p' "$LOCK_DIR/cierre.err" >&2
    echo 'FALLO: el cierre concurrente terminó antes de tomar el lock' >&2
    exit 1
  fi
  sleep 0.05
done
if ! rg -q 'T2_CIERRE_LISTO' "$LOCK_DIR/cierre.out"; then
  echo 'FALLO: el cierre concurrente no confirmó su lock' >&2
  exit 1
fi

set +e
CONVERSION_OUT="$(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq 2>&1 <<'SQL'
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5200000-0000-4000-8000-000000000201","role":"authenticated"}',
  true
);
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  'f5200000-0000-4000-8000-000000000201',NULL,'CONTADO',
  '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,NULL
);
COMMIT;
SQL
)"
CONVERSION_STATUS=$?
set -e
wait "$LOCK_PID"
LOCK_PID=""

if [[ "$CONVERSION_STATUS" -eq 0 ]] || [[ "$CONVERSION_OUT" != *"caja abierta"* ]]; then
  echo "FALLO: la conversión concurrente no falló por caja cerrada: $CONVERSION_OUT" >&2
  exit 1
fi

"${PSQL[@]}" <<'SQL'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.caja_sesiones AS cs
    JOIN public.sucursales AS s ON s.id=cs.sucursal_id
    WHERE s.codigo='OHIGGINS' AND cs.estado='ABIERTA'
  ) OR EXISTS (
    SELECT 1 FROM public.ventas WHERE observaciones='Presupuesto T2-CONC-0001'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.presupuestos
     WHERE id='f5200000-0000-4000-8000-000000000201'
       AND estado='ABIERTO' AND venta_id IS NULL
  ) THEN
    RAISE EXCEPTION 'FALLO: el cierre concurrente dejó una caja nueva, una venta o un presupuesto convertido';
  END IF;
  RAISE NOTICE '✓ el cierre que gana la carrera no deja venta huérfana ni autoabre otra caja';
END;
$$;
SQL

cleanup
trap - EXIT
echo '✓ presupuesto consumidor final: candidato, caja, replay, BOLA y concurrencia'
