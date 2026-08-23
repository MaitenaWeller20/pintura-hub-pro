export type ValidezFiscalTipo = "PRODUCCION" | "HOMOLOGACION" | "SIMULADA";

export function textoValidezFiscal(validez: ValidezFiscalTipo | null | undefined): string {
  if (validez === "PRODUCCION") return "Producción · validez legal";
  if (validez === "HOMOLOGACION") return "Homologación · sin validez legal";
  if (validez === "SIMULADA") return "Simulada · sin validez legal";
  return "Validez pendiente";
}
