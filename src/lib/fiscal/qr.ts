import QRCode from "qrcode";
import { fmtFechaIsoAr } from "./fecha";
import { round2 } from "./iva";

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
  fecha: Date;
  cuit: number; // CUIT del emisor, sin guiones
  ptoVta: number;
  tipoCmp: number; // CbteTipo
  nroCmp: number;
  importe: number;
  tipoDocRec: number; // 80 CUIT | 96 DNI | 99 consumidor final
  nroDocRec: number; // 0 si no hay documento
  codAut: string; // el CAE
}

export function urlQrAfip(d: QrAfipInput): string {
  const data = {
    ver: 1,
    fecha: fmtFechaIsoAr(d.fecha),
    cuit: d.cuit,
    ptoVta: d.ptoVta,
    tipoCmp: d.tipoCmp,
    nroCmp: d.nroCmp,
    importe: round2(d.importe),
    moneda: "PES",
    ctz: 1,
    tipoDocRec: d.tipoDocRec,
    nroDocRec: d.nroDocRec,
    tipoCodAut: "E",
    codAut: Number(d.codAut),
  };
  const p = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  return `https://www.afip.gob.ar/fe/qr/?p=${p}`;
}

/** PNG como data-URL, listo para <img src>. null si todavía no hay CAE. */
export async function qrAfipDataUrl(d: QrAfipInput): Promise<string | null> {
  if (!d.codAut || !Number.isFinite(Number(d.codAut))) return null;
  try {
    return await QRCode.toDataURL(urlQrAfip(d), {
      margin: 0,
      width: 256,
      errorCorrectionLevel: "M",
    });
  } catch {
    return null;
  }
}
