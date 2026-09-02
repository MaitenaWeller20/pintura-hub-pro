#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" <<'SQL'
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_ok boolean,p_message text)
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

SELECT pg_temp.assert_true(
  (SELECT count(*)=1
          AND bool_and(pg_get_function_identity_arguments(p.oid)='')
          AND bool_and(NOT p.prosecdef)
          AND bool_and(p.proconfig = ARRAY['search_path=""']::text[])
     FROM pg_proc AS p
     JOIN pg_namespace AS n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname='bloquear_nota_debito_v2'),
  'el guard ND tiene firma única, SECURITY INVOKER y search_path vacío'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl,acldefault('f',p.proowner))
      ) AS acl
      LEFT JOIN pg_roles AS r ON r.oid=acl.grantee
     WHERE n.nspname='public'
       AND p.proname='bloquear_nota_debito_v2'
       AND acl.privilege_type='EXECUTE'
       AND (acl.grantee=0 OR r.rolname IN ('anon','authenticated','service_role'))
  ),
  'PUBLIC y roles API no ejecutan directamente el guard ND'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1
     FROM pg_trigger AS t
     JOIN pg_class AS c ON c.oid=t.tgrelid
     JOIN pg_namespace AS n ON n.oid=c.relnamespace
    WHERE n.nspname='public'
      AND c.relname='ventas'
      AND t.tgname='bloquear_nota_debito_v2_antes_de_mutar'
      AND NOT t.tgisinternal
      AND t.tgenabled='O'
      AND t.tgfoid='public.bloquear_nota_debito_v2()'::regprocedure
      AND pg_get_triggerdef(t.oid) LIKE
        '%BEFORE INSERT OR UPDATE OF tipo_comprobante ON public.ventas%'),
  'el trigger ND está activo antes de INSERT/UPDATE sobre ventas'
);

INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  'a1300000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','t13-notas@test.local','x',now(),now(),now()
);
UPDATE public.profiles
   SET username='t13_notas',activo=true,
       sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)
 WHERE id='a1300000-0000-4000-8000-000000000001';
INSERT INTO public.user_roles(user_id,role)
VALUES ('a1300000-0000-4000-8000-000000000001','admin');
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a1300000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

INSERT INTO public.clientes(id,razon_social,tipo,condicion_cta_cte,activo)
VALUES (
  'b1300000-0000-4000-8000-000000000001','T13 NOTAS CLIENTE',
  'RESPONSABLE_INSCRIPTO',true,true
);
INSERT INTO public.productos(
  id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado
) VALUES (
  'b1300000-0000-4000-8000-000000000002','T13-NOTAS-PROD',
  'T13 producto para notas',100,21,true,false
);
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
SELECT 'b1300000-0000-4000-8000-000000000002',s.id,10
  FROM public.sucursales AS s ORDER BY s.numero LIMIT 1;
-- Factura histórica mínima usada sólo para probar el cerco de asociación. El
-- writer legacy vigente ya no permite crearla por el trigger de producción.
SET LOCAL session_replication_role=replica;
INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
  estado_pago,observaciones,afip_estado
)
SELECT
  'c1300000-0000-4000-8000-000000000001',s.id,
  'b1300000-0000-4000-8000-000000000001',
  'a1300000-0000-4000-8000-000000000001','T13-ORIGINAL','FACTURA_A',
  'CTA_CTE',100,21,0,121,0,'PENDIENTE','T13-ND-ORIGINAL','PENDIENTE'
FROM public.sucursales AS s ORDER BY s.numero LIMIT 1;
SET LOCAL session_replication_role=origin;

CREATE OR REPLACE FUNCTION pg_temp.huella_comercial_notas()
RETURNS text
LANGUAGE sql
STABLE
SET search_path=''
AS $$
  SELECT pg_catalog.md5(pg_catalog.concat_ws('|',
    (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.ventas AS t),
    (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.venta_items AS t),
    (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.venta_pagos AS t),
    (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.stock_movimientos AS t),
    (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text,'|' ORDER BY t.producto_id,t.sucursal_id),'') FROM public.stock_sucursal AS t),
    (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.caja_movimientos AS t),
    (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.caja_sesiones AS t),
    (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text,'|' ORDER BY t.id),'') FROM public.cuenta_corriente_movimientos AS t),
    (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text,'|' ORDER BY t.sucursal_id,t.tipo),'') FROM public.comprobante_secuencias AS t)
  ));
