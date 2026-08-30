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
