import type { CondicionIva } from "./codigos";
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
