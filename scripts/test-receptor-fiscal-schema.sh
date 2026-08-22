#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)

q() { "${PSQL[@]}" -tAc "$1"; }
check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "✗ $name — esperaba '$expected', obtuvo '$actual'" >&2
    exit 1
  fi
  echo "✓ $name"
}

check "VENTA existe en tipo_comprobante" "1" \
  "$(q "select count(*) from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname='tipo_comprobante' and e.enumlabel='VENTA'")"

check "ventas tiene los doce campos fiscales nuevos" "12" \
  "$(q "select count(*) from information_schema.columns where table_schema='public' and table_name='ventas' and column_name = any(array['afip_fecha_comprobante','afip_snapshot_hash','afip_claim_token','afip_claimed_at','afip_fase','afip_error_clase','afip_error_codigo','afip_error_fase','afip_ultimo_error_at','afip_validez','afip_legacy_incompleto','afip_version'])")"

check "profiles.puede_facturar nace false" "false" \
  "$(q "select column_default from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='puede_facturar'")"
check "flags de rollout nacen v2 apagado y legacy encendido" "false|true" \
  "$(q "select facturacion_receptor_v2_enabled::text||'|'||facturacion_legacy_writer_enabled::text from public.settings where id=true")"
check "modalidad A nace desconocida" "'DESCONOCIDA'::text" \
  "$(q "select column_default from information_schema.columns where table_schema='public' and table_name='emisores' and column_name='factura_a_modalidad'")"

check "tablas auxiliares existen" "receptores_fiscales|emision_fiscal_intentos" \
  "$(q "select string_agg(relname,'|' order by relname desc) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relname in ('receptores_fiscales','emision_fiscal_intentos') and relkind='r'")"
check "tablas auxiliares tienen RLS" "true|true" \
  "$(q "select bool_and(relrowsecurity)::text||'|'||bool_and(relrowsecurity)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relname in ('receptores_fiscales','emision_fiscal_intentos')")"

check "anon no tiene privilegios sobre intentos" "false|false|false|false" \
  "$(q "select has_table_privilege('anon','public.emision_fiscal_intentos','select')::text||'|'||has_table_privilege('anon','public.emision_fiscal_intentos','insert')::text||'|'||has_table_privilege('anon','public.emision_fiscal_intentos','update')::text||'|'||has_table_privilege('anon','public.emision_fiscal_intentos','delete')::text")"
check "authenticated no tiene privilegios sobre intentos" "false|false|false|false" \
  "$(q "select has_table_privilege('authenticated','public.emision_fiscal_intentos','select')::text||'|'||has_table_privilege('authenticated','public.emision_fiscal_intentos','insert')::text||'|'||has_table_privilege('authenticated','public.emision_fiscal_intentos','update')::text||'|'||has_table_privilege('authenticated','public.emision_fiscal_intentos','delete')::text")"
check "service_role tiene sólo lectura/alta/actualización de intentos" "true|true|true|false" \
  "$(q "select has_table_privilege('service_role','public.emision_fiscal_intentos','select')::text||'|'||has_table_privilege('service_role','public.emision_fiscal_intentos','insert')::text||'|'||has_table_privilege('service_role','public.emision_fiscal_intentos','update')::text||'|'||has_table_privilege('service_role','public.emision_fiscal_intentos','delete')::text")"

check "puede_facturar tiene una única firma invoker" "1|false" \
  "$(q "select count(*)::text||'|'||bool_or(p.prosecdef)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='puede_facturar' and pg_get_function_identity_arguments(p.oid)='_uid uuid'")"
check "backfill tiene una única firma invoker" "1|false" \
  "$(q "select count(*)::text||'|'||bool_or(p.prosecdef)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='backfill_cola_fiscal' and pg_get_function_identity_arguments(p.oid)='p_aplicar boolean'")"
