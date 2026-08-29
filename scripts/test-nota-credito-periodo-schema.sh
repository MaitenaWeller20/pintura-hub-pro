#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -X -v ON_ERROR_STOP=1)

q() { "${PSQL[@]}" -tAc "$1"; }
check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "✗ $name — esperaba '$expected', obtuvo '$actual'" >&2
    exit 1
  fi
  echo "✓ $name"
}

check "flag de NC por período nace apagado" "false" \
  "$(q "select nota_credito_periodo_enabled::text from public.settings where id=true")"
check "capacidad de perfil nace apagada" "false" \
  "$(q "select column_default from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='puede_emitir_nc_periodo'")"
check "los dos enums de NC por período tienen sus valores exactos" \
  "BONIFICACION_AJUSTE|DEVOLUCION_PRODUCTOS|REINTEGRO|SALDO_FAVOR" \
  "$(q "select string_agg(e.enumlabel,'|' order by e.enumlabel) from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname in ('modalidad_nc_periodo','resolucion_nc_periodo')")"
check "ventas expone los siete campos de NC por período" "7" \
  "$(q "select count(*) from information_schema.columns where table_schema='public' and table_name='ventas' and column_name=any(array['nc_periodo_modalidad','periodo_asoc_desde','periodo_asoc_hasta','motivo_nota_credito','nc_resolucion','nc_periodo_payload_hash','nc_efectos_aplicados_at'])")"

# Contrato de acceso pedido explícitamente por el plan.
q "select nota_credito_periodo_enabled from public.settings where id=true" >/dev/null
q "select puede_emitir_nc_periodo from public.profiles limit 1" >/dev/null
q "select nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash,nc_efectos_aplicados_at from public.ventas limit 0" >/dev/null
q "select venta_id,forma_pago,monto,detalle,orden from public.nota_credito_periodo_reintegros limit 0" >/dev/null

check "reintegros tiene RLS y una sola policy SELECT" "true|1|0" \
  "$(q "select c.relrowsecurity::text||'|'||(select count(*) from pg_policies where schemaname='public' and tablename='nota_credito_periodo_reintegros' and cmd='SELECT')::text||'|'||(select count(*) from pg_policies where schemaname='public' and tablename='nota_credito_periodo_reintegros' and cmd<>'SELECT')::text from pg_class c where c.oid='public.nota_credito_periodo_reintegros'::regclass")"
check "authenticated sólo lee intenciones de reintegro" "true|false|false|false" \
  "$(q "select has_table_privilege('authenticated','public.nota_credito_periodo_reintegros','select')::text||'|'||has_table_privilege('authenticated','public.nota_credito_periodo_reintegros','insert')::text||'|'||has_table_privilege('authenticated','public.nota_credito_periodo_reintegros','update')::text||'|'||has_table_privilege('authenticated','public.nota_credito_periodo_reintegros','delete')::text")"
check "service_role administra intenciones de reintegro" "true|true|true|true" \
  "$(q "select has_table_privilege('service_role','public.nota_credito_periodo_reintegros','select')::text||'|'||has_table_privilege('service_role','public.nota_credito_periodo_reintegros','insert')::text||'|'||has_table_privilege('service_role','public.nota_credito_periodo_reintegros','update')::text||'|'||has_table_privilege('service_role','public.nota_credito_periodo_reintegros','delete')::text")"

