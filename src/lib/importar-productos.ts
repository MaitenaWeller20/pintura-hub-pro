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

export type CampoDestino = { key: string; label: string };

export const FIELDS_TARGET: CampoDestino[] = [
  { key: "codigo", label: "Código *" },
  { key: "nombre", label: "Nombre *" },
  { key: "precio_lista", label: "Precio de lista (Quimex)" },
  { key: "precio_fabrica", label: "Precio fábrica (costo)" },
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

export function autoMapear(headers: string[]): Record<string, string> {
  const auto: Record<string, string> = {};
  const usados = new Set<string>();
  for (const t of FIELDS_TARGET) {
    const candidatos = SINONIMOS[t.key] ?? [t.key];
    // Coincidencia exacta primero; si no, la cabecera que contenga el sinónimo.
    const exacto = headers.find((h) => !usados.has(h) && candidatos.includes(normalizar(h)));
    let parcial =
      exacto ??
      headers.find((h) => !usados.has(h) && candidatos.some((c) => normalizar(h).includes(c)));
    // El % de IVA no debe engancharse a una columna de PRECIO que contenga "c/iva"
    // (ej "Sugerido al público C/IVA"): sus valores romperían numeric(5,2).
    if (
      parcial &&
      exacto == null &&
      t.key === "iva_porcentaje" &&
      /precio|sugerido|publico|venta|costo|importe/.test(normalizar(parcial))
    ) {
      parcial = undefined;
    }
    if (parcial) {
      auto[t.key] = parcial;
      usados.add(parcial);
    }
  }
  return auto;
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