check "PUBLIC no ejecuta rutinas fiscales o privilegiadas nuevas" "0" \
  "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname='public' and p.proname in ('puede_facturar','guard_profiles_columnas','backfill_cola_fiscal','transicionar_emision_fiscal') and a.grantee=0 and a.privilege_type='EXECUTE'")"
check "authenticated y service_role ejecutan puede_facturar" "true|true" \
  "$(q "select has_function_privilege('authenticated','public.puede_facturar(uuid)','execute')::text||'|'||has_function_privilege('service_role','public.puede_facturar(uuid)','execute')::text")"
check "el navegador no ejecuta backfill" "false|false" \
  "$(q "select has_function_privilege('anon','public.backfill_cola_fiscal(boolean)','execute')::text||'|'||has_function_privilege('authenticated','public.backfill_cola_fiscal(boolean)','execute')::text")"
check "el navegador no ejecuta directamente el guard de perfiles" "false|false" \
  "$(q "select has_function_privilege('anon','public.guard_profiles_columnas()','execute')::text||'|'||has_function_privilege('authenticated','public.guard_profiles_columnas()','execute')::text")"

check "índices de cola, favoritos e intentos existen" "4" \
  "$(q "select count(*) from pg_indexes where schemaname='public' and indexname in ('idx_ventas_cola_fiscal','idx_receptores_fiscales_sucursal','idx_receptores_fiscales_documento','idx_emision_fiscal_intentos_venta')")"
check "se preserva la unicidad fiscal multiemisor exacta" "true" \
  "$(q "select (indexdef ilike '%(afip_emisor_cuit, afip_punto_venta, afip_cbte_tipo, afip_numero, afip_modo, afip_simulado)%' and indexdef ilike '%where (afip_numero is not null)%')::text from pg_indexes where schemaname='public' and indexname='uq_ventas_afip_numeracion'")"

"${PSQL[@]}" <<'SQL'
BEGIN;

INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES
  ('a2000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t2-admin@test.local','x',now(),now(),now()),
  ('a2000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t2-capaz@test.local','x',now(),now(),now()),
  ('a2000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t2-sin-cap@test.local','x',now(),now(),now());

UPDATE public.profiles
   SET sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)
 WHERE id::text LIKE 'a2000000-%';
INSERT INTO public.user_roles (user_id,role)
VALUES ('a2000000-0000-0000-0000-000000000001','admin');
INSERT INTO public.profile_sucursales (profile_id,sucursal_id)
SELECT p.id,p.sucursal_id FROM public.profiles p WHERE p.id::text LIKE 'a2000000-%';
UPDATE public.profiles SET puede_facturar=true
WHERE id='a2000000-0000-0000-0000-000000000002';

INSERT INTO public.clientes (id,razon_social)
VALUES ('b2000000-0000-0000-0000-000000000001','T2 CLIENTE SCHEMA');

-- La lista de estados se prueba por comportamiento, no leyendo la expresión del CHECK.
INSERT INTO public.ventas (
  sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado
)
SELECT
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000002',
  'T2-ESTADO-'||s.estado,
  'VENTA',s.estado
FROM unnest(ARRAY[
  'NO_APLICA','PENDIENTE','ERROR','SIN_FACTURAR','ERROR_CORREGIBLE','CANCELADO','BLOQUEADO'
]) AS s(estado);

