// Lectura paginada de PostgREST.
//
// PostgREST devuelve como MÁXIMO `db-max-rows` filas por request (1000 por
// defecto en Supabase) y no avisa: la respuesta viene con 1000 filas y el
// cliente cree que eso es todo. `/productos` ya estaba truncando así (mostraba
// "1000 de 1000" con 1133 productos). En un catálogo es molesto; en la planilla
// de un conteo físico es peligroso, porque un producto que no aparece se lee
// como "no existe" y su stock nunca se carga.
//
// Este helper pide páginas con `.range()` hasta juntarlas todas. Dos reglas lo
// hacen correcto, y las dos son fáciles de olvidar:
//
//  1. ORDEN TOTAL. La consulta paginada TIENE que ordenar por una columna única
//     y estable (típicamente `id`, o `nombre` + `id` como desempate). Sin orden
//     total, PostgREST no garantiza el mismo orden entre requests y la
//     paginación por offset saltea o repite filas.
//
//  2. TAMAÑO DE PÁGINA <= db-max-rows. Si el server recorta una página a menos
//     de lo pedido, las páginas siguientes se calculan con offsets que asumen
//     páginas completas y se SALTEAN filas. No se puede recuperar desde el
//     cliente. Por eso el caller debe pasar `{ count: 'exact' }`: con el total
//     real, este helper detecta que quedó corto y devuelve `truncado: true` en
//     vez de mentir que la lista está completa. Igual conviene tener el
//     db-max-rows de producción en >= TAMANO_PAGINA.

export type RespuestaPagina<T> = {
  data: T[] | null;
  error: { message: string } | null;
  /** Total de filas de la consulta (PostgREST lo devuelve con `{ count: 'exact' }`). */
  count?: number | null;
};

/** Trae una página: `desde` y `hasta` son índices inclusivos, como `.range()`. */
export type TraerPagina<T> = (desde: number, hasta: number) => Promise<RespuestaPagina<T>>;

export type ResultadoPaginado<T> = {
  filas: T[];
  /** true si la lista quedó incompleta (se tocó el tope, o el server recortó las páginas). */
  truncado: boolean;
};

export const TAMANO_PAGINA = 1000;
/** Tope duro: ni el catálogo ni el inventario llegan a esto ni de casualidad. */
export const TOPE_FILAS = 50_000;

/**
 * Junta todas las páginas de una consulta de PostgREST.
 *
 * Corta cuando una página vuelve incompleta (última página) o cuando se alcanza
 * el tope de seguridad. Si el caller pasó `{ count: 'exact' }` en su `select`,
 * usa ese total como fuente de verdad: si al terminar juntó menos filas que el
 * total, devuelve `truncado: true` para que la pantalla lo DIGA. Así, aunque el
 * db-max-rows del server sea menor que el tamaño de página, el resultado nunca
 * es "silenciosamente incompleto".
 */
export async function traerTodo<T>(
  traerPagina: TraerPagina<T>,
  opts: { tamanoPagina?: number; tope?: number } = {},
): Promise<ResultadoPaginado<T>> {
  const tamano = opts.tamanoPagina ?? TAMANO_PAGINA;
  const tope = opts.tope ?? TOPE_FILAS;
  if (tamano <= 0) throw new Error("El tamaño de página tiene que ser mayor que cero");

  const filas: T[] = [];
  let total: number | null = null;
  let topeAlcanzado = false;

  for (let desde = 0; ; desde += tamano) {
    const { data, error, count } = await traerPagina(desde, desde + tamano - 1);
    if (error) throw new Error(error.message);
    if (typeof count === "number") total = count;
    const pagina = data ?? [];
    filas.push(...pagina);

    if (pagina.length < tamano) break; // página incompleta (o vacía) = última
    if (filas.length >= tope) {
      topeAlcanzado = true;
      break;
    }
  }

  // Incompleto si tocamos el tope, o si el server recortó páginas y juntamos
  // menos de lo que dijo el total.
  const truncado = topeAlcanzado || (total != null && filas.length < total);
  return { filas, truncado };
}
