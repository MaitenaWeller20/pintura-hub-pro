#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)
TMP_DIR="$(mktemp -d)"

USUARIO_ID="a4160000-0000-4000-8000-000000000001"
OTRO_USUARIO_ID="a4160000-0000-4000-8000-000000000002"
PRODUCTO_ID="c4160000-0000-4000-8000-000000000001"
IDEM_VALIDO="d4160000-0000-4000-8000-000000000001"
IDEM_INVALIDO="d4160000-0000-4000-8000-000000000002"
IDEM_INACTIVO="d4160000-0000-4000-8000-000000000003"
IDEM_CONCURRENTE="d4160000-0000-4000-8000-000000000004"

q() { "${PSQL[@]}" -qAtc "$1"; }

ORIGEN_ID="$(q "SELECT id FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1")"
DESTINO_ID="$(q "SELECT id FROM public.sucursales WHERE activa AND id<>'$ORIGEN_ID' ORDER BY numero LIMIT 1")"
if [[ -z "$ORIGEN_ID" || -z "$DESTINO_ID" ]]; then
  echo "Se necesitan dos sucursales activas en la base local." >&2
  exit 1
fi

limpiar_fixtures() {
  "${PSQL[@]}" >/dev/null <<SQL
BEGIN;
DELETE FROM public.remito_items
 WHERE remito_id IN (
   SELECT id FROM public.remitos
    WHERE creado_por='$USUARIO_ID' OR observaciones LIKE 'T16-REM-AUTO%'
 );
DELETE FROM public.remitos
 WHERE creado_por IN ('$USUARIO_ID','$OTRO_USUARIO_ID') OR observaciones LIKE 'T16-REM-AUTO%';
DELETE FROM public.stock_movimientos WHERE producto_id='$PRODUCTO_ID';
DELETE FROM public.stock_sucursal WHERE producto_id='$PRODUCTO_ID';
DELETE FROM public.productos WHERE id='$PRODUCTO_ID' OR codigo='T16-REM-AUTO';
UPDATE public.profiles SET sucursal_id=NULL WHERE id IN ('$USUARIO_ID','$OTRO_USUARIO_ID');
DELETE FROM public.profile_sucursales WHERE profile_id IN ('$USUARIO_ID','$OTRO_USUARIO_ID');
DELETE FROM public.user_roles WHERE user_id IN ('$USUARIO_ID','$OTRO_USUARIO_ID');
DELETE FROM public.profiles WHERE id IN ('$USUARIO_ID','$OTRO_USUARIO_ID');
DELETE FROM auth.users
 WHERE id IN ('$USUARIO_ID','$OTRO_USUARIO_ID')
    OR email IN ('t16-remito@local.test','t16-remito-otro@local.test');
COMMIT;
SQL
}

limpiar_fixtures
SEQ_EXISTIA="$(q "SELECT count(*) FROM public.comprobante_secuencias WHERE sucursal_id='$ORIGEN_ID' AND tipo='REMITO'")"
SEQ_ANTES="$(q "SELECT COALESCE(max(ultimo_numero),0) FROM public.comprobante_secuencias WHERE sucursal_id='$ORIGEN_ID' AND tipo='REMITO'")"

cleanup() {
  local previo=$?
  trap - EXIT
  set +e
  limpiar_fixtures
  if [[ "$SEQ_EXISTIA" == "1" ]]; then
    q "INSERT INTO public.comprobante_secuencias(sucursal_id,tipo,ultimo_numero) VALUES ('$ORIGEN_ID','REMITO',$SEQ_ANTES) ON CONFLICT (sucursal_id,tipo) DO UPDATE SET ultimo_numero=EXCLUDED.ultimo_numero" >/dev/null
  else
    q "DELETE FROM public.comprobante_secuencias WHERE sucursal_id='$ORIGEN_ID' AND tipo='REMITO'" >/dev/null
  fi
  rm -r "$TMP_DIR"
  set -e
  exit "$previo"
}
trap cleanup EXIT

"${PSQL[@]}" >/dev/null <<SQL
INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  '$USUARIO_ID','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','t16-remito@local.test','x',now(),now(),now()
);
INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  '$OTRO_USUARIO_ID','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','t16-remito-otro@local.test','x',now(),now(),now()
);
UPDATE public.profiles
   SET username='t16_remito',nombre_completo='Empleado T16',
       sucursal_id='$ORIGEN_ID',activo=true
 WHERE id='$USUARIO_ID';
