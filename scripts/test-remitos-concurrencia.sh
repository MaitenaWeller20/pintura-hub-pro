#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^" ]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)

ADMIN_ID="a4190000-0000-4000-8000-000000000001"
PRODUCTO_ID="c4190000-0000-4000-8000-000000000001"
REMITO_A="e4190000-0000-4000-8000-000000000001"
REMITO_B="e4190000-0000-4000-8000-000000000002"
LOG_A="$(mktemp -t t14-remito-a.XXXXXX)"
LOG_B="$(mktemp -t t14-remito-b.XXXXXX)"

q() { "${PSQL[@]}" -qAtc "$1"; }
ORIGEN_ID="$(q "SELECT id FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1")"
DESTINO_ID="$(q "SELECT id FROM public.sucursales WHERE activa AND id<>'$ORIGEN_ID' ORDER BY numero LIMIT 1")"
if [[ -z "$ORIGEN_ID" || -z "$DESTINO_ID" ]]; then
  echo "Se necesitan dos sucursales activas en la base local." >&2
  exit 1
fi

cleanup() {
  "${PSQL[@]}" >/dev/null 2>&1 <<SQL || true
DROP TRIGGER IF EXISTS test_t14_pause_stock ON public.stock_sucursal;
DROP FUNCTION IF EXISTS public.test_t14_pause_stock();
DELETE FROM public.stock_movimientos WHERE referencia_id IN ('$REMITO_A','$REMITO_B');
DELETE FROM public.remito_items WHERE remito_id IN ('$REMITO_A','$REMITO_B');
DELETE FROM public.remitos WHERE id IN ('$REMITO_A','$REMITO_B');
DELETE FROM public.stock_sucursal WHERE producto_id='$PRODUCTO_ID';
DELETE FROM public.productos WHERE id='$PRODUCTO_ID';
DELETE FROM auth.users WHERE id='$ADMIN_ID';
SQL
  rm -f "$LOG_A" "$LOG_B"
}
trap cleanup EXIT

"${PSQL[@]}" <<SQL
INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  '$ADMIN_ID','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','t14-remitos-concurrencia@local.test','x',now(),now(),now()
);
UPDATE public.profiles
   SET username='t14_remitos_concurrencia',nombre_completo='Admin concurrencia remitos',
       sucursal_id='$ORIGEN_ID',activo=true
 WHERE id='$ADMIN_ID';
INSERT INTO public.user_roles(user_id,role) VALUES ('$ADMIN_ID','admin');

INSERT INTO public.productos(
  id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado
) VALUES ('$PRODUCTO_ID','T14-REM-CONC','Producto concurrencia remitos',100,21,true,false);
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
VALUES ('$PRODUCTO_ID','$ORIGEN_ID',10),('$PRODUCTO_ID','$DESTINO_ID',10);

INSERT INTO public.remitos(
  id,numero,sucursal_origen_id,sucursal_destino_id,creado_por,observaciones
) VALUES
  ('$REMITO_A','T14-REM-A','$ORIGEN_ID','$DESTINO_ID','$ADMIN_ID','concurrencia A'),
  ('$REMITO_B','T14-REM-B','$DESTINO_ID','$ORIGEN_ID','$ADMIN_ID','concurrencia B');
INSERT INTO public.remito_items(remito_id,producto_id,cantidad)
VALUES ('$REMITO_A','$PRODUCTO_ID',1),('$REMITO_B','$PRODUCTO_ID',1);

CREATE FUNCTION public.test_t14_pause_stock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=''
AS \$\$
BEGIN
  IF NEW.producto_id='$PRODUCTO_ID'::uuid THEN
    PERFORM pg_catalog.pg_sleep(0.4);
  END IF;
  RETURN NEW;
END;
\$\$;
CREATE TRIGGER test_t14_pause_stock
BEFORE UPDATE ON public.stock_sucursal
FOR EACH ROW EXECUTE FUNCTION public.test_t14_pause_stock();
SQL

aprobar() {
  local remito="$1" log="$2"
  "${PSQL[@]}" >"$log" 2>&1 <<SQL
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims='{"sub":"$ADMIN_ID","role":"authenticated"}';
SELECT public.aprobar_remito('$remito');
COMMIT;
SQL
}

set +e
aprobar "$REMITO_A" "$LOG_A" &
PID_A=$!
aprobar "$REMITO_B" "$LOG_B" &
PID_B=$!
wait "$PID_A"; STATUS_A=$?
wait "$PID_B"; STATUS_B=$?
set -e

if (( STATUS_A != 0 || STATUS_B != 0 )); then
  echo "FALLO: dos aprobaciones inversas deben serializarse sin abortar." >&2
  sed -n '1,120p' "$LOG_A" >&2
  sed -n '1,120p' "$LOG_B" >&2
  exit 1
fi
if grep -Eqi 'deadlock|ERROR' "$LOG_A" "$LOG_B"; then
  echo "FALLO: se detectó un deadlock al aprobar remitos inversos." >&2
  exit 1
fi

RESULTADO="$(q "SELECT count(*)||':'||min(estado)||':'||max(estado) FROM public.remitos WHERE id IN ('$REMITO_A','$REMITO_B')")"
STOCK="$(q "SELECT sum(cantidad) FROM public.stock_sucursal WHERE producto_id='$PRODUCTO_ID'")"
if [[ "$RESULTADO" != "2:APROBADO:APROBADO" || "$STOCK" != "20.00" ]]; then
  echo "FALLO: resultado final inesperado ($RESULTADO; stock total $STOCK)." >&2
  exit 1
fi

echo "Concurrencia inversa de aprobación de remitos: OK"
