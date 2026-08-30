import type { EvidenciaAutorizacionFiscal } from "@/lib/fiscal/evidencia-auditoria";
import { validarSnapshotFiscalV3 } from "@/lib/fiscal/snapshot";

export type ErrorLecturaSegura = { message: string } | null;

type RespuestaAuditoria<T> = Promise<{ data: T | null; error: ErrorLecturaSegura }>;
const UUID_CANONICO = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OperadorAuditoriaRow = { nombre_completo: string | null; username: string };
export type ReintegroAuditoriaRow = {
  id: string;
  forma_pago: string;
  monto: number;
  orden: number;
};
export type StockAuditoriaRow = {
  id: string;
  producto_id: string;
  cantidad: number;
  cantidad_anterior: number | null;
  cantidad_nueva: number | null;
  created_at: string;
  producto: { codigo: string; nombre: string } | Array<{ codigo: string; nombre: string }> | null;
};
export type CuentaAuditoriaRow = {
  id: string;
  tipo: string;
  estado: string;
  monto: number;
  descripcion: string | null;
  created_at: string;
};

type FiscalAuditoriaNotaCreditoPeriodo =
  | {
      estado: "SNAPSHOT_V3_VALIDADO";
      periodoDesde: string;
      periodoHasta: string;
      modalidad: "DEVOLUCION_PRODUCTOS" | "BONIFICACION_AJUSTE";
      motivo: string;
      receptor: { razonSocial: string; documento: string | null; letra: "A" | "B" | "C" };
    }
  | {
      estado: "INTENCION_NO_CONGELADA";
      periodoDesde: string;
      periodoHasta: string;
      modalidad: "DEVOLUCION_PRODUCTOS" | "BONIFICACION_AJUSTE";
      motivo: string;
    };

export type AuditoriaPersistidaNotaCreditoPeriodo = {
  fiscal: FiscalAuditoriaNotaCreditoPeriodo;
  operador: { nombre: string; username: string } | null;
  evidenciaAutorizacion: EvidenciaAutorizacionFiscal | null;
  reintegrosIntencion: Array<{ id: string; formaPago: string; monto: number; orden: number }>;
  movimientosStock: Array<{
    id: string;
    productoId: string;
    etiquetaActual: string;
    cantidad: number;
    cantidadAnterior: number | null;
    cantidadNueva: number | null;
    createdAt: string;
  }>;
  movimientosCuentaCorriente: Array<{
    id: string;
    tipo: string;
    estado: string;
    monto: number;
    descripcion: string | null;
    createdAt: string;
  }>;
};

type VentaAuditoriaNotaCreditoPeriodo = {
  id: string;
  estado?: string;
  afipEstado?: string;
  afipFase?: string | null;
  afipVersion?: number;
  afipIntentos?: number;
  afipSnapshot: unknown;
  afipSnapshotHash: string | null;
  cae?: string | null;
  caeVencimiento?: string | null;
  afipEmisorCuit?: string | null;
  afipPuntoVenta?: number | null;
  afipCbteTipo?: number | null;
  afipNumero?: number | null;
  afipModo?: string | null;
  afipValidez?: string | null;
  afipFechaComprobante?: string | null;
  afipEmitidoAt?: string | null;
  afipImpTotal?: number | null;
  afipSimulado?: boolean;
  afipCbteAsocId?: string | null;
  ncEfectosAplicadosAt?: string | null;
  periodoDesde?: string | null;
  periodoHasta?: string | null;
  modalidad?: string | null;
  motivo?: string | null;
  requiereEvidenciaAutorizacion: boolean;
};

function esFechaCanonica(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const fecha = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === value;
}

function esIntencionNoCongelada(
  venta: VentaAuditoriaNotaCreditoPeriodo,
): venta is VentaAuditoriaNotaCreditoPeriodo & {
  periodoDesde: string;
  periodoHasta: string;
  modalidad: "DEVOLUCION_PRODUCTOS" | "BONIFICACION_AJUSTE";
  motivo: string;
} {
  const cicloValido =
    (venta.estado === "PENDIENTE_FISCAL" &&
      venta.afipEstado === "SIN_FACTURAR" &&
      venta.afipVersion === 0) ||
    (venta.estado === "ANULADA" && venta.afipEstado === "CANCELADO" && venta.afipVersion === 1);
  const identidadAusente = [
    venta.afipSnapshot,
    venta.afipSnapshotHash,
    venta.cae,
    venta.caeVencimiento,
    venta.afipEmisorCuit,
    venta.afipPuntoVenta,
    venta.afipCbteTipo,
    venta.afipNumero,
    venta.afipModo,
    venta.afipValidez,
    venta.afipFechaComprobante,
    venta.afipEmitidoAt,
    venta.afipImpTotal,
    venta.afipCbteAsocId,
    venta.ncEfectosAplicadosAt,
  ].every((value) => value === null);
  const modalidadValida =
    venta.modalidad === "DEVOLUCION_PRODUCTOS" || venta.modalidad === "BONIFICACION_AJUSTE";
  const motivoValido =
    typeof venta.motivo === "string" &&
    venta.motivo === venta.motivo.trim() &&
    venta.motivo.length >= 5;

  return Boolean(
    cicloValido &&
    venta.afipFase === null &&
    venta.afipIntentos === 0 &&
    venta.afipSimulado === false &&
    identidadAusente &&
    esFechaCanonica(venta.periodoDesde) &&
    esFechaCanonica(venta.periodoHasta) &&
    venta.periodoDesde <= venta.periodoHasta &&
    modalidadValida &&
    motivoValido,
  );
}

