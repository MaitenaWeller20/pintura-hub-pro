-- La anulación idempotente distinguía solamente dos resultados:
--   1. cancelación neutral (devuelve la venta original), o
--   2. NC fiscal enlazada por afip_cbte_asoc_id.
-- Las facturas internas históricas crean una tercera variante válida: una NC
-- comercial NO_APLICA enlazada desde ventas.venta_anulada_por. La transacción
-- llegaba a crearla, pero el wrapper no reconocía esa relación y hacía rollback.

CREATE OR REPLACE FUNCTION public.anular_venta(
  p_venta_id uuid,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS TABLE(nc_id uuid,nc_numero text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sucursal_id uuid;
  v_hash_nc text;
  v_hash_neutral text;
  v_existente public.ventas%ROWTYPE;
  v_nc_id uuid;
  v_nc_numero text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  PERFORM 1
    FROM public.profiles AS p
   WHERE p.id=v_uid
     AND p.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El perfil autenticado no existe o está inactivo';
  END IF;

  -- El original se autoriza antes de consultar una clave global: la
  -- idempotencia nunca funciona como oráculo de comprobantes ajenos.
  SELECT v.sucursal_id
    INTO v_sucursal_id
    FROM public.ventas AS v
   WHERE v.id=p_venta_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;
  IF NOT public.is_admin(v_uid)
     AND v_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés anular una venta de otra sucursal';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_hash_nc := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'version',1,
            'operacion','NOTA_CREDITO_TOTAL_V2',
            'actor_id',v_uid,
            'venta_original_id',p_venta_id,
            'idempotency_key',p_idempotency_key
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );
    v_hash_neutral := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'version',1,
            'operacion','CANCELACION_NEUTRAL_V2',
            'actor_id',v_uid,
            'venta_original_id',p_venta_id,
            'idempotency_key',p_idempotency_key
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_idempotency_key::text,0)
    );

    SELECT v.* INTO v_existente
      FROM public.ventas AS v
     WHERE v.idempotency_key=p_idempotency_key
     FOR UPDATE;
    IF FOUND THEN
      IF v_existente.usuario_id IS DISTINCT FROM v_uid
         OR v_existente.tipo_comprobante<>'NOTA_CREDITO'
         OR NOT COALESCE(
           v_existente.afip_cbte_asoc_id=p_venta_id
           OR (
             v_existente.afip_cbte_asoc_id IS NULL
             AND v_existente.afip_estado='NO_APLICA'
             AND EXISTS (
               SELECT 1
                 FROM public.ventas AS o
                WHERE o.id=p_venta_id
                  AND o.estado='ANULADA'
                  AND o.venta_anulada_por=v_existente.id
             )
           ),
           false
         )
         OR v_existente.idempotency_payload_hash IS NULL
         OR v_existente.idempotency_payload_hash IS DISTINCT FROM v_hash_nc THEN
        RAISE EXCEPTION 'La clave de idempotencia no corresponde a esta operación';
      END IF;
      RETURN QUERY SELECT v_existente.id,v_existente.numero_comprobante;
      RETURN;
    END IF;

    SELECT v.* INTO v_existente
      FROM public.ventas AS v
     WHERE v.anulacion_idempotency_key=p_idempotency_key
     FOR UPDATE;
    IF FOUND THEN
      IF v_existente.id IS DISTINCT FROM p_venta_id
         OR v_existente.estado<>'ANULADA'
         OR v_existente.afip_estado<>'CANCELADO'
         OR v_existente.venta_anulada_por IS NOT NULL
         OR v_existente.anulacion_idempotency_payload_hash IS NULL
         OR v_existente.anulacion_idempotency_payload_hash IS DISTINCT FROM v_hash_neutral THEN
        RAISE EXCEPTION 'La clave de idempotencia no corresponde a esta operación';
      END IF;
      RETURN QUERY SELECT v_existente.id,v_existente.numero_comprobante;
      RETURN;
    END IF;
  END IF;

  SELECT r.nc_id,r.nc_numero
    INTO v_nc_id,v_nc_numero
    FROM public._anular_venta_core_20260823(p_venta_id) AS r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La anulación no devolvió resultado';
  END IF;

  IF p_idempotency_key IS NOT NULL AND v_nc_id IS DISTINCT FROM p_venta_id THEN
    UPDATE public.ventas AS n
       SET idempotency_key=p_idempotency_key,
           idempotency_payload_hash=v_hash_nc
     WHERE n.id=v_nc_id
       AND n.tipo_comprobante='NOTA_CREDITO'
       AND n.usuario_id=v_uid
       AND n.idempotency_key IS NULL
       AND n.idempotency_payload_hash IS NULL
       AND (
         n.afip_cbte_asoc_id=p_venta_id
         OR (
           n.afip_cbte_asoc_id IS NULL
           AND n.afip_estado='NO_APLICA'
           AND EXISTS (
             SELECT 1
               FROM public.ventas AS o
              WHERE o.id=p_venta_id
                AND o.estado='ANULADA'
                AND o.venta_anulada_por=n.id
           )
         )
       );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No se pudo vincular la huella idempotente a la nota de crédito';
    END IF;
  ELSIF p_idempotency_key IS NOT NULL THEN
    UPDATE public.ventas AS v
       SET anulacion_idempotency_key=p_idempotency_key,
           anulacion_idempotency_payload_hash=v_hash_neutral
     WHERE v.id=p_venta_id
       AND v.estado='ANULADA'
       AND v.afip_estado='CANCELADO'
       AND v.venta_anulada_por IS NULL
       AND v.anulacion_idempotency_key IS NULL
       AND v.anulacion_idempotency_payload_hash IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No se pudo vincular la huella idempotente a la cancelación neutral';
    END IF;
  END IF;

  RETURN QUERY SELECT v_nc_id,v_nc_numero;
END;
$$;

REVOKE ALL ON FUNCTION public.anular_venta(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid,uuid)
  TO authenticated,service_role;

COMMENT ON FUNCTION public.anular_venta(uuid,uuid) IS
  'Anulación idempotente para cancelación neutral, NC fiscal o NC comercial interna enlazada por venta_anulada_por.';
