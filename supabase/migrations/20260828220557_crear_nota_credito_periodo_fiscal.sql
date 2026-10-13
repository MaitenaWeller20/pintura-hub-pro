-- Una NC por período nace como intención fiscal. No debe abrir una caja por el
-- mero INSERT de la cabecera; los demás consumidores del trigger conservan la
-- apertura automática vigente.
CREATE OR REPLACE FUNCTION public.estampar_caja_sesion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
BEGIN
  IF TG_TABLE_SCHEMA='public'
     AND TG_TABLE_NAME='ventas'
     AND pg_catalog.to_jsonb(NEW)->>'estado'='PENDIENTE_FISCAL' THEN
    RETURN NEW;
  END IF;

  IF NEW.caja_sesion_id IS NULL THEN
    NEW.caja_sesion_id := public.caja_sesion_actual(NEW.sucursal_id);
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.estampar_caja_sesion() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.estampar_caja_sesion()
  FROM PUBLIC,anon,authenticated,service_role;

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
  v_uid uuid := auth.uid();
  v_perfil public.profiles%ROWTYPE;
  v_es_admin boolean;
  v_settings public.settings%ROWTYPE;
  v_cliente public.clientes%ROWTYPE;
  v_emisor_condicion text;
  v_receptor_condicion text;
  v_fecha_fiscal date := (pg_catalog.now() AT TIME ZONE 'America/Argentina/Cordoba')::date;
  v_motivo text := pg_catalog.btrim(p_motivo);
  v_item jsonb;
  v_fila record;
  v_items_canonicos jsonb := '[]'::jsonb;
  v_items_resueltos jsonb := '[]'::jsonb;
  v_reintegros_canonicos jsonb := '[]'::jsonb;
  v_cantidad numeric;
  v_precio numeric;
  v_iva numeric;
  v_neto_linea numeric;
  v_iva_linea numeric;
  v_total_linea numeric;
  v_neto numeric := 0;
  v_iva_total numeric := 0;
  v_total numeric := 0;
  v_reintegro_centavos numeric := 0;
  v_payload jsonb;
  v_payload_hash text;
  v_existente public.ventas%ROWTYPE;
  v_venta_id uuid;
  v_numero text;
  v_es_cta_cte boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE='28000';
  END IF;

  SELECT p.* INTO v_perfil
    FROM public.profiles AS p
   WHERE p.id=v_uid;
  IF NOT FOUND OR v_perfil.activo IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'El perfil autenticado no existe o está inactivo'
      USING ERRCODE='42501';
  END IF;

  v_es_admin := COALESCE(public.is_admin(v_uid),false);

  IF p_sucursal_id IS NULL THEN
    RAISE EXCEPTION 'La sucursal es obligatoria';
  END IF;
  SELECT e.condicion_iva
    INTO v_emisor_condicion
    FROM public.sucursales AS s
    JOIN public.emisores AS e ON e.id=s.emisor_id
   WHERE s.id=p_sucursal_id
     AND s.activa
     AND e.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sucursal o su emisor no existen o están inactivos';
  END IF;

  IF NOT v_es_admin AND (
    v_perfil.sucursal_id IS DISTINCT FROM p_sucursal_id
    OR NOT EXISTS (
      SELECT 1
        FROM public.profile_sucursales AS ps
       WHERE ps.profile_id=v_uid
         AND ps.sucursal_id=p_sucursal_id
    )
  ) THEN
    RAISE EXCEPTION 'No podés emitir una nota en una sucursal que no es la tuya'
      USING ERRCODE='42501';
  END IF;

  SELECT s.* INTO v_settings
    FROM public.settings AS s
   WHERE s.id=true
   FOR UPDATE;
  IF NOT FOUND
     OR v_settings.facturacion_receptor_v2_enabled IS DISTINCT FROM true
     OR v_settings.facturacion_legacy_writer_enabled IS DISTINCT FROM false
     OR v_settings.nota_credito_periodo_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'La emisión de notas de crédito por período está deshabilitada'
      USING ERRCODE='55000';
  END IF;

  IF NOT public.puede_emitir_nc_periodo(v_uid) THEN
    RAISE EXCEPTION 'El usuario no tiene el permiso efectivo para emitir NC por período'
      USING ERRCODE='42501';
  END IF;

  SELECT c.* INTO v_cliente
    FROM public.clientes AS c
   WHERE c.id=p_cliente_id
     AND c.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;
  IF v_cliente.es_generico THEN
    RAISE EXCEPTION 'La nota por período requiere un cliente comercial, no el cliente genérico';
  END IF;

  -- La matriz A/B/C se valida aquí aunque la identidad ARCA recién se reserve
  -- al crear el snapshot v3. Así nunca se guarda una intención que no pueda
  -- mapearse a un comprobante estándar 3, 8 o 13.
  v_receptor_condicion := CASE v_cliente.tipo
    WHEN 'RESPONSABLE_INSCRIPTO' THEN 'RESPONSABLE_INSCRIPTO'
    WHEN 'MONOTRIBUTISTA' THEN 'MONOTRIBUTO'
    WHEN 'EXENTO' THEN 'EXENTO'
    WHEN 'CONSUMIDOR_FINAL' THEN 'CONSUMIDOR_FINAL'
    ELSE NULL
  END;
  IF NOT (
    (v_emisor_condicion='MONOTRIBUTO' AND v_receptor_condicion IS NOT NULL)
    OR (
      v_emisor_condicion='RESPONSABLE_INSCRIPTO'
      AND v_receptor_condicion IN (
        'RESPONSABLE_INSCRIPTO','MONOTRIBUTO','EXENTO','CONSUMIDOR_FINAL'
      )
    )
  ) THEN
    RAISE EXCEPTION 'La condición fiscal del emisor o receptor no admite una NC A, B o C';
  END IF;

  IF p_periodo_desde IS NULL OR p_periodo_hasta IS NULL THEN
    RAISE EXCEPTION 'Las dos fechas del período son obligatorias';
  END IF;
  IF p_periodo_desde>p_periodo_hasta THEN
    RAISE EXCEPTION 'La fecha desde no puede ser posterior a la fecha hasta';
  END IF;
  IF p_periodo_hasta>v_fecha_fiscal THEN
    RAISE EXCEPTION 'El período asociado no puede terminar en el futuro';
  END IF;
  IF v_motivo IS NULL OR pg_catalog.char_length(v_motivo)<5 THEN
    RAISE EXCEPTION 'El motivo debe tener al menos cinco caracteres útiles';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'La clave de idempotencia es obligatoria';
  END IF;
  IF p_modalidad IS NULL OR p_resolucion IS NULL THEN
    RAISE EXCEPTION 'La modalidad y la resolución son obligatorias';
  END IF;
  IF p_items IS NULL
     OR pg_catalog.jsonb_typeof(p_items)<>'array'
     OR pg_catalog.jsonb_array_length(p_items)=0
     OR pg_catalog.jsonb_array_length(p_items)>500 THEN
    RAISE EXCEPTION 'Los ítems deben ser un arreglo no vacío de hasta 500 líneas';
  END IF;
  IF p_reintegros IS NULL
     OR pg_catalog.jsonb_typeof(p_reintegros)<>'array'
     OR pg_catalog.jsonb_array_length(p_reintegros)>20 THEN
    RAISE EXCEPTION 'Los reintegros deben ser un arreglo de hasta 20 medios';
  END IF;

  IF p_modalidad='DEVOLUCION_PRODUCTOS' THEN
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_items) AS e(item)
       WHERE pg_catalog.jsonb_typeof(e.item)<>'object'
          OR NOT (e.item ?& ARRAY[
            'producto_id','cantidad','precio_unitario_sin_iva','iva_porcentaje'
          ])
          OR pg_catalog.jsonb_typeof(e.item->'producto_id')<>'string'
          OR pg_catalog.jsonb_typeof(e.item->'cantidad')<>'number'
          OR pg_catalog.jsonb_typeof(e.item->'precio_unitario_sin_iva')<>'number'
          OR pg_catalog.jsonb_typeof(e.item->'iva_porcentaje')<>'number'
          OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_object_keys(e.item) AS k(clave)
             WHERE k.clave<>ALL(ARRAY[
               'producto_id','cantidad','precio_unitario_sin_iva','iva_porcentaje'
             ])
          )
    ) THEN
      RAISE EXCEPTION 'Cada línea de producto debe contener únicamente producto_id, cantidad, precio e IVA';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_items) AS e(item)
       WHERE (e.item->>'producto_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR (e.item->>'cantidad')::numeric<=0
          OR (e.item->>'cantidad')::numeric>999999999999.99
          OR (e.item->>'cantidad')::numeric<>pg_catalog.round((e.item->>'cantidad')::numeric,2)
          OR (e.item->>'precio_unitario_sin_iva')::numeric<=0
          OR (e.item->>'precio_unitario_sin_iva')::numeric>999999999999.99
          OR (e.item->>'precio_unitario_sin_iva')::numeric<>pg_catalog.round((e.item->>'precio_unitario_sin_iva')::numeric,2)
          OR (e.item->>'iva_porcentaje')::numeric<>ALL(ARRAY[0,2.5,5,10.5,21,27]::numeric[])
    ) THEN
      RAISE EXCEPTION 'Los productos requieren UUID, cantidad y precio positivos en centavos e IVA permitido';
    END IF;
    IF (
      SELECT pg_catalog.count(*)<>pg_catalog.count(DISTINCT (e.item->>'producto_id')::uuid)
        FROM pg_catalog.jsonb_array_elements(p_items) AS e(item)
    ) THEN
      RAISE EXCEPTION 'Un producto no puede repetirse en la misma nota';
    END IF;

    FOR v_fila IN
      SELECT
        p.id,p.codigo,p.nombre,p.precio_sin_iva,p.iva_porcentaje,
        i.cantidad,i.precio_unitario_sin_iva,i.iva_porcentaje AS iva_solicitada
      FROM pg_catalog.jsonb_to_recordset(p_items) AS i(
        producto_id uuid,cantidad numeric,precio_unitario_sin_iva numeric,iva_porcentaje numeric
      )
      JOIN public.productos AS p ON p.id=i.producto_id
     WHERE p.activo AND NOT p.archivado
     ORDER BY p.id
     FOR UPDATE OF p
    LOOP
      v_iva := v_fila.iva_solicitada;
      IF v_iva IS DISTINCT FROM v_fila.iva_porcentaje THEN
        RAISE EXCEPTION 'El IVA del producto no coincide con el catálogo bloqueado';
      END IF;
      v_items_canonicos := v_items_canonicos||pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'producto_id',v_fila.id::text,
          'cantidad',pg_catalog.round(v_fila.cantidad,2),
          'precio_unitario_sin_iva',pg_catalog.round(v_fila.precio_unitario_sin_iva,2),
          'iva_porcentaje',v_iva
        )
      );
      v_items_resueltos := v_items_resueltos||pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'producto_id',v_fila.id::text,'codigo',v_fila.codigo,
          'descripcion',v_fila.nombre,'cantidad',pg_catalog.round(v_fila.cantidad,2),
          'precio_unitario_sin_iva',pg_catalog.round(v_fila.precio_unitario_sin_iva,2),
          'precio_lista_sin_iva',pg_catalog.round(v_fila.precio_sin_iva,2),
          'iva_porcentaje',v_iva
        )
      );
    END LOOP;
    IF pg_catalog.jsonb_array_length(v_items_resueltos)
       <>pg_catalog.jsonb_array_length(p_items) THEN
      RAISE EXCEPTION 'El producto no existe, está inactivo o archivado';
    END IF;
  ELSE
    IF pg_catalog.jsonb_array_length(p_items)<>1 THEN
      RAISE EXCEPTION 'La bonificación requiere exactamente una línea de concepto';
    END IF;
    v_item := p_items->0;
    IF pg_catalog.jsonb_typeof(v_item)<>'object'
       OR NOT (v_item ?& ARRAY[
         'producto_id','descripcion','cantidad','precio_unitario_sin_iva','iva_porcentaje'
       ])
       OR v_item->'producto_id' IS DISTINCT FROM 'null'::jsonb
       OR pg_catalog.jsonb_typeof(v_item->'descripcion')<>'string'
       OR pg_catalog.jsonb_typeof(v_item->'cantidad')<>'number'
       OR pg_catalog.jsonb_typeof(v_item->'precio_unitario_sin_iva')<>'number'
       OR pg_catalog.jsonb_typeof(v_item->'iva_porcentaje')<>'number'
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_object_keys(v_item) AS k(clave)
          WHERE k.clave<>ALL(ARRAY[
            'producto_id','descripcion','cantidad','precio_unitario_sin_iva','iva_porcentaje'
          ])
       ) THEN
      RAISE EXCEPTION 'El ajuste debe contener únicamente un concepto sin producto';
    END IF;
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio := (v_item->>'precio_unitario_sin_iva')::numeric;
    v_iva := (v_item->>'iva_porcentaje')::numeric;
    IF pg_catalog.btrim(v_item->>'descripcion')=''
       OR v_cantidad<>1
       OR v_precio<=0 OR v_precio>999999999999.99
       OR v_precio<>pg_catalog.round(v_precio,2)
       OR v_iva<>ALL(ARRAY[0,2.5,5,10.5,21,27]::numeric[]) THEN
      RAISE EXCEPTION 'El concepto requiere descripción, cantidad uno, precio positivo en centavos e IVA permitido';
    END IF;
    v_items_canonicos := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'producto_id',NULL,'descripcion',pg_catalog.btrim(v_item->>'descripcion'),
        'cantidad',1,'precio_unitario_sin_iva',pg_catalog.round(v_precio,2),
        'iva_porcentaje',v_iva
      )
    );
    v_items_resueltos := v_items_canonicos;
  END IF;

  FOR v_item IN SELECT e.value FROM pg_catalog.jsonb_array_elements(v_items_resueltos) AS e(value)
  LOOP
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio := (v_item->>'precio_unitario_sin_iva')::numeric;
    v_iva := (v_item->>'iva_porcentaje')::numeric;
    v_neto_linea := pg_catalog.round(v_cantidad*v_precio,2);
    v_iva_linea := pg_catalog.round(v_neto_linea*v_iva/100,2);
    v_total_linea := pg_catalog.round(v_neto_linea+v_iva_linea,2);
    v_neto := v_neto+v_neto_linea;
    v_iva_total := v_iva_total+v_iva_linea;
    v_total := v_total+v_total_linea;
  END LOOP;
  IF v_total<=0 OR v_neto>999999999999.99 OR v_iva_total>999999999999.99
     OR v_total>999999999999.99 THEN
    RAISE EXCEPTION 'El total debe ser positivo y caber en centavos contables';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_reintegros) AS e(item)
     WHERE pg_catalog.jsonb_typeof(e.item)<>'object'
        OR NOT (e.item ?& ARRAY['forma_pago','monto_centavos'])
        OR pg_catalog.jsonb_typeof(e.item->'forma_pago')<>'string'
        OR pg_catalog.jsonb_typeof(e.item->'monto_centavos')<>'number'
        OR EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_object_keys(e.item) AS k(clave)
           WHERE k.clave<>ALL(ARRAY['forma_pago','monto_centavos'])
        )
  ) THEN
    RAISE EXCEPTION 'Cada reintegro debe contener únicamente forma_pago y monto_centavos';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_reintegros) AS e(item)
     WHERE e.item->>'forma_pago' NOT IN (
       'EFECTIVO','TRANSFERENCIA','TARJETA_DEBITO','TARJETA_CREDITO','MERCADO_PAGO','CHEQUE'
     )
        OR (e.item->>'monto_centavos')::numeric<=0
        OR (e.item->>'monto_centavos')::numeric>99999999999999
        OR (e.item->>'monto_centavos')::numeric<>pg_catalog.trunc((e.item->>'monto_centavos')::numeric)
  ) THEN
    RAISE EXCEPTION 'Los reintegros requieren forma permitida y monto entero positivo en centavos';
  END IF;
  IF (
    SELECT pg_catalog.count(*)<>pg_catalog.count(DISTINCT e.item->>'forma_pago')
      FROM pg_catalog.jsonb_array_elements(p_reintegros) AS e(item)
  ) THEN
    RAISE EXCEPTION 'Cada forma de reintegro puede aparecer una sola vez';
  END IF;
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'forma_pago',e.item->>'forma_pago',
               'monto_centavos',(e.item->>'monto_centavos')::numeric
             ) ORDER BY e.item->>'forma_pago'
           ),
           '[]'::jsonb
         ),
         COALESCE(pg_catalog.sum((e.item->>'monto_centavos')::numeric),0)
    INTO v_reintegros_canonicos,v_reintegro_centavos
    FROM pg_catalog.jsonb_array_elements(p_reintegros) AS e(item);

  IF p_resolucion='REINTEGRO' THEN
    IF pg_catalog.jsonb_array_length(v_reintegros_canonicos)=0
       OR v_reintegro_centavos IS DISTINCT FROM v_total*100 THEN
      RAISE EXCEPTION 'El reintegro debe coincidir exactamente con el total en centavos';
    END IF;
    v_es_cta_cte := false;
  ELSE
    IF pg_catalog.jsonb_array_length(v_reintegros_canonicos)<>0 THEN
      RAISE EXCEPTION 'El saldo a favor no admite reintegros planificados';
    END IF;
    v_es_cta_cte := true;
  END IF;

  v_payload := pg_catalog.jsonb_build_object(
    'version',1,
    'actor_id',v_uid::text,
    'sucursal_id',p_sucursal_id::text,
    'cliente_id',p_cliente_id::text,
    'modalidad',p_modalidad::text,
    'periodo_desde',p_periodo_desde::text,
    'periodo_hasta',p_periodo_hasta::text,
    'motivo',v_motivo,
    'resolucion',p_resolucion::text,
    'items',v_items_canonicos,
    'reintegros',v_reintegros_canonicos
  );
  v_payload_hash := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_payload::text,'UTF8'),'sha256'),
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
       OR v_existente.nc_periodo_modalidad IS NULL
       OR v_existente.nc_periodo_payload_hash IS NULL
       OR v_existente.nc_periodo_payload_hash IS DISTINCT FROM v_payload_hash THEN
      RAISE EXCEPTION 'La clave de idempotencia ya fue utilizada por otra operación'
        USING ERRCODE='23505',CONSTRAINT='uq_ventas_idempotency_key';
    END IF;
    RETURN QUERY SELECT
      v_existente.id,v_existente.numero_comprobante,
      v_existente.condicion_venta='CTA_CTE';
    RETURN;
  END IF;

  v_numero := public.next_comprobante_numero(p_sucursal_id,'NOTA_CREDITO');
  INSERT INTO public.ventas(
    sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
    condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
    estado_pago,estado,afip_estado,idempotency_key,idempotency_payload_hash,
    nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
    motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash
  ) VALUES (
    p_sucursal_id,p_cliente_id,v_uid,v_numero,'NOTA_CREDITO',
    CASE WHEN p_resolucion='REINTEGRO' THEN 'CONTADO'::public.condicion_venta
         ELSE 'CTA_CTE'::public.condicion_venta END,
    -v_neto,-v_iva_total,0,-v_total,0,
    'PENDIENTE','PENDIENTE_FISCAL','SIN_FACTURAR',p_idempotency_key,v_payload_hash,
    p_modalidad,p_periodo_desde,p_periodo_hasta,v_motivo,p_resolucion,v_payload_hash
  ) RETURNING id INTO v_venta_id;

  INSERT INTO public.venta_items(
    venta_id,producto_id,codigo,descripcion,cantidad,
    precio_unitario_sin_iva,precio_lista_sin_iva,iva_porcentaje,
    descuento_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
  )
  SELECT
    v_venta_id,NULLIF(i.item->>'producto_id','')::uuid,
    CASE WHEN i.item->>'producto_id' IS NULL THEN 'AJUSTE' ELSE i.item->>'codigo' END,
    CASE WHEN i.item->>'producto_id' IS NULL THEN i.item->>'descripcion' ELSE i.item->>'descripcion' END,
    (i.item->>'cantidad')::numeric,
    (i.item->>'precio_unitario_sin_iva')::numeric,
    COALESCE((i.item->>'precio_lista_sin_iva')::numeric,(i.item->>'precio_unitario_sin_iva')::numeric),
    (i.item->>'iva_porcentaje')::numeric,0,
    -pg_catalog.round((i.item->>'cantidad')::numeric*(i.item->>'precio_unitario_sin_iva')::numeric,2),
    -pg_catalog.round(
      pg_catalog.round((i.item->>'cantidad')::numeric*(i.item->>'precio_unitario_sin_iva')::numeric,2)
      *(i.item->>'iva_porcentaje')::numeric/100,2
    ),
    -pg_catalog.round(
      pg_catalog.round((i.item->>'cantidad')::numeric*(i.item->>'precio_unitario_sin_iva')::numeric,2)
      +pg_catalog.round(
        pg_catalog.round((i.item->>'cantidad')::numeric*(i.item->>'precio_unitario_sin_iva')::numeric,2)
        *(i.item->>'iva_porcentaje')::numeric/100,2
      ),2
    )
  FROM pg_catalog.jsonb_array_elements(v_items_resueltos) AS i(item);

  INSERT INTO public.nota_credito_periodo_reintegros(
    venta_id,forma_pago,monto,detalle,orden
  )
  SELECT
    v_venta_id,(r.item->>'forma_pago')::public.forma_pago,
    (r.item->>'monto_centavos')::numeric/100,'{}'::jsonb,r.orden::integer-1
  FROM pg_catalog.jsonb_array_elements(v_reintegros_canonicos)
       WITH ORDINALITY AS r(item,orden);

  RETURN QUERY SELECT v_venta_id,v_numero,v_es_cta_cte;
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

COMMENT ON FUNCTION public.crear_nota_credito_periodo_fiscal(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) IS
  'Crea de forma idempotente una intención de NC por período, sin aplicar caja, pagos, stock ni cuenta corriente.';
