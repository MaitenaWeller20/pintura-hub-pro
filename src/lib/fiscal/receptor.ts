import { cuitValido, type CondicionIva } from "./codigos";

export type TipoDocumentoFiscal = "CUIT" | "CUIL" | "DNI" | "CDI" | "SIN_IDENTIFICAR";
export type DocTipoArca = 80 | 86 | 87 | 96 | 99;

export type SelectorReceptorFiscal =
  | { origen: "CLIENTE_COMERCIAL" }
  | { origen: "FAVORITO"; receptor_fiscal_id: string }
  | {
      origen: "MANUAL";
      tipo_documento: TipoDocumentoFiscal;
      numero_documento: string | null;
      razon_social: string;
      condicion_iva: CondicionIva;
      domicilio: string | null;
      guardar_para_proximas: boolean;
      confirma_datos_manuales: true;
    }
  | { origen: "COMPROBANTE_ORIGINAL" };

export type ReceptorFiscalConfirmado = {
  razonSocial: string;
  domicilio: string | null;
  tipoDocumento: TipoDocumentoFiscal;
  numeroDocumento: string | null;
  docTipoArca: DocTipoArca;
  docNroArca: string;
  condicionIva: CondicionIva;
  origen: "CLIENTE_COMERCIAL" | "FAVORITO" | "MANUAL" | "ARCA";
  origenId: string | null;
  verificadoArcaAt: string | null;
};

export const UMBRAL_IDENTIFICACION_CF_2026 = 10_000_000;

const TIPOS_DOCUMENTO = new Set<TipoDocumentoFiscal>([
  "CUIT",
  "CUIL",
  "DNI",
  "CDI",
  "SIN_IDENTIFICAR",
]);

const CONDICIONES_IVA = new Set<CondicionIva>([
  "RESPONSABLE_INSCRIPTO",
  "MONOTRIBUTO",
  "EXENTO",
  "CONSUMIDOR_FINAL",
]);

const ORIGENES_CONFIRMADOS = new Set<ReceptorFiscalConfirmado["origen"]>([
  "CLIENTE_COMERCIAL",
  "FAVORITO",
  "MANUAL",
  "ARCA",
]);

type DocumentoFiscalArca = Pick<
  ReceptorFiscalConfirmado,
  "tipoDocumento" | "numeroDocumento" | "docTipoArca" | "docNroArca"
>;

