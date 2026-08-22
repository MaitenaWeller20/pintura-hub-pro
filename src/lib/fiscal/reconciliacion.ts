import type { ComprobanteArcaConsultado } from "./arca";
import type { SnapshotFiscalV2 } from "./snapshot";

export type DecisionConciliacion =
  | { accion: "RECUPERAR_CAE"; cae: string; vencimiento: string | null }
  | { accion: "REENVIAR_MISMO_NUMERO" }
  | { accion: "BLOQUEAR"; diferencias: string[] };

type Comparable = string | number | null;

function agregarSiDifiere(
  diferencias: string[],
  ruta: string,
  local: Comparable,
  remoto: Comparable,
): void {
  if (local !== remoto) diferencias.push(ruta);
}

function compararColeccion<TLocal, TRemoto>(
  diferencias: string[],
  ruta: string,
  locales: readonly TLocal[],
  remotos: readonly TRemoto[],
  ordenarLocal: (a: TLocal, b: TLocal) => number,
  ordenarRemoto: (a: TRemoto, b: TRemoto) => number,
  campos: Array<[string, (row: TLocal) => Comparable, (row: TRemoto) => Comparable]>,
): void {
  if (locales.length !== remotos.length) {
    diferencias.push(`${ruta}.length`);
    return;
  }
  const a = [...locales].sort(ordenarLocal);
  const b = [...remotos].sort(ordenarRemoto);
  for (let index = 0; index < a.length; index += 1) {
    for (const [campo, local, remoto] of campos) {
      agregarSiDifiere(
        diferencias,
        `${ruta}[${index}].${campo}`,
        local(a[index]),
        remoto(b[index]),
      );
    }
  }
}

const compararAlicuotaLocal = (
  a: SnapshotFiscalV2["alicuotasIva"][number],
  b: SnapshotFiscalV2["alicuotasIva"][number],
) =>
  a.id - b.id ||
  a.baseImponible.localeCompare(b.baseImponible) ||
  a.importe.localeCompare(b.importe);
const compararAlicuotaRemota = (
  a: ComprobanteArcaConsultado["alicuotas"][number],
  b: ComprobanteArcaConsultado["alicuotas"][number],
) => a.id - b.id || a.base.localeCompare(b.base) || a.importe.localeCompare(b.importe);
const compararTributoLocal = (
  a: SnapshotFiscalV2["tributos"][number],
  b: SnapshotFiscalV2["tributos"][number],
) =>
  a.id - b.id ||
  a.descripcion.localeCompare(b.descripcion) ||
  a.baseImponible.localeCompare(b.baseImponible) ||
  a.alicuota.localeCompare(b.alicuota) ||
  a.importe.localeCompare(b.importe);
const compararTributoRemoto = (
  a: ComprobanteArcaConsultado["tributos"][number],
  b: ComprobanteArcaConsultado["tributos"][number],
) =>
  a.id - b.id ||
  a.descripcion.localeCompare(b.descripcion) ||
  a.base.localeCompare(b.base) ||
  a.alicuota.localeCompare(b.alicuota) ||
  a.importe.localeCompare(b.importe);
const compararAsociadoLocal = (
  a: SnapshotFiscalV2["cbtesAsoc"][number],
  b: SnapshotFiscalV2["cbtesAsoc"][number],
) =>
  a.tipo - b.tipo ||
  a.puntoVenta - b.puntoVenta ||
  a.numero - b.numero ||
  a.cuit.localeCompare(b.cuit) ||
  a.fecha.localeCompare(b.fecha);
const compararAsociadoRemoto = (
  a: ComprobanteArcaConsultado["asociados"][number],
  b: ComprobanteArcaConsultado["asociados"][number],
) =>
  a.tipo - b.tipo ||
  a.puntoVenta - b.puntoVenta ||
  a.numero - b.numero ||
  a.cuit.localeCompare(b.cuit) ||
  (a.fecha ?? "").localeCompare(b.fecha ?? "");

