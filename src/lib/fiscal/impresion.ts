import type { CondicionIva } from "./codigos";
import type { QrAfipInput } from "./qr";
import { validarSnapshotFiscalV2, type SnapshotFiscalV2 } from "./snapshot";

export type CodigoErrorImpresionFiscal =
  | "COMPROBANTE_FISCAL_INCONSISTENTE"
  | "SNAPSHOT_FISCAL_INVALIDO"
  | "SNAPSHOT_FISCAL_DIVERGENTE"
  | "LEGACY_FISCAL_NO_MARCADO"
  | "QR_FISCAL_OBLIGATORIO";

export class ErrorImpresionFiscal extends Error {
  readonly name = "ErrorImpresionFiscal";

  constructor(
    public readonly codigo: CodigoErrorImpresionFiscal,
    mensaje: string,
    options?: ErrorOptions,
  ) {
    super(mensaje, options);
  }
}

export const LEYENDA_CREDITO_FISCAL_MONOTRIBUTO =
  "El crédito fiscal discriminado en el presente comprobante, sólo podrá ser computado a efectos del Régimen de Sostenimiento e Inclusión Fiscal para Pequeños Contribuyentes de la Ley Nº 27.618.";

export const ADVERTENCIA_LEGACY_FISCAL = "HISTÓRICO LEGACY — DATOS FISCALES INCOMPLETOS";

export interface ItemComprobante {
  codigo?: string | null;
  descripcion?: string | null;
  cantidad: number | string;
  precio_unitario_sin_iva: number | string;
  descuento_porcentaje?: number | string | null;
  iva_porcentaje?: number | string | null;
  subtotal_con_iva: number | string;
}

export interface EmisorImpreso {
  razon_social?: string | null;
  nombre_fantasia?: string | null;
  cuit?: string | null;
  domicilio_fiscal?: string | null;
  condicion_iva?: CondicionIva | null;
  ingresos_brutos?: string | null;
  inicio_actividades?: string | null;
  telefono?: string | null;
}

export interface ReceptorImpreso {
  razon_social?: string | null;
  cuit_dni?: string | null;
  doc_tipo?: number | null;
  doc_nro?: number | string | null;
  condicion_iva?: CondicionIva | null;
  domicilio?: string | null;
}

export interface TotalesFiscalesImpresos {
  neto: number | string;
  exento: number | string;
  no_gravado: number | string;
  iva: number | string;
  tributos: number | string;
  total: number | string;
  alicuotas: Array<{
    Id: number;
    BaseImp: number | string;
    Importe: number | string;
  }>;
}

interface DatosFiscalesImpresosBase {
  emisor: EmisorImpreso | null;
  receptor: ReceptorImpreso;
  condicion_venta?: string | null;
  totales?: TotalesFiscalesImpresos | null;
  lineas?: ItemComprobante[] | null;
  fecha: string;
  cae: string;
  cae_vencimiento?: string | null;
  punto_venta: number;
  numero: number;
  cbte_tipo: number;
  modo: "PRODUCCION" | "HOMOLOGACION";
  simulado: boolean;
  validez: "PRODUCCION" | "HOMOLOGACION" | "SIMULADA";
  iva_contenido?: number | string | null;
  otros_impuestos_nacionales_indirectos?: number | string | null;
  qrInput: QrAfipInput;
  qr?: string;
}

export interface DatosFiscalesImpresos extends DatosFiscalesImpresosBase {
  origen: "SNAPSHOT_V2";
  advertencia: null;
  emisor: EmisorImpreso;
  totales: TotalesFiscalesImpresos;
  lineas: ItemComprobante[];
  iva_contenido: string;
  otros_impuestos_nacionales_indirectos: string;
}

export interface DatosFiscalesImpresosLegacy extends DatosFiscalesImpresosBase {
  origen: "LEGACY_INCOMPLETO";
  advertencia: string;
}

export type DatosFiscalesPreparados = DatosFiscalesImpresos | DatosFiscalesImpresosLegacy;

type Registro = Record<string, unknown>;

const esRegistro = (value: unknown): value is Registro =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fallar(codigo: CodigoErrorImpresionFiscal, mensaje: string, cause?: unknown): never {
  throw new ErrorImpresionFiscal(codigo, mensaje, cause === undefined ? undefined : { cause });
}

