/**
 * Helpers para armar filtros de PostgREST a mano.
 *
 * El `.or()` de supabase-js recibe la expresión del filtro ya armada, sin
 * parámetros ligados: si se interpola texto del usuario crudo, un nombre con
 * coma parte la expresión y rompe la búsqueda.
 */

/**
 * Valor para un `ilike` de PostgREST, con los dos escapados encadenados que
 * hacen falta. El orden importa:
 *
 *   1. El del patrón LIKE. `\` `%` y `_` son comodines de SQL; para buscarlos
 *      literalmente hay que anteponerles `\` (el ESCAPE por defecto de
 *      Postgres). Verificado contra un PostgREST real: sin esto, buscar "A_B"
 *      devuelve también "A\B" y "AXB", y "A\BARRA" no devuelve nada.
 *   2. El de la gramática de PostgREST, ya sobre el patrón armado. El valor va
 *      entre comillas dobles, que es como PostgREST admite los caracteres
 *      reservados (`,` `.` `(` `)` `:`), con `"` y `\` escapados adentro.
 */
const escaparLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
const escaparPostgrest = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** `campo.ilike."%valor%"` para cada par, unidos por coma. Descarta los vacíos. */
export function filtroIlikeOr(pares: Array<{ campo: string; valor: string }>): string {
  return pares
    .filter((p) => p.valor !== "")
    .map(({ campo, valor }) => `${campo}.ilike."${escaparPostgrest(`%${escaparLike(valor)}%`)}"`)
    .join(",");
}

/**
 * Cuántos productos trae un buscador antes de pedirle a quien busca que afine.
 *
 * Estaba en 10 y sin `order`, así que Postgres devolvía diez cualesquiera: si
 * lo tipeado matcheaba más, el producto buscado podía no estar y no había
 * ninguna señal de que faltaban. Es lo que pasaba con la membrana en los
 * presupuestos, que en Ventas sí aparecía (ahí se baja el catálogo entero).
 */
export const TOPE_BUSQUEDA_PRODUCTOS = 50;

/** Filtro por código o nombre de producto. `null` si no hay nada que buscar. */
export function filtroProducto(consulta: string): string | null {
  const q = consulta.trim();
  if (!q) return null;
  return (
    filtroIlikeOr([
      { campo: "codigo", valor: q },
      { campo: "nombre", valor: q },
    ]) || null
  );
}
