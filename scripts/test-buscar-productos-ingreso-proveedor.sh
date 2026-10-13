#!/usr/bin/env bash
# Regresión del buscador de Nuevo ingreso de mercadería.
# Verifica que el proveedor se filtre ANTES del límite y que una búsqueda con
# más de 25 coincidencias no pierda artículos del catálogo elegido.
set -uo pipefail
cd "$(dirname "$0")/.."

DB_CONTAINER="${SUPABASE_DB_CONTAINER:-$(docker ps --format '{{.Names}}' | sed -n '/^supabase_db_/p' | head -1)}"
if [[ -z "$DB_CONTAINER" ]]; then
  echo "No hay una base local de Supabase en ejecución."
  exit 2
fi
PSQL="docker exec -i $DB_CONTAINER psql -U postgres -d postgres -v ON_ERROR_STOP=1"
fallos=0
q() { $PSQL -qAtc "$1"; }
chequear() {
  if [[ "$2" == "$3" ]]; then
    echo "  ✓ $1"
  else
    echo "  ✗ $1 — esperaba '$2', obtuvo '$3'"
    fallos=$((fallos+1))
  fi
}

firma=$(q "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='buscar_productos_similares' AND pronargs=4")
if [[ "$firma" != "1" ]]; then
  echo "  ✗ buscar_productos_similares todavía no acepta proveedor"
  exit 1
fi

echo "── Sembrando ─────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.productos WHERE codigo LIKE 'BUSQ-ING-%';
DELETE FROM public.proveedores WHERE razon_social IN ('BUSQ ING QM', 'BUSQ ING OTRO');
INSERT INTO public.proveedores (razon_social) VALUES ('BUSQ ING QM'), ('BUSQ ING OTRO');

INSERT INTO public.productos (codigo, nombre, precio_sin_iva, iva_porcentaje, proveedor_id)
SELECT
  'BUSQ-ING-QM-' || lpad(n::text, 3, '0'),
  'BLANCO SATINADO QM ' || n,
  100,
  21,
  (SELECT id FROM public.proveedores WHERE razon_social = 'BUSQ ING QM')
FROM generate_series(1, 40) AS n;

INSERT INTO public.productos (codigo, nombre, precio_sin_iva, iva_porcentaje, proveedor_id)
SELECT
  'BUSQ-ING-OTRO-' || lpad(n::text, 3, '0'),
  'BLANCO SATINADO OTRO ' || n,
  100,
  21,
  (SELECT id FROM public.proveedores WHERE razon_social = 'BUSQ ING OTRO')
FROM generate_series(1, 40) AS n;
SQL

QM=$(q "SELECT id FROM public.proveedores WHERE razon_social='BUSQ ING QM'")

echo "── Filtro y catálogo completo ────────────────────────────"
chequear "trae las 40 coincidencias del proveedor, no sólo 12/25" "40" \
  "$(q "SELECT count(*) FROM public.buscar_productos_similares('SATIN','SATIN',500,'$QM') WHERE codigo LIKE 'BUSQ-ING-QM-%'")"
chequear "no mezcla productos de otro proveedor" "0" \
  "$(q "SELECT count(*) FROM public.buscar_productos_similares('SATIN','SATIN',500,'$QM') WHERE codigo LIKE 'BUSQ-ING-OTRO-%'")"
chequear "un usuario autenticado conserva acceso con RLS" "40" \
  "$(q "SET ROLE authenticated; SELECT count(*) FROM public.buscar_productos_similares('SATIN','SATIN',500,'$QM') WHERE codigo LIKE 'BUSQ-ING-QM-%'; RESET ROLE")"

# Producción concede EXECUTE a anon por ALTER DEFAULT PRIVILEGES. Simulamos ese
# estado y ejecutamos la migración real para que esta regresión no dependa de
# que Supabase local tenga exactamente los mismos defaults del proyecto remoto.
shopt -s nullglob
migraciones_acl=(supabase/migrations/*_restringir_busqueda_productos_ingreso.sql)
if [[ ${#migraciones_acl[@]} -ne 1 ]]; then
  echo "  ✗ falta una única migración para restringir la búsqueda de ingresos"
  fallos=$((fallos+1))
else
  q "GRANT EXECUTE ON FUNCTION public.buscar_productos_similares(text,text,integer,uuid) TO anon"
  $PSQL < "${migraciones_acl[0]}" > /dev/null
  chequear "un visitante anónimo no puede ejecutar el buscador de ingresos" "f" \
    "$(q "SELECT has_function_privilege('anon', 'public.buscar_productos_similares(text,text,integer,uuid)', 'EXECUTE')")"
fi

echo "── Limpieza ──────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.productos WHERE codigo LIKE 'BUSQ-ING-%';
DELETE FROM public.proveedores WHERE razon_social IN ('BUSQ ING QM', 'BUSQ ING OTRO');
SQL

echo
if [[ $fallos -eq 0 ]]; then echo "Todo bien."; else echo "$fallos fallo(s)."; fi
exit $((fallos > 0))
