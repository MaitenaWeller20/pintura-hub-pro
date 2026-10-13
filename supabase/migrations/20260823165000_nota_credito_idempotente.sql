-- Recuperación segura de una nota de crédito cuando se pierde la respuesta.
-- La operación comercial existente queda como core owner-only; la envoltura
-- pública liga la clave estable al actor y al comprobante original antes de
-- devolver un replay.

ALTER FUNCTION public.anular_venta(uuid)
  RENAME TO _anular_venta_core_20260823;

REVOKE ALL ON FUNCTION public._anular_venta_core_20260823(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.anular_venta(
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
  v_hash text;
  v_existente public.ventas%ROWTYPE;
  v_nc_id uuid;
  v_nc_numero text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- Autorizar el original antes de consultar una clave global evita usar la
  -- idempotencia como oráculo de comprobantes ajenos.
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
    v_hash := pg_catalog.encode(
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
         OR v_existente.afip_cbte_asoc_id IS DISTINCT FROM p_venta_id
         OR v_existente.idempotency_payload_hash IS NULL
         OR v_existente.idempotency_payload_hash IS DISTINCT FROM v_hash THEN
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

  -- El core también cancela ventas todavía no emitidas devolviendo el original.
  -- Sólo una NC fiscal nueva recibe esta clave de creación.
  IF p_idempotency_key IS NOT NULL AND v_nc_id IS DISTINCT FROM p_venta_id THEN
    UPDATE public.ventas AS n
       SET idempotency_key=p_idempotency_key,
           idempotency_payload_hash=v_hash
     WHERE n.id=v_nc_id
       AND n.tipo_comprobante='NOTA_CREDITO'
       AND n.afip_cbte_asoc_id=p_venta_id
       AND n.usuario_id=v_uid
       AND n.idempotency_key IS NULL
       AND n.idempotency_payload_hash IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No se pudo vincular la huella idempotente a la nota de crédito';
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
  'Anula o crea una NC total. Con clave estable recupera la misma NC sólo para el mismo actor y original.';
COMMENT ON FUNCTION public._anular_venta_core_20260823(uuid) IS
  'Core comercial owner-only; invocar exclusivamente desde anular_venta(uuid,uuid).';
