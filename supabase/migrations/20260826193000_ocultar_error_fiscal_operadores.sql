-- `afip_error` conserva diagnósticos técnicos para investigación interna. RLS
-- limita qué filas puede ver un operador, pero no qué columnas puede pedir por
-- PostgREST. Se reemplaza por permisos columnares: la aplicación mantiene toda
-- su lectura operativa y únicamente el texto técnico queda del lado servidor.

REVOKE SELECT ON TABLE public.ventas FROM authenticated;

GRANT SELECT (
  afip_cbte_asoc_id,
  afip_cbte_tipo,
  afip_claim_token,
  afip_claimed_at,
  afip_emisor_cuit,
  afip_emitido_at,
  afip_error_clase,
  afip_error_codigo,
  afip_error_fase,
  afip_estado,
  afip_fase,
  afip_fecha_comprobante,
  afip_imp_total,
  afip_intentos,
  afip_legacy_incompleto,
  afip_modo,
  afip_numero,
  afip_punto_venta,
  afip_simulado,
  afip_snapshot,
  afip_snapshot_hash,
  afip_ultimo_error_at,
  afip_validez,
  afip_version,
  anulacion_idempotency_key,
  anulacion_idempotency_payload_hash,
  cae,
  cae_vencimiento,
  caja_sesion_id,
  cliente_id,
  condicion_venta,
  created_at,
  estado,
  estado_pago,
  fecha,
  id,
  idempotency_key,
  idempotency_payload_hash,
  iva_total,
  nombre_obra,
  numero_comprobante,
  observaciones,
  percepciones,
  subtotal_sin_iva,
  sucursal_id,
  tipo_comprobante,
  total,
  total_pagado,
  updated_at,
  usuario_id,
  venta_anulada_por
) ON TABLE public.ventas TO authenticated;

COMMENT ON COLUMN public.ventas.afip_error IS
  'Diagnóstico técnico fiscal reservado al backend/service_role; nunca se expone a operadores.';
