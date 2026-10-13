-- La representación textual de jsonb conserva la escala de numeric (21 versus
-- 21.0). Se normalizan los escalares antes de entrar al core que calcula la
-- huella, para que la idempotencia represente el negocio y no el spelling JSON.
ALTER FUNCTION public.crear_nota_credito_periodo_fiscal(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) RENAME TO _crear_nota_credito_periodo_fiscal_core_20260828;

REVOKE ALL ON FUNCTION public._crear_nota_credito_periodo_fiscal_core_20260828(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.crear_nota_credito_periodo_fiscal(
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
  v_item jsonb;
  v_numero numeric;
BEGIN
  IF pg_catalog.jsonb_typeof(p_items)='array' THEN
    v_items := '[]'::jsonb;
    FOR v_item IN
      SELECT e.value FROM pg_catalog.jsonb_array_elements(p_items) AS e(value)
    LOOP
      IF pg_catalog.jsonb_typeof(v_item)='object' THEN
        IF pg_catalog.jsonb_typeof(v_item->'cantidad')='number' THEN
          v_numero := (v_item->>'cantidad')::numeric;
          IF v_numero=pg_catalog.round(v_numero,2) THEN
            v_item := pg_catalog.jsonb_set(
              v_item,'{cantidad}',pg_catalog.to_jsonb(pg_catalog.round(v_numero,2)),false
            );
          END IF;
        END IF;
        IF pg_catalog.jsonb_typeof(v_item->'precio_unitario_sin_iva')='number' THEN
          v_numero := (v_item->>'precio_unitario_sin_iva')::numeric;
          IF v_numero=pg_catalog.round(v_numero,2) THEN
            v_item := pg_catalog.jsonb_set(
              v_item,'{precio_unitario_sin_iva}',
              pg_catalog.to_jsonb(pg_catalog.round(v_numero,2)),false
            );
          END IF;
        END IF;
        IF pg_catalog.jsonb_typeof(v_item->'iva_porcentaje')='number' THEN
          v_numero := (v_item->>'iva_porcentaje')::numeric;
          IF v_numero=pg_catalog.round(v_numero,2) THEN
            v_item := pg_catalog.jsonb_set(
              v_item,'{iva_porcentaje}',
              pg_catalog.to_jsonb(pg_catalog.round(v_numero,2)),false
            );
          END IF;
        END IF;
      END IF;
      v_items := v_items||pg_catalog.jsonb_build_array(v_item);
    END LOOP;
  END IF;

  IF pg_catalog.jsonb_typeof(p_reintegros)='array' THEN
    v_reintegros := '[]'::jsonb;
    FOR v_item IN
      SELECT e.value FROM pg_catalog.jsonb_array_elements(p_reintegros) AS e(value)
    LOOP
      IF pg_catalog.jsonb_typeof(v_item)='object'
         AND pg_catalog.jsonb_typeof(v_item->'monto_centavos')='number' THEN
        v_numero := (v_item->>'monto_centavos')::numeric;
        IF v_numero=pg_catalog.round(v_numero,0) THEN
          v_item := pg_catalog.jsonb_set(
            v_item,'{monto_centavos}',
            pg_catalog.to_jsonb(pg_catalog.round(v_numero,0)),false
          );
        END IF;
      END IF;
      v_reintegros := v_reintegros||pg_catalog.jsonb_build_array(v_item);
    END LOOP;
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

COMMENT ON FUNCTION public._crear_nota_credito_periodo_fiscal_core_20260828(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) IS 'Core owner-only: validar, hashear y persistir la intención de NC por período.';

-- El estado pendiente no puede existir como una cabecera vacía, ni siquiera si
-- un rol privilegiado evita RLS. No se exige snapshot: su construcción y la
-- transición fiscal pertenecen a la etapa siguiente.
ALTER TABLE public.ventas
  ADD CONSTRAINT ventas_pendiente_fiscal_nc_periodo_check CHECK (
    estado<>'PENDIENTE_FISCAL'
    OR (
      tipo_comprobante='NOTA_CREDITO'
      AND afip_estado='SIN_FACTURAR'
      AND afip_cbte_asoc_id IS NULL
      AND nc_periodo_modalidad IS NOT NULL
      AND periodo_asoc_desde IS NOT NULL
      AND periodo_asoc_hasta IS NOT NULL
      AND periodo_asoc_desde<=periodo_asoc_hasta
      AND motivo_nota_credito IS NOT NULL
      AND pg_catalog.length(pg_catalog.btrim(motivo_nota_credito))>=5
      AND nc_resolucion IS NOT NULL
      AND nc_periodo_payload_hash~'^[0-9a-f]{64}$'
      AND nc_efectos_aplicados_at IS NULL
      AND subtotal_sin_iva<0
      AND iva_total<=0
      AND total<0
      AND percepciones=0
      AND total_pagado=0
      AND caja_sesion_id IS NULL
      AND condicion_venta=(
        CASE nc_resolucion
          WHEN 'REINTEGRO'::public.resolucion_nc_periodo THEN 'CONTADO'::public.condicion_venta
          WHEN 'SALDO_FAVOR'::public.resolucion_nc_periodo THEN 'CTA_CTE'::public.condicion_venta
        END
      )
    )
  );

-- SECURITY DEFINER ejecuta como owner y conserva el writer acotado. Todos los
-- demás roles deben usar la RPC; service_role no es una vía DML alternativa.
CREATE OR REPLACE FUNCTION public.guard_ventas_nc_periodo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)
    INTO v_owner
    FROM pg_catalog.pg_class AS c
   WHERE c.oid=TG_RELID;

  IF current_user=v_owner THEN
    IF TG_OP='DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.estado='PENDIENTE_FISCAL'
       OR NEW.nc_periodo_modalidad IS NOT NULL
       OR NEW.nc_efectos_aplicados_at IS NOT NULL THEN
      RAISE EXCEPTION 'Las notas de crédito por período sólo se escriben mediante funciones del sistema'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE' THEN
    IF OLD.estado='PENDIENTE_FISCAL'
       OR NEW.estado='PENDIENTE_FISCAL'
       OR OLD.nc_periodo_modalidad IS NOT NULL
       OR NEW.nc_periodo_modalidad IS NOT NULL
       OR OLD.afip_estado='APROBADO'
       OR OLD.nc_efectos_aplicados_at IS NOT NULL THEN
      RAISE EXCEPTION 'La nota de crédito por período o venta aprobada es inmutable fuera de la transición fiscal'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.estado='PENDIENTE_FISCAL'
     OR OLD.nc_periodo_modalidad IS NOT NULL
     OR OLD.afip_estado='APROBADO'
     OR OLD.nc_efectos_aplicados_at IS NOT NULL THEN
    RAISE EXCEPTION 'La nota de crédito por período o venta aprobada no se elimina directamente'
      USING ERRCODE='42501';
  END IF;
  RETURN OLD;
END;
$$;

ALTER FUNCTION public.guard_ventas_nc_periodo() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_ventas_nc_periodo()
  FROM PUBLIC,anon,authenticated,service_role;
