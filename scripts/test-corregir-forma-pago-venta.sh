#!/usr/bin/env bash
# Corrección administrativa del medio de un pago y recálculo de cierres.
# El fixture entero vive en una transacción que termina en ROLLBACK.
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
  ('a4000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','admin-pago@test.local','x',now(),now(),now()),
  ('a4000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','empleado-pago@test.local','x',now(),now(),now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id,username,nombre_completo,activo,sucursal_id)
VALUES
  ('a4000000-0000-0000-0000-000000000001','admin_pago_test','Admin pago',true,(SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1)),
  ('a4000000-0000-0000-0000-000000000002','empleado_pago_test','Empleado pago',true,(SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1))
ON CONFLICT (id) DO UPDATE SET activo=true;
UPDATE public.profiles
SET username=CASE id
      WHEN 'a4000000-0000-0000-0000-000000000001'::uuid THEN 'admin_pago_test'
      ELSE 'empleado_pago_test'
    END,
    nombre_completo=CASE id
      WHEN 'a4000000-0000-0000-0000-000000000001'::uuid THEN 'Admin pago'
      ELSE 'Empleado pago'
    END,
    sucursal_id=(SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1),
    activo=true
WHERE id IN (
  'a4000000-0000-0000-0000-000000000001'::uuid,
  'a4000000-0000-0000-0000-000000000002'::uuid
);
INSERT INTO public.user_roles(user_id,role)
VALUES ('a4000000-0000-0000-0000-000000000001','admin')
ON CONFLICT DO NOTHING;

UPDATE public.caja_sesiones
SET estado='CERRADA',cerrada_en=coalesce(cerrada_en,now())
WHERE estado='ABIERTA';

INSERT INTO public.caja_sesiones(
  id,sucursal_id,estado,abierta_por,abierta_en,fondo_inicial,cerrada_por,cerrada_en,
  esperado,contado,diferencia,total_esperado,total_contado,total_diferencia,
  efectivo_dejado,notas
) VALUES
  (
    'c4000000-0000-0000-0000-000000000001',
    (SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1),
    'CERRADA','a4000000-0000-0000-0000-000000000001','2026-08-30 10:00:00+00',0,
    'a4000000-0000-0000-0000-000000000001','2026-08-30 18:00:00+00',
    '{"EFECTIVO":{"entra":100,"sale":0,"neto":100},"TRANSFERENCIA":{"entra":50,"sale":0,"neto":50}}',
    '{"EFECTIVO":90,"TRANSFERENCIA":50}',
    '{"EFECTIVO":-10,"TRANSFERENCIA":0}',150,140,-10,20,'Cierre que se recalcula'
  ),
  (
    'c4000000-0000-0000-0000-000000000002',
    (SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1),
    'CERRADA','a4000000-0000-0000-0000-000000000001','2026-08-29 10:00:00+00',0,
    'a4000000-0000-0000-0000-000000000001','2026-08-29 18:00:00+00',
    '{"EFECTIVO":{"entra":25,"sale":0,"neto":25}}',
    '{"EFECTIVO":"incompatible"}',
    '{"EFECTIVO":0}',25,25,0,5,'Snapshot inválido para probar rollback'
  ),
  (
    'c4000000-0000-0000-0000-000000000003',
    (SELECT id FROM public.sucursales ORDER BY created_at,id OFFSET 1 LIMIT 1),
    'ABIERTA','a4000000-0000-0000-0000-000000000001','2026-08-31 10:00:00+00',0,
    NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
  );

INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,total,total_pagado,estado_pago,estado,caja_sesion_id,afip_estado
) VALUES
  (
    'e4000000-0000-0000-0000-000000000001',
    (SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1),
    (SELECT id FROM public.clientes ORDER BY created_at,id LIMIT 1),
    'a4000000-0000-0000-0000-000000000001','CORR-FP-1','VENTA',
    'CONTADO',150,150,'PAGADO','ACTIVA','c4000000-0000-0000-0000-000000000001','NO_APLICA'
  ),
  (
    'e4000000-0000-0000-0000-000000000002',
    (SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1),
    (SELECT id FROM public.clientes ORDER BY created_at,id LIMIT 1),
    'a4000000-0000-0000-0000-000000000001','CORR-FP-2','VENTA',
    'CONTADO',25,25,'PAGADO','ACTIVA','c4000000-0000-0000-0000-000000000002','NO_APLICA'
  ),
  (
    'e4000000-0000-0000-0000-000000000003',
    (SELECT id FROM public.sucursales ORDER BY created_at,id LIMIT 1),
    (SELECT id FROM public.clientes ORDER BY created_at,id LIMIT 1),
    'a4000000-0000-0000-0000-000000000001','CORR-FP-3','VENTA',
    'CONTADO',3,0,'PENDIENTE','ANULADA','c4000000-0000-0000-0000-000000000002','NO_APLICA'
  ),
  (
    'e4000000-0000-0000-0000-000000000004',
    (SELECT id FROM public.sucursales ORDER BY created_at,id OFFSET 1 LIMIT 1),
    (SELECT id FROM public.clientes ORDER BY created_at,id LIMIT 1),
    'a4000000-0000-0000-0000-000000000001','CORR-FP-4','VENTA',
    'CONTADO',10,10,'PAGADO','ACTIVA','c4000000-0000-0000-0000-000000000003','NO_APLICA'
  );

INSERT INTO public.venta_pagos(id,venta_id,forma_pago,monto,detalle,caja_sesion_id)
VALUES
  ('f4000000-0000-0000-0000-000000000001','e4000000-0000-0000-0000-000000000001','EFECTIVO',100,'{"origen":"mostrador"}',NULL),
  ('f4000000-0000-0000-0000-000000000002','e4000000-0000-0000-0000-000000000001','TRANSFERENCIA',50,'{"banco":"Banco anterior"}','c4000000-0000-0000-0000-000000000001'),
  ('f4000000-0000-0000-0000-000000000003','e4000000-0000-0000-0000-000000000003','EFECTIVO',1,'{}',NULL),
  ('f4000000-0000-0000-0000-000000000004','e4000000-0000-0000-0000-000000000001','EFECTIVO',0,'{}','c4000000-0000-0000-0000-000000000002'),
  ('f4000000-0000-0000-0000-000000000005','e4000000-0000-0000-0000-000000000001','EFECTIVO',-1,'{}','c4000000-0000-0000-0000-000000000002'),
  ('f4000000-0000-0000-0000-000000000006','e4000000-0000-0000-0000-000000000001','CTA_CTE',1,'{}','c4000000-0000-0000-0000-000000000002'),
  ('f4000000-0000-0000-0000-000000000007','e4000000-0000-0000-0000-000000000002','EFECTIVO',25,'{}',NULL),
  ('f4000000-0000-0000-0000-000000000008','e4000000-0000-0000-0000-000000000004','TRANSFERENCIA',10,'{}',NULL);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"a4000000-0000-0000-0000-000000000002","role":"authenticated"}';

