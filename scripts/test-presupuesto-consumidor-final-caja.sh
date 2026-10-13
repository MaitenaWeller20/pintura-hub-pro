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

-- Compatibilidad pre-release: este snapshot antecede el límite actual. La
-- conversión debe resolver importes/productos autoritativamente y copiar estos
-- bytes congelados antes de confirmar la transacción.
CREATE TEMP TABLE t_historico_largo AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'),
  '[{"producto_id":"c5200000-0000-4000-8000-000000000001","cantidad":1}]'::jsonb,
  NULL,NULL,NULL,'T2-HISTORICO-LARGO'
);
UPDATE public.presupuesto_items AS i
   SET descripcion='  Histórico  sin normalizar  '||pg_catalog.repeat('😀',170)||E'\t'
  FROM t_historico_largo AS h
 WHERE i.presupuesto_id=h.presupuesto_id;
CREATE TEMP TABLE t_historico_largo_sale AS
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  (SELECT presupuesto_id FROM t_historico_largo),
  'b5200000-0000-4000-8000-000000000001','CTA_CTE','[]'::jsonb,
  'e5200000-0000-4000-8000-000000000090'
);
SELECT pg_temp.assert_true(
  (SELECT vi.descripcion IS NOT DISTINCT FROM pi.descripcion
     FROM t_historico_largo_sale AS s
     JOIN public.venta_items AS vi ON vi.venta_id=s.venta_id
     JOIN public.presupuesto_items AS pi
       ON pi.presupuesto_id=(SELECT presupuesto_id FROM t_historico_largo)
      AND pi.producto_id=vi.producto_id),
  'la conversión copia byte a byte una descripción histórica mayor a 160'
);

-- Regresión de la segunda revisión: un presupuesto pre-release puede contener
-- dos renglones del mismo producto. Cantidad, descuento, importe y descripción
-- identifican cada snapshot; el writer no puede emparejarlos por ubicación
-- física ni calcular la huella antes de copiar sus bytes finales.
CREATE TEMP TABLE t_historico_duplicado AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'),
  '[
    {"producto_id":"c5200000-0000-4000-8000-000000000001","cantidad":2,"descuento_porcentaje":10},
    {"producto_id":"c5200000-0000-4000-8000-000000000001","cantidad":3,"descuento_porcentaje":25}
  ]'::jsonb,
  NULL,NULL,NULL,'T2-HISTORICO-DUPLICADO'
);
UPDATE public.presupuesto_items AS i
   SET descripcion=CASE i.cantidad
     WHEN 2 THEN '  Duplicado largo  '||pg_catalog.repeat('🚀',170)||E'\t'
     WHEN 3 THEN E' \t\n'
   END
 WHERE i.presupuesto_id=(SELECT presupuesto_id FROM t_historico_duplicado);

SELECT pg_temp.assert_true(
  (SELECT count(*)=2
       AND count(*) FILTER (
         WHERE cantidad=2 AND descuento_porcentaje=10
           AND char_length(descripcion)>160
       )=1
       AND count(*) FILTER (
         WHERE cantidad=3 AND descuento_porcentaje=25
           AND descripcion=E' \t\n'
       )=1
     FROM public.presupuesto_items
    WHERE presupuesto_id=(SELECT presupuesto_id FROM t_historico_duplicado)),
  'la fixture conserva duplicados con cantidades, descuentos y descripciones históricas distintas'
);
DO $$
DECLARE v_marker constant text := 'T2_VACIO_NO_FALLO';
BEGIN
  BEGIN
    PERFORM public._normalizar_descripcion_item_20260830(E' \t\n','fallback',true);
    RAISE EXCEPTION '%',v_marker;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM=v_marker OR SQLERRM NOT LIKE '%Ingresá una descripción%' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(true,'el segundo snapshot histórico normaliza a vacío bajo el contrato actual');

CREATE TEMP TABLE t_historico_duplicado_final AS
SELECT pg_catalog.jsonb_agg(
         pg_catalog.jsonb_build_object(
           'producto_id',i.producto_id,
           'cantidad',i.cantidad,
           'precio_unitario_sin_iva',i.precio_sin_iva,
           'descuento_porcentaje',0,
           'descripcion',i.descripcion
         )
         ORDER BY i.id
       ) AS items
  FROM public.presupuesto_items AS i
 WHERE i.presupuesto_id=(SELECT presupuesto_id FROM t_historico_duplicado);

CREATE TEMP TABLE t_historico_duplicado_sale AS
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  (SELECT presupuesto_id FROM t_historico_duplicado),
  'b5200000-0000-4000-8000-000000000001','CTA_CTE','[]'::jsonb,
  'e5200000-0000-4000-8000-000000000091'
);

