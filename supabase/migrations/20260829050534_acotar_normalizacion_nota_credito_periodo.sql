-- El wrapper sólo canonicaliza arreglos que caben en el contrato. Los inputs
-- mayores pasan intactos al core para que autentique y los rechace sin una
-- reconstrucción previa. Dentro del límite, jsonb_agg evita concatenaciones
-- sucesivas y WITH ORDINALITY conserva el orden recibido.
CREATE OR REPLACE FUNCTION public.crear_nota_credito_periodo_fiscal(
  p_sucursal_id uuid,
  p_cliente_id uuid,
  p_modalidad public.modalidad_nc_periodo,
  p_periodo_desde date,
  p_periodo_hasta date,
  p_motivo text,
  p_resolucion public.resolucion_nc_periodo,
  p_items jsonb,
  p_reintegros jsonb,
  p_idempotency_key uuid
)
RETURNS TABLE(venta_id uuid,numero text,es_cta_cte boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_items jsonb := p_items;
  v_reintegros jsonb := p_reintegros;
BEGIN
  IF pg_catalog.jsonb_typeof(p_items)='array' THEN
    IF pg_catalog.jsonb_array_length(p_items)<=500 THEN
      SELECT COALESCE(
               pg_catalog.jsonb_agg(n_iva.item ORDER BY e.orden),
               '[]'::jsonb
             )
        INTO v_items
        FROM pg_catalog.jsonb_array_elements(p_items)
             WITH ORDINALITY AS e(item,orden)
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN pg_catalog.jsonb_typeof(e.item)='object'
             AND pg_catalog.jsonb_typeof(e.item->'cantidad')='number' THEN
              CASE
                WHEN (e.item->>'cantidad')::numeric
                     =pg_catalog.round((e.item->>'cantidad')::numeric,2) THEN
                  pg_catalog.jsonb_set(
                    e.item,'{cantidad}',
                    pg_catalog.to_jsonb(
                      pg_catalog.round((e.item->>'cantidad')::numeric,2)
                    ),false
                  )
                ELSE e.item
              END
            ELSE e.item
          END AS item
        ) AS n_cantidad
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN pg_catalog.jsonb_typeof(n_cantidad.item)='object'
             AND pg_catalog.jsonb_typeof(
                   n_cantidad.item->'precio_unitario_sin_iva'
                 )='number' THEN
              CASE
                WHEN (n_cantidad.item->>'precio_unitario_sin_iva')::numeric
                     =pg_catalog.round(
                       (n_cantidad.item->>'precio_unitario_sin_iva')::numeric,2
                     ) THEN
                  pg_catalog.jsonb_set(
                    n_cantidad.item,'{precio_unitario_sin_iva}',
                    pg_catalog.to_jsonb(pg_catalog.round(
                      (n_cantidad.item->>'precio_unitario_sin_iva')::numeric,2
                    )),false
                  )
                ELSE n_cantidad.item
              END
            ELSE n_cantidad.item
          END AS item
        ) AS n_precio
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN pg_catalog.jsonb_typeof(n_precio.item)='object'
             AND pg_catalog.jsonb_typeof(n_precio.item->'iva_porcentaje')='number' THEN
              CASE
                WHEN (n_precio.item->>'iva_porcentaje')::numeric
                     =pg_catalog.round((n_precio.item->>'iva_porcentaje')::numeric,2) THEN
                  pg_catalog.jsonb_set(
                    n_precio.item,'{iva_porcentaje}',
                    pg_catalog.to_jsonb(pg_catalog.round(
                      (n_precio.item->>'iva_porcentaje')::numeric,2
                    )),false
                  )
                ELSE n_precio.item
              END
            ELSE n_precio.item
          END AS item
        ) AS n_iva;
    END IF;
  END IF;

  IF pg_catalog.jsonb_typeof(p_reintegros)='array' THEN
    IF pg_catalog.jsonb_array_length(p_reintegros)<=20 THEN
      SELECT COALESCE(
               pg_catalog.jsonb_agg(n_monto.item ORDER BY e.orden),
               '[]'::jsonb
             )
        INTO v_reintegros
        FROM pg_catalog.jsonb_array_elements(p_reintegros)
             WITH ORDINALITY AS e(item,orden)
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN pg_catalog.jsonb_typeof(e.item)='object'
             AND pg_catalog.jsonb_typeof(e.item->'monto_centavos')='number' THEN
              CASE
                WHEN (e.item->>'monto_centavos')::numeric
                     =pg_catalog.round((e.item->>'monto_centavos')::numeric,0) THEN
                  pg_catalog.jsonb_set(
                    e.item,'{monto_centavos}',
                    pg_catalog.to_jsonb(pg_catalog.round(
                      (e.item->>'monto_centavos')::numeric,0
                    )),false
                  )
                ELSE e.item
              END
            ELSE e.item
          END AS item
        ) AS n_monto;
    END IF;
  END IF;

  RETURN QUERY
  SELECT r.venta_id,r.numero,r.es_cta_cte
    FROM public._crear_nota_credito_periodo_fiscal_core_20260828(
      p_sucursal_id,p_cliente_id,p_modalidad,p_periodo_desde,p_periodo_hasta,
      p_motivo,p_resolucion,v_items,v_reintegros,p_idempotency_key
    ) AS r;
END;
$$;

ALTER FUNCTION public.crear_nota_credito_periodo_fiscal(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.crear_nota_credito_periodo_fiscal(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.crear_nota_credito_periodo_fiscal(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) TO authenticated,service_role;
