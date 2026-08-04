// Mapeo de la planilla de precios a campos de producto.
//
// Vive acá (y no dentro de la ruta) para poder testearlo: el mapeo automático es
// la parte de la importación que más veces se equivocó (el "Sugerido al público
// C/IVA" enganchado al % de IVA, el envase confundido con el stock) y cada error
// se paga corrompiendo el catálogo entero de un saque.
//
// REGLA: esta importación actualiza PRECIOS y DATOS DEL PRODUCTO. No toca el
// stock. El stock se carga aparte (Ingresos de mercadería, Compras, o el ajuste
// de Inventario) y siempre deja kardex. Ver
// docs/superpowers/specs/2026-07-24-stock-no-es-envase-design.md.

import { calcularPrecios, costoDeLista, normalizarIva } from "./precios";

export type CampoDestino = { key: string; label: string };

export const FIELDS_TARGET: CampoDestino[] = [
  { key: "codigo", label: "Código *" },
  { key: "nombre", label: "Nombre *" },
  { key: "precio_lista", label: "Precio de lista (Quimex)" },
  { key: "precio_fabrica", label: "Precio fábrica (costo)" },
  // Va ANTES de precio_sin_iva a propósito: autoMapear reclama las cabeceras en
  // orden y precio_sin_iva tiene "precio" entre sus sinónimos, así que se quedaría
  // con una columna "PRECIO SUGERIDO AL PUBLICO".
  { key: "precio_sugerido_publico", label: "Sugerido al público (C/IVA)" },
  { key: "precio_sin_iva", label: "Precio s/IVA" },
  { key: "iva_porcentaje", label: "IVA %" },
  { key: "stock_minimo", label: "Stock mínimo (umbral de alerta)" },
  { key: "tamano_envase", label: "Envase (ENV)" },
  { key: "unidad_medida", label: "Unidad" },
  { key: "categoria", label: "Categoría (texto)" },
  { key: "marca", label: "Marca (texto)" },
];

// Las planillas reales traen cabeceras con acentos, puntos y abreviaturas
// ("Código", "P. Unit s/IVA", "ENV."). Normalizamos y probamos varios sinónimos
// por campo en vez de exigir que la cabecera contenga la clave.
export const normalizar = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export const SINONIMOS: Record<string, string[]> = {
  codigo: ["codigo", "cod", "sku", "articulo"],
  nombre: ["nombre", "descripcion", "detalle", "producto"],
  precio_lista: ["preciodelista", "preciolista", "listadeprecios", "listaprecios", "lista"],
  precio_fabrica: ["preciofabrica", "fabrica", "costo", "preciocosto"],
  precio_sugerido_publico: [
    "sugeridoalpublicociva",
    "sugeridoalpublico",
    "preciosugerido",
    "sugerido",
    "preciopublico",
    "pvp",
  ],
  precio_sin_iva: ["preciosiniva", "preciosiva", "preciounitario", "precioneto", "precio", "punit"],
  iva_porcentaje: ["iva", "alicuota", "ivaporcentaje"],
  stock_minimo: ["stockminimo", "minimo", "stockmin"],
  tamano_envase: ["env", "envase", "tamanoenvase", "tamano", "presentacion", "capacidad"],
  unidad_medida: ["unidad", "unidadmedida", "um", "medida"],
  categoria: ["categoria", "rubro"],
  marca: ["marca", "fabricante"],
};

// Números que pueden venir en formato argentino ("1.234,56": punto miles, coma
// decimal) o inglés/datos ("1234.56": punto decimal). Reglas:
//  - Si hay coma: la coma es el decimal y los puntos (si hay) son miles.
//  - Si NO hay coma y hay VARIOS puntos: son separadores de miles ("1.234.567").
//  - Si NO hay coma y hay UN solo punto: es el decimal y se respeta tal cual
//    ("224410.56" NO se convierte en 22441056). Antes se lo trataba como miles
//    cuando tenía 3 dígitos, lo que corrompía precios de lista con muchos decimales.
export function parseNumAr(v: unknown): number {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  let s = String(v)
    .trim()
    .replace(/[^\d.,-]/g, "");
  if (s === "") return NaN;
  const puntos = (s.match(/\./g) || []).length;
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (puntos > 1) {
    s = s.replace(/\./g, "");
  }
  return Number(s);
}

// parseNumAr con valor por defecto cuando la celda está vacía o no es un número.
export const numOr = (v: unknown, def: number) => {
  const n = parseNumAr(v);
  return Number.isFinite(n) ? n : def;
};

