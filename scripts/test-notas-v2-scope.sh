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
     FROM pg_proc AS p
     JOIN pg_namespace AS n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname='bloquear_nota_debito_v2'
      AND pg_get_function_identity_arguments(p.oid)=''
      AND NOT p.prosecdef
      AND p.proconfig = ARRAY['search_path=""']::text[]),
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

CREATE TEMP TABLE t_antes AS
SELECT
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

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.crear_venta(
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b1300000-0000-4000-8000-000000000001','NOTA_DEBITO','CTA_CTE',
      '[{"producto_id":null,"descripcion":"Recargo diferido","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]'::jsonb,
      '[]'::jsonb,0,'T13-ND-NO-DEBE-PERSISTIR',NULL,NULL,
      'c1300000-0000-4000-8000-000000000001',
      'd1300000-0000-4000-8000-000000000001'
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

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.ventas WHERE observaciones='T13-ND-NO-DEBE-PERSISTIR'
  ),
  'la llamada directa no persiste una ND'
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
     FROM t_antes AS a),
  'el rechazo conserva venta, ítems, pagos, stock, caja, deuda y numeradores'
);

UPDATE public.settings
   SET facturacion_receptor_v2_enabled=false,
       facturacion_legacy_writer_enabled=true
 WHERE id=true;

CREATE TEMP TABLE t_legacy_nd AS
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b1300000-0000-4000-8000-000000000001','NOTA_DEBITO','CTA_CTE',
  '[{"producto_id":null,"descripcion":"Recargo legacy","cantidad":1,"precio_unitario_sin_iva":100,"iva_porcentaje":21}]'::jsonb,
  '[]'::jsonb,0,'T13-ND-LEGACY-PERMITIDA',NULL,NULL,
  'c1300000-0000-4000-8000-000000000001',
  'd1300000-0000-4000-8000-000000000002'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
      FROM public.ventas AS v
      JOIN t_legacy_nd AS creada ON creada.venta_id=v.id
     WHERE v.tipo_comprobante='NOTA_DEBITO'
       AND v.observaciones='T13-ND-LEGACY-PERMITIDA'
  ),
  'el writer legacy conserva la ND mientras v2 está desactivado'
);

ROLLBACK;
SQL
