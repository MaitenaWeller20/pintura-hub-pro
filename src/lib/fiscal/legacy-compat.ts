import { fmtFechaIsoAr } from "./fecha";

/**
 * Evidencia mínima e inequívoca que deja el writer legacy durante el drain.
 * Sigue siendo version 0: nunca se presenta como snapshot v2 completo.
 */
export function camposEvidenciaFiscalLegacy(input: {
  modo: "PRODUCCION" | "HOMOLOGACION";
  simulado: boolean;
  fecha: string;
}) {
  return {
    afip_version: 0,
    afip_legacy_incompleto: true,
    afip_validez: input.simulado ? ("SIMULADA" as const) : input.modo,
    afip_fecha_comprobante: fmtFechaIsoAr(new Date(input.fecha)),
  };
}
