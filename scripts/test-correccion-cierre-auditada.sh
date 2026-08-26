#!/usr/bin/env bash
# Corrección de cierres: cálculo atómico, permisos, versionado y auditoría.
# Todo sucede dentro de una transacción que termina en ROLLBACK.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL client_min_messages TO WARNING;

INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES
  ('a3000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','admin-cierre@test.local','x',now(),now(),now()),
  ('a3000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','empleado-cierre@test.local','x',now(),now(),now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id,username,nombre_completo,activo,sucursal_id)
VALUES
  ('a3000000-0000-0000-0000-000000000001','admin_cierre_test','Admin cierre',true,(SELECT id FROM public.sucursales ORDER BY created_at LIMIT 1)),
  ('a3000000-0000-0000-0000-000000000002','empleado_cierre_test','Empleado cierre',true,(SELECT id FROM public.sucursales ORDER BY created_at LIMIT 1))
ON CONFLICT (id) DO UPDATE SET activo=true;
-- El trigger de auth puede haber creado el perfil al insertar auth.users.
UPDATE public.profiles
SET username=CASE id
      WHEN 'a3000000-0000-0000-0000-000000000001'::uuid THEN 'admin_cierre_test'
      ELSE 'empleado_cierre_test'
    END,
    nombre_completo=CASE id
      WHEN 'a3000000-0000-0000-0000-000000000001'::uuid THEN 'Admin cierre'
      ELSE 'Empleado cierre'
    END,
    sucursal_id=(SELECT id FROM public.sucursales ORDER BY created_at LIMIT 1),
    activo=true
WHERE id IN (
  'a3000000-0000-0000-0000-000000000001'::uuid,
  'a3000000-0000-0000-0000-000000000002'::uuid
);

INSERT INTO public.user_roles (user_id,role)
VALUES ('a3000000-0000-0000-0000-000000000001','admin')
ON CONFLICT DO NOTHING;

UPDATE public.caja_sesiones
SET estado='CERRADA',cerrada_en=COALESCE(cerrada_en,now())
WHERE sucursal_id=(SELECT id FROM public.sucursales ORDER BY created_at LIMIT 1)
  AND estado='ABIERTA';

INSERT INTO public.caja_sesiones (
  id,sucursal_id,estado,abierta_por,abierta_en,fondo_inicial,cerrada_por,cerrada_en,
  esperado,contado,diferencia,total_esperado,total_contado,total_diferencia,
  efectivo_dejado,notas
) VALUES (
  'c3000000-0000-0000-0000-000000000001',
  (SELECT id FROM public.sucursales ORDER BY created_at LIMIT 1),
  'CERRADA','a3000000-0000-0000-0000-000000000001','2026-08-25 10:00:00+00',0,
  'a3000000-0000-0000-0000-000000000001','2026-08-25 18:00:00+00',
  '{"EFECTIVO":{"entra":100,"sale":0,"neto":100},"CHEQUE":{"entra":200,"sale":0,"neto":200}}',
  '{"EFECTIVO":10,"CHEQUE":200}',
  '{"EFECTIVO":-90,"CHEQUE":0}',300,210,-90,5,'Conteo original'
);

INSERT INTO public.caja_sesiones (
  id,sucursal_id,estado,abierta_por,abierta_en,fondo_inicial,cerrada_por,cerrada_en,
  esperado,contado,diferencia,total_esperado,total_contado,total_diferencia,
  efectivo_dejado,notas
) VALUES
  (
    'c3000000-0000-0000-0000-000000000003',
    (SELECT id FROM public.sucursales ORDER BY created_at LIMIT 1),
    'CERRADA','a3000000-0000-0000-0000-000000000001','2026-08-23 10:00:00+00',0,
    'a3000000-0000-0000-0000-000000000001','2026-08-23 18:00:00+00',
    NULL,'{"EFECTIVO":10}',NULL,NULL,10,NULL,5,'Esperado histórico ausente'
  ),
  (
    'c3000000-0000-0000-0000-000000000004',
    (SELECT id FROM public.sucursales ORDER BY created_at LIMIT 1),
    'CERRADA','a3000000-0000-0000-0000-000000000001','2026-08-24 10:00:00+00',0,
    'a3000000-0000-0000-0000-000000000001','2026-08-24 18:00:00+00',
    '{"EFECTIVO":{"entra":10,"sale":0,"neto":10}}',NULL,NULL,10,NULL,NULL,5,
    'Conteo histórico ausente'
  );

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"a3000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT * FROM public.corregir_cierre_caja(
  'c3000000-0000-0000-0000-000000000001',100,20,
  'Conteo corregido','Se había omitido un billete en el conteo',0
);

DO $assert_snapshots_historicos$
DECLARE
  v_id uuid;
  v_error text;
BEGIN
  FOREACH v_id IN ARRAY ARRAY[
    'c3000000-0000-0000-0000-000000000003'::uuid,
    'c3000000-0000-0000-0000-000000000004'::uuid
  ] LOOP
    v_error := NULL;
    BEGIN
      PERFORM * FROM public.corregir_cierre_caja(
        v_id,10,5,'Sin cambio','Prueba de detalle histórico ausente',0
      );
    EXCEPTION WHEN OTHERS THEN
      v_error := SQLERRM;
    END;
    IF v_error IS NULL OR position('histórico' IN lower(v_error))=0 THEN
      RAISE EXCEPTION 'Un snapshot SQL-null se corrigió o devolvió otro mensaje (%): %',v_id,v_error;
    END IF;
  END LOOP;
END;
$assert_snapshots_historicos$;