INSERT INTO public.ventas (
  sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado,
  afip_claim_token,afip_claimed_at,afip_snapshot,afip_snapshot_hash,afip_version
) VALUES (
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002',
  'T2-ESTADO-EMITIENDO','VENTA','EMITIENDO',
  'c2000000-0000-0000-0000-000000000001',now(),'{"version":2}'::jsonb,repeat('e',64),2
);
INSERT INTO public.ventas (
  sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado,
  afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,
  afip_fecha_comprobante,afip_snapshot,afip_snapshot_hash,afip_validez,afip_version
) VALUES (
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002',
  'T2-ESTADO-RECONCILIAR','VENTA','RECONCILIAR',
  '30714199664',90,6,920001,'PRODUCCION','2026-08-22','{"version":2}'::jsonb,repeat('r',64),'PRODUCCION',2
);
INSERT INTO public.ventas (
  sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado,
  afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,
  afip_fecha_comprobante,afip_snapshot,afip_snapshot_hash,afip_validez,afip_version,cae
) VALUES (
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002',
  'T2-ESTADO-APROBADO','VENTA','APROBADO',
  '30714199664',90,6,920002,'PRODUCCION','2026-08-22','{"version":2}'::jsonb,repeat('a',64),'PRODUCCION',2,'CAE-T2'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.ventas (
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002',
      'T2-ESTADO-BASURA','VENTA','BASURA'
    );
    RAISE EXCEPTION 'el CHECK aceptó un estado fiscal basura';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.ventas (
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado,
      afip_emisor_cuit,afip_numero
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002',
      'T2-RECONCILIAR-INCOMPLETO','VENTA','RECONCILIAR','30714199664',920003
    );
    RAISE EXCEPTION 'RECONCILIAR aceptó una reserva sin snapshot v2/hash';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.ventas (
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado,cae
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002',
      'T2-CANCELADO-CAE','VENTA','CANCELADO','CAE-ILEGAL'
    );
    RAISE EXCEPTION 'CANCELADO aceptó un CAE';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.ventas (
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
      afip_claim_token
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002',
      'T2-CLAIM-SIN-FECHA','VENTA','c2000000-0000-0000-0000-000000000099'
    );
    RAISE EXCEPTION 'se aceptó un claim sin claimed_at';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Dos flags verdaderos se rechazan; ambos falsos son la cerca corta de corte.
DO $$
BEGIN
  BEGIN
    UPDATE public.settings
       SET facturacion_receptor_v2_enabled=true,
           facturacion_legacy_writer_enabled=true
     WHERE id=true;
    RAISE EXCEPTION 'se habilitaron simultáneamente ambos escritores fiscales';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE public.settings
     SET facturacion_receptor_v2_enabled=false,
         facturacion_legacy_writer_enabled=false
   WHERE id=true;
  IF NOT EXISTS (
    SELECT 1 FROM public.settings
     WHERE id=true
       AND NOT facturacion_receptor_v2_enabled
       AND NOT facturacion_legacy_writer_enabled
  ) THEN
    RAISE EXCEPTION 'la cerca fiscal con ambos flags falsos no funciona';
  END IF;
END $$;

-- Favoritos: datos de dos sucursales y uno inactivo en la sucursal activa.
INSERT INTO public.receptores_fiscales (
  id,sucursal_id,creado_por,cliente_comercial_id,tipo_documento,numero_documento,
  razon_social,condicion_iva,activo
) VALUES
  ('d2000000-0000-0000-0000-000000000001',(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),'a2000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000001','CUIT','30714199664','T2 FAV PROPIO','RESPONSABLE_INSCRIPTO',true),
  ('d2000000-0000-0000-0000-000000000002',(SELECT id FROM public.sucursales ORDER BY numero OFFSET 1 LIMIT 1),'a2000000-0000-0000-0000-000000000002',NULL,'CUIL','20333111222','T2 FAV OTRA SUCURSAL','MONOTRIBUTO',true),
  ('d2000000-0000-0000-0000-000000000003',(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),'a2000000-0000-0000-0000-000000000002',NULL,'DNI','33111222','T2 FAV INACTIVO','CONSUMIDOR_FINAL',false),
  ('d2000000-0000-0000-0000-000000000004',(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),'a2000000-0000-0000-0000-000000000003',NULL,'CDI','27333111229','T2 FAV AJENO','EXENTO',true);

UPDATE public.ventas
   SET afip_snapshot='{"version":1,"receptor":{"origenId":"d2000000-0000-0000-0000-000000000002","razonSocial":"CONGELADO"}}'::jsonb
 WHERE numero_comprobante='T2-ESTADO-NO_APLICA';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
DO $$
DECLARE v_count integer; v_rows integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.receptores_fiscales
   WHERE activo AND razon_social LIKE 'T2 FAV %';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'empleado fiscal vio % favoritos; esperaba 2 activos de su sucursal',v_count;
  END IF;
  IF NOT public.puede_facturar() THEN
    RAISE EXCEPTION 'puede_facturar no reconoció al empleado fiscal activo';
  END IF;

  INSERT INTO public.receptores_fiscales (
    id,sucursal_id,creado_por,tipo_documento,numero_documento,razon_social,condicion_iva
  ) VALUES (
    'd2000000-0000-0000-0000-000000000010',public.current_sucursal_id(),auth.uid(),
    'DNI','32111222','T2 FAV INSERT PROPIO','CONSUMIDOR_FINAL'
  );

  BEGIN
    INSERT INTO public.receptores_fiscales (
      sucursal_id,creado_por,tipo_documento,numero_documento,razon_social,condicion_iva
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero OFFSET 1 LIMIT 1),auth.uid(),
      'DNI','32111223','T2 FAV INSERT OTRA','CONSUMIDOR_FINAL'
    );
    RAISE EXCEPTION 'empleado insertó un favorito en otra sucursal';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.receptores_fiscales (
      sucursal_id,creado_por,tipo_documento,numero_documento,razon_social,condicion_iva
    ) VALUES (
      public.current_sucursal_id(),'a2000000-0000-0000-0000-000000000003',
      'DNI','32111224','T2 FAV INSERT OTRO CREADOR','CONSUMIDOR_FINAL'
    );
    RAISE EXCEPTION 'empleado falseó el creador de un favorito';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.receptores_fiscales (
      sucursal_id,creado_por,tipo_documento,numero_documento,razon_social,condicion_iva
    ) VALUES (
      public.current_sucursal_id(),auth.uid(),'SIN_IDENTIFICAR','0',
      'T2 FAV ANONIMO','CONSUMIDOR_FINAL'
    );
    RAISE EXCEPTION 'se guardó SIN_IDENTIFICAR como favorito';
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.receptores_fiscales (
      sucursal_id,creado_por,tipo_documento,numero_documento,razon_social,condicion_iva
    ) VALUES (
      public.current_sucursal_id(),auth.uid(),'CUIT','30-71419966-4',
      'T2 FAV DOC NO CANONICO','RESPONSABLE_INSCRIPTO'
    );
    RAISE EXCEPTION 'se guardó un documento no canónico';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE public.receptores_fiscales SET domicilio='NO DEBE CAMBIAR'
   WHERE id='d2000000-0000-0000-0000-000000000004';
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'empleado editó un favorito creado por otro usuario';
  END IF;

  UPDATE public.receptores_fiscales SET activo=false
   WHERE id='d2000000-0000-0000-0000-000000000010';
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'empleado no pudo desactivar su favorito';
  END IF;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a2000000-0000-0000-0000-000000000003","role":"authenticated"}',true);