UPDATE public.profiles
   SET username='t16_remito_otro',nombre_completo='Empleado T16 Otro',
       sucursal_id='$ORIGEN_ID',activo=true
 WHERE id='$OTRO_USUARIO_ID';
INSERT INTO public.profile_sucursales(profile_id,sucursal_id)
VALUES ('$USUARIO_ID','$ORIGEN_ID')
ON CONFLICT DO NOTHING;
INSERT INTO public.profile_sucursales(profile_id,sucursal_id)
VALUES ('$OTRO_USUARIO_ID','$ORIGEN_ID')
ON CONFLICT DO NOTHING;
DELETE FROM public.user_roles WHERE user_id='$USUARIO_ID';
DELETE FROM public.user_roles WHERE user_id='$OTRO_USUARIO_ID';
INSERT INTO public.productos(
  id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado
) VALUES (
  '$PRODUCTO_ID','T16-REM-AUTO','PRODUCTO REMITO ATOMICO',100,21,true,false
);
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
VALUES ('$PRODUCTO_ID','$ORIGEN_ID',10);
SQL

echo "── Contrato, permisos, autorización y rollback ─────────────────────"
"${PSQL[@]}" <<SQL
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_ok boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS \$\$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FALLO: %', p_message;
  END IF;
  RAISE NOTICE '✓ %', p_message;
END;
\$\$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(p_sql text, p_expected text, p_message text)
RETURNS void
LANGUAGE plpgsql
AS \$\$
DECLARE
  v_message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT ILIKE '%' || p_expected || '%' THEN
      RAISE EXCEPTION 'FALLO: % — esperaba %, obtuvo %', p_message, p_expected, v_message;
    END IF;
    RAISE NOTICE '✓ %', p_message;
    RETURN;
  END;
  RAISE EXCEPTION 'FALLO: % — la operación no fue rechazada', p_message;
END;
\$\$;

SELECT pg_temp.assert_true(
  to_regprocedure('public.crear_remito(uuid,uuid,text,jsonb,uuid)') IS NOT NULL,
  'existe una única RPC crear_remito con firma exacta'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='crear_remito'),
  'crear_remito no tiene sobrecargas ambiguas'
);
SELECT pg_temp.assert_true(
  (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']::text[]
     FROM pg_catalog.pg_proc p
    WHERE p.oid='public.crear_remito(uuid,uuid,text,jsonb,uuid)'::regprocedure),
  'crear_remito es SECURITY DEFINER con search_path vacío'
);
SELECT pg_temp.assert_true(
  has_function_privilege('authenticated','public.crear_remito(uuid,uuid,text,jsonb,uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','public.crear_remito(uuid,uuid,text,jsonb,uuid)','EXECUTE')
  AND NOT has_function_privilege('service_role','public.crear_remito(uuid,uuid,text,jsonb,uuid)','EXECUTE'),
  'sólo authenticated recibe EXECUTE sobre la RPC exterior'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege('authenticated','public.next_comprobante_numero(uuid,public.tipo_comprobante)','EXECUTE')
  AND NOT has_function_privilege('anon','public.next_comprobante_numero(uuid,public.tipo_comprobante)','EXECUTE')
  AND has_function_privilege('service_role','public.next_comprobante_numero(uuid,public.tipo_comprobante)','EXECUTE'),
  'el helper queda cerrado a JWT de usuario y disponible sólo al backend legacy confiable'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated','public.remitos','INSERT')
  AND NOT has_table_privilege('authenticated','public.remitos','UPDATE')
  AND NOT has_table_privilege('authenticated','public.remitos','DELETE')
  AND NOT has_table_privilege('authenticated','public.remito_items','INSERT')
  AND NOT has_table_privilege('authenticated','public.remito_items','UPDATE')
  AND NOT has_table_privilege('authenticated','public.remito_items','DELETE'),
  'authenticated no puede escribir encabezados ni ítems por PostgREST'
);
SELECT pg_temp.assert_true(
  to_regprocedure('public.crear_remito(uuid,uuid,text,jsonb)') IS NULL,
  'la firma anterior se retiró y no deja una sobrecarga sin idempotencia'
);

