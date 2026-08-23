-- Lectura fiscal autoritativa de una venta persistida.
--
-- Los NUMERIC se serializan dentro de PostgreSQL: ningún importe, cantidad,
-- porcentaje o precio atraviesa el adaptador PostgREST como number/float antes
-- de formar el Snapshot fiscal v2.
CREATE OR REPLACE FUNCTION public.leer_venta_fiscal_exacta(p_venta_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_resultado jsonb;
BEGIN
  SELECT pg_catalog.jsonb_build_object(
    'venta',pg_catalog.jsonb_build_object(
      'id',v.id,
      'sucursalId',v.sucursal_id,
      'clienteId',v.cliente_id,
      'fechaComercial',pg_catalog.to_char(
        v.fecha AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'numeroComercial',v.numero_comprobante,
      'tipoComprobante',v.tipo_comprobante::text,
      'condicionVenta',v.condicion_venta::text,
      'estado',v.estado::text,
      'subtotalSinIva',pg_catalog.to_char(
        pg_catalog.abs(v.subtotal_sin_iva),'FM999999999999990.00'
      ),
      'ivaTotal',pg_catalog.to_char(
        pg_catalog.abs(v.iva_total),'FM999999999999990.00'
      ),
      'percepciones',pg_catalog.to_char(
        pg_catalog.abs(v.percepciones),'FM999999999999990.00'
      ),
      'total',pg_catalog.to_char(
        pg_catalog.abs(v.total),'FM999999999999990.00'
      ),
      'totalPagado',pg_catalog.to_char(
        pg_catalog.abs(v.total_pagado),'FM999999999999990.00'
      ),
      'saldo',pg_catalog.to_char(
        GREATEST(
          pg_catalog.abs(v.total)-pg_catalog.abs(v.total_pagado),0::numeric
        ),
        'FM999999999999990.00'
      ),
      'afipEstado',v.afip_estado,
      'afipFase',v.afip_fase,
      'afipClaimToken',v.afip_claim_token,
      'afipNumero',v.afip_numero,
      'afipVersion',v.afip_version,
      'afipEmisorCuit',v.afip_emisor_cuit,
      'afipPuntoVenta',v.afip_punto_venta,
      'afipCbteTipo',v.afip_cbte_tipo,
      'afipModo',v.afip_modo,
      'afipSimulado',v.afip_simulado,
      'afipValidez',v.afip_validez,
      'afipFechaComprobante',v.afip_fecha_comprobante,
      'afipImpTotal',CASE WHEN v.afip_imp_total IS NULL THEN NULL ELSE
        pg_catalog.to_char(
          pg_catalog.abs(v.afip_imp_total),'FM999999999999990.00'
        )
      END,
      'afipSnapshot',v.afip_snapshot,
      'afipSnapshotHash',v.afip_snapshot_hash,
      'afipCbteAsocId',v.afip_cbte_asoc_id,
      'cae',v.cae,
      'caeVencimiento',v.cae_vencimiento
    ),
    'items',COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id',i.id,
          'productoId',i.producto_id,
          'codigo',i.codigo,
          'descripcion',i.descripcion,
          'cantidad',pg_catalog.to_char(
            pg_catalog.abs(i.cantidad),'FM999999999999990.00'
          ),
          'precioUnitarioSinIva',pg_catalog.to_char(
            pg_catalog.abs(i.precio_unitario_sin_iva),'FM999999999999990.00'
          ),
          'descuentoPorcentaje',pg_catalog.to_char(
            i.descuento_porcentaje,'FM990.00'
          ),
          'ivaPorcentaje',pg_catalog.to_char(i.iva_porcentaje,'FM990.00'),
          'subtotalNeto',pg_catalog.to_char(
            pg_catalog.abs(i.subtotal_sin_iva),'FM999999999999990.00'
          ),
          'importeIva',pg_catalog.to_char(
            pg_catalog.abs(i.iva_monto),'FM999999999999990.00'
          ),
          'subtotalTotal',pg_catalog.to_char(
            pg_catalog.abs(i.subtotal_con_iva),'FM999999999999990.00'
          )
        ) ORDER BY i.id
      )
      FROM public.venta_items AS i
      WHERE i.venta_id=v.id
    ),'[]'::jsonb)
  )
  INTO v_resultado
  FROM public.ventas AS v
  WHERE v.id=p_venta_id;

  IF v_resultado IS NULL THEN
    RAISE EXCEPTION 'Venta fiscal inexistente: %',p_venta_id;
  END IF;
  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION public.leer_venta_fiscal_exacta(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.leer_venta_fiscal_exacta(uuid)
  TO service_role;

-- SECURITY INVOKER: se documentan explícitamente las lecturas que necesita la
-- firma. No se amplían privilegios de anon/authenticated ni se altera RLS.
GRANT SELECT ON TABLE public.ventas,public.venta_items TO service_role;