DO $$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.receptores_fiscales WHERE razon_social LIKE 'T2 FAV %';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'empleado sin capacidad fiscal vio % favoritos',v_count;
  END IF;
  IF public.puede_facturar() THEN
    RAISE EXCEPTION 'puede_facturar elevó a un empleado sin permiso';
  END IF;
  BEGIN
    UPDATE public.profiles SET puede_facturar=true WHERE id=auth.uid();
    RAISE EXCEPTION 'empleado se autoasignó puede_facturar';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'No puede modificar el permiso fiscal de su propio perfil' THEN
      RAISE;
    END IF;
  END;
END $$;
RESET ROLE;

-- El canal administrativo de servidor puede cambiar el permiso; el trigger
-- distingue este canal por auth.uid() NULL, igual que los guards existentes.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{}',true);
UPDATE public.profiles SET puede_facturar=true
 WHERE id='a2000000-0000-0000-0000-000000000003';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id='a2000000-0000-0000-0000-000000000003' AND puede_facturar
  ) THEN
    RAISE EXCEPTION 'el canal administrativo de servidor no pudo asignar puede_facturar';
  END IF;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a2000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
DO $$
DECLARE v_count integer; v_rows integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.receptores_fiscales WHERE razon_social LIKE 'T2 FAV %';
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'admin vio % favoritos; esperaba los 4 originales y el insertado',v_count;
  END IF;
  UPDATE public.receptores_fiscales SET domicilio='ADMIN OK'
   WHERE id='d2000000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'admin no pudo administrar favorito de otra sucursal';
  END IF;
  IF (SELECT afip_snapshot FROM public.ventas WHERE numero_comprobante='T2-ESTADO-NO_APLICA')
       IS DISTINCT FROM
       '{"version":1,"receptor":{"origenId":"d2000000-0000-0000-0000-000000000002","razonSocial":"CONGELADO"}}'::jsonb THEN
    RAISE EXCEPTION 'editar un favorito modificó el snapshot ya congelado de una venta';
  END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);