// Guardas semánticas del auto-mapeo: una cabecera puede coincidir con un sinónimo
// y aun así traer el dato equivocado. Devuelven true cuando hay que RECHAZARLA
// para ese campo. Es más mantenible que una lista de sinónimos interminable.
const RECHAZAR_CABECERA: Record<string, (normalizada: string) => boolean> = {
  // El % de IVA no debe engancharse a una columna de PRECIO que contenga "c/iva"
  // (ej "Sugerido al público C/IVA"): sus valores romperían numeric(5,2).
  iva_porcentaje: (h) => /precio|sugerido|publico|venta|costo|importe/.test(h),
  // El sugerido se asume CON IVA: el cálculo lo divide por (1 + iva/100) para
  // guardar el neto. Si una planilla trae "PVP S/IVA" o "Precio sugerido s/IVA",
  // el sinónimo amplio ("pvp", "sugerido") se la llevaría y se le sacaría el IVA
  // a un número que ya era neto: todos esos precios bajarían ~17% en silencio.
  // "S/IVA" normaliza a "siva" y "SIN IVA" a "siniva" — hay que mirar los dos.
  // También "NETO" y "sin impuestos", que son la misma trampa con otro nombre.
  // Ante la duda se RECHAZA: no auto-mapear cuesta un click; auto-mapear un neto
  // como si fuera bruto baja todos esos precios un 17% sin que nadie lo note.
  precio_sugerido_publico: (h) =>
    (h.includes("siva") ||
      h.includes("siniva") ||
      h.includes("neto") ||
      h.includes("sinimpuesto")) &&
    !h.includes("civa") &&
    !h.includes("coniva"),
};

export function autoMapear(headers: string[]): Record<string, string> {
  const auto: Record<string, string> = {};
  const usados = new Set<string>();
  for (const t of FIELDS_TARGET) {
    const candidatos = SINONIMOS[t.key] ?? [t.key];
    const rechazar = RECHAZAR_CABECERA[t.key];
    const admisible = (h: string) => !usados.has(h) && !rechazar?.(normalizar(h));
    // Coincidencia exacta primero; si no, la cabecera que contenga el sinónimo.
    const elegida =
      headers.find((h) => admisible(h) && candidatos.includes(normalizar(h))) ??
      headers.find((h) => admisible(h) && candidatos.some((c) => normalizar(h).includes(c)));
    if (elegida) {
      auto[t.key] = elegida;
      usados.add(elegida);
    }
  }
  return auto;
}

// ---------------------------------------------------------------------------
// Chequeos del mapeo que hace la persona a mano (la pantalla avisa, no bloquea)
// ---------------------------------------------------------------------------

/**
 * Cabeceras asignadas a más de un campo destino.
 *
 * Le pasó al cliente: mapeó "PRECIO DE LISTA" en "Precio de lista" y también en
 * "Precio fábrica (costo)". No rompe —hay precedencias que lo salvan— pero casi
 * nunca es lo que se quiso hacer.
 */
export function columnasDuplicadas(mapping: Record<string, string>): string[] {
  const cuenta = new Map<string, number>();
  for (const col of Object.values(mapping)) {
    if (col) cuenta.set(col, (cuenta.get(col) ?? 0) + 1);
  }
  return [...cuenta.entries()].filter(([, n]) => n > 1).map(([col]) => col);
}

/**
 * Una columna del archivo que parece el sugerido al público y NO está mapeada al
 * campo del sugerido.
 *
 * Sin este aviso, re-importar la lista olvidándose de mapearla haría que los
 * precios vuelvan al cálculo por costo: el bug que esta feature arregla, de vuelta
 * y sin que nadie se entere.
 *
 * Deliberadamente NO se saltean las cabeceras ya usadas por otro campo: mapear la
 * columna del sugerido a "Precio s/IVA" o a "IVA %" —que es exactamente lo que
 * hizo el cliente— es todavía peor que no mapearla, y también hay que avisarlo.
 */
export function sugeridoSinMapear(
  headers: string[],
  mapping: Record<string, string>,
): string | null {
  if (mapping.precio_sugerido_publico) return null;
  const rechazar = RECHAZAR_CABECERA.precio_sugerido_publico;
  return (
    headers.find((h) => {
      const n = normalizar(h);
      return !rechazar(n) && (n.includes("sugerido") || n.includes("pvp"));
    }) ?? null
  );
}

