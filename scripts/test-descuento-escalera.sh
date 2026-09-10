#!/usr/bin/env bash
# ============================================================
# La escalera del descuento: producto ?? proveedor ?? settings ?? 0
#
# Existe en DOS lados —`descuentoEfectivo` en TypeScript y el COALESCE de
# `cambiar_precios_masivo` en SQL— y los dos tienen que dar el mismo número.
# Que puedan divergir es el riesgo real: ya pasó con el redondeo, donde la vista
# previa prometía no tocar un precio y el SQL lo movía igual.
#
# Este script prueba el lado SQL con los MISMOS casos que `precios.test.ts`.
# Si alguien cambia un COALESCE, acá se cae.
#
# Uso:  ./scripts/test-descuento-escalera.sh
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/.."

DB="${DB:-supabase_db_local}"
psql_run() { docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAq; }

ok=0; fallas=0
paso()  { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
fallo() { printf '  \033[31m✗\033[0m %s\n' "$1"; fallas=$((fallas+1)); }

ADMIN=$(psql_run <<<"SELECT user_id FROM public.user_roles WHERE role='admin' LIMIT 1;")
[ -n "$ADMIN" ] || { echo "No hay ningún admin en la base local."; exit 1; }

# Un caso = descuento del producto, de su proveedor, del global, y el costo que
# TIENE que salir de una lista de 1000. Mismos casos que el it.each de TS.
#   prod | prov | settings | costo esperado
CASOS=(
  "10|20|30|900.00"
  "NULL|20|30|800.00"
  "NULL|NULL|30|700.00"
  "0|20|30|1000.00"
  "NULL|0|30|1000.00"
  "42|NULL|30|580.00"
  "NULL|NULL|0|1000.00"
)

echo "== La escalera del descuento en SQL, con una lista de \$1.000 =="

for caso in "${CASOS[@]}"; do
  IFS='|' read -r d_prod d_prov d_set esperado <<<"$caso"

  # Todo adentro de una transacción que se revierte: la base queda como estaba.
  real=$(psql_run <<SQL
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"$ADMIN","role":"authenticated"}';

SET LOCAL client_min_messages TO WARNING;
UPDATE public.settings SET descuento_proveedor_porcentaje = $d_set;

INSERT INTO public.proveedores (id, razon_social, descuento_porcentaje)
VALUES ('eeeeeeee-0000-0000-0000-000000000001', 'Proveedor de prueba', $d_prov);

INSERT INTO public.productos (id, codigo, nombre, precio_lista, precio_fabrica,
                              precio_sin_iva, iva_porcentaje, proveedor_id, descuento_porcentaje)
VALUES ('eeeeeeee-0000-0000-0000-000000000002', 'ZZ-ESCALERA', 'Producto de prueba',
        1000, 0, 0, 21, 'eeeeeeee-0000-0000-0000-000000000001', $d_prod);

SELECT public.cambiar_precios_masivo(
  ARRAY['eeeeeeee-0000-0000-0000-000000000002']::uuid[],
  'RECALCULAR_COSTO', 0, gen_random_uuid());

SELECT to_char(precio_fabrica, 'FM999999990.00')
  FROM public.productos WHERE id = 'eeeeeeee-0000-0000-0000-000000000002';
ROLLBACK;
SQL
)
  real=$(tr -d ' ' <<<"$real" | tail -1)
  etiqueta="producto=$d_prod proveedor=$d_prov settings=$d_set → costo $esperado"
  if [ "$real" = "$esperado" ]; then paso "$etiqueta"
  else fallo "$etiqueta — pero dio $real"; fi
done

echo
echo "== El CHECK del rango =="
for malo in -1 101; do
  salida=$(psql_run <<SQL 2>&1
BEGIN;
INSERT INTO public.productos (codigo, nombre, precio_sin_iva, iva_porcentaje, descuento_porcentaje)
VALUES ('ZZ-RANGO', 'Producto de prueba', 0, 21, $malo);
ROLLBACK;
SQL
)
  if grep -q "productos_descuento_rango" <<<"$salida"; then paso "rechaza un descuento de $malo%"
  else fallo "ACEPTÓ un descuento de $malo%"; fi
done

echo
echo "── resumen ──────────────────"
printf 'ok: %d   fallas: %d\n' "$ok" "$fallas"
[ "$fallas" -eq 0 ] || exit 1
