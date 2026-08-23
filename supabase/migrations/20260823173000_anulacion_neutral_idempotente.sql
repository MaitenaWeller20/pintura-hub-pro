-- La anulación de una venta todavía no emitida no crea una NC: devuelve la
-- misma venta ya cancelada. Esa rama también necesita recordar la clave para
-- recuperar un commit cuya respuesta HTTP se perdió, sin repetir efectos.

ALTER TABLE public.ventas
  ADD COLUMN anulacion_idempotency_key uuid,
  ADD COLUMN anulacion_idempotency_payload_hash text;

ALTER TABLE public.ventas
  ADD CONSTRAINT ventas_anulacion_idempotency_par_check CHECK (
    (anulacion_idempotency_key IS NULL AND anulacion_idempotency_payload_hash IS NULL)
    OR (
      anulacion_idempotency_key IS NOT NULL
      AND anulacion_idempotency_payload_hash ~ '^[0-9a-f]{64}$'
    )
  );

CREATE UNIQUE INDEX uq_ventas_anulacion_idempotency_key
  ON public.ventas(anulacion_idempotency_key)
  WHERE anulacion_idempotency_key IS NOT NULL;

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

    -- Conserva el contrato de reintento de las NC ya existentes.
    SELECT v.* INTO v_existente
      FROM public.ventas AS v
     WHERE v.idempotency_key=p_idempotency_key
     FOR UPDATE;
    IF FOUND THEN
      IF v_existente.usuario_id IS DISTINCT FROM v_uid
         OR v_existente.tipo_comprobante<>'NOTA_CREDITO'
         OR v_existente.afip_cbte_asoc_id IS DISTINCT FROM p_venta_id
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
       AND n.afip_cbte_asoc_id=p_venta_id
       AND n.usuario_id=v_uid
       AND n.idempotency_key IS NULL
       AND n.idempotency_payload_hash IS NULL;
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
  'Anula sólo para perfiles activos. La clave estable recupera tanto una NC total como una cancelación neutral ya confirmada.';