$$;

CREATE TEMP TABLE t_antes AS
SELECT
  pg_temp.huella_comercial_notas() AS huella,
  (SELECT count(*) FROM public.ventas) AS ventas,
  (SELECT count(*) FROM public.venta_items) AS items,
  (SELECT count(*) FROM public.venta_pagos) AS pagos,
  (SELECT count(*) FROM public.stock_movimientos) AS stock,
  (SELECT count(*) FROM public.caja_movimientos) AS caja,
  (SELECT count(*) FROM public.cuenta_corriente_movimientos) AS deuda,
  (SELECT COALESCE(sum(ultimo_numero),0) FROM public.comprobante_secuencias) AS numeradores;

UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;

SET LOCAL ROLE authenticated;

CREATE TEMP TABLE t_v2_nc_interna AS
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b1300000-0000-4000-8000-000000000001','NOTA_CREDITO','CTA_CTE',
  '[{"producto_id":"b1300000-0000-4000-8000-000000000002","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'T13-NC-V2-INTERNA',NULL,NULL,NULL,
  'd1300000-0000-4000-8000-000000000000'
);

RESET ROLE;
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
      FROM public.ventas AS v
      JOIN t_v2_nc_interna AS creada ON creada.venta_id=v.id
     WHERE v.tipo_comprobante='NOTA_CREDITO'
       AND v.afip_cbte_asoc_id IS NULL
       AND v.afip_estado='NO_APLICA'
       AND v.cae IS NULL
       AND v.afip_numero IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.emision_fiscal_intentos AS e
          WHERE e.venta_id=v.id
       )
  ),
  'v2 permite una NC manual sin factura y la deja estrictamente interna'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
      FROM public.cuenta_corriente_movimientos AS cc
      JOIN t_v2_nc_interna AS creada ON creada.venta_id=cc.venta_id
     WHERE cc.tipo='CREDITO' AND cc.estado='CONFIRMADO'
  ),
  'la NC interna v2 conserva sus efectos comerciales de cuenta corriente'
);

CREATE TEMP TABLE t_despues_nc_interna AS
SELECT
  pg_temp.huella_comercial_notas() AS huella,
  (SELECT count(*) FROM public.ventas) AS ventas,
  (SELECT count(*) FROM public.venta_items) AS items,
  (SELECT count(*) FROM public.venta_pagos) AS pagos,
  (SELECT count(*) FROM public.stock_movimientos) AS stock,
  (SELECT count(*) FROM public.caja_movimientos) AS caja,
  (SELECT count(*) FROM public.cuenta_corriente_movimientos) AS deuda,
  (SELECT COALESCE(sum(ultimo_numero),0) FROM public.comprobante_secuencias) AS numeradores;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.crear_venta(
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b1300000-0000-4000-8000-000000000001','NOTA_CREDITO','CTA_CTE',
      '[{"producto_id":"b1300000-0000-4000-8000-000000000002","cantidad":1}]'::jsonb,
      '[]'::jsonb,0,'T13-NC-V2-ASOCIADA-NO-DEBE-PERSISTIR',NULL,NULL,
      'c1300000-0000-4000-8000-000000000001',
      'd1300000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'FALLO: la RPC aceptó una NC v2 asociada directa';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FALLO:%' THEN RAISE; END IF;
    IF SQLERRM NOT ILIKE '%nota de crédito v2 se crea exclusivamente mediante anular_venta%' THEN
      RAISE EXCEPTION 'FALLO: rechazo NC v2 inesperado: %',SQLERRM;
    END IF;
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.crear_venta(
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b1300000-0000-4000-8000-000000000001','NOTA_DEBITO','CTA_CTE',
      '[{"producto_id":null,"descripcion":"Recargo diferido","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]'::jsonb,
      '[]'::jsonb,0,'T13-ND-NO-DEBE-PERSISTIR',NULL,NULL,
      'c1300000-0000-4000-8000-000000000001',
      'd1300000-0000-4000-8000-000000000002'
    );
    RAISE EXCEPTION 'FALLO: la RPC aceptó una ND durante v2';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FALLO:%' THEN RAISE; END IF;
    IF SQLERRM NOT ILIKE '%nota de débito nueva queda fuera de alcance fiscal%' THEN
      RAISE EXCEPTION 'FALLO: rechazo ND inesperado: %',SQLERRM;
    END IF;
  END;
END;
$$;

RESET ROLE;

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.ventas
     WHERE observaciones IN (
       'T13-NC-V2-ASOCIADA-NO-DEBE-PERSISTIR',
       'T13-ND-NO-DEBE-PERSISTIR'
     )
  ),
  'las llamadas directas no persisten una NC v2 asociada ni una ND'
);
SELECT pg_temp.assert_true(
  (SELECT (a.ventas,a.items,a.pagos,a.stock,a.caja,a.deuda,a.numeradores)
     IS NOT DISTINCT FROM
          ((SELECT count(*) FROM public.ventas),
           (SELECT count(*) FROM public.venta_items),
           (SELECT count(*) FROM public.venta_pagos),
           (SELECT count(*) FROM public.stock_movimientos),
           (SELECT count(*) FROM public.caja_movimientos),
           (SELECT count(*) FROM public.cuenta_corriente_movimientos),
           (SELECT COALESCE(sum(ultimo_numero),0) FROM public.comprobante_secuencias))
     FROM t_despues_nc_interna AS a),
  'los rechazos conservan la NC interna y no agregan efectos comerciales'
);
SELECT pg_temp.assert_true(
  (SELECT huella=pg_temp.huella_comercial_notas() FROM t_despues_nc_interna),
  'NC asociada/ND rechazadas conservan la huella posterior a la NC interna'
);

