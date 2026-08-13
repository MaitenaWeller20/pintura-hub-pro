/**
 * CUIT/DNI: mostrarlo, buscarlo y filtrarlo.
 *
 * La columna `cuit_dni` guarda el documento **canónico, sólo dígitos** — lo
 * garantiza el trigger `normalizar_cuit_dni` (migración 20260811120000). Los
 * guiones son cosa de la vista.
 *
 * Antes no era así: la importación de la migración de 3C guardaba el texto
 * crudo del archivo ("30-71582607-7") y el formulario sólo los dígitos
 * ("30715826077"). Como el índice único compara la forma normalizada pero los
 * buscadores comparaban el texto crudo, dar de alta un CUIT que ya existía
 * fallaba con "Ya existe un cliente con ese CUIT/DNI" y buscarlo no devolvía
 * nada. Estos helpers son el otro lado de esa cura: normalizan también lo que
 * la usuaria escribe, para que dé igual si pone guiones o no.
 *
 * Ver docs/superpowers/specs/2026-08-11-cuit-canonico-design.md
 */

/** Sólo los dígitos de un valor. Espeja `regexp_replace(v,'\D','','g')` en SQL. */
export const soloDigitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");

/**
 * Documento para mostrar: el CUIT de 11 dígitos se ve con guiones.
 *
 * El DNI se deja tal cual (nadie lo escribe con guiones) y los valores con
 * letras —pasaportes, placeholders legacy tipo "S/D"— no se tocan: el trigger
 * tampoco los normaliza, así que acá tienen que sobrevivir igual.
 */
export function fmtDocumento(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  if (!s) return "—";
  const d = soloDigitos(s);
  if (d.length === 11 && !/[A-Za-z]/.test(s)) {
    return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
  }
  return s;
}

/**
 * ¿La ficha coincide con lo que se escribió en el buscador?
 *
 * El nombre se compara como texto y el documento por sus dígitos, así que
 * "30715826077", "30-71582607-7" y "71582607" encuentran a la misma ficha.
 */
export function coincideDocumento(
  ficha: { razon_social?: string | null; cuit_dni?: string | null },
  consulta: string,
): boolean {
  const q = consulta.trim();
  if (!q) return true;

  // Se conserva el comportamiento viejo —buscar sobre "nombre documento"
  // concatenado— para no perder las consultas que cruzan los dos campos
  // ("ACME AAB123" con un documento alfanumérico). Lo nuevo se SUMA a esto.
  const crudo = `${ficha.razon_social ?? ""} ${ficha.cuit_dni ?? ""}`.toLowerCase();
  if (crudo.includes(q.toLowerCase())) return true;

  // Sólo tiene sentido buscar por documento si lo escrito tiene dígitos. Sin
  // esta guarda, un nombre como "J.V.S." normalizaría a "" y matchearía con
  // cualquier ficha.
  const qd = soloDigitos(q);
  if (!qd) return false;

  const fd = soloDigitos(ficha.cuit_dni);
  return fd !== "" && fd.includes(qd);
}

/**
 * Expresión `or=` de PostgREST para buscar un término en varios campos.
 *
 * El valor va **entre comillas dobles**, que es como PostgREST admite
 * caracteres reservados (`,` `.` `(` `)` `:`) dentro de un filtro; adentro se
 * escapan `"` y `\`. Interpolar el texto crudo —lo que se hacía antes— hace que
 * un cliente llamado "SANCHEZ, JUAN" parta la expresión y rompa la búsqueda.
 *
 * Hay DOS escapados encadenados y el orden importa:
 *
 *   1. El del patrón LIKE. `\` `%` y `_` son comodines de SQL; para buscarlos
 *      literalmente hay que anteponerles `\` (el ESCAPE por defecto de Postgres).
 *      Verificado contra PostgREST: sin esto, buscar "A_B" devuelve también
 *      "A\B" y "AXB", y buscar "A\BARRA" no devuelve nada.
 *   2. El de la gramática de PostgREST, ya sobre el patrón armado.
 */
const escaparLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
const escaparPostgrest = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function filtroIlikeOr(pares: Array<{ campo: string; valor: string }>): string {
  return pares
    .filter((p) => p.valor !== "")
    .map(({ campo, valor }) => `${campo}.ilike."${escaparPostgrest(`%${escaparLike(valor)}%`)}"`)
    .join(",");
}

/**
 * Filtro para buscar una ficha por nombre o documento contra PostgREST.
 * Devuelve `null` si no hay nada que buscar (para no aplicar filtro).
 */
export function filtroNombreODocumento(
  consulta: string,
  campoNombre = "razon_social",
): string | null {
  const q = consulta.trim();
  if (!q) return null;
  const filtro = filtroIlikeOr([
    { campo: campoNombre, valor: q },
    { campo: "cuit_dni", valor: soloDigitos(q) },
  ]);
  return filtro || null;
}
