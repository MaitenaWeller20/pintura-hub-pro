import type { CondicionIva, Letra } from "./codigos";
import type { TotalesFiscales } from "./iva";

export type EmisorSnapshotFiscal = {
  razon_social: string;
  nombre_fantasia: string | null;
  cuit: string;
  domicilio_fiscal: string | null;
  condicion_iva: CondicionIva;
  ingresos_brutos: string | null;
  inicio_actividades: string;
  telefono: string | null;
};

export type ReceptorSnapshotFiscal = {
  razon_social: string | null;
  cuit_dni: string | null;
  doc_tipo: number;
  doc_nro: number;
  condicion_iva: CondicionIva | null;
  domicilio: string | null;
};

export type ReceptorDeclaradoLegacy = Omit<ReceptorSnapshotFiscal, "condicion_iva"> & {
  condicion_iva: CondicionIva;
};

export type LineaSnapshotFiscal = {
  codigo: string;
  descripcion: string;
  cantidad: number;
  precio_unitario_sin_iva: number;
  descuento_porcentaje: number;
  iva_porcentaje: number;
  subtotal_con_iva: number;
};

export type SnapshotFiscal = {
  emisor: EmisorSnapshotFiscal;
  receptor: ReceptorSnapshotFiscal;
  condicion_venta: string | null;
  totales: TotalesFiscales;
  fecha: string;
  lineas: LineaSnapshotFiscal[];
  version: 1;
};

export type SnapshotFiscalInput = Omit<SnapshotFiscal, "version">;

export type IdentidadReservaFiscal = {
  cuit: string | null;
  punto_venta: number | null;
  cbte_tipo: number | null;
  ambiente: string | null;
};

export function identidadReservaCoincide(
  reserva: IdentidadReservaFiscal,
  esperada: IdentidadReservaFiscal,
): boolean {
  return (
    reserva.cuit === esperada.cuit &&
    reserva.punto_venta === esperada.punto_venta &&
    reserva.cbte_tipo === esperada.cbte_tipo &&
    reserva.ambiente === esperada.ambiente
  );
}

const CONDICIONES_IVA = new Set<CondicionIva>([
  "RESPONSABLE_INSCRIPTO",
  "MONOTRIBUTO",
  "EXENTO",
  "CONSUMIDOR_FINAL",
]);
const DOC_TIPOS_ARCA = new Set([80, 86, 87, 96, 99]);

function esRegistro(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receptorDesdeSnapshotV1(snapshot: unknown): ReceptorDeclaradoLegacy {
  if (!esRegistro(snapshot) || snapshot.version !== 1 || !esRegistro(snapshot.receptor)) {
    throw new Error("La nota exige un snapshot v1 válido del receptor original.");
  }

  const receptor = snapshot.receptor;
  if (
    (receptor.razon_social !== null && typeof receptor.razon_social !== "string") ||
    (receptor.cuit_dni !== null && typeof receptor.cuit_dni !== "string") ||
    (receptor.domicilio !== null && typeof receptor.domicilio !== "string") ||
    typeof receptor.doc_tipo !== "number" ||
    !DOC_TIPOS_ARCA.has(receptor.doc_tipo) ||
    typeof receptor.doc_nro !== "number" ||
    !Number.isSafeInteger(receptor.doc_nro) ||
    receptor.doc_nro < 0 ||
    (receptor.condicion_iva !== null &&
      !CONDICIONES_IVA.has(receptor.condicion_iva as CondicionIva))
  ) {
    throw new Error("La nota exige un snapshot v1 válido del receptor original.");
  }

  if (
    (receptor.doc_tipo === 99 && receptor.doc_nro !== 0) ||
    ([80, 86, 87].includes(receptor.doc_tipo) && String(receptor.doc_nro).length !== 11) ||
    (receptor.doc_tipo === 96 && !/^\d{7,8}$/.test(String(receptor.doc_nro)))
  ) {
    throw new Error("El documento del receptor en el snapshot v1 original es incoherente.");
  }

  return {
    razon_social: receptor.razon_social as string | null,
    cuit_dni: receptor.cuit_dni as string | null,
    doc_tipo: receptor.doc_tipo,
    doc_nro: receptor.doc_nro,
    // Snapshot v1 guardaba null para el consumidor final anónimo, pero el
    // payload legacy declaraba 5 mediante condicionIvaReceptorId(null).
    condicion_iva: (receptor.condicion_iva as CondicionIva | null) ?? "CONSUMIDOR_FINAL",
    domicilio: receptor.domicilio as string | null,
  };
}

/**
 * Compatibilidad acotada del escritor legacy. Las notas heredan receptor del
 * snapshot v1 original; sólo una nota B histórica sin snapshot puede reconstruir
 * el viejo RI→Consumidor Final. Una factura nueva nunca entra en ese fallback.
 */
export function resolverReceptorFiscalLegacy(input: {
  tipoComprobante: string;
  letra: Letra;
  receptorVivo: ReceptorDeclaradoLegacy;
  snapshotOriginal: unknown | null;
}): ReceptorDeclaradoLegacy {
  const esNota =
    input.tipoComprobante === "NOTA_CREDITO" || input.tipoComprobante === "NOTA_DEBITO";
  if (!esNota) return { ...input.receptorVivo };
  if (input.snapshotOriginal !== null) return receptorDesdeSnapshotV1(input.snapshotOriginal);
  if (input.letra === "B" && input.receptorVivo.condicion_iva === "RESPONSABLE_INSCRIPTO") {
    return { ...input.receptorVivo, condicion_iva: "CONSUMIDOR_FINAL" };
  }
  return { ...input.receptorVivo };
}

/**
 * Copia todos los valores que forman el comprobante legal. No conserva
 * referencias a objetos vivos: una corrección posterior no cambia el snapshot
 * que se persiste junto con la reserva del número fiscal.
 */
export function crearSnapshotFiscal(input: SnapshotFiscalInput): SnapshotFiscal {
  return {
    emisor: { ...input.emisor },
    receptor: { ...input.receptor },
    condicion_venta: input.condicion_venta,
    totales: {
      ...input.totales,
      alicuotas: input.totales.alicuotas.map((alicuota) => ({ ...alicuota })),
    },
    fecha: input.fecha,
    lineas: input.lineas.map((linea) => ({ ...linea })),
    version: 1,
  };
}
