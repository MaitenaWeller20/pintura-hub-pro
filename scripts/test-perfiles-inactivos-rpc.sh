#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^" ]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)

EMPLEADO_ID="a4180000-0000-4000-8000-000000000001"
ADMIN_ID="a4180000-0000-4000-8000-000000000002"
CLIENTE_ID="b4180000-0000-4000-8000-000000000001"
PRODUCTO_ID="c4180000-0000-4000-8000-000000000001"
VENTA_ID="d4180000-0000-4000-8000-000000000001"
REMITO_ID="e4180000-0000-4000-8000-000000000001"

q() { "${PSQL[@]}" -qAtc "$1"; }
ORIGEN_ID="$(q "SELECT id FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1")"
DESTINO_ID="$(q "SELECT id FROM public.sucursales WHERE activa AND id<>'$ORIGEN_ID' ORDER BY numero LIMIT 1")"
if [[ -z "$ORIGEN_ID" || -z "$DESTINO_ID" ]]; then
  echo "Se necesitan dos sucursales activas en la base local." >&2
  exit 1
fi

"${PSQL[@]}" <<SQL
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(p_sql text,p_expected text,p_message text)
RETURNS void
LANGUAGE plpgsql
AS \$\$
DECLARE
  v_message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
    IF v_message NOT ILIKE '%'||p_expected||'%' THEN
      RAISE EXCEPTION 'FALLO: % — esperaba %, obtuvo %',p_message,p_expected,v_message;
    END IF;
    RAISE NOTICE '✓ %',p_message;
    RETURN;
  END;
  RAISE EXCEPTION 'FALLO: % — la operación no fue rechazada',p_message;
END;
\$\$;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_ok boolean,p_message text)
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

SELECT pg_temp.assert_true(
  (SELECT pg_catalog.count(*)=3 AND pg_catalog.bool_and(p.prosecdef)
     FROM pg_catalog.pg_proc AS p
    WHERE p.oid IN (
      'public.anular_venta(uuid,uuid)'::regprocedure,
      'public.aprobar_remito(uuid)'::regprocedure,
      'public.rechazar_remito(uuid,text)'::regprocedure
    )),
  'las tres entradas privilegiadas conservan SECURITY DEFINER'
);

INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES
  (
    '$EMPLEADO_ID','00000000-0000-0000-0000-000000000000',
    'authenticated','authenticated','t17-inactivo-empleado@local.test','x',now(),now(),now()
  ),
  (
    '$ADMIN_ID','00000000-0000-0000-0000-000000000000',
    'authenticated','authenticated','t17-inactivo-admin@local.test','x',now(),now(),now()
  );

UPDATE public.profiles
   SET username='t17_inactivo_empleado',nombre_completo='Empleado inactivo T17',
       sucursal_id='$DESTINO_ID',activo=false
 WHERE id='$EMPLEADO_ID';
UPDATE public.profiles
   SET username='t17_inactivo_admin',nombre_completo='Admin inactivo T17',
       sucursal_id=NULL,activo=false
 WHERE id='$ADMIN_ID';

INSERT INTO public.profile_sucursales(profile_id,sucursal_id)
VALUES ('$EMPLEADO_ID','$DESTINO_ID');
DELETE FROM public.user_roles WHERE user_id IN ('$EMPLEADO_ID','$ADMIN_ID');
INSERT INTO public.user_roles(user_id,role)
VALUES ('$ADMIN_ID','admin');

INSERT INTO public.clientes(id,razon_social,tipo,activo,sucursal_habitual_id)
VALUES ('$CLIENTE_ID','CLIENTE PERFIL INACTIVO T17','CONSUMIDOR_FINAL',true,'$DESTINO_ID');
INSERT INTO public.productos(
  id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado
) VALUES (
  '$PRODUCTO_ID','T17-INACTIVO-RPC','PRODUCTO PERFIL INACTIVO T17',100,21,true,false
);
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
VALUES ('$PRODUCTO_ID','$ORIGEN_ID',10);

INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,total,afip_estado
) VALUES (
  '$VENTA_ID','$DESTINO_ID','$CLIENTE_ID','$EMPLEADO_ID',
  'T17-INACTIVO-VTA','VENTA','CONTADO',0,'SIN_FACTURAR'
);
INSERT INTO public.remitos(
  id,numero,sucursal_origen_id,sucursal_destino_id,creado_por,observaciones
) VALUES (
  '$REMITO_ID','T17-INACTIVO-REM','$ORIGEN_ID','$DESTINO_ID',
  '$EMPLEADO_ID','T17 perfiles inactivos'
);
INSERT INTO public.remito_items(remito_id,producto_id,cantidad)
VALUES ('$REMITO_ID','$PRODUCTO_ID',1);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims='{"sub":"$EMPLEADO_ID","role":"authenticated"}';

SELECT pg_temp.assert_raises(
  \$q\$SELECT * FROM public.anular_venta('$VENTA_ID')\$q\$,
  'perfil autenticado no existe o está inactivo',
  'un empleado inactivo no puede anular ventas con un JWT todavía vigente'
);
SELECT pg_temp.assert_raises(
  \$q\$SELECT public.aprobar_remito('$REMITO_ID')\$q\$,
  'perfil autenticado no existe o está inactivo',
  'un empleado inactivo no puede aprobar remitos con un JWT todavía vigente'
);
SELECT pg_temp.assert_raises(
  \$q\$SELECT public.rechazar_remito('$REMITO_ID','rechazo indebido')\$q\$,
  'perfil autenticado no existe o está inactivo',
  'un empleado inactivo no puede rechazar remitos con un JWT todavía vigente'
);

SET LOCAL request.jwt.claims='{"sub":"$ADMIN_ID","role":"authenticated"}';

SELECT pg_temp.assert_raises(
  \$q\$SELECT * FROM public.anular_venta('$VENTA_ID')\$q\$,
  'perfil autenticado no existe o está inactivo',
  'un admin inactivo no puede anular ventas con un JWT todavía vigente'
);
SELECT pg_temp.assert_raises(
  \$q\$SELECT public.aprobar_remito('$REMITO_ID')\$q\$,
  'perfil autenticado no existe o está inactivo',
  'un admin inactivo no puede aprobar remitos con un JWT todavía vigente'
);
SELECT pg_temp.assert_raises(
  \$q\$SELECT public.rechazar_remito('$REMITO_ID','rechazo indebido')\$q\$,
  'perfil autenticado no existe o está inactivo',
  'un admin inactivo no puede rechazar remitos con un JWT todavía vigente'
);

RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT estado='ACTIVA' FROM public.ventas WHERE id='$VENTA_ID')
  AND (SELECT estado='PENDIENTE' FROM public.remitos WHERE id='$REMITO_ID')
  AND (SELECT cantidad=10 FROM public.stock_sucursal
        WHERE producto_id='$PRODUCTO_ID' AND sucursal_id='$ORIGEN_ID'),
  'todos los rechazos ocurren antes de mutar venta, remito o stock'
);

ROLLBACK;
SQL

echo "Perfiles inactivos en RPC privilegiadas: OK"
