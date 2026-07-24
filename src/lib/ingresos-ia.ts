/**
 * Esquemas y lógica pura de la extracción de remitos. Sin dependencias de servidor
 * ni del SDK, para poder testearlo con vitest.
 */
// zod/v4 (incluido en zod 3.25+): es la variante que espera zodOutputFormat del
// SDK de Anthropic. Misma API para lo que usamos acá (object/string/array/enum/
// nullable/describe/infer). El resto del repo sigue con `import { z } from "zod"`.
import * as z from "zod/v4";

// ---------------------------------------------------------------------------
// Esquemas de la extracción (salida estructurada del modelo)
// ---------------------------------------------------------------------------

// Una línea tal como la lee el modelo del papel. Guardamos SIEMPRE el crudo
// (cantidad_raw, descripcion_raw) además del valor interpretado: es la defensa
// contra el problema del remito de Quimexur, donde "BASE TINT. ... 10 LT. 1.00"
// tiene el envase (10 LT) en el medio y la cantidad real (1.00) al final.
export const LineaExtraidaSchema = z.object({
  linea: z
    .number()
    .int()
    .describe("Número de orden de la línea dentro del remito, empezando en 1."),
  pagina: z
    .number()
    .int()
    .describe("Número de página del PDF donde aparece la línea, empezando en 1."),
  codigo_proveedor: z
    .string()
    .describe("El código del artículo tal como figura en el remito. Vacío si no hay."),
  descripcion: z.string().describe("La descripción del artículo, sin el código."),
  cantidad: z
    .number()
    .describe(
      "La CANTIDAD de unidades/bultos. NO es el tamaño del envase. Si la fila dice '10 LT ... 1.00', la cantidad es 1.",
    ),
  cantidad_raw: z
    .string()
    .describe("El texto crudo de la columna de cantidad, tal cual está impreso."),
  descripcion_raw: z
    .string()
    .describe("La descripción completa cruda, incluyendo envase/unidad si aparecen ahí."),
  advertencia: z
    .string()
    .nullable()
    .describe(
      "Si hay ambigüedad entre envase y cantidad, u otra duda, describila acá. null si no hay.",
    ),
});
export type LineaExtraida = z.infer<typeof LineaExtraidaSchema>;

export const ExtraccionSchema = z.object({
  proveedor_nombre: z
    .string()
    .nullable()
    .describe("Razón social del proveedor que emite el remito (QUIMEXUR, KUM, etc.)."),
  numero_remito: z
    .string()
    .nullable()
    .describe(
      "El número del remito tal como figura en el papel (ej '00054-00023918'). null si no se ve.",
    ),
  numeros_remito_detectados: z
    .array(z.string())
    .describe(
      "TODOS los números de remito distintos que aparecen en el documento. Si hay más de uno, son documentos mezclados.",
    ),
  fecha_remito: z
    .string()
    .nullable()
    .describe("Fecha del remito en formato YYYY-MM-DD. null si no se ve."),
  fechas_detectadas: z
    .array(z.string())
    .describe("Todas las fechas de remito distintas detectadas, en YYYY-MM-DD."),
  paginas_total: z.number().int().describe("Cantidad de páginas del documento."),
  items: z.array(LineaExtraidaSchema),
});
export type Extraccion = z.infer<typeof ExtraccionSchema>;

// ---------------------------------------------------------------------------
// Esquema del matching (segunda llamada, sólo texto)
// ---------------------------------------------------------------------------

export const MatchDecisionSchema = z.object({
  decisiones: z.array(
    z.object({
      linea: z.number().int().describe("El número de línea que se está resolviendo."),
      producto_id: z
        .string()
        .nullable()
        .describe(
          "El id del producto elegido de la lista de candidatos, o null si ninguno corresponde.",
        ),
      confianza: z.enum(["ALTA", "MEDIA", "BAJA"]).describe("Qué tan seguro estás del match."),
    }),
  ),
});
export type MatchDecision = z.infer<typeof MatchDecisionSchema>;

// ---------------------------------------------------------------------------
// Detección de páginas duplicadas (un PDF real de Quimexur trae la misma página
// dos veces). Deduplicamos por firma de PÁGINA, nunca por producto: dos líneas
// del mismo producto pueden ser legítimas.
// ---------------------------------------------------------------------------

