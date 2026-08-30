import type { Database } from "@/integrations/supabase/types";
import {
  leerComprobanteAsociadoFiscal,
  leerReceptorFiscalCongelado,
  type ComprobanteAsociadoFiscalListado,
  type ReceptorFiscalCongeladoListado,
} from "./ventas-ui";

type VentaRow = Database["public"]["Tables"]["ventas"]["Row"];

/**
 * Datos de una venta que la interfaz de un operador necesita realmente.
 *
 * La lista es deliberadamente explícita: `ventas.afip_error` puede contener
 * diagnósticos históricos de red o base de datos y no debe serializarse al
 * navegador. Los códigos/clases cerrados sí son aptos para decidir el estado
 * visible sin transportar el texto técnico original.
 */
export const COLUMNAS_VENTA_SEGURAS =
  "id,cliente_id,sucursal_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,created_at,condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,estado,estado_pago,observaciones,cae,cae_vencimiento,afip_estado,afip_fase,afip_version,afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,afip_validez,afip_fecha_comprobante,afip_emitido_at,afip_imp_total,afip_simulado,afip_cbte_asoc_id,periodo_asoc_desde,periodo_asoc_hasta,nc_periodo_modalidad,motivo_nota_credito,nc_resolucion,nc_efectos_aplicados_at,afip_error_clase,afip_error_codigo,afip_intentos" as const;

export const COLUMNAS_VENTA_REPORTE =
  "id,numero_comprobante,tipo_comprobante,fecha,subtotal_sin_iva,iva_total,total,total_pagado" as const;

type ColumnaVentaSegura =
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
  | "afip_error_clase"
  | "afip_error_codigo"
  | "afip_intentos";

export type VentaSeguraOperador = Pick<VentaRow, ColumnaVentaSegura>;

export type VentaListadoSeguro = VentaSeguraOperador & {
  cliente: { razon_social: string | null; cuit_dni: string | null } | null;
  sucursal: { nombre: string | null; codigo: string | null; telefono: string | null } | null;
  pagos: Array<{ forma_pago: string; monto: number }>;
  fiscalPresentacion: {
    receptor: ReceptorFiscalCongeladoListado | null;
    comprobanteAsociado: ComprobanteAsociadoFiscalListado | null;
  };
};

type EvidenciaListadoServidor = { id: string; afip_snapshot: unknown };

const columnasVentaSegura = COLUMNAS_VENTA_SEGURAS.split(",") as ColumnaVentaSegura[];

/**
 * Cierra la frontera server-only de la evidencia fiscal. Incluso si un adapter
 * agrega accidentalmente otra propiedad, sólo las columnas allowlisted y las
 * relaciones comerciales explícitas pueden cruzar al navegador.
 */
export function proyectarListadoVentasSeguro(
  ventas: Array<Record<string, unknown>>,
  evidencias: EvidenciaListadoServidor[],
): VentaListadoSeguro[] {
  const evidenciaPorVenta = new Map(evidencias.map((evidencia) => [evidencia.id, evidencia]));
  return ventas.map((venta) => {
    const segura: Record<string, unknown> = {};
    for (const columna of columnasVentaSegura) segura[columna] = venta[columna];
    const evidencia = evidenciaPorVenta.get(String(venta.id));
    return {
      ...(segura as unknown as VentaSeguraOperador),
      cliente: (venta.cliente ?? null) as VentaListadoSeguro["cliente"],
      sucursal: (venta.sucursal ?? null) as VentaListadoSeguro["sucursal"],
      pagos: (Array.isArray(venta.pagos) ? venta.pagos : []) as VentaListadoSeguro["pagos"],
      fiscalPresentacion: {
        receptor: leerReceptorFiscalCongelado(evidencia?.afip_snapshot),
        comprobanteAsociado: leerComprobanteAsociadoFiscal(evidencia?.afip_snapshot),
      },
    };
  });
}
