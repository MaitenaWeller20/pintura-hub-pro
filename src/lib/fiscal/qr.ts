import QRCode from "qrcode";
import { fmtFechaIsoAr } from "./fecha";
import { ErrorImpresionFiscal } from "./impresion";

/**
 * QR de AFIP — RG 4892.
 * Especificación: https://www.afip.gob.ar/fe/qr/especificaciones.asp
 *
 * Detalles que importan y que se rompen fácil:
 *   - El orden de las claves del JSON es fijo.
 *   - cuit, nroCmp, importe, nroDocRec y codAut van como NÚMEROS, no como strings.
 *   - tipoCodAut: "E" = CAE (sería "A" si fuera CAEA).
 *   - El host es www.afip.gob.ar (.gob), a diferencia de los endpoints SOAP que
 *     son .gov.ar.
 *   - La fecha va en hora de Argentina, no UTC (ver fecha.ts).
 */
export interface QrAfipInput {
  fecha: string | Date;
  cuit: string | number; // CUIT del emisor, sin guiones
  ptoVta: number;
  tipoCmp: number; // CbteTipo
  nroCmp: number;
  importe: string | number;
  moneda?: "PES";
  ctz?: string | number;
  tipoDocRec: number; // 80 CUIT | 96 DNI | 99 consumidor final
  nroDocRec: string | number; // 0 si no hay documento
  codAut: string; // el CAE
}

const FIRMA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const BASE64_ESTRICTO = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function esPngDataUrlFiscal(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^data:image\/png;base64,(.+)$/.exec(value);
  if (!match || !BASE64_ESTRICTO.test(match[1])) return false;

  let bytes: Uint8Array;
  try {
    const binario = globalThis.atob(match[1]);
    bytes = new Uint8Array(binario.length);
    for (let index = 0; index < binario.length; index += 1) {
      bytes[index] = binario.charCodeAt(index);
    }
  } catch {
    return false;
  }
  if (!FIRMA_PNG.every((byte, index) => bytes[index] === byte)) return false;

  const vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset: number = FIRMA_PNG.length;
  let primerChunk = true;
  while (offset + 12 <= bytes.length) {
    const longitud = vista.getUint32(offset, false);
    const finChunk = offset + 12 + longitud;
    if (finChunk > bytes.length) return false;
    const tipo = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (primerChunk && (tipo !== "IHDR" || longitud !== 13)) return false;
    primerChunk = false;
    offset = finChunk;
    if (tipo === "IEND") return longitud === 0 && offset === bytes.length;
  }
  return false;
}

export function exigirPngDataUrlFiscal(value: unknown): string {
  if (!esPngDataUrlFiscal(value)) {
    throw new ErrorImpresionFiscal(
      "QR_FISCAL_OBLIGATORIO",
      "El QR fiscal obligatorio no es un PNG válido.",
    );
  }
  return value;
}

function fechaQr(value: string | Date): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("La fecha del QR es inválida.");
    return fmtFechaIsoAr(value);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("La fecha del QR no es canónica.");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error("La fecha del QR no existe.");
  }
  return value;
}

function enteroQr(value: unknown, campo: string, permitirCero = false): number {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error(`El campo ${campo} del QR es inválido.`);
  }
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || (permitirCero ? number < 0 : number <= 0)) {
    throw new Error(`El campo ${campo} del QR está fuera de rango.`);
  }
  return number;
}

function decimalQr(value: unknown, campo: string, escalaMaxima: number): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${escalaMaxima}})?$`);
  if (typeof raw !== "string" || !pattern.test(raw)) {
    throw new Error(`El decimal ${campo} del QR es inválido.`);
  }
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`El decimal ${campo} del QR está fuera de rango.`);
  }
  return number;
}

export function urlQrAfip(d: QrAfipInput): string {
  const cuit = String(d.cuit);
  if (!/^\d{11}$/.test(cuit)) throw new Error("El CUIT emisor del QR es inválido.");
  if (!/^\d{14}$/.test(d.codAut)) throw new Error("El CAE del QR es inválido.");
  if (d.moneda !== undefined && d.moneda !== "PES") {
    throw new Error("La moneda del QR no está soportada.");
  }
  const data = {
    ver: 1,
    fecha: fechaQr(d.fecha),
    cuit: enteroQr(cuit, "cuit"),
    ptoVta: enteroQr(d.ptoVta, "ptoVta"),
    tipoCmp: enteroQr(d.tipoCmp, "tipoCmp"),
    nroCmp: enteroQr(d.nroCmp, "nroCmp"),
    importe: decimalQr(d.importe, "importe", 2),
    moneda: "PES",
    ctz: decimalQr(d.ctz ?? 1, "ctz", 6),
    tipoDocRec: enteroQr(d.tipoDocRec, "tipoDocRec"),
    nroDocRec: enteroQr(d.nroDocRec, "nroDocRec", true),
    tipoCodAut: "E",
    codAut: enteroQr(d.codAut, "codAut"),
  };
  const p = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  return `https://www.afip.gob.ar/fe/qr/?p=${p}`;
}

/** PNG obligatorio para un comprobante autorizado; nunca degrada a null. */
export async function qrAfipDataUrlObligatorio(d: QrAfipInput): Promise<string> {
  try {
    const result = await QRCode.toDataURL(urlQrAfip(d), {
      margin: 0,
      width: 256,
      errorCorrectionLevel: "M",
    });
    return exigirPngDataUrlFiscal(result);
  } catch (cause) {
    if (cause instanceof ErrorImpresionFiscal) throw cause;
    throw new ErrorImpresionFiscal(
      "QR_FISCAL_OBLIGATORIO",
      "No se pudo generar el QR obligatorio del comprobante fiscal.",
      { cause },
    );
  }
}

/** @deprecated Compatibilidad del escritor/lector legacy durante el drain. */
export async function qrAfipDataUrl(d: QrAfipInput): Promise<string | null> {
  try {
    return await qrAfipDataUrlObligatorio(d);
  } catch {
    return null;
  }
}
