import { z } from "zod";
import { cuitValido, determinarLetra, letraDeCbteTipo } from "@/lib/fiscal/codigos";
import {
  confirmacionesFiscalesIguales,
  verificarHuellaConfirmacionFiscal,
  type ConfirmacionFiscalPostBorrador,
} from "@/lib/fiscal/confirmacion";
import { validarFechaIsoCalendario } from "@/lib/fiscal/fecha";
import { validarReceptorFiscalConfirmado } from "@/lib/fiscal/receptor";
import type { LetraSolicitada } from "./dialogo-emision-state";

const uuid = z.string().uuid();
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().regex(/^(0|[1-9]\d{0,12})\.\d{2}$/);
const huella = z.string().regex(/^[0-9a-f]{64}$/);
const cuit = z.string().regex(/^\d{11}$/);
const textoSemantico = z.string().refine((value) => value.trim().length > 0);
const cae = z
  .string()
  .regex(/^\d{14}$/)
  .refine((value) => value !== "00000000000000");
const validezFiscal = z.enum(["PRODUCCION", "HOMOLOGACION", "SIMULADA"]);
const cbteAsocSchema = z
  .object({
    tipo: z.number().int().positive(),
    letra: z.enum(["A", "B", "C"]),
    punto_venta: z.number().int().positive(),
    numero: z.number().int().positive(),
    fecha,
  })
  .strict();
const cbteAsocConfirmacionSchema = z
  .object({
    tipo: z.number().int().positive(),
    letra: z.enum(["A", "B", "C"]),
    puntoVenta: z.number().int().positive(),
    numero: z.number().int().positive(),
    fecha,
  })
  .strict();

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
    emisorRazonSocial: textoSemantico,
    sucursalId: uuid,
    sucursalNombre: textoSemantico,
    puntoVenta: z.number().int().positive(),
    modo: z.enum(["PRODUCCION", "HOMOLOGACION"]),
    afipValidez: validezFiscal,
    letra: z.enum(["A", "B", "C"]),
    cbteTipo: z.number().int().positive(),
    fechaFiscal: fecha,
    pagado: decimal,
    saldo: decimal,
    cbteAsoc: cbteAsocConfirmacionSchema.nullable(),
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
    emisor_razon_social: textoSemantico,
    sucursal_id: uuid,
    sucursal_nombre: textoSemantico,
    punto_venta: z.number().int().positive(),
    modo: z.enum(["PRODUCCION", "HOMOLOGACION"]),
    afip_validez: validezFiscal,
    cbte_tipo: z.number().int().positive(),
    cbte_asoc: cbteAsocSchema.nullable(),
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
    emisor_razon_social: textoSemantico,
    sucursal_id: uuid,
    sucursal_nombre: textoSemantico,
    punto_venta: z.number().int().positive(),
    modo: z.enum(["PRODUCCION", "HOMOLOGACION"]),
    afip_validez: validezFiscal,
    letra: z.enum(["A", "B", "C"]),
    cbte_tipo: z.number().int().positive(),
    cbte_asoc: cbteAsocSchema.nullable(),
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
        version: z.literal(1),
        importe: decimal,
        emisor_cuit: cuit,
        emisor_razon_social: textoSemantico,
        sucursal_id: uuid,
        sucursal_nombre: textoSemantico,
        punto_venta: z.number().int().positive(),
        modo: z.enum(["PRODUCCION", "HOMOLOGACION"]),
        afip_validez: validezFiscal,
        letra: z.enum(["A", "B", "C"]),
        cbte_tipo: z.number().int().positive(),
        fecha_fiscal: fecha,
        pagado: decimal,
        saldo: decimal,
        cbte_asoc: cbteAsocSchema.nullable(),
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
      cae,
      numero: z.number().int().positive(),
      recuperado: z.boolean(),
      advertencias: z.array(textoSemantico),
    })
    .strict(),
  z.object({ estado: z.literal("ERROR_CORREGIBLE"), mensaje: textoSemantico }).strict(),
  z.object({ estado: z.literal("RECONCILIAR"), mensaje: textoSemantico }).strict(),
  z
    .object({ estado: z.literal("BLOQUEADO"), diferencias: z.array(textoSemantico).min(1) })
    .strict(),
  z.object({ estado: z.literal("EN_CURSO"), mensaje: textoSemantico }).strict(),
]);