SELECT pg_temp.assert_true(
  (SELECT count(*)=2
       AND count(*) FILTER (
         WHERE vi.cantidad=2
           AND vi.precio_unitario_sin_iva=90
           AND vi.descripcion='  Duplicado largo  '||pg_catalog.repeat('🚀',170)||E'\t'
       )=1
       AND count(*) FILTER (
         WHERE vi.cantidad=3
           AND vi.precio_unitario_sin_iva=75
           AND vi.descripcion=E' \t\n'
       )=1
     FROM public.venta_items AS vi
    WHERE vi.venta_id=(SELECT venta_id FROM t_historico_duplicado_sale)),
  'cada duplicado llega a su venta_item exacto por identidad comercial'
);

CREATE TEMP TABLE t_historico_duplicado_hash AS
SELECT pg_catalog.encode(
         extensions.digest(
           pg_catalog.convert_to(
             pg_catalog.jsonb_build_object(
               'version',1,
               'actor_id','a5200000-0000-4000-8000-000000000001'::uuid,
               'sucursal_id',p.sucursal_id,
               'cliente_id','b5200000-0000-4000-8000-000000000001'::uuid,
               'tipo_comprobante','VENTA'::public.tipo_comprobante,
               'condicion_venta','CTA_CTE'::public.condicion_venta,
               'items',f.items,
               'pagos','[]'::jsonb,
               'percepciones',0::numeric,
               'observaciones','Presupuesto '||p.numero,
               'nombre_obra',NULL::text,
               'fecha',NULL::timestamptz,
               'cbte_asoc_id',NULL::uuid,
               'idempotency_key',pg_catalog.md5('presupuesto:'||p.id::text)::uuid
             )::text,
             'UTF8'
           ),
           'sha256'
         ),
         'hex'
       ) AS hash
  FROM public.presupuestos AS p
 CROSS JOIN t_historico_duplicado_final AS f
 WHERE p.id=(SELECT presupuesto_id FROM t_historico_duplicado);
SELECT pg_temp.assert_true(
  (SELECT v.idempotency_payload_hash=h.hash
     FROM public.ventas AS v
     CROSS JOIN t_historico_duplicado_hash AS h
    WHERE v.id=(SELECT venta_id FROM t_historico_duplicado_sale)),
  'ventas.idempotency_payload_hash representa los valores y bytes finales persistidos'
);

