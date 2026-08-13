#!/usr/bin/env bash
# ============================================================
# buscar_productos_similares (migración 20260813140000).
#   ./scripts/test-buscar-productos.sh
#
# Agustina escribió "ESPUMA DE" en Nuevo ingreso de mercadería y le dijo que no
# había productos, con tres activos que empiezan exactamente con eso. La función
# filtraba sólo por similitud de trigramas, que compara las cadenas ENTERAS:
# contra un nombre largo, escribir el principio no llega nunca al umbral de 0,3.
#
# Lo que se prueba: que ahora encuentre por el principio y por el medio, que siga
# encontrando con un error de tipeo (para eso estaban los trigramas), que el
# orden sea el esperado, y que los comodines de LIKE no se cuelen.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/.."
PSQL="docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1"
fallos=0
q() { $PSQL -tAc "$1"; }
# Las aserciones miran SÓLO los productos que siembra este script (BUSQ-%). La
# base local tiene el catálogo real, así que contar el total o mirar cuál salió
# primero sin filtrar da resultados que dependen de datos ajenos a la prueba.
# El límite va alto para que el filtro no se coma resultados legítimos.
tiene() { # nombre, consulta, código que TIENE que aparecer
  local encontrado
  encontrado=$(q "SELECT count(*) FROM public.buscar_productos_similares('$2','$2',25) WHERE codigo='$3'")
  if [[ "$encontrado" == "1" ]]; then echo "  ✓ $1"; else echo "  ✗ $1 — buscando '$2' no apareció $3"; fallos=$((fallos+1)); fi
}
primero() { # nombre, consulta, código que tiene que salir primero DE LOS SEMBRADOS
  local top
  top=$(q "SELECT codigo FROM public.buscar_productos_similares('$2','$2',25) WHERE codigo LIKE 'BUSQ-%' LIMIT 1")
  if [[ "$top" == "$3" ]]; then echo "  ✓ $1"; else echo "  ✗ $1 — primero salió '$top', esperaba '$3'"; fallos=$((fallos+1)); fi
}
cuenta() { # nombre, consulta, cuántos de los SEMBRADOS tienen que salir
  local n
  n=$(q "SELECT count(*) FROM public.buscar_productos_similares('$2','$2',25) WHERE codigo LIKE 'BUSQ-%'")
  if [[ "$n" == "$3" ]]; then echo "  ✓ $1"; else echo "  ✗ $1 — devolvió $n, esperaba $3"; fallos=$((fallos+1)); fi
}

echo "── Sembrando ─────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.productos WHERE codigo LIKE 'BUSQ-%';
INSERT INTO public.productos (codigo, nombre, precio_sin_iva, iva_porcentaje, activo) VALUES
  ('BUSQ-001', 'ESPUMA DE POLIURETANO KUWAIT X300 ML', 100, 21, true),
  ('BUSQ-002', 'ESPUMA DE POLIURETANO KUWAIT X750 ML', 100, 21, true),
  ('BUSQ-003', 'LATEX BLANCO MATE INTERIOR X20 LITROS', 100, 21, true),
  ('BUSQ-004', 'PINCELETA EL GALGO CAPABLANCA N40',    100, 21, true),
  ('BUSQ-005', 'ESPUMA DE POLIURETANO VIEJA X300 ML',  100, 21, false),
  ('BUSQ-006', 'DESCUENTO 50% PROMO',                  100, 21, true),
  ('BUSQ-007', 'CODIGO_RARO A_B',                      100, 21, true);
SQL

echo
echo "── 1. El caso de Agustina ────────────────────────────────"
# Medido en producción: similarity con el nombre entero da 0,270 y el umbral es
# 0,3, así que por trigramas solo NO entraba.
tiene "encuentra escribiendo el principio del nombre" "ESPUMA DE" "BUSQ-001"
tiene "y también con una sola palabra" "ESPUMA" "BUSQ-002"
cuenta "trae los tres (dos activos + uno inactivo)" "ESPUMA DE POLIURETANO" "3"

echo
echo "── 2. Por el medio del nombre ────────────────────────────"
tiene "una palabra del medio encuentra el producto" "BLANCO" "BUSQ-003"
primero "y la palabra entera gana contra la pegada adentro" "BLANCO" "BUSQ-003"  # CAPABLANCA queda después

echo
echo "── 3. Los trigramas siguen rescatando un error de tipeo ──"
# Es para lo que estaban, y no se pierde: 'POLIURETANO' mal escrito.
tiene "encuentra con una letra cambiada" "POLIURETANI" "BUSQ-001"

echo
echo "── 4. El orden ───────────────────────────────────────────"
primero "el código exacto manda" "BUSQ-004" "BUSQ-004"
primero "primero el activo, después el dado de baja" "ESPUMA DE POLIURETANO" "BUSQ-001"

echo
echo "── 5. Los comodines de LIKE no se cuelan ─────────────────"
# Sin escapar, '%' traería CUALQUIER producto y '_' cualquier caracter.
tiene "un nombre con % se busca literal" "50%" "BUSQ-006"
cuenta "y no trae todo el catálogo" "50%" "1"
tiene "un nombre con _ se busca literal" "A_B" "BUSQ-007"
cuenta "y el guión bajo no hace de comodín" "A_B" "1"

echo
echo "── 6. Nada que buscar no trae nada ───────────────────────"
cuenta "vacío" "" "0"
cuenta "sólo espacios" "   " "0"

echo "── Limpieza ──────────────────────────────────────────────"
$PSQL -tAc "DELETE FROM public.productos WHERE codigo LIKE 'BUSQ-%'" > /dev/null

echo
if [[ $fallos -eq 0 ]]; then echo "Todo bien."; else echo "$fallos fallo(s)."; fi
exit $((fallos > 0))