DO $rechaza_empleado$
DECLARE v_error text;
BEGIN
  BEGIN
    PERFORM * FROM public.corregir_forma_pago_venta(
      'f4000000-0000-0000-0000-000000000001','CHEQUE',
      'Intento de una persona sin permiso',0
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('administrador' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'Un empleado pudo corregir el pago o recibió otro error: %',v_error;
  END IF;
END;
$rechaza_empleado$;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a4000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

SELECT * FROM public.corregir_forma_pago_venta(
  'f4000000-0000-0000-0000-000000000001','CHEQUE',
  'Se informó efectivo en vez de cheque',0
);

DO $assert_primera$
DECLARE
  v_pago public.venta_pagos%ROWTYPE;
  v_caja public.caja_sesiones%ROWTYPE;
  v_auditoria public.venta_pago_correcciones%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_pago FROM public.venta_pagos
  WHERE id='f4000000-0000-0000-0000-000000000001';
  SELECT * INTO STRICT v_caja FROM public.caja_sesiones
  WHERE id='c4000000-0000-0000-0000-000000000001';
  SELECT * INTO STRICT v_auditoria FROM public.venta_pago_correcciones
  WHERE venta_pago_id=v_pago.id;

  IF v_pago.forma_pago<>'CHEQUE' OR v_pago.detalle<>'{}'::jsonb
     OR v_pago.correccion_version<>1 THEN
    RAISE EXCEPTION 'El RPC modificó campos incorrectos o no versionó el pago';
  END IF;
  IF (v_caja.esperado->'CHEQUE'->>'neto')::numeric<>100
     OR (v_caja.esperado->'TRANSFERENCIA'->>'neto')::numeric<>50
     OR (v_caja.contado->>'EFECTIVO')::numeric<>90
     OR (v_caja.contado->>'CHEQUE')::numeric<>100
     OR (v_caja.contado->>'TRANSFERENCIA')::numeric<>50
     OR (v_caja.diferencia->>'EFECTIVO')::numeric<>90
     OR (v_caja.diferencia->>'CHEQUE')::numeric<>0
     OR v_caja.total_esperado<>150 OR v_caja.total_contado<>240
     OR v_caja.total_diferencia<>90 OR v_caja.efectivo_dejado<>20
     OR v_caja.notas<>'Cierre que se recalcula' OR v_caja.correccion_version<>1 THEN
    RAISE EXCEPTION 'La caja cerrada no se recalculó preservando sólo el efectivo físico';
  END IF;
  IF v_auditoria.forma_pago_anterior<>'EFECTIVO'
     OR v_auditoria.forma_pago_nueva<>'CHEQUE'
     OR v_auditoria.monto<>100
     OR v_auditoria.detalle_anterior->>'origen'<>'mostrador'
     OR v_auditoria.detalle_nuevo<>'{}'::jsonb
     OR v_auditoria.version_anterior<>0 OR v_auditoria.version_nueva<>1 THEN
    RAISE EXCEPTION 'La auditoría del pago no conservó el antes/después completo';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.caja_cierre_correcciones AS c
    WHERE c.caja_sesion_id=v_caja.id
      AND c.campos_modificados=ARRAY['forma_pago_venta']
      AND c.valores_anteriores->'pago'->>'id'=v_pago.id::text
      AND c.valores_anteriores->'pago'->>'forma_pago'='EFECTIVO'
      AND c.valores_nuevos->'pago'->>'forma_pago'='CHEQUE'
  ) THEN
    RAISE EXCEPTION 'La corrección automática no quedó en el historial de caja';
  END IF;
END;
$assert_primera$;

-- El segundo pago tiene caja propia: prueba la otra rama del COALESCE efectivo.
SELECT * FROM public.corregir_forma_pago_venta(
  'f4000000-0000-0000-0000-000000000002','MERCADO_PAGO',
  'La transferencia correspondía a Mercado Pago',0
);

-- Una caja todavía abierta toma el nuevo medio al cerrar; no necesita reescribir
-- snapshots ni sumar una corrección de cierre anticipada.
SELECT * FROM public.corregir_forma_pago_venta(
  'f4000000-0000-0000-0000-000000000008','CHEQUE',
  'El cobro abierto se recibió con cheque',0
);

DO $assert_segunda_y_rechazos$
DECLARE
  v_error text;
  v_bloqueada boolean:=false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.caja_sesiones
    WHERE id='c4000000-0000-0000-0000-000000000001'
      AND correccion_version=2
      AND esperado->'MERCADO_PAGO'->>'neto'='50.00'
      AND contado->>'TRANSFERENCIA'='0.00'
      AND contado->>'MERCADO_PAGO'='50.00'
  ) THEN
    RAISE EXCEPTION 'El pago con caja propia no actualizó el mismo cierre';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.venta_pagos
    WHERE id='f4000000-0000-0000-0000-000000000008'
      AND forma_pago='CHEQUE' AND correccion_version=1
  ) OR NOT EXISTS (
    SELECT 1 FROM public.caja_sesiones
    WHERE id='c4000000-0000-0000-0000-000000000003'
      AND estado='ABIERTA' AND correccion_version=0
  ) OR EXISTS (
    SELECT 1 FROM public.caja_cierre_correcciones
    WHERE caja_sesion_id='c4000000-0000-0000-0000-000000000003'
  ) THEN
    RAISE EXCEPTION 'Una caja abierta se trató incorrectamente como cierre histórico';
  END IF;

  BEGIN
    PERFORM * FROM public.corregir_forma_pago_venta(
      'f4000000-0000-0000-0000-000000000001','TRANSFERENCIA',
      'Intento con una versión vieja del pago',0
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('otra persona' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'Una versión obsoleta fue aceptada o devolvió otro error: %',v_error;
  END IF;

  v_error:=NULL;
  BEGIN
    PERFORM * FROM public.corregir_forma_pago_venta(
      'f4000000-0000-0000-0000-000000000001','CHEQUE',
      'El mismo medio no constituye una corrección',1
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('distinta' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'El RPC aceptó el mismo medio: %',v_error;
  END IF;

  v_error:=NULL;
  BEGIN
    PERFORM * FROM public.corregir_forma_pago_venta(
      'f4000000-0000-0000-0000-000000000001','CTA_CTE',
      'Cuenta corriente no es un medio corregible',1
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('cuenta corriente' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'El RPC aceptó CTA_CTE como destino: %',v_error;
  END IF;

  v_error:=NULL;
  BEGIN
    PERFORM * FROM public.corregir_forma_pago_venta(
      'f4000000-0000-0000-0000-000000000001','TRANSFERENCIA','mal',1
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('motivo' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'El RPC aceptó un motivo demasiado corto: %',v_error;
  END IF;

  v_error:=NULL;
  BEGIN
    PERFORM * FROM public.corregir_forma_pago_venta(
      'f4000000-0000-0000-0000-000000000003','CHEQUE',
      'La venta anulada no debe poder mutar',0
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('anulada' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'Se corrigió un pago de venta anulada: %',v_error;
  END IF;

  FOREACH v_error IN ARRAY ARRAY[
    'f4000000-0000-0000-0000-000000000004',
    'f4000000-0000-0000-0000-000000000005'
  ] LOOP
    BEGIN
      PERFORM * FROM public.corregir_forma_pago_venta(
        v_error::uuid,'CHEQUE','Un importe no positivo debe rechazarse',0
      );
      RAISE EXCEPTION 'Se corrigió un pago no positivo: %',v_error;
    EXCEPTION WHEN OTHERS THEN
      IF position('importe positivo' IN lower(SQLERRM))=0 THEN RAISE; END IF;
    END;
  END LOOP;

  v_error:=NULL;
  BEGIN
    PERFORM * FROM public.corregir_forma_pago_venta(
      'f4000000-0000-0000-0000-000000000006','CHEQUE',
      'Cuenta corriente no debe entrar en este flujo',0
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('cuenta corriente' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'CTA_CTE fue aceptada como pago corregible: %',v_error;
  END IF;

  BEGIN
    UPDATE public.venta_pago_correcciones SET motivo='alterado';
  EXCEPTION WHEN OTHERS THEN v_bloqueada:=true;
  END;
  IF NOT v_bloqueada THEN
    RAISE EXCEPTION 'La auditoría de pagos permitió UPDATE directo';
  END IF;

  v_bloqueada:=false;
  BEGIN
    UPDATE public.venta_pagos
    SET monto=999999
    WHERE id='f4000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN v_bloqueada:=true;
  END;
  IF NOT v_bloqueada THEN
    RAISE EXCEPTION 'Un cliente autenticado pudo alterar directamente el importe';
  END IF;
END;
$assert_segunda_y_rechazos$;

-- Un snapshot inválido debe abortar tanto caja como pago y auditoría.
DO $assert_rollback$
DECLARE v_error text;
BEGIN
  BEGIN
    PERFORM * FROM public.corregir_forma_pago_venta(
      'f4000000-0000-0000-0000-000000000007','CHEQUE',
      'El recálculo inválido tiene que deshacer todo',0
    );
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL OR position('incompatible' IN lower(v_error))=0 THEN
    RAISE EXCEPTION 'El snapshot inválido no frenó la operación: %',v_error;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.venta_pagos
    WHERE id='f4000000-0000-0000-0000-000000000007'
      AND forma_pago='EFECTIVO' AND correccion_version=0
  ) OR EXISTS (
    SELECT 1 FROM public.venta_pago_correcciones
    WHERE venta_pago_id='f4000000-0000-0000-0000-000000000007'
  ) THEN
    RAISE EXCEPTION 'El error de caja dejó una corrección parcial';
  END IF;
END;
$assert_rollback$;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a4000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
DO $assert_rls_empleado$
BEGIN
  IF EXISTS (SELECT 1 FROM public.venta_pago_correcciones) THEN
    RAISE EXCEPTION 'Un empleado pudo leer la auditoría administrativa de pagos';
  END IF;
END;
$assert_rls_empleado$;

ROLLBACK;
SQL

printf '✓ corrección de forma de pago: permisos, auditoría, versionado, caja y rollback\n'