CREATE TEMP TABLE t_historico_duplicado_effects AS
SELECT
  (SELECT count(*) FROM public.ventas) AS ventas,
  (SELECT count(*) FROM public.venta_items) AS items,
  (SELECT count(*) FROM public.venta_pagos) AS pagos,
  (SELECT count(*) FROM public.stock_movimientos) AS stock_movimientos,
  (SELECT count(*) FROM public.caja_movimientos) AS caja_movimientos,
  (SELECT count(*) FROM public.cuenta_corriente_movimientos) AS cuenta_corriente,
  (SELECT COALESCE(sum(ultimo_numero),0) FROM public.comprobante_secuencias) AS secuencias,
  (SELECT cantidad FROM public.stock_sucursal
    WHERE producto_id='c5200000-0000-4000-8000-000000000001'
      AND sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS')) AS stock;

CREATE TEMP TABLE t_historico_duplicado_replay AS
SELECT * FROM public.crear_venta(
  (SELECT sucursal_id FROM public.presupuestos
    WHERE id=(SELECT presupuesto_id FROM t_historico_duplicado)),
  'b5200000-0000-4000-8000-000000000001','VENTA','CTA_CTE',
  (SELECT items FROM t_historico_duplicado_final),'[]'::jsonb,0,
  (SELECT 'Presupuesto '||numero FROM public.presupuestos
    WHERE id=(SELECT presupuesto_id FROM t_historico_duplicado)),
  NULL,NULL,NULL,
  (SELECT pg_catalog.md5('presupuesto:'||presupuesto_id::text)::uuid
     FROM t_historico_duplicado)
);
SELECT pg_temp.assert_true(
  (SELECT r.venta_id=s.venta_id
     FROM t_historico_duplicado_replay AS r
     CROSS JOIN t_historico_duplicado_sale AS s),
  'el replay público con descripciones históricas finales exactas recupera la venta'
);

DO $$
DECLARE
  v_items jsonb := (SELECT items FROM t_historico_duplicado_final);
  v_marker constant text := 'T2_HASH_DESCRIPCION_NO_FALLO';
  v_sucursal uuid := (SELECT sucursal_id FROM public.presupuestos
    WHERE id=(SELECT presupuesto_id FROM t_historico_duplicado));
  v_observaciones text := (SELECT 'Presupuesto '||numero FROM public.presupuestos
    WHERE id=(SELECT presupuesto_id FROM t_historico_duplicado));
  v_key uuid := (SELECT pg_catalog.md5('presupuesto:'||presupuesto_id::text)::uuid
    FROM t_historico_duplicado);
BEGIN
  BEGIN
    PERFORM * FROM public.crear_venta(
      v_sucursal,'b5200000-0000-4000-8000-000000000001','VENTA','CTA_CTE',
      pg_catalog.jsonb_set(v_items,'{0,descripcion}',pg_catalog.to_jsonb('distinta'::text),false),
      '[]'::jsonb,0,v_observaciones,NULL,NULL,NULL,v_key
    );
    RAISE EXCEPTION '%',v_marker;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM=v_marker OR SQLERRM NOT LIKE '%clave de idempotencia no corresponde%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM * FROM public.crear_venta(
      v_sucursal,'b5200000-0000-4000-8000-000000000001','VENTA','CTA_CTE',
      v_items #- '{0,descripcion}','[]'::jsonb,0,v_observaciones,NULL,NULL,NULL,v_key
    );
    RAISE EXCEPTION '%',v_marker;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM=v_marker OR SQLERRM NOT LIKE '%clave de idempotencia no corresponde%' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT b IS NOT DISTINCT FROM a
     FROM t_historico_duplicado_effects AS b
     CROSS JOIN LATERAL (
       SELECT
         (SELECT count(*) FROM public.ventas) AS ventas,
         (SELECT count(*) FROM public.venta_items) AS items,
         (SELECT count(*) FROM public.venta_pagos) AS pagos,
         (SELECT count(*) FROM public.stock_movimientos) AS stock_movimientos,
         (SELECT count(*) FROM public.caja_movimientos) AS caja_movimientos,
         (SELECT count(*) FROM public.cuenta_corriente_movimientos) AS cuenta_corriente,
         (SELECT COALESCE(sum(ultimo_numero),0) FROM public.comprobante_secuencias) AS secuencias,
         (SELECT cantidad FROM public.stock_sucursal
           WHERE producto_id='c5200000-0000-4000-8000-000000000001'
             AND sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS')) AS stock
     ) AS a),
  'replay exacto y conflictos de descripción no duplican ningún efecto comercial'
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
CREATE TEMP TABLE t_sin_caja_sale AS
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  (SELECT presupuesto_id FROM t_sin_caja),NULL,'CONTADO',
  '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,NULL
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM public.caja_sesiones AS cs
    JOIN public.sucursales AS s ON s.id=cs.sucursal_id
   WHERE s.codigo='GENERALPAZ' AND cs.estado='ABIERTA')
  AND (SELECT count(*)=1 FROM public.caja_sesiones AS cs
       JOIN public.sucursales AS s ON s.id=cs.sucursal_id
      WHERE s.codigo='OHIGGINS' AND cs.estado='ABIERTA')
  AND (SELECT p.estado='CONVERTIDO'
              AND p.venta_id=sale.venta_id
              AND v.caja_sesion_id=cs.id
              AND cs.abierta_por='a5200000-0000-4000-8000-000000000001'
         FROM public.presupuestos AS p
         CROSS JOIN t_sin_caja_sale AS sale
         JOIN public.ventas AS v ON v.id=sale.venta_id
         JOIN public.caja_sesiones AS cs ON cs.id=v.caja_sesion_id
        WHERE p.id=(SELECT presupuesto_id FROM t_sin_caja)
          AND cs.sucursal_id=p.sucursal_id
          AND cs.estado='ABIERTA'),
  'la primera conversión abre una sola caja en la sucursal del presupuesto y queda vinculada'
);
UPDATE public.caja_sesiones AS cs
   SET estado='CERRADA',cerrada_en=now(),
       cerrada_por='a5200000-0000-4000-8000-000000000001'
 WHERE cs.estado='ABIERTA'
   AND cs.sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='GENERALPAZ');
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
  NOT has_function_privilege('public','public.caja_sesion_actual(uuid)','execute')
  AND NOT has_function_privilege('anon','public.caja_sesion_actual(uuid)','execute')
  AND NOT has_function_privilege('authenticated','public.caja_sesion_actual(uuid)','execute')
  AND has_function_privilege('service_role','public.caja_sesion_actual(uuid)','execute'),
  'el helper de apertura automática permanece interno para los clientes'
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
  (SELECT count(*)=1
       AND bool_and(p.proowner='postgres'::regrole)
       AND bool_and(p.proconfig='{"search_path=\"\""}'::text[])
       AND bool_and(NOT has_function_privilege('public',p.oid,'execute'))
       AND bool_and(NOT has_function_privilege('anon',p.oid,'execute'))
       AND bool_and(NOT has_function_privilege('authenticated',p.oid,'execute'))
       AND bool_and(NOT has_function_privilege('service_role',p.oid,'execute'))
     FROM pg_catalog.pg_proc AS p
     JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname='_crear_venta_desde_presupuesto_20260830'),
  'el writer histórico especializado permanece owner-only'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2
       AND bool_and(pg_catalog.strpos(
         pg_catalog.lower(pg_catalog.pg_get_functiondef(p.oid)),
         'ctid'
       )=0)
     FROM pg_catalog.pg_proc AS p
     JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname IN (
        'convertir_presupuesto_en_venta_neutral',
        '_crear_venta_desde_presupuesto_20260830'
      )),
  'conversión y writer owner-only no dependen de ctid'
);
SELECT pg_temp.assert_true(
  to_regprocedure('public.convertir_presupuesto_en_venta(uuid,uuid,tipo_comprobante,condicion_venta,jsonb,uuid)') IS NULL,
  'el conversor legacy sigue retirado'
);