-- Fixtures del backfill. La rutina se ejecuta en aplicar=true sólo dentro de
-- esta transacción y todo se revierte al final.
INSERT INTO public.ventas (
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado,
  cae,afip_numero,afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_modo,
  afip_simulado,afip_snapshot
) VALUES (
  'e2000000-0000-0000-0000-000000000001',(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002',
  'T2-BACKFILL-CAE','FACTURA_B','PENDIENTE','CAE-LEGACY',930001,'30714199664',91,6,
  'HOMOLOGACION',true,'{"version":1,"legacy":"preservar"}'::jsonb
);
INSERT INTO public.ventas (
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado,
  afip_numero,afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_modo,
  afip_snapshot,afip_snapshot_hash,afip_version,afip_fecha_comprobante
) VALUES (
  'e2000000-0000-0000-0000-000000000002',(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002',
  'T2-BACKFILL-V2','FACTURA_B','PENDIENTE',930002,'30714199664',91,6,'PRODUCCION',
  '{"version":2,"receptor":{"tipoDocumento":"CUIT"}}'::jsonb,repeat('2',64),2,'2026-08-22'
);
INSERT INTO public.ventas (
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado,
  afip_numero,afip_emisor_cuit
) VALUES (
  'e2000000-0000-0000-0000-000000000003',(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002',
  'T2-BACKFILL-RESERVA-LEGACY','FACTURA_A','PENDIENTE',930003,'30714199664'
);
INSERT INTO public.ventas (
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado,estado
) VALUES
  ('e2000000-0000-0000-0000-000000000004',(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002','T2-BACKFILL-ERROR','FACTURA_B','ERROR','ACTIVA'),
  ('e2000000-0000-0000-0000-000000000005',(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002','T2-BACKFILL-SIN-FACTURAR','FACTURA_C','NO_APLICA','ACTIVA'),
  ('e2000000-0000-0000-0000-000000000006',(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002','T2-BACKFILL-CANCELADO','FACTURA_B','NO_APLICA','ANULADA'),
  ('e2000000-0000-0000-0000-000000000007',(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002','T2-BACKFILL-REMITO','REMITO','PENDIENTE','ACTIVA'),
  ('e2000000-0000-0000-0000-000000000008',(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),'b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002','T2-BACKFILL-NOTA','NOTA_CREDITO','ERROR','ACTIVA');

CREATE TEMP TABLE t2_backfill_antes ON COMMIT DROP AS
SELECT id,afip_estado,afip_validez,afip_legacy_incompleto,afip_snapshot,
       afip_fecha_comprobante,afip_punto_venta
  FROM public.ventas WHERE id::text LIKE 'e2000000-%';
CREATE TEMP TABLE t2_backfill_preview ON COMMIT DROP AS
SELECT * FROM public.backfill_cola_fiscal(false);

DO $$
BEGIN
  IF EXISTS (
    (SELECT id,afip_estado,afip_validez,afip_legacy_incompleto,afip_snapshot,afip_fecha_comprobante,afip_punto_venta
       FROM public.ventas WHERE id::text LIKE 'e2000000-%')
    EXCEPT
    (SELECT * FROM t2_backfill_antes)
  ) OR EXISTS (
    (SELECT * FROM t2_backfill_antes)
    EXCEPT
    (SELECT id,afip_estado,afip_validez,afip_legacy_incompleto,afip_snapshot,afip_fecha_comprobante,afip_punto_venta
       FROM public.ventas WHERE id::text LIKE 'e2000000-%')
  ) THEN
    RAISE EXCEPTION 'el dry-run del backfill mutó ventas';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM t2_backfill_preview WHERE estado_destino='APROBADO' AND cantidad>=1)
     OR NOT EXISTS (SELECT 1 FROM t2_backfill_preview WHERE estado_destino='RECONCILIAR' AND cantidad>=1)
     OR NOT EXISTS (SELECT 1 FROM t2_backfill_preview WHERE estado_destino='BLOQUEADO' AND cantidad>=2)
     OR NOT EXISTS (SELECT 1 FROM t2_backfill_preview WHERE estado_destino='ERROR_CORREGIBLE' AND cantidad>=1)
     OR NOT EXISTS (SELECT 1 FROM t2_backfill_preview WHERE estado_destino='SIN_FACTURAR' AND cantidad>=1)
     OR NOT EXISTS (SELECT 1 FROM t2_backfill_preview WHERE estado_destino='CANCELADO' AND cantidad>=1)
     OR NOT EXISTS (SELECT 1 FROM t2_backfill_preview WHERE estado_destino='NO_APLICA' AND cantidad>=1) THEN
    RAISE EXCEPTION 'las cuentas del dry-run no clasifican todos los fixtures';
  END IF;
END $$;

SELECT * FROM public.backfill_cola_fiscal(true);

DO $$
BEGIN
  IF (SELECT afip_estado FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000001') <> 'APROBADO'
     OR NOT (SELECT afip_legacy_incompleto FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000001')
     OR (SELECT afip_validez FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000001') <> 'SIMULADA'
     OR (SELECT afip_snapshot FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000001') IS DISTINCT FROM '{"version":1,"legacy":"preservar"}'::jsonb
     OR (SELECT afip_fecha_comprobante FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'el aprobado legacy no preservó snapshot/fecha ni quedó marcado y simulado';
  END IF;
  IF (SELECT afip_estado FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000002') <> 'RECONCILIAR'
     OR (SELECT afip_validez FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000002') <> 'PRODUCCION'
     OR (SELECT afip_legacy_incompleto FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'la reserva v2 completa no quedó en conciliación de producción';
  END IF;
  IF (SELECT afip_estado FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000003') <> 'BLOQUEADO'
     OR NOT (SELECT afip_legacy_incompleto FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000003')
     OR (SELECT afip_snapshot FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000003') IS NOT NULL
     OR (SELECT afip_fecha_comprobante FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000003') IS NOT NULL
     OR (SELECT afip_punto_venta FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000003') IS NOT NULL THEN
    RAISE EXCEPTION 'la reserva legacy inventó historia o no quedó bloqueada';
  END IF;
  IF (SELECT afip_estado FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000004') <> 'ERROR_CORREGIBLE'
     OR (SELECT afip_estado FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000005') <> 'SIN_FACTURAR'
     OR (SELECT afip_estado FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000006') <> 'CANCELADO'
     OR (SELECT afip_estado FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000007') <> 'NO_APLICA'
     OR (SELECT afip_estado FROM public.ventas WHERE id='e2000000-0000-0000-0000-000000000008') <> 'BLOQUEADO' THEN
    RAISE EXCEPTION 'el backfill no respetó la matriz de clasificación';
  END IF;
END $$;

ROLLBACK;
SQL

echo "✓ estados, checks, flags, RLS, guard y backfill"

# La unicidad por (venta, claim) se prueba con dos sesiones reales. La venta de
# soporte se confirma sólo en la base local y se limpia incluso si falla una sesión.
TMP_DIR="$(mktemp -d)"
cleanup_concurrency() {
  "${PSQL[@]}" >/dev/null 2>&1 <<'SQL' || true
DELETE FROM public.emision_fiscal_intentos WHERE venta_id='f2000000-0000-0000-0000-000000000001';
DELETE FROM public.ventas WHERE id='f2000000-0000-0000-0000-000000000001';
DELETE FROM public.clientes WHERE id='f2000000-0000-0000-0000-000000000001';
DELETE FROM auth.users WHERE id='f2000000-0000-0000-0000-000000000001';
SQL
  rm -f "$TMP_DIR/uno.out" "$TMP_DIR/dos.out"
  rmdir "$TMP_DIR" 2>/dev/null || true
}
trap cleanup_concurrency EXIT
cleanup_concurrency
TMP_DIR="$(mktemp -d)"
trap cleanup_concurrency EXIT

"${PSQL[@]}" >/dev/null <<'SQL'
INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  'f2000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','t2-intento@test.local','x',now(),now(),now()
);
INSERT INTO public.clientes (id,razon_social)
VALUES ('f2000000-0000-0000-0000-000000000001','T2 CLIENTE INTENTO');
INSERT INTO public.ventas (
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_estado
) VALUES (
  'f2000000-0000-0000-0000-000000000001',(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'f2000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000001',
  'T2-INTENTO-CONCURRENTE','VENTA','SIN_FACTURAR'
);
SQL

"${PSQL[@]}" >"$TMP_DIR/uno.out" 2>&1 <<'SQL' &
BEGIN;
INSERT INTO public.emision_fiscal_intentos (
  venta_id,claim_token,snapshot_version,payload_hash,fase,resultado
) VALUES (
  'f2000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000099',
  2,repeat('f',64),'PREFLIGHT','INICIADO'
);
SELECT pg_sleep(1);
COMMIT;
SQL
pid_uno=$!

"${PSQL[@]}" >"$TMP_DIR/dos.out" 2>&1 <<'SQL' &
BEGIN;
INSERT INTO public.emision_fiscal_intentos (
  venta_id,claim_token,snapshot_version,payload_hash,fase,resultado
) VALUES (
  'f2000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000099',
  2,repeat('f',64),'PREFLIGHT','INICIADO'
);
SELECT pg_sleep(1);
COMMIT;
SQL
pid_dos=$!

set +e
wait "$pid_uno"; estado_uno=$?
wait "$pid_dos"; estado_dos=$?
set -e

if [[ "$estado_uno" -eq 0 && "$estado_dos" -eq 0 ]] || [[ "$estado_uno" -ne 0 && "$estado_dos" -ne 0 ]]; then
  echo "✗ unicidad concurrente de intentos — estados $estado_uno/$estado_dos" >&2
  sed -n '1,80p' "$TMP_DIR/uno.out" >&2
  sed -n '1,80p' "$TMP_DIR/dos.out" >&2
  exit 1
fi
if ! rg -q "duplicate key value violates unique constraint" "$TMP_DIR/uno.out" "$TMP_DIR/dos.out"; then
  echo "✗ la sesión perdedora no falló por la unicidad (venta_id, claim_token)" >&2
  exit 1
fi
check "dos inserts concurrentes producen un solo intento" "1" \
  "$(q "select count(*) from public.emision_fiscal_intentos where venta_id='f2000000-0000-0000-0000-000000000001' and claim_token='f2000000-0000-0000-0000-000000000099'")"

cleanup_concurrency
trap - EXIT

echo "✅ Contrato de esquema fiscal y outbox correcto."