check "capacidad efectiva tiene una única firma invoker estable" "1|true|false|s|search_path=\"\"" \
  "$(q "select count(*)::text||'|'||bool_and(pg_get_function_identity_arguments(p.oid)='_uid uuid')::text||'|'||bool_or(p.prosecdef)::text||'|'||min(p.provolatile)||'|'||min(array_to_string(p.proconfig,',')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='puede_emitir_nc_periodo'")"
check "administración tiene una única firma definer" "1|true|true" \
  "$(q "select count(*)::text||'|'||bool_and(pg_get_function_identity_arguments(p.oid)='p_profile_id uuid, p_habilitado boolean')::text||'|'||bool_or(p.prosecdef)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='administrar_puede_emitir_nc_periodo'")"
check "las dos RPC sólo se exponen a roles internos autenticados" "false|true|true|false|true|true" \
  "$(q "select has_function_privilege('anon','public.puede_emitir_nc_periodo(uuid)','execute')::text||'|'||has_function_privilege('authenticated','public.puede_emitir_nc_periodo(uuid)','execute')::text||'|'||has_function_privilege('service_role','public.puede_emitir_nc_periodo(uuid)','execute')::text||'|'||has_function_privilege('anon','public.administrar_puede_emitir_nc_periodo(uuid,boolean)','execute')::text||'|'||has_function_privilege('authenticated','public.administrar_puede_emitir_nc_periodo(uuid,boolean)','execute')::text||'|'||has_function_privilege('service_role','public.administrar_puede_emitir_nc_periodo(uuid,boolean)','execute')::text")"
check "los guards de NC no son APIs invocables" "false|false|false|false|false|false" \
  "$(q "select has_function_privilege('anon','public.guard_ventas_nc_periodo()','execute')::text||'|'||has_function_privilege('authenticated','public.guard_ventas_nc_periodo()','execute')::text||'|'||has_function_privilege('service_role','public.guard_ventas_nc_periodo()','execute')::text||'|'||has_function_privilege('anon','public.guard_venta_hijos_nc_periodo()','execute')::text||'|'||has_function_privilege('authenticated','public.guard_venta_hijos_nc_periodo()','execute')::text||'|'||has_function_privilege('service_role','public.guard_venta_hijos_nc_periodo()','execute')::text")"

"${PSQL[@]}" <<'SQL'
BEGIN;

INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES
  ('a2100000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nc-periodo-admin@test.local','x',now(),now(),now()),
  ('a2100000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nc-periodo-empleado@test.local','x',now(),now(),now()),
  ('a2100000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nc-periodo-autogestion@test.local','x',now(),now(),now()),
  ('a2100000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nc-periodo-otra-sucursal@test.local','x',now(),now(),now());

UPDATE public.profiles
   SET sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)
 WHERE id IN (
  'a2100000-0000-0000-0000-000000000001',
  'a2100000-0000-0000-0000-000000000002',
  'a2100000-0000-0000-0000-000000000003'
 );
INSERT INTO public.user_roles(user_id,role)
VALUES ('a2100000-0000-0000-0000-000000000001','admin');

INSERT INTO public.clientes(id,razon_social)
VALUES ('b2100000-0000-0000-0000-000000000001','CLIENTE NC PERIODO');

INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante
) VALUES (
  'd2100000-0000-0000-0000-000000000001',
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2100000-0000-0000-0000-000000000001',
  'a2100000-0000-0000-0000-000000000002',
  'NC-PERIODO-ORIGINAL','VENTA'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.ventas(
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
      nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
      motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
      'NC-PERIODO-NO-NC','VENTA','DEVOLUCION_PRODUCTOS','2026-07-01','2026-07-31',
      'Devolución válida','REINTEGRO',repeat('a',64)
    );
    RAISE EXCEPTION 'una venta común aceptó datos de período' USING ERRCODE='ZX001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.ventas(
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_cbte_asoc_id,
      nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
      motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
      'NC-PERIODO-DOBLE-ASOC','NOTA_CREDITO','d2100000-0000-0000-0000-000000000001',
      'DEVOLUCION_PRODUCTOS','2026-07-01','2026-07-31','Devolución válida','REINTEGRO',repeat('b',64)
    );
    RAISE EXCEPTION 'una NC por período aceptó comprobante asociado' USING ERRCODE='ZX001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.ventas(
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,nc_periodo_modalidad
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
      'NC-PERIODO-PARCIAL','NOTA_CREDITO','DEVOLUCION_PRODUCTOS'
    );
    RAISE EXCEPTION 'se aceptaron datos parciales de período' USING ERRCODE='ZX001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.ventas(
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
      nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
      motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
      'NC-PERIODO-FECHAS','NOTA_CREDITO','DEVOLUCION_PRODUCTOS','2026-08-01','2026-07-31',
      'Devolución válida','REINTEGRO',repeat('c',64)
    );
    RAISE EXCEPTION 'se aceptó desde posterior a hasta' USING ERRCODE='ZX001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.ventas(
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
      nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
      motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
      'NC-PERIODO-MOTIVO','NOTA_CREDITO','DEVOLUCION_PRODUCTOS','2026-07-01','2026-07-31',
      ' 1234 ','REINTEGRO',repeat('d',64)
    );
    RAISE EXCEPTION 'se aceptó un motivo de menos de cinco caracteres ajustados' USING ERRCODE='ZX001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.ventas(
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
      nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
      motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
      'NC-PERIODO-HASH-CORTO','NOTA_CREDITO','DEVOLUCION_PRODUCTOS','2026-07-01','2026-07-31',
      'Devolución válida','REINTEGRO',repeat('e',63)
    );
    RAISE EXCEPTION 'se aceptó un hash de 63 caracteres' USING ERRCODE='ZX001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.ventas(
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
      nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
      motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
      'NC-PERIODO-HASH-LARGO','NOTA_CREDITO','DEVOLUCION_PRODUCTOS','2026-07-01','2026-07-31',
      'Devolución válida','REINTEGRO',repeat('f',65)
    );
    RAISE EXCEPTION 'se aceptó un hash de 65 caracteres' USING ERRCODE='ZX001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.ventas(
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
      nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
      motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
      'NC-PERIODO-HASH-MAYUS','NOTA_CREDITO','DEVOLUCION_PRODUCTOS','2026-07-01','2026-07-31',
      'Devolución válida','REINTEGRO',repeat('A',64)
    );
    RAISE EXCEPTION 'se aceptó un hash hexadecimal con mayúsculas' USING ERRCODE='ZX001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.ventas(
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,estado,
      nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
      motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash,nc_efectos_aplicados_at
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
      'NC-PERIODO-EFECTO-PREMATURO','NOTA_CREDITO','PENDIENTE_FISCAL',
      'DEVOLUCION_PRODUCTOS','2026-07-01','2026-07-31','Devolución válida','REINTEGRO',repeat('1',64),now()
    );
    RAISE EXCEPTION 'se aceptaron efectos sin estado comercial ACTIVA' USING ERRCODE='ZX001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Historia válida: una NC interna sin asociación ni período y una NC vinculada
-- siguen siendo aceptadas.
INSERT INTO public.ventas(
  sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante
) VALUES (
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
  'NC-PERIODO-LEGACY-INTERNA','NOTA_CREDITO'
);
INSERT INTO public.ventas(
  sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,afip_cbte_asoc_id
) VALUES (
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
  'NC-PERIODO-LEGACY-VINCULADA','NOTA_CREDITO','d2100000-0000-0000-0000-000000000001'
);

INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,estado,
  condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,afip_estado,
  nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
  motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash
) VALUES (
  'd2100000-0000-0000-0000-000000000002',
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
  'NC-PERIODO-PENDIENTE','NOTA_CREDITO','PENDIENTE_FISCAL',
  'CONTADO',-100,-21,0,-121,0,'SIN_FACTURAR',
  'DEVOLUCION_PRODUCTOS','2026-07-01','2026-07-31','Devolución del período','REINTEGRO',repeat('2',64)
), (
  'd2100000-0000-0000-0000-000000000003',
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
  'NC-PERIODO-EFECTOS','NOTA_CREDITO','ACTIVA',
  'CTA_CTE',0,0,0,0,0,'NO_APLICA',
  'BONIFICACION_AJUSTE','2026-06-01','2026-06-30','Bonificación del período','SALDO_FAVOR',repeat('3',64)
);
UPDATE public.ventas
   SET nc_efectos_aplicados_at=now()
 WHERE id='d2100000-0000-0000-0000-000000000003';

INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,estado,
  afip_estado,cae,afip_numero,afip_emisor_cuit,
  nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
  motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash
) VALUES (
  'd2100000-0000-0000-0000-000000000004',
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
  'NC-PERIODO-APROBADA','NOTA_CREDITO','ACTIVA',
  'APROBADO','CAE-NC-PERIODO',921004,'30714199664',
  'DEVOLUCION_PRODUCTOS','2026-05-01','2026-05-31','Devolución aprobada','REINTEGRO',repeat('4',64)
);
-- Venta fiscal aprobada sin marcador de período: el estado fiscal por sí solo
-- debe volver inmutables al padre y a sus hijos para todo no-owner.
INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,estado,
  afip_estado,cae,afip_numero,afip_emisor_cuit
) VALUES (
  'd2100000-0000-0000-0000-000000000005',
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
  'NC-PERIODO-APROBADA-SIN-MARCADOR','VENTA','ACTIVA',
  'APROBADO','CAE-APROBADA-SIN-MARCADOR',921005,'30714199664'
);
-- Caso separado para demostrar que un flujo legítimo aún puede llegar a
-- APROBADO: OLD no está aprobado y el guard no debe mirar NEW.afip_estado.
INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,estado,
  afip_estado
) VALUES (
  'd2100000-0000-0000-0000-000000000006',
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
  'NC-PERIODO-TRANSICION-A-APROBADA','VENTA','ACTIVA','PENDIENTE'
);

INSERT INTO public.venta_items(
  id,venta_id,codigo,descripcion,cantidad,precio_unitario_sin_iva,
  iva_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
) VALUES
  ('e2100000-0000-0000-0000-000000000001','d2100000-0000-0000-0000-000000000002','PER-1','Item período',-1,100,21,-100,-21,-121),
  ('e2100000-0000-0000-0000-000000000002','d2100000-0000-0000-0000-000000000004','APR-1','Item aprobado',-1,100,21,-100,-21,-121),
  ('e2100000-0000-0000-0000-000000000003','d2100000-0000-0000-0000-000000000005','APR-2','Item aprobado sin marcador',1,100,21,100,21,121);
INSERT INTO public.venta_pagos(id,venta_id,forma_pago,monto)
VALUES
  ('f2100000-0000-0000-0000-000000000001','d2100000-0000-0000-0000-000000000002','EFECTIVO',-121),
  ('f2100000-0000-0000-0000-000000000002','d2100000-0000-0000-0000-000000000004','EFECTIVO',-121),
  ('f2100000-0000-0000-0000-000000000003','d2100000-0000-0000-0000-000000000005','EFECTIVO',121);
INSERT INTO public.nota_credito_periodo_reintegros(venta_id,forma_pago,monto,orden)
VALUES ('d2100000-0000-0000-0000-000000000002','EFECTIVO',121,0);