/** Firma estable de una página: el conjunto de sus líneas normalizadas. */
export function firmaPagina(items: LineaExtraida[], pagina: number): string {
  return items
    .filter((it) => it.pagina === pagina)
    .map(
      (it) =>
        `${normalizarTexto(it.codigo_proveedor)}|${normalizarTexto(it.descripcion_raw)}|${it.cantidad_raw.trim()}`,
    )
    .sort()
    .join("\n");
}

/**
 * Devuelve el set de páginas que son duplicado EXACTO de una página anterior.
 * La primera aparición de cada firma se conserva; las repetidas se marcan.
 */
export function paginasDuplicadas(items: LineaExtraida[]): Set<number> {
  const paginas = [...new Set(items.map((it) => it.pagina))].sort((a, b) => a - b);
  const vistas = new Map<string, number>();
  const dup = new Set<number>();
  for (const p of paginas) {
    const firma = firmaPagina(items, p);
    if (firma === "") continue;
    if (vistas.has(firma)) dup.add(p);
    else vistas.set(firma, p);
  }
  return dup;
}

/** Quita las líneas de páginas duplicadas. */
export function quitarPaginasDuplicadas(items: LineaExtraida[]): {
  items: LineaExtraida[];
  paginasQuitadas: number[];
} {
  const dup = paginasDuplicadas(items);
  if (dup.size === 0) return { items, paginasQuitadas: [] };
  return {
    items: items.filter((it) => !dup.has(it.pagina)),
    paginasQuitadas: [...dup].sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------------------
// Detección de documento mezclado: dos números de remito o dos fechas distintas
// bloquean la confirmación (probablemente son dos remitos en un mismo archivo).
// ---------------------------------------------------------------------------

export function documentoInconsistente(
  ex: Pick<Extraccion, "numeros_remito_detectados" | "fechas_detectadas">,
): string | null {
  const nums = [...new Set(ex.numeros_remito_detectados.map(normalizarTexto).filter(Boolean))];
  const fechas = [...new Set(ex.fechas_detectadas.map((f) => f.trim()).filter(Boolean))];
  if (nums.length > 1)
    return `El archivo tiene ${nums.length} números de remito distintos (${ex.numeros_remito_detectados.join(", ")}). Separá los remitos en archivos distintos.`;
  if (fechas.length > 1)
    return `El archivo tiene ${fechas.length} fechas de remito distintas (${fechas.join(", ")}). Separá los remitos en archivos distintos.`;
  return null;
}

// ---------------------------------------------------------------------------
// Detección de riesgo envase/cantidad: si la descripción cruda tiene un número
// pegado a una unidad de medida, marcamos la línea para revisión.
// ---------------------------------------------------------------------------

const UNIDADES =
  /\b\d+([.,]\d+)?\s?(lts|lt|litros|litro|kgs|kg|kilos|kilo|grs|gr|gramos|gramo|ml|cc|und|un|mts|mt|metros|metro|l|m|u)\b/i;

export function riesgoEnvaseCantidad(
  linea: Pick<LineaExtraida, "descripcion_raw" | "advertencia">,
): boolean {
  if (linea.advertencia) return true;
  return UNIDADES.test(linea.descripcion_raw ?? "");
}

// ---------------------------------------------------------------------------
// Normalización de texto para comparar (firmas, números de remito).
// Debe coincidir en espíritu con la función SQL normalizar_codigo.
// ---------------------------------------------------------------------------

export function normalizarTexto(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// Tipos de archivo aceptados y tope de tamaño (espejo del bucket).
export const MIME_ACEPTADOS = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export const TAMANO_MAX_BYTES = 10 * 1024 * 1024;

export function validarArchivo(mime: string, bytes: number): string | null {
  if (!MIME_ACEPTADOS.includes(mime as any)) {
    return `Tipo de archivo no soportado (${mime}). Subí un PDF o una foto (JPG/PNG/WebP).`;
  }
  if (bytes > TAMANO_MAX_BYTES) {
    return `El archivo pesa ${(bytes / 1024 / 1024).toFixed(1)} MB; el máximo es 10 MB.`;
  }
  return null;
}