function resolverFiscalAuditado(
  venta: VentaAuditoriaNotaCreditoPeriodo,
): FiscalAuditoriaNotaCreditoPeriodo {
  if (esIntencionNoCongelada(venta)) {
    return {
      estado: "INTENCION_NO_CONGELADA",
      periodoDesde: venta.periodoDesde,
      periodoHasta: venta.periodoHasta,
      modalidad: venta.modalidad,
      motivo: venta.motivo,
    };
  }

  const snapshot = validarSnapshotFiscalV3(venta.afipSnapshot);
  if (snapshot.hash !== venta.afipSnapshotHash || snapshot.venta.id !== venta.id) {
    throw new Error("Snapshot v3 divergente");
  }
  return {
    estado: "SNAPSHOT_V3_VALIDADO",
    periodoDesde: snapshot.periodoAsoc.desde,
    periodoHasta: snapshot.periodoAsoc.hasta,
    modalidad: snapshot.notaCredito.modalidad,
    motivo: snapshot.notaCredito.motivo,
    receptor: {
      razonSocial: snapshot.receptor.razonSocial,
      documento: snapshot.receptor.numeroDocumento,
      letra: snapshot.letra,
    },
  };
}

export async function cargarAuditoriaNotaCreditoPeriodo(deps: {
  venta: VentaAuditoriaNotaCreditoPeriodo;
  cargarOperador(): RespuestaAuditoria<OperadorAuditoriaRow>;
  cargarReintegros(): RespuestaAuditoria<ReintegroAuditoriaRow[]>;
  cargarStock(): RespuestaAuditoria<StockAuditoriaRow[]>;
  cargarCuentaCorriente(): RespuestaAuditoria<CuentaAuditoriaRow[]>;
  cargarEvidenciaAutorizacion(): Promise<EvidenciaAutorizacionFiscal | null>;
}): Promise<AuditoriaPersistidaNotaCreditoPeriodo> {
  let fiscal: FiscalAuditoriaNotaCreditoPeriodo;
  try {
    fiscal = resolverFiscalAuditado(deps.venta);
  } catch {
    throw new Error("No se pudo validar la evidencia fiscal congelada de la nota de crédito.");
  }

  const [operador, reintegros, stock, cuentaCorriente, evidenciaAutorizacion] = await Promise.all([
    deps.cargarOperador(),
    deps.cargarReintegros(),
    deps.cargarStock(),
    deps.cargarCuentaCorriente(),
    fiscal.estado === "SNAPSHOT_V3_VALIDADO"
      ? deps.cargarEvidenciaAutorizacion()
      : Promise.resolve(null),
  ]);
  if (
    operador.error ||
    !operador.data ||
    reintegros.error ||
    !reintegros.data ||
    stock.error ||
    !stock.data ||
    cuentaCorriente.error ||
    !cuentaCorriente.data
  ) {
    throw new Error("No se pudo reconstruir la auditoría de la nota de crédito.");
  }
  if (deps.venta.requiereEvidenciaAutorizacion && !evidenciaAutorizacion) {
    throw new Error("No se pudo validar la evidencia de autorización fiscal.");
  }
  if (stock.data.some((row) => !UUID_CANONICO.test(row.producto_id))) {
    throw new Error("No se pudo reconstruir la auditoría de la nota de crédito.");
  }

  return {
    fiscal,
    operador: {
      nombre: operador.data.nombre_completo?.trim() || operador.data.username,
      username: operador.data.username,
    },
    evidenciaAutorizacion,
    reintegrosIntencion: reintegros.data.map((row) => ({
      id: row.id,
      formaPago: row.forma_pago,
      monto: Number(row.monto),
      orden: row.orden,
    })),
    movimientosStock: stock.data.map((row) => {
      const producto = Array.isArray(row.producto) ? row.producto[0] : row.producto;
      return {
        id: row.id,
        productoId: row.producto_id,
        etiquetaActual: producto
          ? `${producto.codigo} · ${producto.nombre}`
          : "Sin etiqueta actual",
        cantidad: Number(row.cantidad),
        cantidadAnterior: row.cantidad_anterior == null ? null : Number(row.cantidad_anterior),
        cantidadNueva: row.cantidad_nueva == null ? null : Number(row.cantidad_nueva),
        createdAt: row.created_at,
      };
    }),
    movimientosCuentaCorriente: cuentaCorriente.data.map((row) => ({
      id: row.id,
      tipo: row.tipo,
      estado: row.estado,
      monto: Number(row.monto),
      descripcion: row.descripcion,
      createdAt: row.created_at,
    })),
  };
}
