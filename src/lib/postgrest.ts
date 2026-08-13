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
 *
 * Después estuvo en 50, y seguía cortando: el catálogo de producción tiene 1572
 * productos activos y "blanco" matchea 161. Renzo buscaba un blanco, veía 50 y
 * el suyo no estaba. 500 cubre con margen la peor búsqueda razonable (289, el
 * prefijo de dos letras más poblado) y sigue frenando un "a" suelto, que
 * traería el catálogo entero en cada tecla.
 *
 * El tope solo no alcanza: con 161 resultados hay que poder recorrerlos, así
 * que las listas son altas, dicen cuántos hay, y vienen ordenadas por
 * relevancia (ver `ordenarProductosPorRelevancia`).
 */
export const TOPE_BUSQUEDA_PRODUCTOS = 500;

/**
 * Los que más se parecen a lo tipeado, primero.
 *
 * Ordenar por código deja el resultado a merced del catálogo: buscando "blanco"
 * los 161 que matchean salen en orden de código, así que "AEROSOL BLANCO" tapa
 * al "LATEX BLANCO" que se buscaba. Acá primero va lo que ARRANCA con lo
 * tipeado —que es lo que uno espera cuando escribe las primeras letras— y
 * después lo que lo contiene en el medio.
 */
export function ordenarProductosPorRelevancia<T extends { codigo?: string; nombre?: string }>(
  lista: T[],
  consulta: string,
): T[] {
  const q = consulta.trim().toLowerCase();
  if (!q) return lista;

  const rango = (p: T): number => {
    const cod = (p.codigo ?? "").toLowerCase();
    const nom = (p.nombre ?? "").toLowerCase();
    if (cod.startsWith(q)) return 0;
    if (nom.startsWith(q)) return 1;
    // Arranca una palabra del nombre: "blanco" tiene que encontrar
    // "LATEX BLANCO MATE" antes que "SEMIBLANCO".
    if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(nom)) return 2;
    return 3;
  };

  // Copia: el llamador suele pasar el array de react-query, que no se toca.
  return [...lista].sort((a, b) => {
    const d = rango(a) - rango(b);
    if (d !== 0) return d;
    // Desempate por nombre además de por código: hay productos con el código
    // repetido, y sin esto dos búsquedas iguales podían devolverlos en distinto
    // orden y la lista bailaba abajo del dedo.
    return (
      (a.codigo ?? "").localeCompare(b.codigo ?? "") ||
      (a.nombre ?? "").localeCompare(b.nombre ?? "")
    );
  });
}

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