ROLLBACK;
SQL

SECUENCIAS_BEFORE="$("${PSQL[@]}" -Atq -c "
  SELECT COALESCE(
    jsonb_agg(to_jsonb(cs) ORDER BY cs.sucursal_id,cs.tipo),
    '[]'::jsonb
  )::text
    FROM public.comprobante_secuencias AS cs
")"

# Fixtures comprometidos para observar locks entre sesiones reales. Cada carrera
# usa un presupuesto distinto para que una conversión previa no tome el replay.
LOCK_DIR="$(mktemp -d)"
LOCK_PID=""
CONVERSION_PID=""
IDENTIFIED_PID=""
DIRECT_PID=""
cleanup() {
  if [[ -n "$DIRECT_PID" ]] && kill -0 "$DIRECT_PID" 2>/dev/null; then
    kill "$DIRECT_PID"
    wait "$DIRECT_PID" 2>/dev/null || true
    DIRECT_PID=""
  fi
  if [[ -n "$CONVERSION_PID" ]] && kill -0 "$CONVERSION_PID" 2>/dev/null; then
    kill "$CONVERSION_PID"
    wait "$CONVERSION_PID" 2>/dev/null || true
    CONVERSION_PID=""
  fi
  if [[ -n "$IDENTIFIED_PID" ]] && kill -0 "$IDENTIFIED_PID" 2>/dev/null; then
    kill "$IDENTIFIED_PID"
    wait "$IDENTIFIED_PID" 2>/dev/null || true
    IDENTIFIED_PID=""
  fi
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    kill "$LOCK_PID"
    wait "$LOCK_PID" 2>/dev/null || true
    LOCK_PID=""
  fi
  "${PSQL[@]}" >/dev/null <<'SQL'
BEGIN;
DROP TRIGGER IF EXISTS aaa_t2_pausar_venta_directa ON public.ventas;
DROP FUNCTION IF EXISTS public._t2_pausar_venta_directa_20260830();
UPDATE public.settings
   SET facturacion_receptor_v2_enabled=false,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;
CREATE TEMP TABLE t2_cleanup_budgets ON COMMIT DROP AS
SELECT id,venta_id FROM public.presupuestos
 WHERE id=ANY(ARRAY[
   'f5200000-0000-4000-8000-000000000201',
   'f5200000-0000-4000-8000-000000000202',
   'f5200000-0000-4000-8000-000000000203',
   'f5200000-0000-4000-8000-000000000204'
 ]::uuid[]);
CREATE TEMP TABLE t2_cleanup_sales ON COMMIT DROP AS
SELECT venta_id AS id FROM t2_cleanup_budgets WHERE venta_id IS NOT NULL
UNION
SELECT id FROM public.ventas WHERE observaciones='T2-DIRECTA-LOCK';
DELETE FROM public.venta_pagos
 WHERE venta_id IN (SELECT id FROM t2_cleanup_sales);
DELETE FROM public.stock_movimientos
 WHERE referencia_id IN (SELECT id FROM t2_cleanup_sales);
DELETE FROM public.venta_items
 WHERE venta_id IN (SELECT id FROM t2_cleanup_sales);
UPDATE public.presupuestos
   SET estado='ABIERTO',venta_id=NULL,conversion_payload_hash=NULL
 WHERE id IN (SELECT id FROM t2_cleanup_budgets);
DELETE FROM public.ventas WHERE id IN (SELECT id FROM t2_cleanup_sales);
DELETE FROM public.presupuesto_items
 WHERE presupuesto_id IN (SELECT id FROM t2_cleanup_budgets);
DELETE FROM public.presupuestos
 WHERE id IN (SELECT id FROM t2_cleanup_budgets);
DELETE FROM public.caja_movimientos WHERE caja_sesion_id='d5200000-0000-4000-8000-000000000201';
DELETE FROM public.caja_sesiones WHERE id='d5200000-0000-4000-8000-000000000201';
DELETE FROM public.stock_sucursal WHERE producto_id='c5200000-0000-4000-8000-000000000201';
DELETE FROM public.productos WHERE id='c5200000-0000-4000-8000-000000000201';
DELETE FROM public.clientes WHERE id='b5200000-0000-4000-8000-000000000201';
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
UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;
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
SELECT 'c5200000-0000-4000-8000-000000000201',id,20
  FROM public.sucursales WHERE codigo='OHIGGINS';
INSERT INTO public.clientes(
  id,razon_social,tipo,condicion_cta_cte,limite_credito,activo,
  es_generico,sucursal_habitual_id,es_obra
) VALUES (
  'b5200000-0000-4000-8000-000000000201','T2 CLIENTE CONCURRENCIA',
  'MONOTRIBUTISTA',false,NULL,true,false,NULL,false
);
INSERT INTO public.caja_sesiones(id,sucursal_id,estado,abierta_por,fondo_inicial)
SELECT 'd5200000-0000-4000-8000-000000000201',id,'ABIERTA',
       'a5200000-0000-4000-8000-000000000201',0
  FROM public.sucursales WHERE codigo='OHIGGINS';
INSERT INTO public.presupuestos(
  id,sucursal_id,usuario_id,numero,cliente_id,nombre_cliente,
  subtotal_sin_iva,iva_total,total,estado,observaciones
)
SELECT fixture.presupuesto_id,s.id,
       'a5200000-0000-4000-8000-000000000201',fixture.numero,
       fixture.cliente_id,fixture.nombre_cliente,
       100,21,121,'ABIERTO',fixture.observaciones
  FROM public.sucursales AS s
 CROSS JOIN (
   VALUES
     ('f5200000-0000-4000-8000-000000000201'::uuid,'T2-CONC-0001',
      NULL::uuid,NULL::text,'T2-CANDIDATO-ANONIMO'),
     ('f5200000-0000-4000-8000-000000000202'::uuid,'T2-CONC-0002',
      'b5200000-0000-4000-8000-000000000201'::uuid,'T2 CLIENTE CONCURRENCIA','T2-CLIENTE-IDENTIFICADO'),
     ('f5200000-0000-4000-8000-000000000203'::uuid,'T2-CONC-0003',
      NULL::uuid,NULL::text,'T2-ORDEN-LOCKS'),
     ('f5200000-0000-4000-8000-000000000204'::uuid,'T2-CONC-0004',
      NULL::uuid,NULL::text,'T2-CIERRE-CAJA')
 ) AS fixture(presupuesto_id,numero,cliente_id,nombre_cliente,observaciones)
 WHERE s.codigo='OHIGGINS';
INSERT INTO public.presupuesto_items(
  presupuesto_id,producto_id,codigo,descripcion,cantidad,
  precio_lista_sin_iva,descuento_porcentaje,precio_sin_iva,
  iva_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
)
SELECT fixture.presupuesto_id,
       'c5200000-0000-4000-8000-000000000201','T2-CONC',fixture.descripcion,1,
       100,0,100,21,100,21,121
  FROM (
    VALUES
      ('f5200000-0000-4000-8000-000000000201'::uuid,'T2 candidato anónimo'),
      ('f5200000-0000-4000-8000-000000000202'::uuid,'T2 cliente identificado'),
      ('f5200000-0000-4000-8000-000000000203'::uuid,'T2 orden de locks'),
      ('f5200000-0000-4000-8000-000000000204'::uuid,'T2 cierre concurrente')
  ) AS fixture(presupuesto_id,descripcion);
SQL

expect_client_mutation_blocked() {
  local label="$1"
  local client_id="$2"
  local assignment="$3"
  local mutation_out
  local mutation_status

  set +e
  mutation_out="$("${PSQL[@]}" -Atq -c "
    BEGIN;
    SET LOCAL statement_timeout='250ms';
    UPDATE public.clientes SET ${assignment} WHERE id='${client_id}';
    ROLLBACK;
  " 2>&1)"
  mutation_status=$?
  set -e

  if [[ "$mutation_status" -eq 0 ]] || [[ "$mutation_out" != *"statement timeout"* ]]; then
    echo "FALLO: ${label} se adelantó a la conversión: ${mutation_out}" >&2
    exit 1
  fi
  echo "✓ ${label} espera a que termine la conversión"
}

# Dos conversiones se detienen juntas sobre productos después de elegir sus
# receptores. El UPDATE multicolumna prueba toda la elegibilidad en un lock.
docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq \
  >"$LOCK_DIR/producto-holder.out" 2>"$LOCK_DIR/producto-holder.err" <<'SQL' &
BEGIN;
LOCK TABLE public.productos IN ACCESS EXCLUSIVE MODE;
SELECT 'T2_PRODUCTO_LOCK_LISTO';
SELECT pg_sleep(6);
COMMIT;
SQL
LOCK_PID=$!

for _ in {1..100}; do
  if rg -q 'T2_PRODUCTO_LOCK_LISTO' "$LOCK_DIR/producto-holder.out"; then break; fi
  sleep 0.05
done
if ! rg -q 'T2_PRODUCTO_LOCK_LISTO' "$LOCK_DIR/producto-holder.out"; then
  echo 'FALLO: no se pudo detener la conversión sobre productos' >&2
  exit 1
fi

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq \
  >"$LOCK_DIR/conversion-candidato.out" 2>"$LOCK_DIR/conversion-candidato.err" <<'SQL' &
BEGIN;
SET application_name='t2_conversion_candidato_anonimo';
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5200000-0000-4000-8000-000000000201","role":"authenticated"}',
  true
);
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  'f5200000-0000-4000-8000-000000000201',NULL,'CONTADO',
  '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,NULL
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.presupuestos AS p
      JOIN public.ventas AS v ON v.id=p.venta_id
     WHERE p.id='f5200000-0000-4000-8000-000000000201'
       AND p.estado='CONVERTIDO' AND p.cliente_id IS NULL
       AND v.caja_sesion_id='d5200000-0000-4000-8000-000000000201'
       AND v.cliente_id=(
         SELECT c.id FROM public.clientes AS c
          WHERE c.activo AND c.es_generico AND c.tipo='CONSUMIDOR_FINAL'
            AND c.sucursal_habitual_id IS NULL AND NOT COALESCE(c.es_obra,false)
       )
  ) THEN
    RAISE EXCEPTION 'FALLO: la conversión anónima no confirmó receptor y caja dentro del worker';
  END IF;
