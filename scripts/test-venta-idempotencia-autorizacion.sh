#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)

USUARIO_PROPIO="a4170000-0000-4000-8000-000000000001"
USUARIO_AJENO="a4170000-0000-4000-8000-000000000002"
CLIENTE_ID="b4170000-0000-4000-8000-000000000001"
PRODUCTO_ID="c4170000-0000-4000-8000-000000000001"
CLAVE_IDEMPOTENCIA="e4170000-0000-4000-8000-000000000001"

q() { "${PSQL[@]}" -qAtc "$1"; }

SUCURSAL_PROPIA="$(q "SELECT id FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1")"
SUCURSAL_AJENA="$(q "SELECT id FROM public.sucursales WHERE activa AND id<>'$SUCURSAL_PROPIA' ORDER BY numero LIMIT 1")"
if [[ -z "$SUCURSAL_PROPIA" || -z "$SUCURSAL_AJENA" ]]; then
  echo "Se necesitan dos sucursales activas en la base local." >&2
  exit 1
fi

"${PSQL[@]}" <<SQL
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_ok boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS \$\$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FALLO: %',p_message;
  END IF;
  RAISE NOTICE '✓ %',p_message;
END;
\$\$;

CREATE OR REPLACE FUNCTION pg_temp.capture_error(p_sql text)
RETURNS text
LANGUAGE plpgsql
AS \$\$
DECLARE
  v_message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
    RETURN v_message;
  END;
  RETURN '<SIN_ERROR>';
END;
\$\$;

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM auth.users
     WHERE id IN ('$USUARIO_PROPIO','$USUARIO_AJENO')
        OR email IN ('t17-idem-propio@local.test','t17-idem-ajeno@local.test')
  )
  AND NOT EXISTS (SELECT 1 FROM public.clientes WHERE id='$CLIENTE_ID')
  AND NOT EXISTS (SELECT 1 FROM public.productos WHERE id='$PRODUCTO_ID')
  AND NOT EXISTS (
    SELECT 1 FROM public.ventas WHERE idempotency_key='$CLAVE_IDEMPOTENCIA'
  ),
  'el fixture parte sin colisiones'
);

INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES
  (
    '$USUARIO_PROPIO','00000000-0000-0000-0000-000000000000',
    'authenticated','authenticated','t17-idem-propio@local.test','x',now(),now(),now()
  ),
  (
    '$USUARIO_AJENO','00000000-0000-0000-0000-000000000000',
    'authenticated','authenticated','t17-idem-ajeno@local.test','x',now(),now(),now()
  );

UPDATE public.profiles
   SET username='t17_idem_propio',nombre_completo='T17 IDEM PROPIO',
       sucursal_id='$SUCURSAL_PROPIA',activo=true
 WHERE id='$USUARIO_PROPIO';
UPDATE public.profiles
   SET username='t17_idem_ajeno',nombre_completo='T17 IDEM AJENO',
       sucursal_id='$SUCURSAL_AJENA',activo=true
 WHERE id='$USUARIO_AJENO';
INSERT INTO public.profile_sucursales(profile_id,sucursal_id) VALUES
  ('$USUARIO_PROPIO','$SUCURSAL_PROPIA'),
  ('$USUARIO_AJENO','$SUCURSAL_AJENA');
DELETE FROM public.user_roles WHERE user_id IN ('$USUARIO_PROPIO','$USUARIO_AJENO');

INSERT INTO public.clientes(
  id,razon_social,tipo,condicion_cta_cte,limite_credito,activo
) VALUES (
  '$CLIENTE_ID','T17 CLIENTE IDEMPOTENCIA','CONSUMIDOR_FINAL',true,99999999,true
);
INSERT INTO public.productos(
  id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado
) VALUES (
  '$PRODUCTO_ID','T17-IDEMP','T17 PRODUCTO IDEMPOTENCIA',100,21,true,false
);
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad) VALUES
  ('$PRODUCTO_ID','$SUCURSAL_PROPIA',100),
  ('$PRODUCTO_ID','$SUCURSAL_AJENA',100);

UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"$USUARIO_PROPIO","role":"authenticated"}',
  true
);

