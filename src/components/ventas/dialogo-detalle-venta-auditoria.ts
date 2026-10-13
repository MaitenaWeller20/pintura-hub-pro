import type { EvidenciaAutorizacionFiscal } from "@/lib/fiscal/evidencia-auditoria";
import { validarParidadColumnasSnapshotFiscal } from "@/lib/fiscal/impresion";
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

type LifecycleFiscalCongelado =
  | "RESERVADO"
  | "REQUEST_INICIADO"
  | "RESPUESTA_RECIBIDA"
  | "RECONCILIANDO_REQUEST"
  | "RECONCILIANDO_RESPUESTA"
  | "BLOQUEADO_RESERVADO"
  | "BLOQUEADO_REQUEST"
  | "BLOQUEADO_RESPUESTA"
  | "ERROR_CORREGIBLE_IDENTIDAD"
  | "APROBADO";

type FiscalAuditoriaNotaCreditoPeriodo =
  | {
      estado: "SNAPSHOT_V3_VALIDADO";
      lifecycle: LifecycleFiscalCongelado;
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
};

function esFechaCanonica(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const fecha = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === value;
}

function instanteFiscal(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return null;
  }
  const instante = new Date(value).getTime();
  return Number.isFinite(instante) ? instante : null;
}

const MATRIZ_LIFECYCLE_FISCAL_CONGELADO = {
  "EMITIENDO/RESERVADO": ["RESERVADO", 2],
  "EMITIENDO/REQUEST_INICIADO": ["REQUEST_INICIADO", 3],
  "EMITIENDO/RESPUESTA_RECIBIDA": ["RESPUESTA_RECIBIDA", 4],
  "RECONCILIAR/REQUEST_INICIADO": ["RECONCILIANDO_REQUEST", 4],
  "RECONCILIAR/RESPUESTA_RECIBIDA": ["RECONCILIANDO_RESPUESTA", 5],
  "BLOQUEADO/RESERVADO": ["BLOQUEADO_RESERVADO", 3],
  "BLOQUEADO/REQUEST_INICIADO": ["BLOQUEADO_REQUEST", 4],
  "BLOQUEADO/RESPUESTA_RECIBIDA": ["BLOQUEADO_RESPUESTA", 5],
  "ERROR_CORREGIBLE/NULL": ["ERROR_CORREGIBLE_IDENTIDAD", 3],
} as const satisfies Record<string, readonly [LifecycleFiscalCongelado, number]>;

function lifecycleFiscalCongelado(
  venta: VentaAuditoriaNotaCreditoPeriodo,
): LifecycleFiscalCongelado {
  if (
    typeof venta.afipVersion !== "number" ||
    !Number.isInteger(venta.afipVersion) ||
    venta.afipVersion < 2 ||
    typeof venta.afipIntentos !== "number" ||
    !Number.isInteger(venta.afipIntentos) ||
    venta.afipIntentos < 1
  ) {
    throw new Error("Lifecycle fiscal incompleto");
  }

  if (venta.afipEstado === "APROBADO" && venta.afipFase === "PERSISTIDO") {
    const emitido = instanteFiscal(venta.afipEmitidoAt);
    const efectos = instanteFiscal(venta.ncEfectosAplicadosAt);
    if (
      venta.estado !== "ACTIVA" ||
      venta.afipVersion < 5 ||
      typeof venta.cae !== "string" ||
      !/^\d{14}$/.test(venta.cae) ||
      emitido === null ||
      efectos === null ||
      efectos < emitido ||
      (venta.caeVencimiento !== null && !esFechaCanonica(venta.caeVencimiento))
    ) {
      throw new Error("Aprobación fiscal incompleta");
    }
    return "APROBADO";
  }

  if (
    venta.estado !== "PENDIENTE_FISCAL" ||
    venta.cae !== null ||
    venta.caeVencimiento !== null ||
    venta.afipEmitidoAt !== null ||
    venta.ncEfectosAplicadosAt !== null
  ) {
    throw new Error("Evidencia fiscal prematura");
  }

  const estadoFase = `${venta.afipEstado ?? "NULL"}/${venta.afipFase ?? "NULL"}`;
  const lifecycle =
    MATRIZ_LIFECYCLE_FISCAL_CONGELADO[estadoFase as keyof typeof MATRIZ_LIFECYCLE_FISCAL_CONGELADO];
  if (!lifecycle || venta.afipVersion < lifecycle[1]) {
    throw new Error("Lifecycle fiscal incoherente");
  }
  return lifecycle[0];
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
  validarParidadColumnasSnapshotFiscal(
    {
      id: venta.id,
      afip_snapshot_hash: venta.afipSnapshotHash,
      afip_emisor_cuit: venta.afipEmisorCuit,
      afip_punto_venta: venta.afipPuntoVenta,
      afip_cbte_tipo: venta.afipCbteTipo,
      afip_numero: venta.afipNumero,
      afip_modo: venta.afipModo,
      afip_simulado: venta.afipSimulado,
      afip_validez: venta.afipValidez,
      afip_fecha_comprobante: venta.afipFechaComprobante,
      afip_imp_total: venta.afipImpTotal,
    },
    snapshot,
  );
  if (venta.afipCbteAsocId !== null) {
    throw new Error("La asociación por período no admite comprobante puntual");
  }
  const lifecycle = lifecycleFiscalCongelado(venta);
  return {
    estado: "SNAPSHOT_V3_VALIDADO",
    lifecycle,
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

function validarEvidenciaAprobada(
  venta: VentaAuditoriaNotaCreditoPeriodo,
  evidencia: EvidenciaAutorizacionFiscal,
): void {
  const emitido = instanteFiscal(venta.afipEmitidoAt);
  const efectos = instanteFiscal(venta.ncEfectosAplicadosAt);
  const confirmado = instanteFiscal(evidencia.confirmadoAt);
  if (emitido === null || efectos === null || confirmado === null) {
    throw new Error("La evidencia temporal de aprobación es inválida");
  }
  if (evidencia.origen === "EMISION") {
    if (!esFechaCanonica(venta.caeVencimiento) || confirmado !== emitido) {
      throw new Error("La evidencia de emisión directa no coincide");
    }
    return;
  }
  if (
    (venta.caeVencimiento !== null && !esFechaCanonica(venta.caeVencimiento)) ||
    confirmado < emitido ||
    confirmado > efectos
  ) {
    throw new Error("La evidencia de recuperación no coincide");
  }
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
    fiscal.estado === "SNAPSHOT_V3_VALIDADO" && fiscal.lifecycle === "APROBADO"
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
  if (fiscal.estado === "SNAPSHOT_V3_VALIDADO" && fiscal.lifecycle === "APROBADO") {
    if (!evidenciaAutorizacion) {
      throw new Error("No se pudo validar la evidencia de autorización fiscal.");
    }
    try {
      validarEvidenciaAprobada(deps.venta, evidenciaAutorizacion);
    } catch {
      throw new Error("No se pudo validar la evidencia de autorización fiscal.");
    }
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