END;
$$;
ROLLBACK;
SQL
CONVERSION_PID=$!

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq \
  >"$LOCK_DIR/conversion-identificada.out" 2>"$LOCK_DIR/conversion-identificada.err" <<'SQL' &
BEGIN;
SET application_name='t2_conversion_cliente_identificado';
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5200000-0000-4000-8000-000000000201","role":"authenticated"}',
  true
);
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  'f5200000-0000-4000-8000-000000000202',
  'b5200000-0000-4000-8000-000000000201','CONTADO',
  '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,NULL
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.presupuestos AS p
      JOIN public.ventas AS v ON v.id=p.venta_id
     WHERE p.id='f5200000-0000-4000-8000-000000000202'
       AND p.estado='CONVERTIDO'
       AND p.cliente_id='b5200000-0000-4000-8000-000000000201'
       AND v.cliente_id='b5200000-0000-4000-8000-000000000201'
       AND v.caja_sesion_id='d5200000-0000-4000-8000-000000000201'
  ) THEN
    RAISE EXCEPTION 'FALLO: la conversión identificada no confirmó receptor y caja dentro del worker';
  END IF;
END;
$$;
ROLLBACK;
SQL
IDENTIFIED_PID=$!

CONVERSION_WAITING="f"
for _ in {1..100}; do
  CONVERSION_WAITING="$("${PSQL[@]}" -Atq -c \
    "SELECT count(*)=2 FROM pg_stat_activity WHERE application_name IN ('t2_conversion_candidato_anonimo','t2_conversion_cliente_identificado') AND wait_event_type='Lock'")"
  if [[ "$CONVERSION_WAITING" == "t" ]]; then break; fi
  sleep 0.05
