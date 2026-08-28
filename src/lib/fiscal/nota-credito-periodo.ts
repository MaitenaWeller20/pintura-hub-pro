import { z } from "zod";
import { ALICUOTAS_SOPORTADAS, type CondicionIva, type Letra } from "./codigos";

export type ModalidadNcPeriodo = "DEVOLUCION_PRODUCTOS" | "BONIFICACION_AJUSTE";
export type ResolucionNcPeriodo = "REINTEGRO" | "SALDO_FAVOR";
export type FormaPagoReintegro =
  | "EFECTIVO"
  | "TRANSFERENCIA"
  | "TARJETA_DEBITO"
  | "TARJETA_CREDITO"
  | "MERCADO_PAGO"
  | "CHEQUE";

export type AsociacionFiscal =
  | { tipo: "NINGUNA" }
  | { tipo: "COMPROBANTE"; comprobanteOriginalId: string }
  | { tipo: "PERIODO"; desde: string; hasta: string };

export type LineaCalculableNcPeriodo = {
  cantidad: number;
  precioUnitarioSinIva: number;
  ivaPorcentaje: number;
};

export type TotalesNotaCreditoPeriodo = {
  netoCentavos: number;
  ivaCentavos: number;
  totalCentavos: number;
};

type PagoNcPeriodoInput = {
  forma_pago: FormaPagoReintegro;
  monto_centavos: number;
};

type ItemProductoNcPeriodo = {
  producto_id: string;
  cantidad: number;
  precio_unitario_sin_iva: number;
  iva_porcentaje: number;
};

type ItemConceptoNcPeriodo = {
  producto_id: null;
  descripcion: string;
  cantidad: number;
  precio_unitario_sin_iva: number;
  iva_porcentaje: number;
};

type BaseNotaCreditoPeriodoInput = {
  idempotency_key: string;
  sucursal_id: string;
  cliente_id: string;
  periodo_desde: string;
  periodo_hasta: string;
  motivo: string;
  resolucion: ResolucionNcPeriodo;
  pagos: PagoNcPeriodoInput[];
};

export type NotaCreditoPeriodoInput =
  | (BaseNotaCreditoPeriodoInput & {
      modalidad: "DEVOLUCION_PRODUCTOS";
      items: ItemProductoNcPeriodo[];
    })
  | (BaseNotaCreditoPeriodoInput & {
      modalidad: "BONIFICACION_AJUSTE";
      items: [ItemConceptoNcPeriodo];
    });

const formasPagoReintegro = [
  "EFECTIVO",
  "TRANSFERENCIA",
  "TARJETA_DEBITO",
  "TARJETA_CREDITO",
  "MERCADO_PAGO",
  "CHEQUE",
] as const;

function esFechaIsoReal(fecha: string): boolean {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!partes) return false;
  const anio = Number(partes[1]);
  const mes = Number(partes[2]);
  const dia = Number(partes[3]);
  const valor = new Date(Date.UTC(anio, mes - 1, dia));
  return (
    valor.getUTCFullYear() === anio && valor.getUTCMonth() === mes - 1 && valor.getUTCDate() === dia
  );
}

const fechaIsoRealSchema = z.string().refine(esFechaIsoReal, "La fecha debe ser YYYY-MM-DD real.");
const ivaPermitidoSchema = z
  .number()
  .finite()
  .refine(
    (porcentaje) => (ALICUOTAS_SOPORTADAS as readonly number[]).includes(porcentaje),
    "La alícuota de IVA no está permitida.",
  );
const importePositivoSchema = z.number().finite().positive();

const itemProductoSchema = z.object({
  producto_id: z.string().uuid(),
  cantidad: importePositivoSchema,
  precio_unitario_sin_iva: importePositivoSchema,
  iva_porcentaje: ivaPermitidoSchema,
});

const itemConceptoSchema = z.object({
  producto_id: z.null(),
  descripcion: z.string().trim().min(1),
  cantidad: importePositivoSchema,
  precio_unitario_sin_iva: importePositivoSchema,
  iva_porcentaje: ivaPermitidoSchema,
});