-- Las policies existentes de hijos son deliberadamente amplias. Los grants
-- temporales y la policy DELETE temporal comprueban que los triggers siguen
-- siendo la barrera aunque privilegios futuros se amplíen accidentalmente.
GRANT UPDATE,DELETE ON public.ventas TO authenticated;
GRANT INSERT,UPDATE,DELETE ON public.venta_items,public.venta_pagos TO authenticated;
CREATE POLICY test_ventas_delete_nc_periodo ON public.ventas
  FOR DELETE TO authenticated
  USING (public.is_admin(auth.uid()) OR sucursal_id=public.current_sucursal_id());

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a2100000-0000-0000-0000-000000000002","role":"authenticated"}',true);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.ventas(
      sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,estado,
      nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
      motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash
    ) VALUES (
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b2100000-0000-0000-0000-000000000001','a2100000-0000-0000-0000-000000000002',
      'NC-PERIODO-DIRECTA','NOTA_CREDITO','PENDIENTE_FISCAL',
      'DEVOLUCION_PRODUCTOS','2026-07-01','2026-07-31','Inserción directa','REINTEGRO',repeat('5',64)
    );
    RAISE EXCEPTION 'authenticated insertó una NC por período' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.ventas SET observaciones='mutación directa'
     WHERE id='d2100000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'authenticated actualizó una NC por período' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.ventas WHERE id='d2100000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'authenticated eliminó una NC por período' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.ventas SET observaciones='post CAE'
     WHERE id='d2100000-0000-0000-0000-000000000004';
    RAISE EXCEPTION 'authenticated actualizó una NC aprobada' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.ventas WHERE id='d2100000-0000-0000-0000-000000000004';
    RAISE EXCEPTION 'authenticated eliminó una NC aprobada' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.venta_items(
      venta_id,codigo,descripcion,cantidad,precio_unitario_sin_iva,
      iva_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
    ) VALUES (
      'd2100000-0000-0000-0000-000000000002','DIRECTO','Directo',-1,10,21,-10,-2.1,-12.1
    );
    RAISE EXCEPTION 'authenticated insertó un item de NC por período' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.venta_items SET descripcion='mutado'
     WHERE id='e2100000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'authenticated actualizó un item de NC por período' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.venta_items
     WHERE id='e2100000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'authenticated eliminó un item de NC por período' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.venta_pagos(venta_id,forma_pago,monto)
    VALUES ('d2100000-0000-0000-0000-000000000002','EFECTIVO',-1);
    RAISE EXCEPTION 'authenticated insertó un pago de NC por período' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.venta_pagos SET monto=-1
     WHERE id='f2100000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'authenticated actualizó un pago de NC por período' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.venta_pagos
     WHERE id='f2100000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'authenticated eliminó un pago de NC por período' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.nota_credito_periodo_reintegros(venta_id,forma_pago,monto,orden)
    VALUES ('d2100000-0000-0000-0000-000000000002','EFECTIVO',1,1);
    RAISE EXCEPTION 'authenticated insertó una intención de reintegro' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.nota_credito_periodo_reintegros SET monto=1;
    RAISE EXCEPTION 'authenticated actualizó una intención de reintegro' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.nota_credito_periodo_reintegros;
    RAISE EXCEPTION 'authenticated eliminó una intención de reintegro' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- El empleado de la sucursal ve el reintegro a través de la venta padre.
DO $$
BEGIN
  IF (SELECT count(*) FROM public.nota_credito_periodo_reintegros
       WHERE venta_id='d2100000-0000-0000-0000-000000000002') <> 1 THEN
    RAISE EXCEPTION 'el empleado no ve la intención de su sucursal';
  END IF;
END $$;

RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);

-- `service_role` no es dueño de las tablas: una fila cuyo OLD ya está
-- APROBADO y todos sus hijos quedan protegidos aun sin marcador de período.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
DO $$
BEGIN
  BEGIN
    UPDATE public.ventas SET observaciones='mutación post-CAE'
     WHERE id='d2100000-0000-0000-0000-000000000005';
    RAISE EXCEPTION 'service_role actualizó una venta ya aprobada' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.ventas
     WHERE id='d2100000-0000-0000-0000-000000000005';
    RAISE EXCEPTION 'service_role eliminó una venta ya aprobada' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.venta_items(
      venta_id,codigo,descripcion,cantidad,precio_unitario_sin_iva,
      iva_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
    ) VALUES (
      'd2100000-0000-0000-0000-000000000005','APR-DIRECTO','Directo',1,10,21,10,2.1,12.1
    );
    RAISE EXCEPTION 'service_role insertó un item post-CAE' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.venta_items SET descripcion='mutado post-CAE'
     WHERE id='e2100000-0000-0000-0000-000000000003';
    RAISE EXCEPTION 'service_role actualizó un item post-CAE' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.venta_items
     WHERE id='e2100000-0000-0000-0000-000000000003';
    RAISE EXCEPTION 'service_role eliminó un item post-CAE' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.venta_pagos(venta_id,forma_pago,monto)
    VALUES ('d2100000-0000-0000-0000-000000000005','EFECTIVO',1);
    RAISE EXCEPTION 'service_role insertó un pago post-CAE' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.venta_pagos SET monto=1
     WHERE id='f2100000-0000-0000-0000-000000000003';
    RAISE EXCEPTION 'service_role actualizó un pago post-CAE' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.venta_pagos
     WHERE id='f2100000-0000-0000-0000-000000000003';
    RAISE EXCEPTION 'service_role eliminó un pago post-CAE' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- La transición hacia APROBADO sigue disponible porque OLD no estaba aprobado.
