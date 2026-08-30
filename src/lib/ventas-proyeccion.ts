import type { Database } from "@/integrations/supabase/types";

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
  "id,cliente_id,sucursal_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,created_at,condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,estado,estado_pago,observaciones,cae,cae_vencimiento,afip_estado,afip_fase,afip_version,afip_snapshot,afip_snapshot_hash,afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,afip_validez,afip_fecha_comprobante,afip_emitido_at,afip_imp_total,afip_simulado,afip_cbte_asoc_id,periodo_asoc_desde,periodo_asoc_hasta,nc_periodo_modalidad,motivo_nota_credito,nc_resolucion,nc_efectos_aplicados_at,afip_error_clase,afip_error_codigo,afip_intentos" as const;

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
  | "afip_error_clase"
  | "afip_error_codigo"
  | "afip_intentos";

export type VentaSeguraOperador = Pick<VentaRow, ColumnaVentaSegura>;