const baseSchema = z
  .object({
    idempotency_key: z.string().uuid(),
    sucursal_id: z.string().uuid(),
    cliente_id: z.string().uuid(),
    periodo_desde: fechaIsoRealSchema,
    periodo_hasta: fechaIsoRealSchema,
    motivo: z.string().trim().min(5),
    resolucion: z.enum(["REINTEGRO", "SALDO_FAVOR"]),
    pagos: z.array(
      z
        .object({
          forma_pago: z.enum(formasPagoReintegro),
          monto_centavos: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

const notaCreditoPeriodoSchema = z
  .discriminatedUnion("modalidad", [
    baseSchema
      .extend({
        modalidad: z.literal("DEVOLUCION_PRODUCTOS"),
        items: z.array(itemProductoSchema.strict()).min(1),
      })
      .strict(),
    baseSchema
      .extend({
        modalidad: z.literal("BONIFICACION_AJUSTE"),
        items: z.tuple([itemConceptoSchema.strict()]),
      })
      .strict(),
  ])
  .superRefine((input, ctx) => {
    if (input.periodo_desde > input.periodo_hasta) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodo_hasta"],
        message: "El período no puede terminar antes de comenzar.",
      });
    }
  });

export const notaCreditoPeriodoInputSchema: z.ZodType<NotaCreditoPeriodoInput> =
  notaCreditoPeriodoSchema;

/**
 * Revalida el período contra la fecha fiscal reservada por el servidor. La fecha
 * de emisión no forma parte de la entrada del navegador.
 */
export function validarPeriodoAsociado(input: {
  desde: string;
  hasta: string;
  fechaEmision: string;
}): void {
  if (
    !esFechaIsoReal(input.desde) ||
    !esFechaIsoReal(input.hasta) ||
    !esFechaIsoReal(input.fechaEmision)
  ) {
    throw new Error("El período y la fecha de emisión deben ser fechas YYYY-MM-DD reales.");
  }
  if (input.desde > input.hasta) {
    throw new Error("La fecha desde no puede ser posterior a la fecha hasta.");
  }
  if (input.hasta > input.fechaEmision) {
    throw new Error("El período asociado no puede terminar después de la fecha de emisión.");
  }
}

const redondear2 = (importe: number): number => Math.round((importe + Number.EPSILON) * 100) / 100;

function centavosSeguros(importe: number, concepto: string, admiteCero = false): number {
  const centavos = Math.round(importe * 100);
  if (
    !Number.isFinite(importe) ||
    !Number.isSafeInteger(centavos) ||
    centavos < 0 ||
    (!admiteCero && centavos === 0)
  ) {
    throw new Error(`El ${concepto} debe producir centavos seguros y positivos.`);
  }
  return centavos;
}

function sumarCentavosSeguros(actual: number, siguiente: number, concepto: string): number {
  const total = actual + siguiente;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error(`El total de ${concepto} excede los centavos seguros.`);
  }
  return total;
}

function validarLineaCalculableNcPeriodo(linea: LineaCalculableNcPeriodo): void {
  if (
    !Number.isFinite(linea.cantidad) ||
    !Number.isFinite(linea.precioUnitarioSinIva) ||
    !Number.isFinite(linea.ivaPorcentaje)
  ) {
    throw new Error("La línea de la nota de crédito debe tener importes finitos.");
  }
  if (linea.cantidad <= 0 || linea.precioUnitarioSinIva <= 0) {
    throw new Error("La línea de la nota de crédito debe tener cantidad y precio positivos.");
  }
  if (!(ALICUOTAS_SOPORTADAS as readonly number[]).includes(linea.ivaPorcentaje)) {
    throw new Error("La línea de la nota de crédito tiene un IVA no permitido.");
  }
}

/**
 * Los montos se calculan del catálogo/override resuelto en servidor. Se
 * devuelven como magnitudes positivas enteras: la persistencia aplica una única
 * vez el signo comercial de la nota de crédito.
 */
export function calcularTotalesNotaCreditoPeriodo(
  lineas: readonly LineaCalculableNcPeriodo[],
): TotalesNotaCreditoPeriodo {
  let netoCentavos = 0;
  let ivaCentavos = 0;
  let totalCentavos = 0;

  for (const linea of lineas) {
    validarLineaCalculableNcPeriodo(linea);
    const netoLinea = redondear2(linea.cantidad * linea.precioUnitarioSinIva);
    const ivaLinea = redondear2((netoLinea * linea.ivaPorcentaje) / 100);
    const totalLinea = redondear2(netoLinea + ivaLinea);
    netoCentavos = sumarCentavosSeguros(
      netoCentavos,
      centavosSeguros(netoLinea, "neto de la línea"),
      "neto",
    );
    ivaCentavos = sumarCentavosSeguros(
      ivaCentavos,
      centavosSeguros(ivaLinea, "IVA de la línea", true),
      "IVA",
    );
    totalCentavos = sumarCentavosSeguros(
      totalCentavos,
      centavosSeguros(totalLinea, "total de la línea"),
      "total",
    );
  }

  return { netoCentavos, ivaCentavos, totalCentavos };
}

export function validarLiquidacionNotaCreditoPeriodo(input: {
  resolucion: ResolucionNcPeriodo;
  totalCentavos: number;
  pagos: readonly { formaPago: FormaPagoReintegro; montoCentavos: number }[];
  clienteId: string;
}): void {
  if (!Number.isSafeInteger(input.totalCentavos) || input.totalCentavos <= 0) {
    throw new Error("El total de la nota de crédito debe ser un importe positivo en centavos.");
  }

  if (input.resolucion === "SALDO_FAVOR") {
    if (!input.clienteId.trim()) throw new Error("El saldo a favor requiere un cliente comercial.");
    if (input.pagos.length !== 0) throw new Error("El saldo a favor no admite pagos de reintegro.");
    return;
  }

  if (input.resolucion !== "REINTEGRO")
    throw new Error("La resolución de la nota de crédito no es válida.");

  let totalPagosCentavos = 0;
  for (const pago of input.pagos) {
    if (pago.formaPago === ("CTA_CTE" as string)) {
      throw new Error("CTA_CTE no es una forma de pago de reintegro.");
    }
    if (!(formasPagoReintegro as readonly string[]).includes(pago.formaPago)) {
      throw new Error("La forma de pago de reintegro no es válida.");
    }
    if (!Number.isSafeInteger(pago.montoCentavos) || pago.montoCentavos <= 0) {
      throw new Error("Cada pago de reintegro debe ser positivo en centavos.");
    }
    totalPagosCentavos += pago.montoCentavos;
  }
  if (totalPagosCentavos !== input.totalCentavos) {
    throw new Error("El reintegro debe coincidir exactamente al centavo con el total.");
  }
}

export function validarAsociacionFiscal(
  tipoComprobante: string,
  asociacion: AsociacionFiscal,
  esFiscal = false,
): void {
  const valor = asociacion as unknown as Record<string, unknown>;
  const esNcONd = tipoComprobante === "NOTA_CREDITO" || tipoComprobante === "NOTA_DEBITO";
  const clavesEsperadas: Record<AsociacionFiscal["tipo"], readonly string[]> = {
    NINGUNA: ["tipo"],
    COMPROBANTE: ["tipo", "comprobanteOriginalId"],
    PERIODO: ["tipo", "desde", "hasta"],
  };
  if (!valor || !Object.prototype.hasOwnProperty.call(clavesEsperadas, valor.tipo as string)) {
    throw new Error("La asociación fiscal no es válida.");
  }
  const tipo = valor.tipo as AsociacionFiscal["tipo"];
  if (Object.keys(valor).some((clave) => !clavesEsperadas[tipo].includes(clave))) {
    throw new Error("La asociación fiscal es ambigua.");
  }

  if (tipo === "NINGUNA") {
    if (esNcONd && esFiscal) throw new Error("Una nota fiscal requiere una asociación.");
    return;
  }
  if (!esNcONd)
    throw new Error("Sólo una nota de crédito o débito puede llevar asociación fiscal.");

  if (tipo === "COMPROBANTE") {
    if (
      typeof valor.comprobanteOriginalId !== "string" ||
      !z.string().uuid().safeParse(valor.comprobanteOriginalId).success
    ) {
      throw new Error("El comprobante original asociado no es válido.");
    }
    return;
  }

  if (typeof valor.desde !== "string" || typeof valor.hasta !== "string") {
    throw new Error("El período asociado no es válido.");
  }
  validarPeriodoAsociado({ desde: valor.desde, hasta: valor.hasta, fechaEmision: valor.hasta });
}

export function determinarLetraNcPeriodo(emisor: CondicionIva, receptor: CondicionIva): Letra {
  if (
    receptor !== "RESPONSABLE_INSCRIPTO" &&
    receptor !== "MONOTRIBUTO" &&
    receptor !== "EXENTO" &&
    receptor !== "CONSUMIDOR_FINAL"
  ) {
    throw new Error("La condición de IVA del receptor no está soportada para una NC por período.");
  }
  if (emisor === "MONOTRIBUTO") return "C";
  if (emisor === "RESPONSABLE_INSCRIPTO") {
    if (receptor === "RESPONSABLE_INSCRIPTO" || receptor === "MONOTRIBUTO") return "A";
    if (receptor === "EXENTO" || receptor === "CONSUMIDOR_FINAL") return "B";
  }
  throw new Error(
    "La condición de IVA del emisor o receptor no está soportada para una NC por período.",
  );
}
