import type { AuditoriaPersistidaNotaCreditoPeriodo } from "@/components/ventas/dialogo-detalle-venta-auditoria";
import type { Database } from "@/integrations/supabase/types";
import type { ComprobanteAsociadoFiscalListado } from "@/lib/ventas-ui";
import { CBTE_INFO } from "./codigos";
import { validarParidadColumnasSnapshotFiscal } from "./impresion";
import { validarSnapshotFiscalPersistido } from "./snapshot";

type VentaRow = Database["public"]["Tables"]["ventas"]["Row"];

export const COLUMNAS_DETALLE_VENTA_FISCAL_SERVIDOR =
  "id,cliente_id,sucursal_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,created_at,condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,estado,estado_pago,observaciones,cae,cae_vencimiento,afip_estado,afip_fase,afip_version,afip_snapshot,afip_snapshot_hash,afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,afip_validez,afip_fecha_comprobante,afip_emitido_at,afip_imp_total,afip_simulado,afip_cbte_asoc_id,periodo_asoc_desde,periodo_asoc_hasta,nc_periodo_modalidad,motivo_nota_credito,nc_resolucion,nc_efectos_aplicados_at,afip_intentos" as const;

type ColumnaDetalleServidor =
  | "id"
  | "cliente_id"
  | "sucursal_id"
  | "usuario_id"
  | "numero_comprobante"
  | "tipo_comprobante"
  | "fecha"
  | "created_at"
  | "condicion_venta"
  | "subtotal_sin_iva"
  | "iva_total"
  | "percepciones"
  | "total"
  | "total_pagado"
  | "estado"
  | "estado_pago"
  | "observaciones"
  | "cae"
  | "cae_vencimiento"
  | "afip_estado"
  | "afip_fase"
  | "afip_version"
  | "afip_snapshot"
  | "afip_snapshot_hash"
  | "afip_emisor_cuit"
  | "afip_punto_venta"
  | "afip_cbte_tipo"
  | "afip_numero"
  | "afip_modo"
  | "afip_validez"
  | "afip_fecha_comprobante"
  | "afip_emitido_at"
  | "afip_imp_total"
  | "afip_simulado"
  | "afip_cbte_asoc_id"
  | "periodo_asoc_desde"
  | "periodo_asoc_hasta"
  | "nc_periodo_modalidad"
  | "motivo_nota_credito"
  | "nc_resolucion"
  | "nc_efectos_aplicados_at"
  | "afip_intentos";

type ColumnaDetallePresentacion = Exclude<
  ColumnaDetalleServidor,
  "afip_snapshot" | "afip_snapshot_hash"
>;

type RelacionesDetalle = {
  cliente: { razon_social: string | null; cuit_dni: string | null } | null;
  sucursal: { nombre: string | null; telefono: string | null } | null;
};

export type DetalleVentaFiscalServidor = Pick<VentaRow, ColumnaDetalleServidor> & RelacionesDetalle;

export type ReceptorFiscalPresentacion = {
  razonSocial: string;
  tipoDocumento: string;
  numeroDocumento: string | null;
  condicionIva: string;
  domicilio: string | null;
};

export type DetalleVentaFiscalPresentacion = Pick<VentaRow, ColumnaDetallePresentacion> &
  RelacionesDetalle & {
    fiscalPresentacion: {
      receptor: ReceptorFiscalPresentacion | null;
      comprobanteAsociado: ComprobanteAsociadoFiscalListado | null;
    };
    auditoriaPeriodo: AuditoriaPersistidaNotaCreditoPeriodo | null;
  };

export async function ejecutarDetalleVentaFiscalPresentacion(
  ventaId: string,
  deps: {
    autorizar(ventaId: string): Promise<void>;
    cargarVenta(ventaId: string): Promise<DetalleVentaFiscalServidor>;
    cargarAuditoriaPeriodo(
      venta: DetalleVentaFiscalServidor,
    ): Promise<AuditoriaPersistidaNotaCreditoPeriodo | null>;
  },
): Promise<DetalleVentaFiscalPresentacion> {
  await deps.autorizar(ventaId);
  const venta = await deps.cargarVenta(ventaId);
  const auditoriaPeriodo = await deps.cargarAuditoriaPeriodo(venta);
  return proyectarDetalleVentaFiscalPresentacion(venta, auditoriaPeriodo);
}

