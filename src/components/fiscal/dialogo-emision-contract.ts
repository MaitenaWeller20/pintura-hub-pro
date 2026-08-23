import { z } from "zod";

const uuid = z.string().uuid();
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().regex(/^(0|[1-9]\d{0,12})\.\d{2}$/);
const huella = z.string().regex(/^[0-9a-f]{64}$/);
const cuit = z.string().regex(/^\d{11}$/);

const receptorConfirmadoSchema = z
  .object({
    razonSocial: z.string().min(1),
    domicilio: z.string().nullable(),
    tipoDocumento: z.enum(["CUIT", "CUIL", "DNI", "CDI", "SIN_IDENTIFICAR"]),
    numeroDocumento: z.string().nullable(),
    docTipoArca: z.union([
      z.literal(80),
      z.literal(86),
      z.literal(87),
      z.literal(96),
      z.literal(99),
    ]),
    docNroArca: z.string().regex(/^\d+$/),
    condicionIva: z.enum(["RESPONSABLE_INSCRIPTO", "MONOTRIBUTO", "EXENTO", "CONSUMIDOR_FINAL"]),
    origen: z.enum(["CLIENTE_COMERCIAL", "FAVORITO", "MANUAL", "ARCA"]),
    origenId: uuid.nullable(),
    verificadoArcaAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

const confirmacionAutoritativaSchema = z
  .object({
    version: z.literal(1),
    importe: decimal,
    emisorCuit: cuit,
    puntoVenta: z.number().int().positive(),
    modo: z.enum(["PRODUCCION", "HOMOLOGACION"]),
    letra: z.enum(["A", "B", "C"]),
    cbteTipo: z.number().int().positive(),
    fechaFiscal: fecha,
    receptor: receptorConfirmadoSchema,
  })
  .strict();

const previewAutoritativaSchema = z
  .object({
    autoritativo: z.literal(true),
    venta_id: uuid,
    fecha_comercial: z.string().datetime({ offset: true }),
    fecha_fiscal: fecha,
    total: decimal,
    pagado: decimal,
    saldo: decimal,
    comprador: uuid.nullable(),
    receptor: receptorConfirmadoSchema,
    letra: z.enum(["A", "B", "C"]),
    razon_letra: z.string().min(1),
    emisor_cuit: cuit,
    punto_venta: z.number().int().positive(),
    modo: z.enum(["PRODUCCION", "HOMOLOGACION"]),
    cbte_tipo: z.number().int().positive(),
    demora_dias: z.number().int().nonnegative(),
    advertencia_demora: z.string().min(1).nullable(),
    confirmacion_factura_a_permitida: z.boolean(),
    confirmacion_autoritativa: confirmacionAutoritativaSchema,
    huella_confirmacion: huella,
  })
  .strict();

const previewProvisionalSchema = z
  .object({
    autoritativo: z.literal(false),
    requiere_reconfirmacion_post_creacion: z.literal(true),
    comprador: uuid,
    receptor: receptorConfirmadoSchema,
    emisor_cuit: cuit,
    punto_venta: z.number().int().positive(),
    modo: z.enum(["PRODUCCION", "HOMOLOGACION"]),
    letra: z.enum(["A", "B", "C"]),
    razon_letra: z.string().min(1),
    fecha_comercial: z.string().datetime({ offset: true }),
    fecha_fiscal: fecha,
    demora_dias: z.number().int().nonnegative(),
    advertencia_demora: z.string().min(1).nullable(),
    total: decimal,
    pagado: decimal,
    saldo: decimal,
    confirmacion_factura_a_permitida: z.boolean(),
    huella_confirmacion: huella,
    confirmacion_provisional: z
      .object({
        importe: decimal,
        emisor_cuit: cuit,
        punto_venta: z.number().int().positive(),
        modo: z.enum(["PRODUCCION", "HOMOLOGACION"]),
        letra: z.enum(["A", "B", "C"]),
        receptor: receptorConfirmadoSchema,
      })
      .strict(),
    advertencia: z.string().min(1),
  })
  .strict();

const previewEmisionFiscalSchema = z.discriminatedUnion("autoritativo", [
  previewAutoritativaSchema,
  previewProvisionalSchema,
]);

const resultadoEmisionFiscalSchema = z.discriminatedUnion("estado", [
  z
    .object({
      estado: z.literal("APROBADO"),
      cae: z.string().min(1),
      numero: z.number().int().positive(),
      recuperado: z.boolean(),
      advertencias: z.array(z.string()),
    })
    .strict(),
  z.object({ estado: z.literal("ERROR_CORREGIBLE"), mensaje: z.string().min(1) }).strict(),
  z.object({ estado: z.literal("RECONCILIAR"), mensaje: z.string().min(1) }).strict(),
  z.object({ estado: z.literal("BLOQUEADO"), diferencias: z.array(z.string()) }).strict(),
  z.object({ estado: z.literal("EN_CURSO"), mensaje: z.string().min(1) }).strict(),
]);

const reconfirmacionSchema = z
  .object({
    estado: z.literal("RECONFIRMACION_REQUERIDA"),
    mensaje: z.string().min(1),
    huella_confirmacion: huella,
    confirmacion_autoritativa: confirmacionAutoritativaSchema,
  })
  .strict();

const respuestaConfirmacionSchema = z.discriminatedUnion("estado", [
  ...resultadoEmisionFiscalSchema.options,
  reconfirmacionSchema,
]);

export type PreviewEmisionFiscal = z.infer<typeof previewEmisionFiscalSchema>;
export type ResultadoEmisionFiscalUi = z.infer<typeof resultadoEmisionFiscalSchema>;
export type RespuestaReconfirmacion = z.infer<typeof reconfirmacionSchema>;
export type RespuestaConfirmacionFiscal = z.infer<typeof respuestaConfirmacionSchema>;

function parsear<T>(schema: z.ZodType<T>, value: unknown, mensaje: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(mensaje);
  return parsed.data;
}

export function parsePreviewEmisionFiscal(value: unknown): PreviewEmisionFiscal {
  return parsear(
    previewEmisionFiscalSchema,
    value,
    "ARCA no devolvió una previsualización fiscal completa y válida.",
  );
}

export function parsePreviewEmisionFiscalAutoritativa(
  value: unknown,
): z.infer<typeof previewAutoritativaSchema> {
  return parsear(
    previewAutoritativaSchema,
    value,
    "ARCA no devolvió una previsualización fiscal autoritativa completa y válida.",
  );
}

export function parseRespuestaConfirmacionFiscal(value: unknown): RespuestaConfirmacionFiscal {
  return parsear(
    respuestaConfirmacionSchema,
    value,
    "ARCA devolvió una respuesta fiscal desconocida o incompleta.",
  );
}

export function despacharRespuestaConfirmacionFiscal(
  value: unknown,
  handlers: {
    onReconfirmacion(result: RespuestaReconfirmacion): void;
    onCompletada(result: ResultadoEmisionFiscalUi): void;
  },
): "RECONFIRMACION" | "COMPLETADA" {
  const resultado = parseRespuestaConfirmacionFiscal(value);
  if (resultado.estado === "RECONFIRMACION_REQUERIDA") {
    handlers.onReconfirmacion(resultado);
    return "RECONFIRMACION";
  }
  handlers.onCompletada(resultado);
  return "COMPLETADA";
}

export function parseResultadoConciliacionFiscal(value: unknown): ResultadoEmisionFiscalUi {
  return parsear(
    resultadoEmisionFiscalSchema,
    value,
    "ARCA devolvió una conciliación fiscal desconocida o incompleta.",
  );
}

export function parseResultadoLiberacionFiscal(value: unknown): { estado: "LIBERADO" } {
  return parsear(
    z.object({ estado: z.literal("LIBERADO") }).strict(),
    value,
    "El servidor devolvió una liberación fiscal desconocida o incompleta.",
  );
}