const reconfirmacionSchema = z
  .object({
    estado: z.literal("RECONFIRMACION_REQUERIDA"),
    mensaje: z.string().min(1),
    afip_validez: validezFiscal,
    preview_autoritativa: previewAutoritativaSchema,
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

type PreviewAutoritativa = z.infer<typeof previewAutoritativaSchema>;
type PreviewProvisional = z.infer<typeof previewProvisionalSchema>;
type ConfirmacionEstructural = z.infer<typeof confirmacionAutoritativaSchema>;

function validarConfirmacionSemantica(confirmacion: ConfirmacionEstructural): void {
  validarFechaIsoCalendario(confirmacion.fechaFiscal, "La fecha fiscal");
  if (!cuitValido(confirmacion.emisorCuit)) {
    throw new Error("El CUIT emisor no es canónico o no tiene dígito verificador válido.");
  }
  validarReceptorFiscalConfirmado(confirmacion.receptor, Number(confirmacion.importe));
  const esNota = [2, 3, 7, 8, 12, 13].includes(confirmacion.cbteTipo);
  if (esNota) {
    if (!confirmacion.cbteAsoc) {
      throw new Error("La nota fiscal no conserva el comprobante asociado.");
    }
    if (confirmacion.letra !== confirmacion.cbteAsoc.letra) {
      throw new Error("La nota fiscal no hereda la letra del comprobante asociado.");
    }
  } else {
    const letraEsperada = determinarLetra(
      "RESPONSABLE_INSCRIPTO",
      confirmacion.receptor.condicionIva,
    );
    if (confirmacion.letra !== letraEsperada) {
      throw new Error("La letra no coincide con la condición fiscal del receptor.");
    }
  }
  if (letraDeCbteTipo(confirmacion.cbteTipo) !== confirmacion.letra) {
    throw new Error("El CbteTipo no coincide con la letra fiscal confirmada.");
  }
  if (confirmacion.cbteAsoc) {
    validarFechaIsoCalendario(confirmacion.cbteAsoc.fecha, "La fecha del comprobante asociado");
    if (letraDeCbteTipo(confirmacion.cbteAsoc.tipo) !== confirmacion.cbteAsoc.letra) {
      throw new Error("El comprobante asociado no coincide con su letra fiscal.");
    }
  }
}

function confirmacionVisibleAutoritativa(
  preview: PreviewAutoritativa,
): ConfirmacionFiscalPostBorrador {
  return {
    version: 1,
    importe: preview.total,
    emisorCuit: preview.emisor_cuit,
    emisorRazonSocial: preview.emisor_razon_social,
    sucursalId: preview.sucursal_id,
    sucursalNombre: preview.sucursal_nombre,
    puntoVenta: preview.punto_venta,
    modo: preview.modo,
    afipValidez: preview.afip_validez,
    letra: preview.letra,
    cbteTipo: preview.cbte_tipo,
    fechaFiscal: preview.fecha_fiscal,
    pagado: preview.pagado,
    saldo: preview.saldo,
    cbteAsoc: preview.cbte_asoc
      ? {
          tipo: preview.cbte_asoc.tipo,
          letra: preview.cbte_asoc.letra,
          puntoVenta: preview.cbte_asoc.punto_venta,
          numero: preview.cbte_asoc.numero,
          fecha: preview.cbte_asoc.fecha,
        }
      : null,
    receptor: preview.receptor,
  };
}

function confirmacionVisibleProvisional(
  preview: PreviewProvisional,
): ConfirmacionFiscalPostBorrador {
  return {
    version: 1,
    importe: preview.total,
    emisorCuit: preview.emisor_cuit,
    emisorRazonSocial: preview.emisor_razon_social,
    sucursalId: preview.sucursal_id,
    sucursalNombre: preview.sucursal_nombre,
    puntoVenta: preview.punto_venta,
    modo: preview.modo,
    afipValidez: preview.afip_validez,
    letra: preview.letra,
    cbteTipo: preview.cbte_tipo,
    fechaFiscal: preview.fecha_fiscal,
    pagado: preview.pagado,
    saldo: preview.saldo,
    cbteAsoc: preview.cbte_asoc
      ? {
          tipo: preview.cbte_asoc.tipo,
          letra: preview.cbte_asoc.letra,
          puntoVenta: preview.cbte_asoc.punto_venta,
          numero: preview.cbte_asoc.numero,
          fecha: preview.cbte_asoc.fecha,
        }
      : null,
    receptor: preview.receptor,
  };
}

function confirmacionProvisional(preview: PreviewProvisional): ConfirmacionFiscalPostBorrador {
  return {
    version: preview.confirmacion_provisional.version,
    importe: preview.confirmacion_provisional.importe,
    emisorCuit: preview.confirmacion_provisional.emisor_cuit,
    emisorRazonSocial: preview.confirmacion_provisional.emisor_razon_social,
    sucursalId: preview.confirmacion_provisional.sucursal_id,
    sucursalNombre: preview.confirmacion_provisional.sucursal_nombre,
    puntoVenta: preview.confirmacion_provisional.punto_venta,
    modo: preview.confirmacion_provisional.modo,
    afipValidez: preview.confirmacion_provisional.afip_validez,
    letra: preview.confirmacion_provisional.letra,
    cbteTipo: preview.confirmacion_provisional.cbte_tipo,
    fechaFiscal: preview.confirmacion_provisional.fecha_fiscal,
    pagado: preview.confirmacion_provisional.pagado,
    saldo: preview.confirmacion_provisional.saldo,
    cbteAsoc: preview.confirmacion_provisional.cbte_asoc
      ? {
          tipo: preview.confirmacion_provisional.cbte_asoc.tipo,
          letra: preview.confirmacion_provisional.cbte_asoc.letra,
          puntoVenta: preview.confirmacion_provisional.cbte_asoc.punto_venta,
          numero: preview.confirmacion_provisional.cbte_asoc.numero,
          fecha: preview.confirmacion_provisional.cbte_asoc.fecha,
        }
      : null,
    receptor: preview.confirmacion_provisional.receptor,
  };
}

function validarPreviewSemantica(preview: PreviewEmisionFiscal): void {
  const validezEsperada = preview.afip_validez === "SIMULADA" ? "SIMULADA" : preview.modo;
  if (preview.afip_validez !== validezEsperada) {
    throw new Error("El ambiente y la validez fiscal de la preview son incoherentes.");
  }
  if (preview.cbte_asoc) {
    validarFechaIsoCalendario(preview.cbte_asoc.fecha, "La fecha del comprobante asociado");
    if (letraDeCbteTipo(preview.cbte_asoc.tipo) !== preview.cbte_asoc.letra) {
      throw new Error("El comprobante asociado no coincide con su letra fiscal.");
    }
  }
  if (preview.autoritativo) {
    const visible = confirmacionVisibleAutoritativa(preview);
    validarConfirmacionSemantica(preview.confirmacion_autoritativa);
    if (!confirmacionesFiscalesIguales(visible, preview.confirmacion_autoritativa)) {
      throw new Error("La preview visible difiere de su confirmación autoritativa.");
    }
    if (
      !verificarHuellaConfirmacionFiscal(
        preview.confirmacion_autoritativa,
        preview.huella_confirmacion,
      )
    ) {
      throw new Error("La huella no coincide con la confirmación autoritativa.");
    }
    return;
  }

  const visible = confirmacionVisibleProvisional(preview);
  const confirmacion = confirmacionProvisional(preview);
  validarConfirmacionSemantica(confirmacion);
  if (!confirmacionesFiscalesIguales(visible, confirmacion)) {
    throw new Error("La preview visible difiere de su confirmación provisional.");
  }
  if (!verificarHuellaConfirmacionFiscal(confirmacion, preview.huella_confirmacion)) {
    throw new Error("La huella no coincide con la confirmación provisional.");
  }
}

function parsear<T>(schema: z.ZodType<T>, value: unknown, mensaje: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(mensaje);
  return parsed.data;
}

function validarLetraSolicitada(
  preview: Pick<PreviewEmisionFiscal, "letra">,
  letraSolicitada?: LetraSolicitada,
): void {
  if (letraSolicitada && preview.letra !== letraSolicitada) {
    throw new Error("La letra de la preview no coincide con la letra solicitada.");
  }
}

export function parsePreviewEmisionFiscal(
  value: unknown,
  letraSolicitada?: LetraSolicitada,
): PreviewEmisionFiscal {
  const preview = parsear(
    previewEmisionFiscalSchema,
    value,
    "ARCA no devolvió una previsualización fiscal completa y válida.",
  );
  try {
    validarPreviewSemantica(preview);
  } catch {
    throw new Error("ARCA no devolvió una previsualización fiscal completa y válida.");
  }
  validarLetraSolicitada(preview, letraSolicitada);
  return preview;
}

export function parsePreviewEmisionFiscalAutoritativa(
  value: unknown,
  letraSolicitada?: LetraSolicitada,
): z.infer<typeof previewAutoritativaSchema> {
  const preview = parsear(
    previewAutoritativaSchema,
    value,
    "ARCA no devolvió una previsualización fiscal autoritativa completa y válida.",
  );
  try {
    validarPreviewSemantica(preview);
  } catch {
    throw new Error("ARCA no devolvió una previsualización fiscal autoritativa completa y válida.");
  }
  validarLetraSolicitada(preview, letraSolicitada);
  return preview;
}

export function parseRespuestaConfirmacionFiscal(value: unknown): RespuestaConfirmacionFiscal {
  const respuesta = parsear(
    respuestaConfirmacionSchema,
    value,
    "ARCA devolvió una respuesta fiscal desconocida o incompleta.",
  );
  if (respuesta.estado !== "RECONFIRMACION_REQUERIDA") return respuesta;
  try {
    validarPreviewSemantica(respuesta.preview_autoritativa);
    validarConfirmacionSemantica(respuesta.confirmacion_autoritativa);
    const validezEsperada =
      respuesta.afip_validez === "SIMULADA" ? "SIMULADA" : respuesta.confirmacion_autoritativa.modo;
    if (respuesta.afip_validez !== validezEsperada) {
      throw new Error("La validez no coincide con el ambiente reconfirmado.");
    }
    if (
      respuesta.preview_autoritativa.afip_validez !== respuesta.afip_validez ||
      respuesta.preview_autoritativa.huella_confirmacion !== respuesta.huella_confirmacion ||
      !confirmacionesFiscalesIguales(
        respuesta.preview_autoritativa.confirmacion_autoritativa,
        respuesta.confirmacion_autoritativa,
      )
    ) {
      throw new Error("La preview autoritativa no coincide con la reconfirmación.");
    }
    if (
      !verificarHuellaConfirmacionFiscal(
        respuesta.confirmacion_autoritativa,
        respuesta.huella_confirmacion,
      )
    ) {
      throw new Error("La huella no coincide con la reconfirmación autoritativa.");
    }
    return respuesta;
  } catch {
    throw new Error("ARCA devolvió una respuesta fiscal desconocida o incompleta.");
  }
}

/** Sustituye toda la identidad visible por la tupla autoritativa reconfirmada. */
export function reconfirmarPreviewEmisionFiscal(
  _anterior: PreviewEmisionFiscal,
  respuesta: RespuestaReconfirmacion,
  letraSolicitada?: LetraSolicitada,
): PreviewEmisionFiscal {
  return parsePreviewEmisionFiscalAutoritativa(respuesta.preview_autoritativa, letraSolicitada);
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