function esRegistro(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function soloFormatoDocumental(
  valor: string,
  tipo: Exclude<TipoDocumentoFiscal, "SIN_IDENTIFICAR">,
) {
  if (!/^[\d.\-\s]+$/.test(valor)) {
    throw new Error(`El ${tipo} sólo puede contener dígitos y separadores de formato.`);
  }
  return valor.replace(/\D/g, "");
}

/**
 * Mapea un tipo documental explícito a DocTipo/DocNro. Nunca decide el tipo a
 * partir de la longitud del número.
 */
export function documentoFiscalArca(
  tipoDocumento: TipoDocumentoFiscal,
  numeroDocumento: string | null,
): DocumentoFiscalArca {
  if (!TIPOS_DOCUMENTO.has(tipoDocumento)) {
    throw new Error("Tipo de documento fiscal desconocido.");
  }

  if (tipoDocumento === "SIN_IDENTIFICAR") {
    if (numeroDocumento !== null) {
      throw new Error("SIN_IDENTIFICAR no admite número de documento.");
    }
    return {
      tipoDocumento,
      numeroDocumento: null,
      docTipoArca: 99,
      docNroArca: "0",
    };
  }

  if (typeof numeroDocumento !== "string" || numeroDocumento.trim() === "") {
    throw new Error(`El ${tipoDocumento} es obligatorio.`);
  }

  const numeroNormalizado = soloFormatoDocumental(numeroDocumento, tipoDocumento);
  if (tipoDocumento === "CUIT") {
    if (!cuitValido(numeroDocumento)) {
      throw new Error("El CUIT debe ser válido según su dígito verificador.");
    }
    return {
      tipoDocumento,
      numeroDocumento: numeroNormalizado,
      docTipoArca: 80,
      docNroArca: numeroNormalizado,
    };
  }

  if ((tipoDocumento === "CUIL" || tipoDocumento === "CDI") && numeroNormalizado.length !== 11) {
    throw new Error(`El ${tipoDocumento} debe tener exactamente 11 dígitos.`);
  }
  if (tipoDocumento === "DNI" && !/^\d{7,8}$/.test(numeroNormalizado)) {
    throw new Error("El DNI debe tener 7 u 8 dígitos.");
  }

  const docTipoArca = tipoDocumento === "CUIL" ? 86 : tipoDocumento === "CDI" ? 87 : 96;
  return {
    tipoDocumento,
    numeroDocumento: numeroNormalizado,
    docTipoArca,
    docNroArca: numeroNormalizado,
  };
}

function validarImporteTotal(importeTotal: number): void {
  if (!Number.isFinite(importeTotal) || importeTotal < 0) {
    throw new Error("El importe total fiscal debe ser un número no negativo.");
  }
}

function validarReglasDeCondicion(receptor: ReceptorFiscalConfirmado, importeTotal: number): void {
  if (receptor.tipoDocumento === "SIN_IDENTIFICAR") {
    if (receptor.condicionIva !== "CONSUMIDOR_FINAL") {
      throw new Error("Un receptor sin identificar sólo puede ser Consumidor Final.");
    }
    if (receptor.origen === "FAVORITO") {
      throw new Error("Un consumidor final sin identificar no puede provenir de un favorito.");
    }
    if (importeTotal >= UMBRAL_IDENTIFICACION_CF_2026) {
      throw new Error(
        "Desde $10.000.000 el consumidor final debe identificar un documento válido.",
      );
    }
  }

  if (
    receptor.condicionIva === "RESPONSABLE_INSCRIPTO" ||
    receptor.condicionIva === "MONOTRIBUTO"
  ) {
    if (receptor.tipoDocumento !== "CUIT") {
      throw new Error("Factura A exige un CUIT válido del receptor.");
    }
    if (receptor.docTipoArca !== 80) {
      throw new Error("Factura A exige DocTipo 80 y un CUIT válido.");
    }
    if (!cuitValido(receptor.numeroDocumento)) {
      throw new Error("Factura A exige un CUIT válido del receptor.");
    }
  }
}

const FECHA_ARCA_CON_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function fechaArcaValida(valor: string): boolean {
  const match = FECHA_ARCA_CON_OFFSET.exec(valor);
  if (!match) return false;

  const [, year, month, day, hour, minute, second, millisecond = "0", offset] = match;
  const offsetHoras = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinutos = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  if (Number(year) === 0 || offsetHoras > 23 || offsetMinutos > 59) return false;

  const milisegundos = Number(millisecond.padEnd(3, "0"));
  const fechaLocal = new Date(0);
  fechaLocal.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  fechaLocal.setUTCHours(Number(hour), Number(minute), Number(second), milisegundos);
  const localUtc = fechaLocal.getTime();
  if (
    fechaLocal.getUTCFullYear() !== Number(year) ||
    fechaLocal.getUTCMonth() !== Number(month) - 1 ||
    fechaLocal.getUTCDate() !== Number(day) ||
    fechaLocal.getUTCHours() !== Number(hour) ||
    fechaLocal.getUTCMinutes() !== Number(minute) ||
    fechaLocal.getUTCSeconds() !== Number(second) ||
    fechaLocal.getUTCMilliseconds() !== milisegundos
  ) {
    return false;
  }
  const signo = offset.startsWith("-") ? -1 : 1;
  const instante = localUtc - signo * (offsetHoras * 60 + offsetMinutos) * 60_000;
  return Number.isFinite(instante) && new Date(instante).getTime() === new Date(valor).getTime();
}

function validarOrigenArca(
  receptor: ReceptorFiscalConfirmado,
  documento: DocumentoFiscalArca,
): void {
  if (receptor.origen !== "ARCA") {
    if (receptor.verificadoArcaAt !== null) {
      throw new Error("Sólo un receptor de origen ARCA puede declarar una verificación ARCA.");
    }
    return;
  }

  if (
    documento.tipoDocumento !== "CUIT" ||
    documento.docTipoArca !== 80 ||
    !cuitValido(documento.numeroDocumento)
  ) {
    throw new Error("Un receptor de origen ARCA exige CUIT válido y DocTipo 80.");
  }
  if (!receptor.verificadoArcaAt || !fechaArcaValida(receptor.verificadoArcaAt)) {
    throw new Error(
      "Un receptor de origen ARCA exige una fecha de verificación ARCA ISO con offset válida.",
    );
  }
}

/** Valida la forma canónica completa que se congelará en el snapshot fiscal v2. */
export function validarReceptorFiscalConfirmado(
  value: unknown,
  importeTotal: number,
): ReceptorFiscalConfirmado {
  validarImporteTotal(importeTotal);
  if (!esRegistro(value)) throw new Error("El receptor fiscal confirmado es obligatorio.");

  if (typeof value.razonSocial !== "string" || value.razonSocial.trim() === "") {
    throw new Error("La razón social del receptor es obligatoria.");
  }
  if (value.domicilio !== null && typeof value.domicilio !== "string") {
    throw new Error("El domicilio del receptor debe ser texto o null.");
  }
  if (!CONDICIONES_IVA.has(value.condicionIva as CondicionIva)) {
    throw new Error("La condición de IVA del receptor es desconocida.");
  }
  if (!ORIGENES_CONFIRMADOS.has(value.origen as ReceptorFiscalConfirmado["origen"])) {
    throw new Error("El origen del receptor fiscal es desconocido.");
  }
  if (value.origenId !== null && typeof value.origenId !== "string") {
    throw new Error("El identificador de origen del receptor debe ser texto o null.");
  }
  if (value.verificadoArcaAt !== null && typeof value.verificadoArcaAt !== "string") {
    throw new Error("La fecha de verificación ARCA debe ser texto o null.");
  }

  const documento = documentoFiscalArca(
    value.tipoDocumento as TipoDocumentoFiscal,
    value.numeroDocumento as string | null,
  );
  const receptor = value as ReceptorFiscalConfirmado;
  validarReglasDeCondicion(receptor, importeTotal);
  if (
    value.numeroDocumento !== documento.numeroDocumento ||
    value.docTipoArca !== documento.docTipoArca ||
    value.docNroArca !== documento.docNroArca
  ) {
    throw new Error("El documento lógico no coincide con el documento ARCA confirmado.");
  }

  validarOrigenArca(receptor, documento);

  if (receptor.origen === "MANUAL" && receptor.origenId !== null) {
    throw new Error("Un receptor manual no admite identificador de origen.");
  }
  if (receptor.origen === "FAVORITO" && !receptor.origenId?.trim()) {
    throw new Error("Un receptor favorito exige su identificador de origen.");
  }

  return receptor;
}

/** Confirma un selector manual ya aceptado expresamente por el operador. */
export function confirmarReceptorManual(
  value: unknown,
  importeTotal: number,
): ReceptorFiscalConfirmado {
  if (!esRegistro(value) || value.origen !== "MANUAL") {
    throw new Error("Se esperaba un selector de receptor manual.");
  }
  if (value.confirma_datos_manuales !== true) {
    throw new Error("Debés confirmar expresamente los datos del receptor manual.");
  }
  if (typeof value.razon_social !== "string" || value.razon_social.trim() === "") {
    throw new Error("La razón social del receptor manual es obligatoria.");
  }
  if (!CONDICIONES_IVA.has(value.condicion_iva as CondicionIva)) {
    throw new Error("La condición de IVA del receptor manual es desconocida.");
  }
  if (typeof value.guardar_para_proximas !== "boolean") {
    throw new Error("La opción de guardar el receptor debe ser booleana.");
  }
  if (value.domicilio !== null && typeof value.domicilio !== "string") {
    throw new Error("El domicilio del receptor manual debe ser texto o null.");
  }

  const documento = documentoFiscalArca(
    value.tipo_documento as TipoDocumentoFiscal,
    value.numero_documento as string | null,
  );
  if (documento.tipoDocumento === "SIN_IDENTIFICAR" && value.guardar_para_proximas) {
    throw new Error("El consumidor final sin identificar no se puede guardar como favorito.");
  }

  const receptor: ReceptorFiscalConfirmado = {
    razonSocial: value.razon_social.trim(),
    domicilio:
      typeof value.domicilio === "string" && value.domicilio.trim() !== ""
        ? value.domicilio.trim()
        : null,
    ...documento,
    condicionIva: value.condicion_iva as CondicionIva,
    origen: "MANUAL",
    origenId: null,
    verificadoArcaAt: null,
  };

  return validarReceptorFiscalConfirmado(receptor, importeTotal);
}
