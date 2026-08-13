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

import { filtroIlikeOr } from "./postgrest";

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

  // La búsqueda por dígitos sueltos SÓLO se aplica si lo escrito es un
  // documento, o sea si no tiene ninguna letra.
  //
  // Antes se aplicaba siempre, y como compara "contiene", cualquier número
  // dentro de un nombre pescaba fichas ajenas: buscar "Pinturería 2000" traía
  // a todo el que tuviera 2000 en el CUIT. Lo encontró una prueba E2E, que
  // buscó "ZZ-E2E-508" y recibió dos filas — la suya y un GONZALO FERREYRA con
  // CUIT 20250807113, que contiene "508".
  //
  // Se comparan los alfanuméricos y no el texto crudo para que "30-71582607-7"
  // y "30.715.826/7" sigan contando como documento.
  if (/[A-Za-z]/.test(q)) return false;

  const qd = soloDigitos(q);
  if (!qd) return false;

  const fd = soloDigitos(ficha.cuit_dni);
  return fd !== "" && fd.includes(qd);
}

/**
 * Se re-exporta para no romper lo que ya lo importaba desde acá. Vive en
 * `./postgrest` porque no tiene nada que ver con documentos: lo usan también
 * los buscadores de productos.
 */
export { filtroIlikeOr };

/**
 * Filtro para buscar una ficha por nombre o documento contra PostgREST.
 * Devuelve `null` si no hay nada que buscar (para no aplicar filtro).
 *
 * Lo que se compara contra `cuit_dni` depende de si lo escrito tiene letras:
 *
 *   · **Sin letras** ("30-71582607-7") es un documento: se comparan los DÍGITOS,
 *     así da igual cómo lo escriba la usuaria y cómo haya quedado guardado.
 *   · **Con letras** se compara el texto CRUDO. Así un documento alfanumérico
 *     —un pasaporte "AAB123456"— se sigue encontrando entero, pero un nombre con
 *     números —"Pinturería 2000"— ya no pesca por CUIT a cualquiera que tenga
 *     esos dígitos adentro, que es lo que pasaba comparando siempre por dígitos.
 */
export function filtroNombreODocumento(
  consulta: string,
  campoNombre = "razon_social",
): string | null {
  const q = consulta.trim();
  if (!q) return null;
  const filtro = filtroIlikeOr([
    { campo: campoNombre, valor: q },
    { campo: "cuit_dni", valor: /[A-Za-z]/.test(q) ? q : soloDigitos(q) },
  ]);
  return filtro || null;
}
