-- Alta atómica de remitos internos.
--
-- next_comprobante_numero es deliberadamente owner-only: permitir que un JWT
-- autenticado lo invoque directamente dejaría quemar secuencias de cualquier
-- sucursal. Esta RPC exterior valida usuario, sucursal e ítems y recién entonces
-- reserva el número y crea encabezado + detalle dentro de la misma transacción.
CREATE OR REPLACE FUNCTION public.crear_remito(
  p_sucursal_origen_id uuid,
  p_sucursal_destino_id uuid,
  p_observaciones text,
  p_items jsonb
)
RETURNS TABLE(remito_id uuid, numero text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sucursal_actual uuid;
  v_perfil_activo boolean;
  v_es_admin boolean;
  v_remito_id uuid;
  v_numero text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT p.sucursal_id,p.activo
    INTO v_sucursal_actual,v_perfil_activo
    FROM public.profiles AS p
   WHERE p.id=v_uid;

  IF NOT FOUND OR v_perfil_activo IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'El perfil autenticado no existe o está inactivo';
  END IF;

  SELECT COALESCE(pg_catalog.bool_or(ur.role='admin'::public.app_role),false)
    INTO v_es_admin
    FROM public.user_roles AS ur
   WHERE ur.user_id=v_uid;

  IF p_sucursal_origen_id IS NULL THEN
    RAISE EXCEPTION 'La sucursal de origen es obligatoria';
  END IF;
  IF p_sucursal_destino_id IS NULL THEN
    RAISE EXCEPTION 'La sucursal de destino es obligatoria';
  END IF;
  IF p_sucursal_origen_id=p_sucursal_destino_id THEN
    RAISE EXCEPTION 'Origen y destino deben ser distintos';
  END IF;

  PERFORM 1
    FROM public.sucursales AS s
   WHERE s.id=p_sucursal_origen_id AND s.activa;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sucursal de origen no existe o está inactiva';
  END IF;

  PERFORM 1
    FROM public.sucursales AS s
   WHERE s.id=p_sucursal_destino_id AND s.activa;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sucursal de destino no existe o está inactiva';
  END IF;

  -- Un empleado sólo puede despachar desde la sucursal en la que trabaja y
  -- que además tiene asignada. El administrador conserva el override operativo.
  IF NOT v_es_admin AND (
    v_sucursal_actual IS DISTINCT FROM p_sucursal_origen_id
    OR NOT EXISTS (
      SELECT 1
        FROM public.profile_sucursales AS ps
       WHERE ps.profile_id=v_uid
         AND ps.sucursal_id=p_sucursal_origen_id
    )
  ) THEN
    RAISE EXCEPTION 'Sólo la sucursal de origen (o un administrador) puede crear este remito';
  END IF;

  IF p_observaciones IS NOT NULL
     AND pg_catalog.char_length(p_observaciones)>2000 THEN
    RAISE EXCEPTION 'Las observaciones no pueden superar 2000 caracteres';
  END IF;

  IF p_items IS NULL
     OR pg_catalog.jsonb_typeof(p_items)<>'array'
     OR pg_catalog.jsonb_array_length(p_items)=0 THEN
    RAISE EXCEPTION 'El remito debe tener al menos un producto';
  END IF;
  IF pg_catalog.jsonb_array_length(p_items)>500 THEN
    RAISE EXCEPTION 'El remito no puede tener más de 500 productos';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_items) AS e(item)
     WHERE pg_catalog.jsonb_typeof(e.item)<>'object'
        OR NOT (e.item ?& ARRAY['producto_id','cantidad'])
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.jsonb_object_keys(e.item) AS k(clave)
           WHERE k.clave<>ALL(ARRAY['producto_id','cantidad'])
        )
  ) THEN
    RAISE EXCEPTION 'Cada ítem debe contener únicamente producto_id y cantidad';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_to_recordset(p_items) AS i(producto_id uuid,cantidad numeric)
     WHERE i.producto_id IS NULL OR i.cantidad IS NULL OR i.cantidad<=0
  ) THEN
    RAISE EXCEPTION 'Todos los productos y cantidades del remito deben ser válidos';
  END IF;

  IF (
    SELECT pg_catalog.count(*)<>pg_catalog.count(DISTINCT i.producto_id)
      FROM pg_catalog.jsonb_to_recordset(p_items) AS i(producto_id uuid,cantidad numeric)
  ) THEN
    RAISE EXCEPTION 'Un producto no puede repetirse en el mismo remito';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_to_recordset(p_items) AS i(producto_id uuid,cantidad numeric)
      LEFT JOIN public.productos AS p ON p.id=i.producto_id
     WHERE p.id IS NULL OR NOT p.activo OR p.archivado
  ) THEN
    RAISE EXCEPTION 'El remito contiene productos inexistentes o inactivos';
  END IF;

  v_numero := public.next_comprobante_numero(p_sucursal_origen_id,'REMITO');

  INSERT INTO public.remitos(
    numero,sucursal_origen_id,sucursal_destino_id,observaciones,creado_por
  ) VALUES (
    v_numero,p_sucursal_origen_id,p_sucursal_destino_id,
    NULLIF(pg_catalog.btrim(p_observaciones),''),v_uid
  )
  RETURNING id INTO v_remito_id;

  INSERT INTO public.remito_items(remito_id,producto_id,cantidad)
  SELECT v_remito_id,i.producto_id,i.cantidad
    FROM pg_catalog.jsonb_to_recordset(p_items) AS i(producto_id uuid,cantidad numeric);

  RETURN QUERY SELECT v_remito_id,v_numero;
END;
$$;

REVOKE ALL ON FUNCTION public.crear_remito(uuid,uuid,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.crear_remito(uuid,uuid,text,jsonb)
  TO authenticated;

COMMENT ON FUNCTION public.crear_remito(uuid,uuid,text,jsonb) IS
  'Crea encabezado e ítems de un remito PENDIENTE en una transacción. Sólo origen o admin; la numeración permanece owner-only.';