-- El ancho mínimo nunca debe truncar el correlativo al superar cuatro cifras.
INSERT INTO public.comprobante_secuencias(sucursal_id,tipo,ultimo_numero)
VALUES ('$ORIGEN_ID','REMITO',9998)
ON CONFLICT (sucursal_id,tipo) DO UPDATE SET ultimo_numero=EXCLUDED.ultimo_numero;
CREATE TEMP TABLE t16_numeros_limite AS
SELECT public.next_comprobante_numero('$ORIGEN_ID','REMITO') AS n
UNION ALL
SELECT public.next_comprobante_numero('$ORIGEN_ID','REMITO');
SELECT pg_temp.assert_true(
  (SELECT pg_catalog.count(*) FILTER (WHERE n ~ '-REM-9999$')=1
       AND pg_catalog.count(*) FILTER (WHERE n ~ '-REM-10000$')=1
     FROM t16_numeros_limite),
  'la numeración conserva 9999 y continúa en 10000 sin truncar'
);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"$USUARIO_ID","role":"authenticated"}';

SELECT pg_temp.assert_raises(
  \$q\$SELECT public.next_comprobante_numero('$ORIGEN_ID','REMITO')\$q\$,
  'permission denied',
  'el usuario no puede quemar secuencias llamando al helper'
);
SELECT pg_temp.assert_raises(
  \$q\$INSERT INTO public.remitos(
    numero,sucursal_origen_id,sucursal_destino_id,creado_por
  ) VALUES ('T16-DIRECTO','$ORIGEN_ID','$DESTINO_ID','$USUARIO_ID')\$q\$,
  'permission denied',
  'el usuario no puede crear un encabezado por PostgREST/INSERT directo'
);
SELECT pg_temp.assert_raises(
  \$q\$SELECT * FROM public.crear_remito(
    '$DESTINO_ID','$ORIGEN_ID','T16-REM-AUTO-AJENO',
    '[{"producto_id":"$PRODUCTO_ID","cantidad":1}]'::jsonb,
    '$IDEM_INVALIDO'
  )\$q\$,
  'sucursal de origen',
  'un empleado no crea remitos desde una sucursal ajena'
);
SELECT pg_temp.assert_raises(
  \$q\$SELECT * FROM public.crear_remito(
    '$ORIGEN_ID','$ORIGEN_ID','T16-REM-AUTO-IGUAL',
    '[{"producto_id":"$PRODUCTO_ID","cantidad":1}]'::jsonb,
    '$IDEM_INVALIDO'
  )\$q\$,
  'distintos',
  'origen y destino deben ser distintos'
);
SELECT pg_temp.assert_raises(
  \$q\$SELECT * FROM public.crear_remito('$ORIGEN_ID','$DESTINO_ID','T16-REM-AUTO-VACIO','[]'::jsonb,'$IDEM_INVALIDO')\$q\$,
  'al menos un producto',
  'no acepta remitos sin ítems'
);
SELECT pg_temp.assert_raises(
  \$q\$SELECT * FROM public.crear_remito(
    '$ORIGEN_ID','$DESTINO_ID','T16-REM-AUTO-DUP',
    '[{"producto_id":"$PRODUCTO_ID","cantidad":1},{"producto_id":"$PRODUCTO_ID","cantidad":2}]'::jsonb,
    '$IDEM_INVALIDO'
  )\$q\$,
  'repetirse',
  'no acepta productos duplicados'
);
SELECT pg_temp.assert_raises(
  \$q\$SELECT * FROM public.crear_remito(
    '$ORIGEN_ID','$DESTINO_ID','T16-REM-AUTO-INEXISTENTE',
    '[{"producto_id":"c4160000-0000-4000-8000-000000000099","cantidad":1}]'::jsonb,
    '$IDEM_INVALIDO'
  )\$q\$,
  'inexistentes',
  'no acepta productos inexistentes'
);
SELECT pg_temp.assert_raises(
  \$q\$SELECT * FROM public.crear_remito(
    '$ORIGEN_ID','$DESTINO_ID',repeat('x',2001),
    '[{"producto_id":"$PRODUCTO_ID","cantidad":1}]'::jsonb,
    '$IDEM_INVALIDO'
  )\$q\$,
  '2000',
  'limita las observaciones a 2000 caracteres'
);

CREATE TEMP TABLE t16_seq_antes AS
SELECT ultimo_numero
  FROM public.comprobante_secuencias
 WHERE sucursal_id='$ORIGEN_ID' AND tipo='REMITO';
