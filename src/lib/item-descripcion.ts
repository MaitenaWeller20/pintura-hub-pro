export const MAX_DESCRIPCION_ITEM = 160;

export function normalizarDescripcionItem(value: string): string {
  const normalizada = value.trim().replace(/\s+/gu, " ");
  if (!normalizada) throw new Error("Ingresá una descripción para la línea.");
  if ([...normalizada].length > MAX_DESCRIPCION_ITEM) {
    throw new Error(`La descripción puede tener hasta ${MAX_DESCRIPCION_ITEM} caracteres.`);
  }
  return normalizada;
}
