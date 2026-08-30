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

export type AuditoriaPersistidaNotaCreditoPeriodo = {
  fiscal: {
    periodoDesde: string;
    periodoHasta: string;
    modalidad: "DEVOLUCION_PRODUCTOS" | "BONIFICACION_AJUSTE";
    motivo: string;
    receptor: { razonSocial: string; documento: string | null; letra: "A" | "B" | "C" };
  };
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

export async function cargarAuditoriaNotaCreditoPeriodo(deps: {
  venta: {
    id: string;
    afipSnapshot: unknown;
    afipSnapshotHash: string | null;
    requiereEvidenciaAutorizacion: boolean;
  };
  cargarOperador(): RespuestaAuditoria<OperadorAuditoriaRow>;
  cargarReintegros(): RespuestaAuditoria<ReintegroAuditoriaRow[]>;
  cargarStock(): RespuestaAuditoria<StockAuditoriaRow[]>;
  cargarCuentaCorriente(): RespuestaAuditoria<CuentaAuditoriaRow[]>;
  cargarEvidenciaAutorizacion(): Promise<EvidenciaAutorizacionFiscal | null>;
}): Promise<AuditoriaPersistidaNotaCreditoPeriodo> {
  let snapshot;
  try {
    snapshot = validarSnapshotFiscalV3(deps.venta.afipSnapshot);
    if (snapshot.hash !== deps.venta.afipSnapshotHash || snapshot.venta.id !== deps.venta.id) {
      throw new Error("Snapshot v3 divergente");
    }
  } catch {
    throw new Error("No se pudo validar la evidencia fiscal congelada de la nota de crédito.");
  }

  const [operador, reintegros, stock, cuentaCorriente, evidenciaAutorizacion] = await Promise.all([
    deps.cargarOperador(),
    deps.cargarReintegros(),
    deps.cargarStock(),
    deps.cargarCuentaCorriente(),
    deps.cargarEvidenciaAutorizacion(),
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
    fiscal: {
      periodoDesde: snapshot.periodoAsoc.desde,
      periodoHasta: snapshot.periodoAsoc.hasta,
      modalidad: snapshot.notaCredito.modalidad,
      motivo: snapshot.notaCredito.motivo,
      receptor: {
        razonSocial: snapshot.receptor.razonSocial,
        documento: snapshot.receptor.numeroDocumento,
        letra: snapshot.letra,
      },
    },
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