SELECT pg_temp.assert_raises(
  \$q\$SELECT * FROM public.crear_remito(
    '$ORIGEN_ID','$DESTINO_ID','T16-REM-AUTO-ROLLBACK',
    '[{"producto_id":"$PRODUCTO_ID","cantidad":100000000000000}]'::jsonb,
    '$IDEM_INVALIDO'
  )\$q\$,
  'cantidad',
  'una cantidad fuera de numeric(14,2) se rechaza antes de reservar número'
);
SELECT pg_temp.assert_raises(
  \$q\$SELECT * FROM public.crear_remito(
    '$ORIGEN_ID','$DESTINO_ID','T16-REM-AUTO-ESCALA',
    '[{"producto_id":"$PRODUCTO_ID","cantidad":0.004}]'::jsonb,
    '$IDEM_INVALIDO'
  )\$q\$,
  'decimales',
  'una cantidad que redondearía a cero o excede dos decimales se rechaza'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.remitos WHERE observaciones='T16-REM-AUTO-ROLLBACK')
  AND (SELECT ultimo_numero FROM public.comprobante_secuencias
        WHERE sucursal_id='$ORIGEN_ID' AND tipo='REMITO')
      IS NOT DISTINCT FROM (SELECT ultimo_numero FROM t16_seq_antes),
  'el rollback no deja encabezado ni avanza la secuencia'
);

CREATE TEMP TABLE t16_creado AS
SELECT * FROM public.crear_remito(
  '$ORIGEN_ID','$DESTINO_ID','  T16-REM-AUTO-VALIDO  ',
  '[{"producto_id":"$PRODUCTO_ID","cantidad":1.25}]'::jsonb,
  '$IDEM_VALIDO'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 AND min(numero) LIKE '%-REM-%' FROM t16_creado),
  'la RPC devuelve id y número de remito'
);
SELECT pg_temp.assert_true(
  (SELECT r.creado_por='$USUARIO_ID'::uuid
       AND r.sucursal_origen_id='$ORIGEN_ID'::uuid
       AND r.sucursal_destino_id='$DESTINO_ID'::uuid
       AND r.estado='PENDIENTE'
       AND r.observaciones='T16-REM-AUTO-VALIDO'
       AND i.producto_id='$PRODUCTO_ID'::uuid
       AND i.cantidad=1.25
     FROM public.remitos r
     JOIN t16_creado c ON c.remito_id=r.id
     JOIN public.remito_items i ON i.remito_id=r.id),
  'encabezado e ítem se crean juntos y con el autor autenticado'
);

CREATE TEMP TABLE t16_replay AS
SELECT * FROM public.crear_remito(
  '$ORIGEN_ID','$DESTINO_ID','T16-REM-AUTO-VALIDO',
  '[{"cantidad":1.250,"producto_id":"$PRODUCTO_ID"}]'::jsonb,
  '$IDEM_VALIDO'
);
SELECT pg_temp.assert_true(
  (SELECT remito_id FROM t16_replay)=(SELECT remito_id FROM t16_creado)
  AND (SELECT numero FROM t16_replay)=(SELECT numero FROM t16_creado)
  AND (SELECT count(*) FROM public.remitos WHERE idempotency_key='$IDEM_VALIDO')=1,
  'reintentar la misma solicitud devuelve el mismo remito sin duplicar'
);
SELECT pg_temp.assert_raises(
  \$q\$SELECT * FROM public.crear_remito(
    '$ORIGEN_ID','$DESTINO_ID','T16-REM-AUTO-OTRO-PAYLOAD',
    '[{"producto_id":"$PRODUCTO_ID","cantidad":1.25}]'::jsonb,
    '$IDEM_VALIDO'
  )\$q\$,
  'otra solicitud',
  'la misma clave con payload distinto se rechaza'
);
SET LOCAL request.jwt.claims = '{"sub":"$OTRO_USUARIO_ID","role":"authenticated"}';
SELECT pg_temp.assert_raises(
  \$q\$SELECT * FROM public.crear_remito(
    '$ORIGEN_ID','$DESTINO_ID','T16-REM-AUTO-VALIDO',
    '[{"producto_id":"$PRODUCTO_ID","cantidad":1.25}]'::jsonb,
    '$IDEM_VALIDO'
  )\$q\$,
  'otra solicitud',
  'una clave ajena no revela ni recupera el remito de otro usuario'
);
SET LOCAL request.jwt.claims = '{"sub":"$USUARIO_ID","role":"authenticated"}';
SELECT pg_temp.assert_raises(
  \$q\$SELECT public.editar_remito(
    (SELECT remito_id FROM t16_creado),'$DESTINO_ID','T16-REM-AUTO-EDIT-ESCALA',
    '[{"producto_id":"$PRODUCTO_ID","cantidad":0.004}]'::jsonb
  )\$q\$,
  'decimales',
  'editar_remito aplica la misma guarda de escala sin borrar el detalle vigente'
);
SELECT pg_temp.assert_true(
  (SELECT i.cantidad=1.25
     FROM public.remito_items AS i
     JOIN t16_creado AS c ON c.remito_id=i.remito_id),
  'una edición inválida revierte sin alterar los ítems'
);