function registro(value: unknown, mensaje: string): Registro {
  if (!esRegistro(value)) fallar("COMPROBANTE_FISCAL_INCONSISTENTE", mensaje);
  return value;
}

function caeValido(value: unknown): string {
  if (typeof value !== "string" || !/^\d{14}$/.test(value)) {
    fallar(
      "COMPROBANTE_FISCAL_INCONSISTENTE",
      "El comprobante fiscal aprobado no tiene un CAE válido de 14 dígitos.",
    );
  }
  return value;
}

function entero(value: unknown, campo: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fallar("COMPROBANTE_FISCAL_INCONSISTENTE", `El campo fiscal ${campo} es inválido.`);
  }
  return value;
}

function fechaCanonica(value: unknown, campo: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fallar("COMPROBANTE_FISCAL_INCONSISTENTE", `La fecha fiscal ${campo} es inválida.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    fallar("COMPROBANTE_FISCAL_INCONSISTENTE", `La fecha fiscal ${campo} no existe.`);
  }
  return value;
}

function fechaLegacy(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return fechaCanonica(value.slice(0, 10), "legacy");
  }
  fallar(
    "COMPROBANTE_FISCAL_INCONSISTENTE",
    "El histórico fiscal no conserva una fecha utilizable para el QR.",
  );
}

function decimalCanonico(value: unknown, campo: string): string {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    fallar("COMPROBANTE_FISCAL_INCONSISTENTE", `El importe fiscal ${campo} es inválido.`);
  }
  const [entera, decimal = ""] = raw.split(".");
  return `${BigInt(entera).toString()}.${decimal.padEnd(2, "0")}`;
}

function decimalSnapshot(value: string, campo: string): string {
  if (!/^\d+\.\d{2}$/.test(value)) {
    fallar("SNAPSHOT_FISCAL_INVALIDO", `El importe ${campo} no es canónico.`);
  }
  return value;
}

function condicionIva(value: unknown): CondicionIva | null {
  return value === "RESPONSABLE_INSCRIPTO" ||
    value === "MONOTRIBUTO" ||
    value === "EXENTO" ||
    value === "CONSUMIDOR_FINAL"
    ? value
    : null;
}

function modoFiscal(value: unknown): "PRODUCCION" | "HOMOLOGACION" {
  if (value !== "PRODUCCION" && value !== "HOMOLOGACION") {
    fallar("COMPROBANTE_FISCAL_INCONSISTENTE", "El ambiente fiscal es inválido.");
  }
  return value;
}

function validezFiscal(value: unknown): "PRODUCCION" | "HOMOLOGACION" | "SIMULADA" {
  if (value !== "PRODUCCION" && value !== "HOMOLOGACION" && value !== "SIMULADA") {
    fallar("COMPROBANTE_FISCAL_INCONSISTENTE", "La validez fiscal es inválida.");
  }
  return value;
}

function exigirCoincidencia(actual: unknown, esperado: unknown, campo: string): void {
  if (actual !== esperado) {
    fallar(
      "SNAPSHOT_FISCAL_DIVERGENTE",
      `La columna fiscal ${campo} no coincide con el snapshot autorizado.`,
    );
  }
}

function validarFilaNueva(fila: Registro): {
  snapshot: SnapshotFiscalV2;
  cae: string;
  caeVencimiento: string | null;
} {
  if (
    fila.afip_estado !== "APROBADO" ||
    fila.afip_fase !== "PERSISTIDO" ||
    typeof fila.afip_version !== "number" ||
    !Number.isInteger(fila.afip_version) ||
    fila.afip_version < 2 ||
    fila.afip_legacy_incompleto !== false
  ) {
    fallar(
      "COMPROBANTE_FISCAL_INCONSISTENTE",
      "La fila no representa una aprobación fiscal v2 persistida.",
    );
  }

  const cae = caeValido(fila.cae);
  let snapshot: SnapshotFiscalV2;
  try {
    snapshot = validarSnapshotFiscalV2(fila.afip_snapshot);
  } catch (cause) {
    fallar(
      "SNAPSHOT_FISCAL_INVALIDO",
      "El snapshot fiscal v2 no es válido; se bloqueó la impresión.",
      cause,
    );
  }

  exigirCoincidencia(fila.afip_snapshot_hash, snapshot.hash, "afip_snapshot_hash");
  exigirCoincidencia(fila.id, snapshot.venta.id, "id");
  exigirCoincidencia(fila.afip_emisor_cuit, snapshot.identidad.emisorCuit, "afip_emisor_cuit");
  exigirCoincidencia(fila.afip_punto_venta, snapshot.identidad.puntoVenta, "afip_punto_venta");
  exigirCoincidencia(fila.afip_cbte_tipo, snapshot.identidad.cbteTipo, "afip_cbte_tipo");
  exigirCoincidencia(fila.afip_numero, snapshot.identidad.numero, "afip_numero");
  exigirCoincidencia(fila.afip_modo, snapshot.identidad.modo, "afip_modo");
  exigirCoincidencia(fila.afip_simulado, snapshot.identidad.simulado, "afip_simulado");
  exigirCoincidencia(fila.afip_validez, snapshot.identidad.validez, "afip_validez");
  exigirCoincidencia(
    fila.afip_fecha_comprobante,
    snapshot.fechaComprobante,
    "afip_fecha_comprobante",
  );
  if (fila.afip_imp_total == null) {
    fallar("COMPROBANTE_FISCAL_INCONSISTENTE", "Falta el total fiscal autorizado.");
  }
  if (decimalCanonico(fila.afip_imp_total, "afip_imp_total") !== snapshot.importeTotal) {
    fallar(
      "SNAPSHOT_FISCAL_DIVERGENTE",
      "El total fiscal persistido no coincide con el snapshot autorizado.",
    );
  }

  return {
    snapshot,
    cae,
    caeVencimiento:
      fila.cae_vencimiento == null ? null : fechaCanonica(fila.cae_vencimiento, "cae_vencimiento"),
  };
}

function mapearSnapshot(
  snapshot: SnapshotFiscalV2,
  cae: string,
  caeVencimiento: string | null,
): DatosFiscalesImpresos {
  return {
    origen: "SNAPSHOT_V2",
    advertencia: null,
    emisor: {
      razon_social: snapshot.emisor.razonSocial,
      nombre_fantasia: snapshot.emisor.nombreFantasia,
      cuit: snapshot.emisor.cuit,
      domicilio_fiscal: snapshot.emisor.domicilioFiscal,
      condicion_iva: snapshot.emisor.condicionIva,
      ingresos_brutos: snapshot.emisor.ingresosBrutos,
      inicio_actividades: snapshot.emisor.inicioActividades,
      telefono: snapshot.emisor.telefono,
    },
    receptor: {
      razon_social: snapshot.receptor.razonSocial,
      cuit_dni: snapshot.receptor.numeroDocumento,
      doc_tipo: snapshot.receptor.docTipoArca,
      doc_nro: snapshot.receptor.docNroArca,
      condicion_iva: snapshot.receptor.condicionIva,
      domicilio: snapshot.receptor.domicilio,
    },
    condicion_venta: snapshot.venta.condicionVenta,
    totales: {
      neto: decimalSnapshot(snapshot.importeNeto, "importeNeto"),
      exento: decimalSnapshot(snapshot.importeExento, "importeExento"),
      no_gravado: decimalSnapshot(snapshot.importeNoGravado, "importeNoGravado"),
      iva: decimalSnapshot(snapshot.importeIva, "importeIva"),
      tributos: decimalSnapshot(snapshot.importeTributos, "importeTributos"),
      total: decimalSnapshot(snapshot.importeTotal, "importeTotal"),
      alicuotas: snapshot.alicuotasIva.map((row) => ({
        Id: row.id,
        BaseImp: row.baseImponible,
        Importe: row.importe,
      })),
    },
    lineas: snapshot.items.map((item) => ({
      codigo: item.codigo,
      descripcion: item.descripcion,
      cantidad: item.cantidad,
      precio_unitario_sin_iva: item.precioUnitarioSinIva,
      descuento_porcentaje: item.descuentoPorcentaje,
      iva_porcentaje: item.ivaPorcentaje,
      subtotal_con_iva: item.subtotalTotal,
    })),
    fecha: snapshot.fechaComprobante,
    cae,
    cae_vencimiento: caeVencimiento,
    punto_venta: snapshot.identidad.puntoVenta,
    numero: snapshot.identidad.numero,
    cbte_tipo: snapshot.identidad.cbteTipo,
    modo: snapshot.identidad.modo,
    simulado: snapshot.identidad.simulado,
    validez: snapshot.identidad.validez,
    iva_contenido: snapshot.ivaContenido,
    otros_impuestos_nacionales_indirectos: snapshot.otrosImpuestosNacionalesIndirectos,
    qrInput: {
      fecha: snapshot.fechaComprobante,
      cuit: snapshot.identidad.emisorCuit,
      ptoVta: snapshot.identidad.puntoVenta,
      tipoCmp: snapshot.identidad.cbteTipo,
      nroCmp: snapshot.identidad.numero,
      importe: snapshot.importeTotal,
      moneda: snapshot.moneda,
      ctz: snapshot.cotizacion,
      tipoDocRec: snapshot.receptor.docTipoArca,
      nroDocRec: snapshot.receptor.docNroArca,
      codAut: cae,
    },
  };
}

export function prepararDatosFiscalesImpresos(input: unknown): DatosFiscalesImpresos {
  const fila = registro(input, "La evidencia fiscal de impresión es inválida.");
  const { snapshot, cae, caeVencimiento } = validarFilaNueva(fila);
  return mapearSnapshot(snapshot, cae, caeVencimiento);
}

function copiarEmisorLegacy(value: unknown): EmisorImpreso | null {
  if (!esRegistro(value)) return null;
  return {
    razon_social: typeof value.razon_social === "string" ? value.razon_social : null,
    nombre_fantasia: typeof value.nombre_fantasia === "string" ? value.nombre_fantasia : null,
    cuit: typeof value.cuit === "string" ? value.cuit : null,
    domicilio_fiscal: typeof value.domicilio_fiscal === "string" ? value.domicilio_fiscal : null,
    condicion_iva: condicionIva(value.condicion_iva),
    ingresos_brutos: typeof value.ingresos_brutos === "string" ? value.ingresos_brutos : null,
    inicio_actividades:
      typeof value.inicio_actividades === "string" ? value.inicio_actividades : null,
    telefono: typeof value.telefono === "string" ? value.telefono : null,
  };
}

function copiarReceptorLegacy(value: unknown): ReceptorImpreso {
  const receptor = registro(value, "El histórico fiscal no conserva receptor.");
  return {
    razon_social: typeof receptor.razon_social === "string" ? receptor.razon_social : null,
    cuit_dni: typeof receptor.cuit_dni === "string" ? receptor.cuit_dni : null,
    doc_tipo: typeof receptor.doc_tipo === "number" ? receptor.doc_tipo : null,
    doc_nro:
      typeof receptor.doc_nro === "number" || typeof receptor.doc_nro === "string"
        ? receptor.doc_nro
        : null,
    condicion_iva: condicionIva(receptor.condicion_iva),
    domicilio: typeof receptor.domicilio === "string" ? receptor.domicilio : null,
  };
}

function copiarTotalesLegacy(value: unknown): TotalesFiscalesImpresos | null {
  if (!esRegistro(value)) return null;
  const alicuotas = Array.isArray(value.alicuotas)
    ? value.alicuotas.filter(esRegistro).map((row) => ({
        Id: Number(row.Id),
        BaseImp:
          typeof row.BaseImp === "string" || typeof row.BaseImp === "number" ? row.BaseImp : 0,
        Importe:
          typeof row.Importe === "string" || typeof row.Importe === "number" ? row.Importe : 0,
      }))
    : [];
  return {
    neto: typeof value.neto === "string" || typeof value.neto === "number" ? value.neto : 0,
    exento: typeof value.exento === "string" || typeof value.exento === "number" ? value.exento : 0,
    no_gravado:
      typeof value.no_gravado === "string" || typeof value.no_gravado === "number"
        ? value.no_gravado
        : 0,
    iva: typeof value.iva === "string" || typeof value.iva === "number" ? value.iva : 0,
    tributos:
      typeof value.tributos === "string" || typeof value.tributos === "number" ? value.tributos : 0,
    total: typeof value.total === "string" || typeof value.total === "number" ? value.total : 0,
    alicuotas,
  };
}

/**
 * Compatibilidad explícita para comprobantes históricos incompletos. La función
 * no consulta datos vivos: recibe el material histórico ya leído por el lector
 * legacy y lo marca de forma que el renderer no pueda confundirlo con snapshot v2.
 */
export function prepararDatosFiscalesLegacyMarcados(input: unknown): DatosFiscalesImpresosLegacy {
  const wrapper = registro(input, "La entrada de impresión legacy es inválida.");
  const fila = registro(wrapper.fila, "Falta la fila fiscal histórica.");
  const datos = registro(wrapper.datosHistoricos, "Faltan los datos fiscales históricos.");

  if (fila.afip_legacy_incompleto !== true) {
    fallar("LEGACY_FISCAL_NO_MARCADO", "El fallback histórico exige afip_legacy_incompleto=true.");
  }
  if (
    (typeof fila.afip_version === "number" && fila.afip_version >= 2) ||
    (esRegistro(fila.afip_snapshot) && fila.afip_snapshot.version === 2)
  ) {
    fallar(
      "LEGACY_FISCAL_NO_MARCADO",
      "Una aprobación fiscal v2 no puede degradarse al lector legacy.",
    );
  }
  if (fila.afip_estado !== "APROBADO") {
    fallar("COMPROBANTE_FISCAL_INCONSISTENTE", "El histórico fiscal no está aprobado.");
  }

  const cae = caeValido(fila.cae);
  const puntoVenta = entero(fila.afip_punto_venta ?? datos.punto_venta, "punto de venta");
  const cbteTipo = entero(fila.afip_cbte_tipo ?? datos.cbte_tipo, "tipo de comprobante");
  const numero = entero(fila.afip_numero ?? datos.numero, "número de comprobante");
  const emisor = copiarEmisorLegacy(datos.emisor);
  const receptor = copiarReceptorLegacy(datos.receptor);
  const fecha = fechaLegacy(fila.afip_fecha_comprobante ?? datos.fecha);
  const cuit = String(fila.afip_emisor_cuit ?? emisor?.cuit ?? "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(cuit)) {
    fallar(
      "COMPROBANTE_FISCAL_INCONSISTENTE",
      "El histórico fiscal no conserva un CUIT emisor utilizable para el QR.",
    );
  }
  const docTipo = entero(receptor.doc_tipo, "DocTipo del receptor");
  const docNroRaw = receptor.doc_nro ?? receptor.cuit_dni?.replace(/\D/g, "") ?? "0";
  const docNro = String(docNroRaw);
  if (!/^\d{1,14}$/.test(docNro)) {
    fallar(
      "COMPROBANTE_FISCAL_INCONSISTENTE",
      "El histórico fiscal no conserva un DocNro utilizable para el QR.",
    );
  }
  const totales = copiarTotalesLegacy(datos.totales);
  const importe = decimalCanonico(fila.afip_imp_total ?? totales?.total, "legacy");
  const modo = modoFiscal(fila.afip_modo ?? datos.modo);
  const simulado = Boolean(fila.afip_simulado ?? datos.simulado);
  const validez = validezFiscal(fila.afip_validez ?? (simulado ? "SIMULADA" : modo));

  return {
    origen: "LEGACY_INCOMPLETO",
    advertencia: ADVERTENCIA_LEGACY_FISCAL,
    emisor,
    receptor,
    condicion_venta: typeof datos.condicion_venta === "string" ? datos.condicion_venta : null,
    totales,
    lineas: Array.isArray(datos.lineas)
      ? (structuredClone(datos.lineas) as ItemComprobante[])
      : null,
    fecha,
    cae,
    cae_vencimiento:
      fila.cae_vencimiento == null ? null : fechaCanonica(fila.cae_vencimiento, "cae_vencimiento"),
    punto_venta: puntoVenta,
    numero,
    cbte_tipo: cbteTipo,
    modo,
    simulado,
    validez,
    iva_contenido: null,
    otros_impuestos_nacionales_indirectos: null,
    qrInput: {
      fecha,
      cuit,
      ptoVta: puntoVenta,
      tipoCmp: cbteTipo,
      nroCmp: numero,
      importe,
      moneda: "PES",
      ctz: "1.000000",
      tipoDocRec: docTipo,
      nroDocRec: docNro,
      codAut: cae,
    },
  };
}
