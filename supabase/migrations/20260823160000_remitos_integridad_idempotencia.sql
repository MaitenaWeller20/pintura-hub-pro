-- Cierra las escrituras directas de remitos y endurece las dos RPC de edición.
--
-- La clave de idempotencia se origina en el navegador y se conserva mientras el
-- diálogo permanece abierto. Si se pierde la respuesta, repetir exactamente la
-- misma solicitud devuelve el remito original sin consumir otro correlativo.

ALTER TABLE public.remitos
  ADD COLUMN IF NOT EXISTS idempotency_key uuid,
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS remitos_idempotency_key_uidx
  ON public.remitos(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.remitos
  DROP CONSTRAINT IF EXISTS remitos_idempotencia_completa_check;
ALTER TABLE public.remitos
  ADD CONSTRAINT remitos_idempotencia_completa_check
  CHECK (
    (idempotency_key IS NULL AND request_fingerprint IS NULL)
    OR (idempotency_key IS NOT NULL AND request_fingerprint ~ '^[0-9a-f]{64}$')
  ) NOT VALID;

-- NOT VALID evita que un dato histórico inesperado bloquee una migración
-- manual. PostgreSQL sí aplica el CHECK a toda fila nueva/modificada.
ALTER TABLE public.remito_items
  DROP CONSTRAINT IF EXISTS remito_items_cantidad_valida_check;
ALTER TABLE public.remito_items
  ADD CONSTRAINT remito_items_cantidad_valida_check
  CHECK (
    cantidad >= 0.01
    AND cantidad <= 999999999999.99
    AND cantidad = pg_catalog.round(cantidad,2)
  ) NOT VALID;

-- El correlativo tiene cuatro dígitos como mínimo, no como máximo. lpad(text,4)
-- truncaba 10000 a 1000.
CREATE OR REPLACE FUNCTION public.next_comprobante_numero(
  _sucursal_id uuid,
  _tipo public.tipo_comprobante
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  _next integer;
  _prefix_suc text;
  _prefix_tipo text;
BEGIN
  INSERT INTO public.comprobante_secuencias AS cs(sucursal_id,tipo,ultimo_numero)
  VALUES (_sucursal_id,_tipo,1)
  ON CONFLICT (sucursal_id,tipo)
  DO UPDATE SET ultimo_numero=cs.ultimo_numero+1
  RETURNING ultimo_numero INTO _next;

  SELECT CASE s.codigo
           WHEN 'OHIGGINS' THEN 'OHI'
           WHEN 'GENERALPAZ' THEN 'GPZ'
         END
    INTO _prefix_suc
    FROM public.sucursales AS s
   WHERE s.id=_sucursal_id;

  _prefix_tipo := CASE _tipo
    WHEN 'VENTA' THEN 'VTA'
    WHEN 'FACTURA_A' THEN 'FAIV'
    WHEN 'FACTURA_B' THEN 'FVTA'
    WHEN 'FACTURA_C' THEN 'FCIV'
    WHEN 'NOTA_CREDITO' THEN 'NCIV'
    WHEN 'NOTA_DEBITO' THEN 'NDIV'
    WHEN 'REMITO' THEN 'REM'
    WHEN 'REMITO_OBRA' THEN 'ROBR'
    WHEN 'FAC_INTERNA_CTA_CTE' THEN 'FICC'
  END;

  IF _prefix_suc IS NULL OR _prefix_tipo IS NULL THEN
    RAISE EXCEPTION 'No hay prefijo de numeración para (sucursal %, tipo %)',
      _sucursal_id,_tipo;
  END IF;

  RETURN _prefix_suc||'-'||_prefix_tipo||'-'||pg_catalog.lpad(
    _next::text,
    CASE
      WHEN pg_catalog.char_length(_next::text)<4 THEN 4
      ELSE pg_catalog.char_length(_next::text)
    END,
    '0'
  );
END;
$$;

-- Los JWT de usuario no pueden reservar números por fuera de una operación.
-- service_role conserva temporalmente el acceso porque el emisor fiscal legacy
-- todavía corrige la letra mediante este helper. Es un rol exclusivo del
-- backend y se retira junto con ese escritor en el gate post-deployment.
REVOKE ALL ON FUNCTION public.next_comprobante_numero(uuid,public.tipo_comprobante)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.next_comprobante_numero(uuid,public.tipo_comprobante)
  TO service_role;

-- La firma sin idempotencia no puede coexistir: una sobrecarga permitiría
-- saltear el contrato nuevo y además vuelve ambiguo a PostgREST.
REVOKE ALL ON FUNCTION public.crear_remito(uuid,uuid,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
DROP FUNCTION public.crear_remito(uuid,uuid,text,jsonb);

CREATE FUNCTION public.crear_remito(
  p_sucursal_origen_id uuid,
  p_sucursal_destino_id uuid,
  p_observaciones text,
  p_items jsonb,
  p_idempotency_key uuid
)
RETURNS TABLE(remito_id uuid,numero text)
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
  v_observaciones text := NULLIF(pg_catalog.btrim(p_observaciones),'');
  v_items_canonicos jsonb;
  v_fingerprint text;
  v_existente_uid uuid;
  v_existente_fingerprint text;
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
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Falta la clave de idempotencia';
  END IF;

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
        OR pg_catalog.jsonb_typeof(e.item->'producto_id')<>'string'
        OR pg_catalog.jsonb_typeof(e.item->'cantidad')<>'number'
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.jsonb_object_keys(e.item) AS k(clave)
           WHERE k.clave<>ALL(ARRAY['producto_id','cantidad'])
        )
  ) THEN
    RAISE EXCEPTION 'Cada ítem debe contener únicamente producto_id UUID y cantidad numérica';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_to_recordset(p_items) AS i(producto_id uuid,cantidad numeric)
     WHERE i.producto_id IS NULL
        OR i.cantidad IS NULL
        OR i.cantidad<0.01
        OR i.cantidad>999999999999.99
        OR i.cantidad<>pg_catalog.round(i.cantidad,2)
  ) THEN
    RAISE EXCEPTION 'Las cantidades deben ser positivas, admitir hasta dos decimales y caber en numeric(14,2)';
  END IF;

  IF (
    SELECT pg_catalog.count(*)<>pg_catalog.count(DISTINCT i.producto_id)
      FROM pg_catalog.jsonb_to_recordset(p_items) AS i(producto_id uuid,cantidad numeric)
  ) THEN
    RAISE EXCEPTION 'Un producto no puede repetirse en el mismo remito';
  END IF;

  SELECT pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'producto_id',i.producto_id::text,
             'cantidad',pg_catalog.round(i.cantidad,2)
           ) ORDER BY i.producto_id
         )
    INTO v_items_canonicos
    FROM pg_catalog.jsonb_to_recordset(p_items) AS i(producto_id uuid,cantidad numeric);

  v_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'sucursal_origen_id',p_sucursal_origen_id::text,
          'sucursal_destino_id',p_sucursal_destino_id::text,
          'observaciones',v_observaciones,
          'items',v_items_canonicos
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

  SELECT r.id,r.numero,r.creado_por,r.request_fingerprint
    INTO v_remito_id,v_numero,v_existente_uid,v_existente_fingerprint
    FROM public.remitos AS r
   WHERE r.idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existente_uid IS DISTINCT FROM v_uid
       OR v_existente_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'La clave de idempotencia ya fue utilizada con otra solicitud';
    END IF;
    RETURN QUERY SELECT v_remito_id,v_numero;
    RETURN;
  END IF;

  PERFORM 1 FROM public.sucursales AS s
   WHERE s.id=p_sucursal_origen_id AND s.activa;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sucursal de origen no existe o está inactiva';
  END IF;
  PERFORM 1 FROM public.sucursales AS s
   WHERE s.id=p_sucursal_destino_id AND s.activa;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sucursal de destino no existe o está inactiva';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_to_recordset(p_items) AS i(producto_id uuid,cantidad numeric)
      LEFT JOIN public.productos AS p ON p.id=i.producto_id
     WHERE p.id IS NULL
        OR p.archivado
        OR (
          p.activo IS DISTINCT FROM true
          AND NOT EXISTS (
            SELECT 1
              FROM public.stock_sucursal AS ss
             WHERE ss.producto_id=i.producto_id
               AND ss.sucursal_id=p_sucursal_origen_id
               AND ss.cantidad>0
          )
        )
  ) THEN
    RAISE EXCEPTION 'El remito contiene productos inexistentes, archivados o inactivos sin stock en origen';
  END IF;

  v_numero := public.next_comprobante_numero(p_sucursal_origen_id,'REMITO');
  INSERT INTO public.remitos(
    numero,sucursal_origen_id,sucursal_destino_id,observaciones,creado_por,
    idempotency_key,request_fingerprint
  ) VALUES (
    v_numero,p_sucursal_origen_id,p_sucursal_destino_id,v_observaciones,v_uid,
    p_idempotency_key,v_fingerprint
  )
  RETURNING id INTO v_remito_id;

  INSERT INTO public.remito_items(remito_id,producto_id,cantidad)
  SELECT v_remito_id,i.producto_id,i.cantidad
    FROM pg_catalog.jsonb_to_recordset(p_items) AS i(producto_id uuid,cantidad numeric);

  RETURN QUERY SELECT v_remito_id,v_numero;