RESET ROLE;
UPDATE public.productos SET activo=false WHERE id='$PRODUCTO_ID';
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true(
  (SELECT activo=false FROM public.productos WHERE id='$PRODUCTO_ID'),
  'el fixture realmente quedó inactivo antes de probar la excepción operativa'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM public.crear_remito(
    '$ORIGEN_ID','$DESTINO_ID','T16-REM-AUTO-INACTIVO-CON-STOCK',
    '[{"producto_id":"$PRODUCTO_ID","cantidad":1}]'::jsonb,
    '$IDEM_INACTIVO'
  )),
  'un producto inactivo pero no archivado con stock se puede transferir'
);
RESET ROLE;
UPDATE public.productos SET activo=true WHERE id='$PRODUCTO_ID';
SET LOCAL ROLE authenticated;

ROLLBACK;
SQL

echo
echo "── Concurrencia y numeración ────────────────────────────────────────"
AUTH_SQL="SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims = '{\"sub\":\"$USUARIO_ID\",\"role\":\"authenticated\"}';"
for i in 1 2; do
  (
    "${PSQL[@]}" -qAt <<SQL >"$TMP_DIR/concurrente-$i.out" 2>"$TMP_DIR/concurrente-$i.err"
BEGIN;
$AUTH_SQL
SELECT numero FROM public.crear_remito(
  '$ORIGEN_ID','$DESTINO_ID','T16-REM-AUTO-CONCURRENTE',
  '[{"producto_id":"$PRODUCTO_ID","cantidad":1}]'::jsonb,
  '$IDEM_CONCURRENTE'
);
COMMIT;
SQL
  ) &
  eval "PID_$i=$!"
done

wait "$PID_1"
wait "$PID_2"
NUMERO_1="$(tail -1 "$TMP_DIR/concurrente-1.out")"
NUMERO_2="$(tail -1 "$TMP_DIR/concurrente-2.out")"
if [[ -z "$NUMERO_1" || -z "$NUMERO_2" || "$NUMERO_1" != "$NUMERO_2" ]]; then
  echo "✗ dos reintentos concurrentes no devolvieron el mismo número" >&2
  cat "$TMP_DIR"/concurrente-*.err >&2
  exit 1
fi
echo "  ✓ dos reintentos concurrentes devuelven el mismo número"

[[ "$(q "SELECT count(*) FROM public.remitos WHERE idempotency_key='$IDEM_CONCURRENTE'")" == "1" ]]
echo "  ✓ ambos reintentos concurrentes dejaron un solo remito"
[[ "$(q "SELECT count(*) FROM public.remito_items i JOIN public.remitos r ON r.id=i.remito_id WHERE r.idempotency_key='$IDEM_CONCURRENTE'")" == "1" ]]
echo "  ✓ el detalle tampoco se duplicó"
[[ "$(q "SELECT ultimo_numero FROM public.comprobante_secuencias WHERE sucursal_id='$ORIGEN_ID' AND tipo='REMITO'")" == "$((SEQ_ANTES + 1))" ]]
echo "  ✓ la secuencia avanzó exactamente un lugar"

if rg -n -U "\\.from\\([\"'](?:remitos|remito_items)[\"']\\)[[:space:][:print:]]{0,160}?\\.(?:insert|update|delete|upsert)\\(" src; then
  echo "✗ quedó una escritura directa a remitos/remito_items en el cliente" >&2
  exit 1
fi
echo "  ✓ el cliente sólo escribe remitos mediante RPCs"

echo
echo "Contrato crear_remito atómico: OK"
