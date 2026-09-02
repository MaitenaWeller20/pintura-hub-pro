export const MAX_DESCRIPCION_ITEM = 160;

const DESCRIPCION_WHITESPACE_RE = new RegExp(
  // eslint-disable-next-line no-control-regex -- HT..CR son parte explícita del contrato común.
  "[\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+",
  "gu",
);

export function normalizarDescripcionItem(value: string): string {
  const normalizada = value.replace(DESCRIPCION_WHITESPACE_RE, " ").replace(/^ | $/gu, "");
  if (!normalizada) throw new Error("Ingresá una descripción para la línea.");
  if ([...normalizada].length > MAX_DESCRIPCION_ITEM) {
    throw new Error(`La descripción puede tener hasta ${MAX_DESCRIPCION_ITEM} caracteres.`);
  }
  return normalizada;
}

export type EstadoDescripcionItem = {
  personalizada: boolean;
  valida: boolean;
  caracteres: number;
  mensaje: string | null;
};

/**
 * El browser sólo es autoritativo cuando el operador cambia el texto. Una
 * coincidencia byte a byte conserva el fallback/snapshot del servidor, incluso
 * si ese texto histórico antecede al límite actual.
 */
export function descripcionItemParaPayload(
  descripcion: string,
  descripcionBase: string,
): { descripcion?: string } {
  if (descripcion === descripcionBase) return {};
  return { descripcion: normalizarDescripcionItem(descripcion) };
}

export function estadoDescripcionItem(
  descripcion: string,
  descripcionBase: string,
): EstadoDescripcionItem {
  if (descripcion === descripcionBase) {
    return {
      personalizada: false,
      valida: true,
      caracteres: [...descripcion].length,
      mensaje: null,
    };
  }
  try {
    const normalizada = normalizarDescripcionItem(descripcion);
    return {
      personalizada: true,
      valida: true,
      caracteres: [...normalizada].length,
      mensaje: null,
    };
  } catch (cause) {
    return {
      personalizada: true,
      valida: false,
      caracteres: [...descripcion].length,
      mensaje: cause instanceof Error ? cause.message : "La descripción de la línea es inválida.",
    };
  }
}
