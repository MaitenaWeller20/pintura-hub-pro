import { z } from "zod";
import { cuitValido } from "./codigos";

export const receptorPadronArcaSchema = z
  .object({
    cuit: z.string().refine(cuitValido),
    razonSocial: z.string().trim().min(1),
    domicilioFiscal: z.string().trim().min(1).nullable(),
    estado: z.literal("ACTIVO"),
    tipoPersona: z.enum(["FISICA", "JURIDICA"]),
    condicionIvaConfirmada: z.enum(["RESPONSABLE_INSCRIPTO", "MONOTRIBUTO"]).nullable(),
    verificadoArcaAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ReceptorPadronArca = z.infer<typeof receptorPadronArcaSchema>;

export const CODIGOS_ERROR_PADRON_ARCA = [
  "PADRON_ARCA_CAIDO",
  "PADRON_NO_AUTORIZADO",
  "PADRON_CONFIG_INVALIDA",
  "CUIT_INVALIDO",
  "CUIT_NO_ENCONTRADO",
  "CUIT_INACTIVO",
  "RESPUESTA_PADRON_INVALIDA",
  "CONDICION_FISCAL_INCOMPATIBLE",
] as const;

export type CodigoErrorPadronArca = (typeof CODIGOS_ERROR_PADRON_ARCA)[number];

export function esCodigoErrorPadronArca(value: unknown): value is CodigoErrorPadronArca {
  return (
    typeof value === "string" && (CODIGOS_ERROR_PADRON_ARCA as readonly string[]).includes(value)
  );
}