UPDATE public.settings
   SET facturacion_receptor_v2_enabled=false,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_tipo public.tipo_comprobante;
BEGIN
  FOREACH v_tipo IN ARRAY ARRAY['NOTA_CREDITO','NOTA_DEBITO']::public.tipo_comprobante[]
  LOOP
    BEGIN
      PERFORM * FROM public.crear_venta(
        (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
        'b1300000-0000-4000-8000-000000000001',v_tipo,'CTA_CTE',
        CASE WHEN v_tipo='NOTA_CREDITO'
          THEN '[{"producto_id":"b1300000-0000-4000-8000-000000000002","cantidad":1}]'::jsonb
          ELSE '[{"producto_id":null,"descripcion":"Recargo mantenimiento","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]'::jsonb
        END,
        '[]'::jsonb,0,'T13-NOTA-MANTENIMIENTO-NO-DEBE-PERSISTIR',NULL,NULL,
        'c1300000-0000-4000-8000-000000000001',
        CASE WHEN v_tipo='NOTA_CREDITO'
          THEN 'd1300000-0000-4000-8000-000000000020'::uuid
          ELSE 'd1300000-0000-4000-8000-000000000021'::uuid
        END
      );
      RAISE EXCEPTION 'FALLO: la RPC aceptó % con ambos writers apagados',v_tipo;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'FALLO:%' THEN RAISE; END IF;
      IF SQLERRM NOT ILIKE '%escritor fiscal legacy está deshabilitado%' THEN
        RAISE EXCEPTION 'FALLO: rechazo de mantenimiento inesperado para %: %',v_tipo,SQLERRM;
      END IF;
    END;
  END LOOP;
END;
$$;
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT huella=pg_temp.huella_comercial_notas() FROM t_despues_nc_interna),
  'mantenimiento rechaza notas asociadas sin alterar la NC interna existente'
);

SET LOCAL ROLE authenticated;
CREATE TEMP TABLE t_nc_interna_sin_writer AS
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b1300000-0000-4000-8000-000000000001','NOTA_CREDITO','CTA_CTE',
  '[{"producto_id":"b1300000-0000-4000-8000-000000000002","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'T13-NC-INTERNA-SIN-WRITER',NULL,NULL,NULL,
  'd1300000-0000-4000-8000-000000000010'
);
RESET ROLE;
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
      FROM public.ventas AS v
      JOIN t_nc_interna_sin_writer AS creada ON creada.venta_id=v.id
     WHERE v.afip_cbte_asoc_id IS NULL
       AND v.afip_estado='NO_APLICA'
       AND v.cae IS NULL
  ),
  'la NC interna no depende de que haya un escritor fiscal habilitado'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS c
     WHERE c.conrelid='public.settings'::regclass
       AND c.conname='ck_settings_legacy_writer_retirado'
       AND pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%NOT facturacion_legacy_writer_enabled%'
  ),
  'el writer fiscal legacy permanece retirado; la excepción sólo habilita NC internas'
);

ROLLBACK;
SQL