CREATE TEMP TABLE t17_venta AS
SELECT * FROM public.crear_venta(
  '$SUCURSAL_PROPIA','$CLIENTE_ID','VENTA','CTA_CTE',
  '[{"producto_id":"$PRODUCTO_ID","cantidad":2,"descuento_porcentaje":5}]'::jsonb,
  '[]'::jsonb,0,'T17-IDEMPOTENCIA',NULL,NULL,NULL,'$CLAVE_IDEMPOTENCIA'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM t17_venta),
  'la primera llamada crea una única venta'
);

CREATE TEMP TABLE t17_efectos AS
SELECT
  (SELECT venta_id FROM t17_venta) AS venta_id,
  (SELECT count(*) FROM public.ventas WHERE idempotency_key='$CLAVE_IDEMPOTENCIA') AS ventas,
  (SELECT count(*) FROM public.venta_items WHERE venta_id=(SELECT venta_id FROM t17_venta)) AS items,
  (SELECT count(*) FROM public.venta_pagos WHERE venta_id=(SELECT venta_id FROM t17_venta)) AS pagos,
  (SELECT count(*) FROM public.stock_movimientos WHERE referencia_id=(SELECT venta_id FROM t17_venta)) AS stock_movimientos,
  (SELECT count(*) FROM public.cuenta_corriente_movimientos WHERE venta_id=(SELECT venta_id FROM t17_venta)) AS cuenta_movimientos,
  (SELECT cantidad FROM public.stock_sucursal WHERE producto_id='$PRODUCTO_ID' AND sucursal_id='$SUCURSAL_PROPIA') AS stock;

CREATE TEMP TABLE t17_replay AS
SELECT * FROM public.crear_venta(
  '$SUCURSAL_PROPIA','$CLIENTE_ID','VENTA','CTA_CTE',
  '[{"producto_id":"$PRODUCTO_ID","cantidad":2,"descuento_porcentaje":5}]'::jsonb,
  '[]'::jsonb,0,'T17-IDEMPOTENCIA',NULL,NULL,NULL,'$CLAVE_IDEMPOTENCIA'
);
SELECT pg_temp.assert_true(
  (SELECT r.venta_id=e.venta_id FROM t17_replay AS r CROSS JOIN t17_efectos AS e),
  'mismo actor, clave y payload devuelve el replay original'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM public.ventas WHERE idempotency_key='$CLAVE_IDEMPOTENCIA')
    =(SELECT ventas FROM t17_efectos)
  AND (SELECT count(*) FROM public.venta_items WHERE venta_id=(SELECT venta_id FROM t17_efectos))
    =(SELECT items FROM t17_efectos)
  AND (SELECT count(*) FROM public.venta_pagos WHERE venta_id=(SELECT venta_id FROM t17_efectos))
    =(SELECT pagos FROM t17_efectos)
  AND (SELECT count(*) FROM public.stock_movimientos WHERE referencia_id=(SELECT venta_id FROM t17_efectos))
    =(SELECT stock_movimientos FROM t17_efectos)
  AND (SELECT count(*) FROM public.cuenta_corriente_movimientos WHERE venta_id=(SELECT venta_id FROM t17_efectos))
    =(SELECT cuenta_movimientos FROM t17_efectos)
  AND (SELECT cantidad FROM public.stock_sucursal WHERE producto_id='$PRODUCTO_ID' AND sucursal_id='$SUCURSAL_PROPIA')
    =(SELECT stock FROM t17_efectos),
  'el replay válido no duplica ni cambia efectos comerciales'
);

-- PENDIENTE y versión 0 es el único caso que el fast path histórico reparaba.
-- Dejarlo así permite comprobar que un actor ajeno no alcanza ese UPDATE.
RESET ROLE;
UPDATE public.ventas
   SET afip_estado='PENDIENTE'
 WHERE id=(SELECT venta_id FROM t17_efectos);
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"$USUARIO_AJENO","role":"authenticated"}',
  true
);