function tituloAsociado(tipo: number): ComprobanteAsociadoFiscalListado["titulo"] | null {
  if ([1, 6, 11].includes(tipo)) return "Factura";
  if ([3, 8, 13].includes(tipo)) return "Nota de crédito";
  if ([2, 7, 12].includes(tipo)) return "Nota de débito";
  return tipo === 15 ? "Recibo" : null;
}

function derivarPresentacionFiscal(venta: DetalleVentaFiscalServidor): {
  receptor: ReceptorFiscalPresentacion | null;
  comprobanteAsociado: ComprobanteAsociadoFiscalListado | null;
} {
  if (venta.afip_version < 2) return { receptor: null, comprobanteAsociado: null };
  if (venta.afip_snapshot === null && venta.afip_snapshot_hash === null) {
    return { receptor: null, comprobanteAsociado: null };
  }
  if (venta.afip_snapshot === null || venta.afip_snapshot_hash === null) {
    throw new Error("La evidencia fiscal del detalle está incompleta.");
  }

  const evidencia = validarSnapshotFiscalPersistido(venta.afip_snapshot);
  if (evidencia.hash !== venta.afip_snapshot_hash || evidencia.venta.id !== venta.id) {
    throw new Error("La evidencia fiscal del detalle es divergente.");
  }
  validarParidadColumnasSnapshotFiscal(venta, evidencia);

  const receptor: ReceptorFiscalPresentacion = {
    razonSocial: evidencia.receptor.razonSocial,
    tipoDocumento: evidencia.receptor.tipoDocumento,
    numeroDocumento: evidencia.receptor.numeroDocumento,
    condicionIva: evidencia.receptor.condicionIva,
    domicilio: evidencia.receptor.domicilio,
  };
  if (evidencia.cbtesAsoc.length === 0) return { receptor, comprobanteAsociado: null };
  const asociado = evidencia.cbtesAsoc[0];
  const info = CBTE_INFO[asociado.tipo];
  const titulo = tituloAsociado(asociado.tipo);
  if (!info || !titulo) throw new Error("El comprobante fiscal asociado no es presentable.");
  return {
    receptor,
    comprobanteAsociado: {
      tipo: asociado.tipo,
      puntoVenta: asociado.puntoVenta,
      numero: asociado.numero,
      cuit: asociado.cuit,
      fecha: asociado.fecha,
      letra: info.letra,
      titulo,
    },
  };
}

function proyectarAuditoriaPeriodo(
  auditoria: AuditoriaPersistidaNotaCreditoPeriodo | null,
): AuditoriaPersistidaNotaCreditoPeriodo | null {
  if (!auditoria) return null;
  const fiscal: AuditoriaPersistidaNotaCreditoPeriodo["fiscal"] =
    auditoria.fiscal.estado === "SNAPSHOT_V3_VALIDADO"
      ? {
          estado: auditoria.fiscal.estado,
          lifecycle: auditoria.fiscal.lifecycle,
          periodoDesde: auditoria.fiscal.periodoDesde,
          periodoHasta: auditoria.fiscal.periodoHasta,
          modalidad: auditoria.fiscal.modalidad,
          motivo: auditoria.fiscal.motivo,
          receptor: {
            razonSocial: auditoria.fiscal.receptor.razonSocial,
            documento: auditoria.fiscal.receptor.documento,
            letra: auditoria.fiscal.receptor.letra,
          },
        }
      : {
          estado: auditoria.fiscal.estado,
          periodoDesde: auditoria.fiscal.periodoDesde,
          periodoHasta: auditoria.fiscal.periodoHasta,
          modalidad: auditoria.fiscal.modalidad,
          motivo: auditoria.fiscal.motivo,
        };
  return {
    fiscal,
    operador: auditoria.operador
      ? { nombre: auditoria.operador.nombre, username: auditoria.operador.username }
      : null,
    evidenciaAutorizacion: auditoria.evidenciaAutorizacion
      ? {
          origen: auditoria.evidenciaAutorizacion.origen,
          confirmadoAt: auditoria.evidenciaAutorizacion.confirmadoAt,
        }
      : null,
    reintegrosIntencion: auditoria.reintegrosIntencion.map((reintegro) => ({
      id: reintegro.id,
      formaPago: reintegro.formaPago,
      monto: reintegro.monto,
      orden: reintegro.orden,
    })),
    movimientosStock: auditoria.movimientosStock.map((movimiento) => ({
      id: movimiento.id,
      productoId: movimiento.productoId,
      etiquetaActual: movimiento.etiquetaActual,
      cantidad: movimiento.cantidad,
      cantidadAnterior: movimiento.cantidadAnterior,
      cantidadNueva: movimiento.cantidadNueva,
      createdAt: movimiento.createdAt,
    })),
    movimientosCuentaCorriente: auditoria.movimientosCuentaCorriente.map((movimiento) => ({
      id: movimiento.id,
      tipo: movimiento.tipo,
      estado: movimiento.estado,
      monto: movimiento.monto,
      descripcion: movimiento.descripcion,
      createdAt: movimiento.createdAt,
    })),
  };
}