/** Devuelve únicamente rutas de campos; nunca incluye valores fiscales. */
export function compararSnapshotConArca(
  snapshot: SnapshotFiscalV2,
  remoto: ComprobanteArcaConsultado,
): string[] {
  const diferencias: string[] = [];
  agregarSiDifiere(
    diferencias,
    "identidad.puntoVenta",
    snapshot.identidad.puntoVenta,
    remoto.puntoVenta,
  );
  agregarSiDifiere(diferencias, "identidad.cbteTipo", snapshot.identidad.cbteTipo, remoto.cbteTipo);
  agregarSiDifiere(diferencias, "identidad.numero", snapshot.identidad.numero, remoto.numero);
  agregarSiDifiere(diferencias, "concepto", snapshot.concepto, remoto.concepto);
  agregarSiDifiere(
    diferencias,
    "receptor.docTipoArca",
    snapshot.receptor.docTipoArca,
    remoto.docTipo,
  );
  agregarSiDifiere(diferencias, "receptor.docNroArca", snapshot.receptor.docNroArca, remoto.docNro);
  agregarSiDifiere(
    diferencias,
    "receptor.condicionIvaReceptorId",
    snapshot.receptor.condicionIvaReceptorId,
    remoto.condicionIvaReceptorId,
  );
  agregarSiDifiere(diferencias, "fechaComprobante", snapshot.fechaComprobante, remoto.fecha);
  agregarSiDifiere(diferencias, "importeTotal", snapshot.importeTotal, remoto.total);
  agregarSiDifiere(diferencias, "importeNeto", snapshot.importeNeto, remoto.neto);
  agregarSiDifiere(diferencias, "importeExento", snapshot.importeExento, remoto.exento);
  agregarSiDifiere(diferencias, "importeNoGravado", snapshot.importeNoGravado, remoto.noGravado);
  agregarSiDifiere(diferencias, "importeIva", snapshot.importeIva, remoto.iva);
  agregarSiDifiere(diferencias, "importeTributos", snapshot.importeTributos, remoto.tributosTotal);
  agregarSiDifiere(diferencias, "moneda", snapshot.moneda, remoto.moneda);
  agregarSiDifiere(diferencias, "cotizacion", snapshot.cotizacion, remoto.cotizacion);

  compararColeccion(
    diferencias,
    "alicuotasIva",
    snapshot.alicuotasIva,
    remoto.alicuotas,
    compararAlicuotaLocal,
    compararAlicuotaRemota,
    [
      ["id", (row) => row.id, (row) => row.id],
      ["baseImponible", (row) => row.baseImponible, (row) => row.base],
      ["importe", (row) => row.importe, (row) => row.importe],
    ],
  );
  compararColeccion(
    diferencias,
    "tributos",
    snapshot.tributos,
    remoto.tributos,
    compararTributoLocal,
    compararTributoRemoto,
    [
      ["id", (row) => row.id, (row) => row.id],
      ["descripcion", (row) => row.descripcion, (row) => row.descripcion],
      ["baseImponible", (row) => row.baseImponible, (row) => row.base],
      ["alicuota", (row) => row.alicuota, (row) => row.alicuota],
      ["importe", (row) => row.importe, (row) => row.importe],
    ],
  );
  compararColeccion(
    diferencias,
    "cbtesAsoc",
    snapshot.cbtesAsoc,
    remoto.asociados,
    compararAsociadoLocal,
    compararAsociadoRemoto,
    [
      ["tipo", (row) => row.tipo, (row) => row.tipo],
      ["puntoVenta", (row) => row.puntoVenta, (row) => row.puntoVenta],
      ["numero", (row) => row.numero, (row) => row.numero],
      ["cuit", (row) => row.cuit, (row) => row.cuit],
      ["fecha", (row) => row.fecha, (row) => row.fecha],
    ],
  );
  return diferencias;
}

export function decidirConciliacion(input: {
  snapshot: SnapshotFiscalV2;
  remoto: ComprobanteArcaConsultado | null;
  ultimoRemoto: number;
  numeroReservado: number;
  payloadHash: string;
}): DecisionConciliacion {
  const invariantes: string[] = [];
  if (input.payloadHash !== input.snapshot.hash) invariantes.push("hash");
  if (input.numeroReservado !== input.snapshot.identidad.numero) {
    invariantes.push("identidad.numero");
  }
  if (invariantes.length > 0) return { accion: "BLOQUEAR", diferencias: invariantes };

  if (input.remoto) {
    const diferencias = compararSnapshotConArca(input.snapshot, input.remoto);
    if (diferencias.length > 0) return { accion: "BLOQUEAR", diferencias };
    if (!/^\d{14}$/.test(input.remoto.cae)) return { accion: "BLOQUEAR", diferencias: ["cae"] };
    if (input.remoto.caeVencimiento !== null && !fechaFiscalValida(input.remoto.caeVencimiento))
      return { accion: "BLOQUEAR", diferencias: ["caeVencimiento"] };
    return {
      accion: "RECUPERAR_CAE",
      cae: input.remoto.cae,
      vencimiento: input.remoto.caeVencimiento,
    };
  }
  const diferencias: string[] = [];
  if (input.ultimoRemoto !== input.numeroReservado - 1) {
    diferencias.push("secuencia");
  }
  return diferencias.length > 0
    ? { accion: "BLOQUEAR", diferencias }
    : { accion: "REENVIAR_MISMO_NUMERO" };
}

function fechaFiscalValida(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