DO $assert_primera$
DECLARE
  v_sesion public.caja_sesiones%ROWTYPE;
  v_auditoria public.caja_cierre_correcciones%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_sesion
  FROM public.caja_sesiones
  WHERE id='c3000000-0000-0000-0000-000000000001';

  IF (v_sesion.contado->>'EFECTIVO')::numeric <> 100
     OR (v_sesion.contado->>'CHEQUE')::numeric <> 200
     OR (v_sesion.diferencia->>'EFECTIVO')::numeric <> 0
     OR v_sesion.total_esperado <> 300
     OR v_sesion.total_contado <> 300
     OR v_sesion.total_diferencia <> 0
     OR v_sesion.efectivo_dejado <> 20
     OR v_sesion.correccion_version <> 1 THEN
    RAISE EXCEPTION 'La primera corrección no recalculó el cierre correctamente';
  END IF;

  SELECT * INTO STRICT v_auditoria
  FROM public.caja_cierre_correcciones
  WHERE caja_sesion_id=v_sesion.id;

  IF v_auditoria.corregida_por <> 'a3000000-0000-0000-0000-000000000001'
     OR v_auditoria.motivo <> 'Se había omitido un billete en el conteo'
     OR v_auditoria.version_anterior <> 0
     OR v_auditoria.version_nueva <> 1
     OR (v_auditoria.valores_anteriores->'contado'->>'EFECTIVO')::numeric <> 10
     OR (v_auditoria.valores_nuevos->'contado'->>'EFECTIVO')::numeric <> 100
     OR NOT (v_auditoria.campos_modificados @> ARRAY['efectivo_contado','efectivo_dejado','notas']) THEN
    RAISE EXCEPTION 'La auditoría no conservó actor, motivo, versiones y valores';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.caja_cierre_correcciones AS correccion
    JOIN public.profiles AS perfil ON perfil.id=correccion.corregida_por
    WHERE correccion.id=v_auditoria.id
      AND perfil.nombre_completo='Admin cierre'
  ) THEN
    RAISE EXCEPTION 'El administrador no puede resolver quién hizo la corrección';
  END IF;
END;
$assert_primera$;

DO $assert_rechazos$
DECLARE
  v_error text;
  v_bloqueada boolean := false;
BEGIN
  BEGIN
    PERFORM * FROM public.corregir_cierre_caja(
      'c3000000-0000-0000-0000-000000000001',101,20,
      'Otro conteo','Intento con una versión vieja',0
    );
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
  END;
  IF v_error IS NULL OR position('otra persona' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'La función aceptó una versión obsoleta o devolvió un mensaje incoherente: %',v_error;
  END IF;

  BEGIN
    UPDATE public.caja_cierre_correcciones SET motivo='alterado';
  EXCEPTION WHEN insufficient_privilege THEN
    v_bloqueada := true;
  END;
  IF NOT v_bloqueada THEN
    RAISE EXCEPTION 'La auditoría permitió una modificación directa';
  END IF;
END;
$assert_rechazos$;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a3000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
DO $assert_empleado$
DECLARE v_error text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.caja_cierre_correcciones
    WHERE caja_sesion_id='c3000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'Un empleado pudo leer la auditoría administrativa';
  END IF;

  BEGIN
    PERFORM * FROM public.corregir_cierre_caja(
      'c3000000-0000-0000-0000-000000000001',101,20,
      'Intento empleado','El empleado no debe corregir cierres',1
    );
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
  END;
  IF v_error IS NULL OR position('administrador' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'Un empleado pudo corregir o recibió otro error: %',v_error;
  END IF;
END;
$assert_empleado$;

RESET ROLE;
INSERT INTO public.caja_sesiones (
  id,sucursal_id,estado,abierta_por,abierta_en,fondo_inicial,cerrada_por,cerrada_en
) VALUES (
  'c3000000-0000-0000-0000-000000000002',
  (SELECT id FROM public.sucursales ORDER BY created_at LIMIT 1),
  'CERRADA','a3000000-0000-0000-0000-000000000001','2026-08-26 10:00:00+00',20,
  'a3000000-0000-0000-0000-000000000001','2026-08-26 18:00:00+00'
);
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"a3000000-0000-0000-0000-000000000001","role":"authenticated"}';

DO $assert_turno_posterior$
DECLARE v_error text;
BEGIN
  BEGIN
    PERFORM * FROM public.corregir_cierre_caja(
      'c3000000-0000-0000-0000-000000000001',110,30,
      'Ajuste posterior','También se intentó cambiar el fondo',1
    );
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
  END;
  IF v_error IS NULL OR position('turno posterior' IN v_error)=0 THEN
    RAISE EXCEPTION 'Se pudo cambiar un fondo ya usado o el mensaje no lo explicó: %',v_error;
  END IF;
END;
$assert_turno_posterior$;

SELECT * FROM public.corregir_cierre_caja(
  'c3000000-0000-0000-0000-000000000001',110,20,
  'Conteo final','Segundo ajuste sin cambiar el fondo heredado',1
);

DO $assert_final$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.caja_sesiones
    WHERE id='c3000000-0000-0000-0000-000000000001'
      AND correccion_version=2
      AND total_contado=310
      AND total_diferencia=10
  ) OR (
    SELECT count(*) FROM public.caja_cierre_correcciones
    WHERE caja_sesion_id='c3000000-0000-0000-0000-000000000001'
  ) <> 2 THEN
    RAISE EXCEPTION 'La segunda corrección válida no quedó versionada y auditada';
  END IF;
END;
$assert_final$;

ROLLBACK;
SQL

printf '✓ corrección de cierres: cálculo, permisos, concurrencia y auditoría\n'