done
if [[ "$CONVERSION_WAITING" != "t" ]]; then
  echo 'FALLO: las conversiones no llegaron al lock posterior a sus clientes' >&2
  exit 1
fi

GLOBAL_CF_ID="$("${PSQL[@]}" -Atq -c "
  SELECT id FROM public.clientes
   WHERE activo AND es_generico AND tipo='CONSUMIDOR_FINAL'
     AND sucursal_habitual_id IS NULL AND NOT COALESCE(es_obra,false)
")"
expect_client_mutation_blocked \
  'elegibilidad completa del candidato anónimo' "$GLOBAL_CF_ID" \
  "es_generico=false,tipo='MONOTRIBUTISTA',sucursal_habitual_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'),es_obra=true,activo=false"
expect_client_mutation_blocked \
  'elegibilidad del cliente identificado' \
  'b5200000-0000-4000-8000-000000000201' 'es_generico=true,activo=false'

wait "$LOCK_PID"
LOCK_PID=""
if ! wait "$CONVERSION_PID"; then
  CONVERSION_PID=""
  sed -n '1,160p' "$LOCK_DIR/conversion-candidato.err" >&2
  echo 'FALLO: la conversión anónima no terminó luego de liberar productos' >&2
  exit 1
fi
CONVERSION_PID=""
if ! wait "$IDENTIFIED_PID"; then
  IDENTIFIED_PID=""
  sed -n '1,160p' "$LOCK_DIR/conversion-identificada.err" >&2
  echo 'FALLO: la conversión identificada no terminó luego de liberar productos' >&2
  exit 1
fi
IDENTIFIED_PID=""
echo '✓ ambos receptores quedan elegibles hasta completar sus conversiones'