/**
 * Única salida del detalle hacia el navegador. La construcción campo por campo
 * evita que una futura columna técnica se filtre por un spread accidental.
 */
export function proyectarDetalleVentaFiscalPresentacion(
  venta: DetalleVentaFiscalServidor,
  auditoriaPeriodo: AuditoriaPersistidaNotaCreditoPeriodo | null,
): DetalleVentaFiscalPresentacion {
  const fiscalPresentacion = derivarPresentacionFiscal(venta);
  return {
    id: venta.id,
    cliente_id: venta.cliente_id,
    sucursal_id: venta.sucursal_id,
    usuario_id: venta.usuario_id,
    numero_comprobante: venta.numero_comprobante,
    tipo_comprobante: venta.tipo_comprobante,
    fecha: venta.fecha,
    created_at: venta.created_at,
    condicion_venta: venta.condicion_venta,
    subtotal_sin_iva: venta.subtotal_sin_iva,
    iva_total: venta.iva_total,
    percepciones: venta.percepciones,
    total: venta.total,
    total_pagado: venta.total_pagado,
    estado: venta.estado,
    estado_pago: venta.estado_pago,
    observaciones: venta.observaciones,
    cae: venta.cae,
    cae_vencimiento: venta.cae_vencimiento,
    afip_estado: venta.afip_estado,
    afip_fase: venta.afip_fase,
    afip_version: venta.afip_version,
    afip_emisor_cuit: venta.afip_emisor_cuit,
    afip_punto_venta: venta.afip_punto_venta,
    afip_cbte_tipo: venta.afip_cbte_tipo,
    afip_numero: venta.afip_numero,
    afip_modo: venta.afip_modo,
    afip_validez: venta.afip_validez,
    afip_fecha_comprobante: venta.afip_fecha_comprobante,
    afip_emitido_at: venta.afip_emitido_at,
    afip_imp_total: venta.afip_imp_total,
    afip_simulado: venta.afip_simulado,
    afip_cbte_asoc_id: venta.afip_cbte_asoc_id,
    periodo_asoc_desde: venta.periodo_asoc_desde,
    periodo_asoc_hasta: venta.periodo_asoc_hasta,
    nc_periodo_modalidad: venta.nc_periodo_modalidad,
    motivo_nota_credito: venta.motivo_nota_credito,
    nc_resolucion: venta.nc_resolucion,
    nc_efectos_aplicados_at: venta.nc_efectos_aplicados_at,
    afip_intentos: venta.afip_intentos,
    cliente: venta.cliente
      ? { razon_social: venta.cliente.razon_social, cuit_dni: venta.cliente.cuit_dni }
      : null,
    sucursal: venta.sucursal
      ? { nombre: venta.sucursal.nombre, telefono: venta.sucursal.telefono }
      : null,
    fiscalPresentacion,
    auditoriaPeriodo: proyectarAuditoriaPeriodo(auditoriaPeriodo),
  };
}
