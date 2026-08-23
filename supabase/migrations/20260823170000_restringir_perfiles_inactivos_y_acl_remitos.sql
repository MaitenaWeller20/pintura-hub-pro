-- Un JWT emitido antes de desactivar un perfil sigue siendo criptográficamente
-- válido. Estas RPC SECURITY DEFINER deben consultar el estado actual del perfil
-- antes de leer o mutar cualquier dato, incluso cuando el usuario conserva admin.

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
  v_hash text;
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
  'Anula o crea una NC total sólo para perfiles activos. Con clave estable recupera la misma NC sólo para el mismo actor y original.';

CREATE OR REPLACE FUNCTION public.aprobar_remito(p_remito_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_remito public.remitos%ROWTYPE;
  v_permite_neg boolean;
  v_item record;
  v_ant_o numeric(14,2);
  v_nue_o numeric(14,2);
  v_ant_d numeric(14,2);
  v_nue_d numeric(14,2);
  v_n_items integer := 0;
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

  SELECT * INTO v_remito
    FROM public.remitos
   WHERE id=p_remito_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Remito inexistente';
  END IF;

  IF NOT (
    public.is_admin(v_uid)
    OR public.current_sucursal_id() IS NOT DISTINCT FROM v_remito.sucursal_destino_id
  ) THEN
    RAISE EXCEPTION 'Sólo la sucursal destino (o un administrador) puede aprobar este remito';
  END IF;
  IF v_remito.estado<>'PENDIENTE' THEN
    RAISE EXCEPTION 'El remito % ya fue procesado (estado %)',v_remito.numero,v_remito.estado;
  END IF;
  IF v_remito.sucursal_origen_id=v_remito.sucursal_destino_id THEN
    RAISE EXCEPTION 'Origen y destino no pueden coincidir';
  END IF;

  SELECT COALESCE(permitir_stock_negativo,false) INTO v_permite_neg
    FROM public.settings WHERE id=true;
  v_permite_neg := COALESCE(v_permite_neg,false);

  FOR v_item IN
    SELECT producto_id,cantidad
      FROM public.remito_items
     WHERE remito_id=p_remito_id
  LOOP
    v_n_items := v_n_items+1;
    IF v_item.cantidad IS NULL OR v_item.cantidad<=0 THEN
      RAISE EXCEPTION 'Cantidad inválida en un ítem del remito %',v_remito.numero;
    END IF;

    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
      VALUES (v_item.producto_id,v_remito.sucursal_origen_id,-v_item.cantidad)
      ON CONFLICT (producto_id,sucursal_id)
      DO UPDATE SET cantidad=stock_sucursal.cantidad-v_item.cantidad
      RETURNING cantidad+v_item.cantidad,cantidad INTO v_ant_o,v_nue_o;
    ELSE
      UPDATE public.stock_sucursal
         SET cantidad=cantidad-v_item.cantidad
       WHERE producto_id=v_item.producto_id
         AND sucursal_id=v_remito.sucursal_origen_id
         AND cantidad>=v_item.cantidad
      RETURNING cantidad+v_item.cantidad,cantidad INTO v_ant_o,v_nue_o;
      IF NOT FOUND THEN
        SELECT COALESCE(cantidad,0) INTO v_ant_o
          FROM public.stock_sucursal
         WHERE producto_id=v_item.producto_id
           AND sucursal_id=v_remito.sucursal_origen_id;
        RAISE EXCEPTION 'Stock insuficiente en origen para el producto %: hay %, se piden %',
          v_item.producto_id,COALESCE(v_ant_o,0),v_item.cantidad;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos(
      producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,
      motivo,referencia_id,usuario_id
    ) VALUES (
      v_item.producto_id,v_remito.sucursal_origen_id,'TRANSFERENCIA_OUT',
      -v_item.cantidad,v_ant_o,v_nue_o,
      'Remito '||v_remito.numero,v_remito.id,v_uid
    );

    INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
    VALUES (v_item.producto_id,v_remito.sucursal_destino_id,v_item.cantidad)
    ON CONFLICT (producto_id,sucursal_id)
    DO UPDATE SET cantidad=stock_sucursal.cantidad+v_item.cantidad
    RETURNING cantidad-v_item.cantidad,cantidad INTO v_ant_d,v_nue_d;

    INSERT INTO public.stock_movimientos(
      producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,
      motivo,referencia_id,usuario_id
    ) VALUES (
      v_item.producto_id,v_remito.sucursal_destino_id,'TRANSFERENCIA_IN',
      v_item.cantidad,v_ant_d,v_nue_d,
      'Remito '||v_remito.numero,v_remito.id,v_uid
    );
  END LOOP;

  IF v_n_items=0 THEN
    RAISE EXCEPTION 'El remito % no tiene ítems',v_remito.numero;
  END IF;

  UPDATE public.remitos
     SET estado='APROBADO',aprobado_por=v_uid,fecha_aprobacion=now()
   WHERE id=p_remito_id;
END;
$$;

REVOKE ALL ON FUNCTION public.aprobar_remito(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.aprobar_remito(uuid)
  TO authenticated,service_role;

COMMENT ON FUNCTION public.aprobar_remito(uuid) IS
  'Aprueba un remito PENDIENTE sólo para perfiles activos de destino o admin y transfiere stock atómicamente.';

CREATE OR REPLACE FUNCTION public.rechazar_remito(
  p_remito_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_remito public.remitos%ROWTYPE;
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

  SELECT * INTO v_remito
    FROM public.remitos
   WHERE id=p_remito_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Remito inexistente';
  END IF;

  IF NOT (
    public.is_admin(v_uid)
    OR public.current_sucursal_id() IS NOT DISTINCT FROM v_remito.sucursal_destino_id
  ) THEN
    RAISE EXCEPTION 'Sólo la sucursal destino (o un administrador) puede rechazar este remito';
  END IF;
  IF v_remito.estado<>'PENDIENTE' THEN
    RAISE EXCEPTION 'El remito % ya fue procesado (estado %)',v_remito.numero,v_remito.estado;
  END IF;

  UPDATE public.remitos
     SET estado='RECHAZADO',aprobado_por=v_uid,fecha_aprobacion=now(),
         motivo_rechazo=p_motivo
   WHERE id=p_remito_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rechazar_remito(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.rechazar_remito(uuid,text)
  TO authenticated,service_role;

COMMENT ON FUNCTION public.rechazar_remito(uuid,text) IS
  'Rechaza un remito PENDIENTE sólo para perfiles activos de destino o admin; no mueve stock.';

-- La ACL anterior conservaba privilegios no usados por PostgREST (TRUNCATE,
-- REFERENCES y TRIGGER). Se reconstruye desde cero para que ambos roles de API
-- tengan una superficie de sólo lectura, protegida además por RLS.
REVOKE ALL PRIVILEGES ON TABLE public.remitos,public.remito_items
  FROM anon,authenticated;
GRANT SELECT ON TABLE public.remitos,public.remito_items
  TO anon,authenticated;