# Hook local y descartable: la venta directa ya tomó FOR UPDATE sobre producto,
# pero todavía no llegó al trigger que toma advisory/fila de caja. Esto vuelve
# determinista la inversión directa producto→caja vs conversión caja→producto.
"${PSQL[@]}" <<'SQL'
CREATE FUNCTION public._t2_pausar_venta_directa_20260830()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
BEGIN
  IF NEW.observaciones='T2-DIRECTA-LOCK' THEN
    RAISE NOTICE 'T2_DIRECTA_PRODUCTO_LISTO';
    PERFORM pg_catalog.pg_sleep(4);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._t2_pausar_venta_directa_20260830()
  FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER aaa_t2_pausar_venta_directa
  BEFORE INSERT ON public.ventas
  FOR EACH ROW
  EXECUTE FUNCTION public._t2_pausar_venta_directa_20260830();
SQL

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq \
  >"$LOCK_DIR/venta-directa.out" 2>"$LOCK_DIR/venta-directa.err" <<'SQL' &
BEGIN;
SET application_name='t2_venta_directa_orden_locks';
SET LOCAL deadlock_timeout='200ms';
SET LOCAL lock_timeout='10s';
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5200000-0000-4000-8000-000000000201","role":"authenticated"}',
  true
);
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'),
  'b5200000-0000-4000-8000-000000000201','VENTA','CONTADO',
  '[{"producto_id":"c5200000-0000-4000-8000-000000000201","cantidad":1,"precio_unitario_sin_iva":100,"descripcion":"T2 venta directa"}]'::jsonb,
  '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,
  0,'T2-DIRECTA-LOCK',NULL,NULL,NULL,
  'e5200000-0000-4000-8000-000000000203'
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ventas AS v
     WHERE v.observaciones='T2-DIRECTA-LOCK'
       AND v.cliente_id='b5200000-0000-4000-8000-000000000201'
       AND v.caja_sesion_id='d5200000-0000-4000-8000-000000000201'
  ) OR (SELECT cantidad FROM public.stock_sucursal
         WHERE producto_id='c5200000-0000-4000-8000-000000000201'
           AND sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'))<>19
     OR NOT EXISTS (
       SELECT 1 FROM public.presupuestos
        WHERE id='f5200000-0000-4000-8000-000000000203'
          AND estado='ABIERTO' AND venta_id IS NULL
     ) THEN
    RAISE EXCEPTION 'FALLO: la venta directa no confirmó caja, stock y aislamiento dentro del worker';
  END IF;
END;
$$;
ROLLBACK;
SQL
DIRECT_PID=$!

for _ in {1..100}; do
  if rg -q 'T2_DIRECTA_PRODUCTO_LISTO' \
    "$LOCK_DIR/venta-directa.out" "$LOCK_DIR/venta-directa.err"; then
    break
  fi
  if ! kill -0 "$DIRECT_PID" 2>/dev/null; then
    sed -n '1,160p' "$LOCK_DIR/venta-directa.err" >&2
    echo 'FALLO: la venta directa terminó antes de exponer el lock de producto' >&2
    exit 1
  fi
  sleep 0.05
done
if ! rg -q 'T2_DIRECTA_PRODUCTO_LISTO' \
  "$LOCK_DIR/venta-directa.out" "$LOCK_DIR/venta-directa.err"; then
  echo 'FALLO: la venta directa no confirmó el lock de producto' >&2
  exit 1
fi

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq \
  >"$LOCK_DIR/conversion-orden-locks.out" \
  2>"$LOCK_DIR/conversion-orden-locks.err" <<'SQL' &
BEGIN;
SET application_name='t2_conversion_orden_locks';
SET LOCAL deadlock_timeout='200ms';
SET LOCAL lock_timeout='10s';
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5200000-0000-4000-8000-000000000201","role":"authenticated"}',
  true
);
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  'f5200000-0000-4000-8000-000000000203',NULL,'CONTADO',
  '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,NULL
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.presupuestos AS p
      JOIN public.ventas AS v ON v.id=p.venta_id
     WHERE p.id='f5200000-0000-4000-8000-000000000203'
       AND p.estado='CONVERTIDO' AND p.cliente_id IS NULL
       AND v.caja_sesion_id='d5200000-0000-4000-8000-000000000201'
  ) OR (SELECT cantidad FROM public.stock_sucursal
         WHERE producto_id='c5200000-0000-4000-8000-000000000201'
           AND sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'))<>19
     OR (SELECT count(*) FROM public.caja_sesiones AS cs
          JOIN public.sucursales AS s ON s.id=cs.sucursal_id
         WHERE s.codigo='OHIGGINS' AND cs.estado='ABIERTA')<>1 THEN
    RAISE EXCEPTION 'FALLO: la conversión no confirmó presupuesto, caja y stock dentro del worker';
  END IF;
END;
$$;
ROLLBACK;
SQL
CONVERSION_PID=$!

CONVERSION_WAITING="f"
for _ in {1..100}; do
  CONVERSION_WAITING="$("${PSQL[@]}" -Atq -c \
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name='t2_conversion_orden_locks' AND wait_event_type='Lock')")"
  if [[ "$CONVERSION_WAITING" == "t" ]]; then break; fi
  if ! kill -0 "$CONVERSION_PID" 2>/dev/null; then break; fi
  sleep 0.05