UPDATE public.ventas
   SET afip_estado='APROBADO',
       cae='CAE-TRANSICION-VALIDA',
       afip_numero=921006,
       afip_emisor_cuit='30714199664'
 WHERE id='d2100000-0000-0000-0000-000000000006';
DO $$
BEGIN
  IF (SELECT afip_estado FROM public.ventas
       WHERE id='d2100000-0000-0000-0000-000000000006') <> 'APROBADO' THEN
    RAISE EXCEPTION 'la transición legítima hacia APROBADO fue bloqueada';
  END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);

-- Un perfil sin sucursal no puede atravesar la policy de la venta padre.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a2100000-0000-0000-0000-000000000004","role":"authenticated"}',true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.nota_credito_periodo_reintegros) THEN
    RAISE EXCEPTION 'un empleado ajeno vio intenciones de otra sucursal';
  END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);

-- Un empleado no puede autoasignarse la capacidad fiscal nueva.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a2100000-0000-0000-0000-000000000003","role":"authenticated"}',true);
DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET puede_emitir_nc_periodo=true
     WHERE id='a2100000-0000-0000-0000-000000000003';
    RAISE EXCEPTION 'el empleado se autoasignó puede_emitir_nc_periodo' USING ERRCODE='ZX001';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);

-- El admin activo es capaz aunque su flag almacenado sea false y administra al
-- empleado sólo mediante las RPC privilegiadas.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a2100000-0000-0000-0000-000000000001","role":"authenticated"}',true);
DO $$
BEGIN
  IF NOT public.puede_emitir_nc_periodo() THEN
    RAISE EXCEPTION 'el admin activo no recibió capacidad efectiva';
  END IF;
  IF (SELECT puede_emitir_nc_periodo FROM public.profiles
       WHERE id='a2100000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'la prueba de admin no partió del flag almacenado false';
  END IF;
END $$;
SELECT public.administrar_puede_emitir_nc_periodo(
  'a2100000-0000-0000-0000-000000000002',true
);
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a2100000-0000-0000-0000-000000000002","role":"authenticated"}',true);
DO $$
BEGIN
  IF public.puede_emitir_nc_periodo() THEN
    RAISE EXCEPTION 'el empleado sin puede_facturar obtuvo capacidad efectiva';
  END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a2100000-0000-0000-0000-000000000001","role":"authenticated"}',true);
SELECT public.administrar_puede_facturar(
  'a2100000-0000-0000-0000-000000000002',true
);
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a2100000-0000-0000-0000-000000000002","role":"authenticated"}',true);
DO $$
BEGIN
  IF NOT public.puede_emitir_nc_periodo() THEN
    RAISE EXCEPTION 'el empleado activo con ambas capacidades fue rechazado';
  END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"sub":"a2100000-0000-0000-0000-000000000001","role":"service_role"}',true);
SELECT public.iniciar_transicion_usuario_activo(
  'a2100000-0000-0000-0000-000000000001',
  'a2100000-0000-0000-0000-000000000002',
  false,
  'c2100000-0000-0000-0000-000000000001'
);
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a2100000-0000-0000-0000-000000000002","role":"authenticated"}',true);
DO $$
BEGIN
  IF public.puede_emitir_nc_periodo() THEN
    RAISE EXCEPTION 'el empleado inactivo conservó capacidad efectiva';
  END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);

-- La RPC también exige que el administrador que llama siga activo.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"sub":"a2100000-0000-0000-0000-000000000001","role":"service_role"}',true);
SELECT public.iniciar_transicion_usuario_activo(
  'a2100000-0000-0000-0000-000000000001',
  'a2100000-0000-0000-0000-000000000001',
  false,
  'c2100000-0000-0000-0000-000000000002'
);
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a2100000-0000-0000-0000-000000000001","role":"authenticated"}',true);
DO $$
BEGIN
  BEGIN
    PERFORM public.administrar_puede_emitir_nc_periodo(
      'a2100000-0000-0000-0000-000000000003',true
    );
    RAISE EXCEPTION 'un admin inactivo administró la capacidad' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

ROLLBACK;
SQL

echo "✓ constraints, RLS, guards y capacidad efectiva de NC por período"
echo "✅ Contrato durable de notas de crédito por período correcto."