END;
$$;

REVOKE ALL ON FUNCTION public.crear_remito(uuid,uuid,text,jsonb,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.crear_remito(uuid,uuid,text,jsonb,uuid)
  TO authenticated;

COMMENT ON FUNCTION public.crear_remito(uuid,uuid,text,jsonb,uuid) IS
  'Crea un remito PENDIENTE de forma atómica e idempotente. Sólo origen o admin; el correlativo no queda expuesto a JWT de usuario.';

-- La edición también debe respetar el mismo dominio de ítems porque ya no hay
-- ninguna ruta directa alternativa.
CREATE OR REPLACE FUNCTION public.editar_remito(
  p_remito_id uuid,
  p_sucursal_destino_id uuid,
  p_observaciones text,
  p_items jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sucursal_actual uuid;
  v_perfil_activo boolean;
  v_es_admin boolean;
  v_remito public.remitos%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

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

  SELECT * INTO v_remito
    FROM public.remitos
   WHERE id=p_remito_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Remito inexistente'; END IF;
  IF v_remito.estado<>'PENDIENTE' THEN
    RAISE EXCEPTION 'El remito % ya fue procesado (estado %)',v_remito.numero,v_remito.estado;
  END IF;
  IF NOT v_es_admin AND (
    v_sucursal_actual IS DISTINCT FROM v_remito.sucursal_origen_id
    OR NOT EXISTS (
      SELECT 1 FROM public.profile_sucursales AS ps
       WHERE ps.profile_id=v_uid AND ps.sucursal_id=v_remito.sucursal_origen_id
    )
  ) THEN
    RAISE EXCEPTION 'Sólo la sucursal de origen (o un administrador) puede editar este remito';
  END IF;

  IF p_sucursal_destino_id IS NULL THEN RAISE EXCEPTION 'La sucursal de destino es obligatoria'; END IF;
  IF p_sucursal_destino_id=v_remito.sucursal_origen_id THEN RAISE EXCEPTION 'Origen y destino deben ser distintos'; END IF;
  PERFORM 1 FROM public.sucursales AS s WHERE s.id=p_sucursal_destino_id AND s.activa;
  IF NOT FOUND THEN RAISE EXCEPTION 'La sucursal de destino no existe o está inactiva'; END IF;
  IF p_observaciones IS NOT NULL AND pg_catalog.char_length(p_observaciones)>2000 THEN
    RAISE EXCEPTION 'Las observaciones no pueden superar 2000 caracteres';
  END IF;
  IF p_items IS NULL OR pg_catalog.jsonb_typeof(p_items)<>'array' OR pg_catalog.jsonb_array_length(p_items)=0 THEN
    RAISE EXCEPTION 'El remito debe tener al menos un producto';
  END IF;
  IF pg_catalog.jsonb_array_length(p_items)>500 THEN RAISE EXCEPTION 'El remito no puede tener más de 500 productos'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_items) AS e(item)
     WHERE pg_catalog.jsonb_typeof(e.item)<>'object'
        OR NOT (e.item ?& ARRAY['producto_id','cantidad'])
        OR pg_catalog.jsonb_typeof(e.item->'producto_id')<>'string'
        OR pg_catalog.jsonb_typeof(e.item->'cantidad')<>'number'
        OR EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_object_keys(e.item) AS k(clave)
           WHERE k.clave<>ALL(ARRAY['producto_id','cantidad'])
        )
  ) THEN
    RAISE EXCEPTION 'Cada ítem debe contener únicamente producto_id UUID y cantidad numérica';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(p_items) AS i(producto_id uuid,cantidad numeric)
     WHERE i.producto_id IS NULL OR i.cantidad IS NULL OR i.cantidad<0.01
        OR i.cantidad>999999999999.99 OR i.cantidad<>pg_catalog.round(i.cantidad,2)
  ) THEN
    RAISE EXCEPTION 'Las cantidades deben ser positivas, admitir hasta dos decimales y caber en numeric(14,2)';
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
     WHERE p.id IS NULL OR p.archivado
        OR (
          p.activo IS DISTINCT FROM true
          AND NOT EXISTS (
            SELECT 1 FROM public.stock_sucursal AS ss
             WHERE ss.producto_id=i.producto_id
               AND ss.sucursal_id=v_remito.sucursal_origen_id
               AND ss.cantidad>0
          )
        )
  ) THEN
    RAISE EXCEPTION 'El remito contiene productos inexistentes, archivados o inactivos sin stock en origen';
  END IF;

  UPDATE public.remitos
     SET sucursal_destino_id=p_sucursal_destino_id,
         observaciones=NULLIF(pg_catalog.btrim(p_observaciones),'')
   WHERE id=p_remito_id;
  DELETE FROM public.remito_items WHERE remito_id=p_remito_id;
  INSERT INTO public.remito_items(remito_id,producto_id,cantidad)
  SELECT p_remito_id,i.producto_id,i.cantidad
    FROM pg_catalog.jsonb_to_recordset(p_items) AS i(producto_id uuid,cantidad numeric);
END;
$$;

REVOKE ALL ON FUNCTION public.editar_remito(uuid,uuid,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.editar_remito(uuid,uuid,text,jsonb)
  TO authenticated,service_role;

-- Desde este punto toda escritura de usuario pasa por crear/editar/aprobar/
-- rechazar. service_role conserva su acceso de backend y SELECT sigue igual.
REVOKE INSERT,UPDATE,DELETE ON TABLE public.remitos FROM authenticated;
REVOKE INSERT,UPDATE,DELETE ON TABLE public.remito_items FROM authenticated;
DROP POLICY IF EXISTS "remitos insert" ON public.remitos;
DROP POLICY IF EXISTS "remitos update admin" ON public.remitos;
DROP POLICY IF EXISTS "ri insert" ON public.remito_items;

COMMENT ON COLUMN public.remitos.idempotency_key IS
  'Clave estable del intento de alta; la genera el cliente y se reutiliza tras una respuesta perdida.';
COMMENT ON COLUMN public.remitos.request_fingerprint IS
  'SHA-256 canónico de origen, destino, observaciones e ítems; impide reutilizar una clave con otro payload.';