done
if [[ "$CONVERSION_WAITING" != "t" ]]; then
  sed -n '1,160p' "$LOCK_DIR/conversion-orden-locks.err" >&2
  echo 'FALLO: la conversión no llegó al lock de producto durante la venta directa' >&2
  exit 1
fi

set +e
wait "$DIRECT_PID"
DIRECT_STATUS=$?
DIRECT_PID=""
wait "$CONVERSION_PID"
CONVERSION_STATUS=$?
CONVERSION_PID=""
set -e
if [[ "$DIRECT_STATUS" -ne 0 ]] || [[ "$CONVERSION_STATUS" -ne 0 ]]; then
  echo 'FALLO: venta directa y conversión no completaron; posible deadlock caja/producto' >&2
  sed -n '1,160p' "$LOCK_DIR/venta-directa.err" >&2
  sed -n '1,160p' "$LOCK_DIR/conversion-orden-locks.err" >&2
  exit 1
fi

"${PSQL[@]}" <<'SQL'
DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.ventas
        WHERE observaciones IN ('T2-DIRECTA-LOCK','Presupuesto T2-CONC-0003')
     ) OR NOT EXISTS (
       SELECT 1 FROM public.presupuestos
        WHERE id='f5200000-0000-4000-8000-000000000203'
          AND estado='ABIERTO' AND venta_id IS NULL AND cliente_id IS NULL
     )
     OR (SELECT count(*) FROM public.caja_sesiones AS cs
          JOIN public.sucursales AS s ON s.id=cs.sucursal_id
         WHERE s.codigo='OHIGGINS' AND cs.estado='ABIERTA')<>1
     OR (SELECT cantidad FROM public.stock_sucursal
          WHERE producto_id='c5200000-0000-4000-8000-000000000201'
            AND sucursal_id=(SELECT id FROM public.sucursales WHERE codigo='OHIGGINS'))<>20 THEN
    RAISE EXCEPTION 'FALLO: los workers con rollback dejaron venta, presupuesto, caja o stock persistente';
  END IF;
  RAISE NOTICE '✓ venta directa y conversión terminan sin deadlock y revierten sus efectos';
END;
$$;
DROP TRIGGER aaa_t2_pausar_venta_directa ON public.ventas;
DROP FUNCTION public._t2_pausar_venta_directa_20260830();
SQL

# Si cerrar_caja obtiene FOR UPDATE primero, la conversión debe esperar al cierre
# y después abrir una sesión nueva dentro de su propia transacción.
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
  'f5200000-0000-4000-8000-000000000204',NULL,'CONTADO',
  '[{"forma_pago":"EFECTIVO","monto":121}]'::jsonb,NULL
);
ROLLBACK;
SQL
)"
CONVERSION_STATUS=$?
set -e
wait "$LOCK_PID"
LOCK_PID=""

if [[ "$CONVERSION_STATUS" -ne 0 ]] || [[ "$CONVERSION_OUT" != *"OHI-VTA-"* ]]; then
  echo "FALLO: la conversión no esperó el cierre y autoabrió la caja siguiente: $CONVERSION_OUT" >&2
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
    SELECT 1 FROM public.ventas WHERE observaciones='Presupuesto T2-CONC-0004'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.presupuestos
     WHERE id='f5200000-0000-4000-8000-000000000204'
       AND estado='ABIERTO' AND venta_id IS NULL
  ) THEN
    RAISE EXCEPTION 'FALLO: el rollback concurrente dejó una caja nueva, una venta o un presupuesto convertido';
  END IF;
  RAISE NOTICE '✓ la conversión espera al cierre, autoabre la caja siguiente y revierte todos sus efectos';
END;
$$;
SQL

cleanup
trap - EXIT

SECUENCIAS_AFTER="$("${PSQL[@]}" -Atq -c "
  SELECT COALESCE(
    jsonb_agg(to_jsonb(cs) ORDER BY cs.sucursal_id,cs.tipo),
    '[]'::jsonb
  )::text
    FROM public.comprobante_secuencias AS cs
")"
if [[ "$SECUENCIAS_AFTER" != "$SECUENCIAS_BEFORE" ]]; then
  echo "FALLO: la concurrencia alteró comprobante_secuencias" >&2
  echo "antes:   $SECUENCIAS_BEFORE" >&2
  echo "después: $SECUENCIAS_AFTER" >&2
  exit 1
fi
echo '✓ los workers concurrentes no alteran comprobante_secuencias'
echo '✓ presupuesto consumidor final: candidato, caja, replay, BOLA y concurrencia'
