import { cuitValido, type CondicionIva, type Letra } from "./codigos";
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

function normalizarDocumentoLogico(valor: string): string {
  if (!/^(?=.*\d)[\d .-]+$/.test(valor)) {
    throw new Error(
      "El formato del documento lógico en el snapshot v1 sólo admite dígitos, puntos, guiones y espacios.",
    );
  }
  return valor.replace(/[ .-]/g, "");
}

function receptorDesdeSnapshotV1(snapshot: unknown, letra: Letra): ReceptorDeclaradoLegacy {
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

  const condicionDeclarada = receptor.condicion_iva as CondicionIva | null;
  let documentoLogico: string | null = null;
  if (receptor.doc_tipo === 99) {
    if (
      receptor.cuit_dni !== null ||
      receptor.doc_nro !== 0 ||
      (condicionDeclarada !== null && condicionDeclarada !== "CONSUMIDOR_FINAL")
    ) {
      throw new Error(
        "El receptor anónimo del snapshot v1 debe declarar cuit_dni null, DocTipo 99, DocNro 0 y condición consumidor final.",
      );
    }
  } else {
    if (receptor.cuit_dni === null) {
      throw new Error("El documento lógico del receptor identificado es obligatorio.");
    }
    documentoLogico = normalizarDocumentoLogico(receptor.cuit_dni as string);
    const largoValido =
      ([80, 86, 87].includes(receptor.doc_tipo) && /^\d{11}$/.test(documentoLogico)) ||
      (receptor.doc_tipo === 96 && /^\d{7,8}$/.test(documentoLogico));
    if (!largoValido) {
      throw new Error("El documento lógico no tiene la longitud exigida por DocTipo.");
    }
    if (documentoLogico !== String(receptor.doc_nro)) {
      throw new Error("El documento lógico del snapshot v1 no coincide exactamente con DocNro.");
    }
    if (receptor.doc_tipo === 80 && !cuitValido(documentoLogico)) {
      throw new Error("DocTipo 80 exige un CUIT válido en el snapshot v1 original.");
    }
    if (condicionDeclarada === null) {
      throw new Error("La condición de IVA es obligatoria para un receptor identificado.");
    }
  }

  const condicionEfectiva = condicionDeclarada ?? "CONSUMIDOR_FINAL";
  if (
    letra === "A" &&
    (!(condicionEfectiva === "RESPONSABLE_INSCRIPTO" || condicionEfectiva === "MONOTRIBUTO") ||
      receptor.doc_tipo !== 80 ||
      documentoLogico === null ||
      !cuitValido(documentoLogico))
  ) {
    throw new Error("La letra A es incompatible con la condición o el documento del receptor.");
  }
  if (letra === "B" && condicionEfectiva !== "EXENTO" && condicionEfectiva !== "CONSUMIDOR_FINAL") {
    throw new Error("La letra B es incompatible con la condición del receptor.");
  }

  return {
    razon_social: receptor.razon_social as string | null,
    cuit_dni: receptor.cuit_dni as string | null,
    doc_tipo: receptor.doc_tipo,
    doc_nro: receptor.doc_nro,
    // Snapshot v1 guardaba null para el consumidor final anónimo, pero el
    // payload legacy declaraba 5 mediante condicionIvaReceptorId(null).
    condicion_iva: condicionEfectiva,
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
  if (input.snapshotOriginal !== null) {
    return receptorDesdeSnapshotV1(input.snapshotOriginal, input.letra);
  }
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