// En las listas reales el título ("LISTA DE PRECIOS N° ...") ocupa las primeras
// filas y los encabezados (CÓDIGO, DESCRIPCIÓN, PRECIO DE LISTA) están más abajo.
// Devolvemos el índice de la primera fila que parezca la de encabezados.
export function detectarFilaEncabezados(aoa: unknown[][]): number {
  const claves = ["codigo", "descripcion", "denominacion", "precio", "nombre"];
  for (let i = 0; i < Math.min(aoa.length, 20); i++) {
    const celdas = (aoa[i] || []).map((c) => normalizar(String(c)));
    if (celdas.filter((c) => claves.some((k) => c.includes(k))).length >= 2) return i;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// De la fila cruda de la planilla a la cadena de precios
// ---------------------------------------------------------------------------

/** Fila cruda de la planilla, tal como la devuelve XLSX/Papa (cabecera -> celda). */
export type FilaPlanilla = Record<string, unknown>;

/** Lo que ya sabemos de un producto que está en el catálogo, indexado por código. */
export type ProductoGuardado = {
  precio_sugerido_publico: number | null;
  markup_porcentaje: number | null;
  /**
   * El descuento PROPIO del producto, si tiene uno cargado.
   *
   * Va separado del de su proveedor porque sobrevive a cosas distintas: elegir un
   * proveedor para todo el archivo reemplaza el del proveedor, pero NO éste — es
   * una decisión sobre ese renglón, no sobre de quién se le compra.
   */
  descuento_porcentaje?: number | null;
  /**
   * El descuento del PROVEEDOR que ya tiene el producto. Se usa cuando la pantalla
   * no eligió un proveedor para todo el archivo: sin esto, todas las filas se
   * derivaban con el mismo descuento de pantalla, así que reimportar una lista
   * mixta le calculaba a los productos de un proveedor el costo con el descuento
   * de otro.
   */
  descuento_proveedor_porcentaje?: number | null;
};

/** Celda numérica opcional: vacía o no-numérica -> null (igual que tamano_envase). */
export const numOrNull = (v: unknown): number | null => {
  const n = parseNumAr(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Traduce una fila de la planilla a la cadena de precios, con el mapeo elegido.
 *
 * La usan la vista previa Y la importación, para que lo que se ve en pantalla sea
 * exactamente lo que se va a guardar.
 *
 * Hay DOS datos que salen del catálogo y no de la planilla, y los dos existen por
 * la misma razón: una importación no puede degradar en silencio lo que ya estaba.
 *
 *  - EL SUGERIDO, cuando la columna no está mapeada. El importador escribe
 *    `precio_sin_iva` en TODAS las filas. Si no se le pasara el sugerido guardado,
 *    una importación a la que se le olvidó mapear esa columna volvería a derivar el
 *    precio del costo y pisaría el neto derivado del sugerido — el bug original,
 *    reintroducido sin que nadie se entere. Omitir la columna del payload conserva
 *    el dato, no el precio.
 *  - EL MARKUP PROPIO del producto. Antes la importación recalculaba todo con el
 *    markup default, así que a un producto con markup propio le quedaba un precio
 *    que contradecía su propio markup.
 */
export function calcularFila(
  r: FilaPlanilla,
  mapping: Record<string, string>,
  p: { descuento: number; markupDefault: number },
  guardado?: ProductoGuardado,
) {
  const precio_lista = mapping.precio_lista ? numOr(r[mapping.precio_lista], 0) : 0;
  // La escalera completa: el del PRODUCTO, si no el de SU proveedor, si no el de
  // la pantalla (que es el del proveedor elegido para el archivo, o el global).
  const descuento =
    guardado?.descuento_porcentaje ?? guardado?.descuento_proveedor_porcentaje ?? p.descuento;
  const precio_fabrica =
    mapping.precio_lista && precio_lista > 0
      ? costoDeLista(precio_lista, descuento)
      : mapping.precio_fabrica
        ? numOr(r[mapping.precio_fabrica], 0)
        : 0;
  // Una CELDA vacía es lo mismo que una columna sin mapear: la planilla no trae
  // el dato, así que se conserva el guardado. La protección tiene que ser por
  // FILA y no por columna — las listas de proveedor no llenan el sugerido en
  // todos los renglones, y un blanco no significa "este producto ya no tiene
  // precio sugerido", significa "acá no lo pusieron". Tomarlo como un borrado
  // devolvía ese producto al cálculo por costo: −40% de un plumazo.
  // Para sacarle el sugerido a un producto se edita el producto.
  const precio_sugerido_publico =
    (mapping.precio_sugerido_publico ? numOrNull(r[mapping.precio_sugerido_publico]) : null) ??
    guardado?.precio_sugerido_publico ??
    null;
  // parseNumAr PRIMERO: en un CSV (o en una columna de texto del Excel) el IVA
  // llega como "10,5", y `normalizarIva` sólo entiende números — lo descartaría y
  // caería a 21. Antes eso sólo cambiaba lo que se le cobraba al cliente; ahora el
  // IVA divide al sugerido, así que también decide el neto que se factura: un
  // producto al 10,5% leído como 21% le deja al negocio ~8,7% menos por unidad.
  const iva_porcentaje = normalizarIva(
    mapping.iva_porcentaje ? numOr(r[mapping.iva_porcentaje], 21) : 21,
  );

  return {
    codigo: String(r[mapping.codigo] ?? "").trim(),
    nombre: String(r[mapping.nombre] ?? "").trim(),
    envase: mapping.tamano_envase ? numOrNull(r[mapping.tamano_envase]) : null,
    precio_lista,
    precio_fabrica,
    precio_sugerido_publico,
    iva_porcentaje,
    ...calcularPrecios(
      {
        precio_fabrica,
        precio_sugerido_publico,
        precio_sin_iva: mapping.precio_sin_iva ? numOrNull(r[mapping.precio_sin_iva]) : null,
        markup_porcentaje: guardado?.markup_porcentaje ?? null,
        iva_porcentaje,
      },
      { markupDefault: p.markupDefault },
    ),
  };
}