CREATE TEMP TABLE t17_errores(tipo text PRIMARY KEY,mensaje text NOT NULL);
INSERT INTO t17_errores(tipo,mensaje)
SELECT 'AJENO',pg_temp.capture_error(\$q\$
  SELECT * FROM public.crear_venta(
    '$SUCURSAL_AJENA','$CLIENTE_ID','VENTA','CTA_CTE',
    '[{"producto_id":"$PRODUCTO_ID","cantidad":2,"descuento_porcentaje":5}]'::jsonb,
    '[]'::jsonb,0,'T17-IDEMPOTENCIA',NULL,NULL,NULL,'$CLAVE_IDEMPOTENCIA'
  )
\$q\$);
SELECT pg_temp.assert_true(
  (SELECT mensaje='La clave de idempotencia no corresponde a esta operación'
     FROM t17_errores WHERE tipo='AJENO'),
  'una clave ajena cross-sucursal se rechaza sin devolver la venta'
);
RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT afip_estado='PENDIENTE'
     FROM public.ventas WHERE id=(SELECT venta_id FROM t17_efectos))
  AND (SELECT count(*) FROM public.ventas WHERE idempotency_key='$CLAVE_IDEMPOTENCIA')
    =(SELECT ventas FROM t17_efectos)
  AND (SELECT count(*) FROM public.venta_items WHERE venta_id=(SELECT venta_id FROM t17_efectos))
    =(SELECT items FROM t17_efectos)
  AND (SELECT count(*) FROM public.stock_movimientos WHERE referencia_id=(SELECT venta_id FROM t17_efectos))
    =(SELECT stock_movimientos FROM t17_efectos)
  AND (SELECT cantidad FROM public.stock_sucursal WHERE producto_id='$PRODUCTO_ID' AND sucursal_id='$SUCURSAL_PROPIA')
    =(SELECT stock FROM t17_efectos),
  'la clave ajena no repara ni muta la operación original'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"$USUARIO_PROPIO","role":"authenticated"}',
  true
);
INSERT INTO t17_errores(tipo,mensaje)
SELECT 'PAYLOAD_DISTINTO',pg_temp.capture_error(\$q\$
  SELECT * FROM public.crear_venta(
    '$SUCURSAL_PROPIA','$CLIENTE_ID','VENTA','CTA_CTE',
    '[{"producto_id":"$PRODUCTO_ID","cantidad":3,"descuento_porcentaje":5}]'::jsonb,
    '[]'::jsonb,0,'T17-IDEMPOTENCIA',NULL,NULL,NULL,'$CLAVE_IDEMPOTENCIA'
  )
\$q\$);
SELECT pg_temp.assert_true(
  (SELECT mensaje='La clave de idempotencia no corresponde a esta operación'
     FROM t17_errores WHERE tipo='PAYLOAD_DISTINTO'),
  'la misma clave con payload distinto se rechaza'
);
SELECT pg_temp.assert_true(
  (SELECT afip_estado='PENDIENTE'
     FROM public.ventas WHERE id=(SELECT venta_id FROM t17_efectos))
  AND (SELECT count(*) FROM public.venta_items WHERE venta_id=(SELECT venta_id FROM t17_efectos))
    =(SELECT items FROM t17_efectos)
  AND (SELECT count(*) FROM public.stock_movimientos WHERE referencia_id=(SELECT venta_id FROM t17_efectos))
    =(SELECT stock_movimientos FROM t17_efectos)
  AND (SELECT cantidad FROM public.stock_sucursal WHERE producto_id='$PRODUCTO_ID' AND sucursal_id='$SUCURSAL_PROPIA')
    =(SELECT stock FROM t17_efectos),
  'el payload distinto no repara ni muta la venta'
);

RESET ROLE;
UPDATE public.ventas
   SET idempotency_payload_hash=NULL
 WHERE id=(SELECT venta_id FROM t17_efectos);
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"$USUARIO_PROPIO","role":"authenticated"}',
  true
);
INSERT INTO t17_errores(tipo,mensaje)
SELECT 'LEGACY_SIN_HASH',pg_temp.capture_error(\$q\$
  SELECT * FROM public.crear_venta(
    '$SUCURSAL_PROPIA','$CLIENTE_ID','VENTA','CTA_CTE',
    '[{"producto_id":"$PRODUCTO_ID","cantidad":2,"descuento_porcentaje":5}]'::jsonb,
    '[]'::jsonb,0,'T17-IDEMPOTENCIA',NULL,NULL,NULL,'$CLAVE_IDEMPOTENCIA'
  )
\$q\$);
SELECT pg_temp.assert_true(
  (SELECT l.mensaje=a.mensaje
     FROM t17_errores AS l CROSS JOIN t17_errores AS a
    WHERE l.tipo='LEGACY_SIN_HASH' AND a.tipo='AJENO')
  AND (SELECT mensaje='La clave de idempotencia no corresponde a esta operación'
         FROM t17_errores WHERE tipo='LEGACY_SIN_HASH'),
  'una clave legacy sin hash usa el mismo rechazo genérico y no filtra existencia'
);
SELECT pg_temp.assert_true(
  (SELECT afip_estado='PENDIENTE'
     FROM public.ventas WHERE id=(SELECT venta_id FROM t17_efectos)),
  'el replay legacy sin hash tampoco repara la venta'
);

RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT count(*)=1
          AND bool_and(p.prosecdef)
          AND bool_and(p.proconfig @> ARRAY['search_path=""']::text[])
          AND bool_and(pg_catalog.pg_get_function_identity_arguments(p.oid)=
            'p_sucursal_id uuid, p_cliente_id uuid, p_tipo_comprobante tipo_comprobante, p_condicion_venta condicion_venta, p_items jsonb, p_pagos jsonb, p_percepciones numeric, p_observaciones text, p_nombre_obra text, p_fecha timestamp with time zone, p_cbte_asoc_id uuid, p_idempotency_key uuid')
     FROM pg_catalog.pg_proc AS p
     JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname='crear_venta'),
  'crear_venta conserva una sola firma exacta, SECURITY DEFINER y search_path vacío'
);
SELECT pg_temp.assert_true(
  NOT pg_catalog.has_function_privilege(
    'public','public.crear_venta(uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)','EXECUTE'
  )
  AND NOT pg_catalog.has_function_privilege(
    'anon','public.crear_venta(uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)','EXECUTE'
  )
  AND pg_catalog.has_function_privilege(
    'authenticated','public.crear_venta(uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)','EXECUTE'
  )
  AND pg_catalog.has_function_privilege(
    'service_role','public.crear_venta(uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)','EXECUTE'
  ),
  'crear_venta mantiene grants mínimos y explícitos'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1
          AND bool_and(p.prosecdef)
          AND bool_and(p.proconfig @> ARRAY['search_path=""']::text[])
          AND bool_and(pg_catalog.pg_get_function_identity_arguments(p.oid)=
            'p_sucursal_id uuid, p_cliente_id uuid, p_tipo_comprobante tipo_comprobante, p_condicion_venta condicion_venta, p_items jsonb, p_pagos jsonb, p_percepciones numeric, p_observaciones text, p_nombre_obra text, p_fecha timestamp with time zone, p_cbte_asoc_id uuid, p_idempotency_key uuid')
     FROM pg_catalog.pg_proc AS p
     JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname='_crear_venta_core_20260823')
  AND NOT pg_catalog.has_function_privilege(
    'public','public._crear_venta_core_20260823(uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)','EXECUTE'
  )
  AND NOT pg_catalog.has_function_privilege(
    'anon','public._crear_venta_core_20260823(uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)','EXECUTE'
  )
  AND NOT pg_catalog.has_function_privilege(
    'authenticated','public._crear_venta_core_20260823(uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)','EXECUTE'
  )
  AND NOT pg_catalog.has_function_privilege(
    'service_role','public._crear_venta_core_20260823(uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)','EXECUTE'
  ),
  'el core sin guardia queda owner-only, sin sobrecargas y con search_path vacío'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ventas'
       AND column_name='idempotency_payload_hash' AND data_type='text'
  )
  AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
     WHERE c.conrelid='public.ventas'::regclass
       AND c.conname='ventas_idempotency_payload_hash_check'
  ),
  'ventas persiste una huella SHA-256 validada para la idempotencia'
);
SELECT pg_temp.assert_true(
  (SELECT idempotency_payload_hash IS NULL
     FROM public.ventas WHERE id=(SELECT venta_id FROM t17_efectos)),
  'el caso legacy del test conserva NULL y no fue reparado'
);

ROLLBACK;
SQL

RESIDUOS="$(q "
  SELECT
    (SELECT count(*) FROM auth.users WHERE id IN ('$USUARIO_PROPIO','$USUARIO_AJENO'))+
    (SELECT count(*) FROM public.clientes WHERE id='$CLIENTE_ID')+
    (SELECT count(*) FROM public.productos WHERE id='$PRODUCTO_ID')+
    (SELECT count(*) FROM public.ventas WHERE idempotency_key='$CLAVE_IDEMPOTENCIA')+
    CASE WHEN auth.uid() IS NULL THEN 0 ELSE 1 END
")"
if [[ "$RESIDUOS" != "0" ]]; then
  echo "FALLO: quedaron fixtures o contexto auth del test ($RESIDUOS)." >&2
  exit 1
fi
echo "✓ rollback exacto: sin fixtures ni contexto auth residual"
