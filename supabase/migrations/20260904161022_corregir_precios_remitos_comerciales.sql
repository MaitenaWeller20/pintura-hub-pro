-- Los remitos comerciales ya emitidos pueden corregir exclusivamente precios y
-- descuentos. Cantidades, productos, stock, pagos y datos fiscales no se tocan.
-- El total y su débito de cuenta corriente cambian en la misma transacción.

ALTER TABLE public.ventas
  ADD COLUMN correccion_precios_version integer NOT NULL DEFAULT 0
  CONSTRAINT ventas_correccion_precios_version_no_negativa
  CHECK (correccion_precios_version>=0);

CREATE TABLE public.remito_precio_correcciones (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venta_id uuid NOT NULL
    REFERENCES public.ventas(id) ON DELETE RESTRICT,
  corregida_por uuid NOT NULL
    REFERENCES public.profiles(id) ON DELETE RESTRICT,
  corregida_en timestamptz NOT NULL DEFAULT pg_catalog.now(),
  motivo text NOT NULL
    CONSTRAINT remito_precio_correcciones_motivo_valido
    CHECK (pg_catalog.char_length(pg_catalog.btrim(motivo)) BETWEEN 5 AND 1000),
  version_anterior integer NOT NULL CHECK (version_anterior>=0),
  version_nueva integer NOT NULL CHECK (version_nueva=version_anterior+1),
  items_anteriores jsonb NOT NULL
    CHECK (pg_catalog.jsonb_typeof(items_anteriores)='array'),
  items_nuevos jsonb NOT NULL
    CHECK (pg_catalog.jsonb_typeof(items_nuevos)='array'),
  subtotal_anterior numeric(14,2) NOT NULL,
  subtotal_nuevo numeric(14,2) NOT NULL,
  iva_anterior numeric(14,2) NOT NULL,
  iva_nuevo numeric(14,2) NOT NULL,
  total_anterior numeric(14,2) NOT NULL,
  total_nuevo numeric(14,2) NOT NULL,
  CONSTRAINT remito_precio_correcciones_version_unica
    UNIQUE (venta_id,version_nueva)
);

CREATE INDEX remito_precio_correcciones_venta_fecha_idx
  ON public.remito_precio_correcciones(venta_id,corregida_en DESC);
CREATE INDEX remito_precio_correcciones_usuario_idx
  ON public.remito_precio_correcciones(corregida_por);

ALTER TABLE public.remito_precio_correcciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.remito_precio_correcciones
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.remito_precio_correcciones
  TO authenticated,service_role;

CREATE POLICY "Sucursal lee correcciones de precios de remitos"
ON public.remito_precio_correcciones
FOR SELECT
TO authenticated
USING (
  (SELECT public.is_admin((SELECT auth.uid())))
  OR EXISTS (
    SELECT 1
    FROM public.ventas AS v
    WHERE v.id=venta_id
      AND v.sucursal_id=(SELECT public.current_sucursal_id())
  )
);

CREATE OR REPLACE FUNCTION public.bloquear_cambio_correccion_precio_remito()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=''
AS $$
BEGIN
  RAISE insufficient_privilege
    USING MESSAGE='La auditoría de correcciones de precios de remitos es inmutable';
END;
$$;

REVOKE ALL ON FUNCTION public.bloquear_cambio_correccion_precio_remito()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER remito_precio_correcciones_inmutables
BEFORE UPDATE OR DELETE ON public.remito_precio_correcciones
FOR EACH ROW EXECUTE FUNCTION public.bloquear_cambio_correccion_precio_remito();

CREATE OR REPLACE FUNCTION public.corregir_precios_remito(
  p_venta_id uuid,
  p_items jsonb,
  p_motivo text,
  p_version_esperada integer
)
RETURNS TABLE(
  venta_id uuid,
  subtotal_sin_iva numeric,
  iva_total numeric,
  percepciones numeric,
  total numeric,
  correccion_precios_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid:=auth.uid();
  v_es_admin boolean:=false;
  v_actor_sucursal uuid;
  v_venta public.ventas%ROWTYPE;
  v_item public.venta_items%ROWTYPE;
  v_movimiento public.cuenta_corriente_movimientos%ROWTYPE;
  v_payload_item jsonb;
  v_item_id uuid;
  v_ids_vistos uuid[]:=ARRAY[]::uuid[];
  v_precio numeric;
  v_descuento numeric;
  v_sub_item numeric(14,2);
  v_iva_item numeric(14,2);
  v_subtotal_nuevo numeric:=0;
  v_iva_nuevo numeric:=0;
  v_total_nuevo numeric;
  v_cantidad_items integer;
  v_cantidad_payload integer;
  v_cambio boolean:=false;
  v_motivo text:=pg_catalog.btrim(COALESCE(p_motivo,''));
  v_items_anteriores jsonb;
  v_items_nuevos jsonb;
  v_subtotal_anterior numeric(14,2);
  v_iva_anterior numeric(14,2);
  v_total_anterior numeric(14,2);
  v_version_anterior integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Iniciá sesión nuevamente para corregir los precios del remito.';
  END IF;

  PERFORM 1
  FROM public.profiles AS p
  JOIN auth.users AS au ON au.id=p.id
  WHERE p.id=v_uid
    AND p.activo
    AND au.deleted_at IS NULL
    AND (au.banned_until IS NULL OR au.banned_until<=pg_catalog.now());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El perfil autenticado no existe o está inactivo.';
  END IF;

  v_es_admin:=COALESCE(public.is_admin(v_uid),false);
  v_actor_sucursal:=public.current_sucursal_id();

  IF p_venta_id IS NULL THEN
    RAISE EXCEPTION 'Elegí el remito que querés corregir.';
  END IF;
  IF p_version_esperada IS NULL OR p_version_esperada<0 THEN
    RAISE EXCEPTION 'Volvé a abrir el remito antes de corregir sus precios.';
  END IF;
  IF pg_catalog.char_length(v_motivo)<5 THEN
    RAISE EXCEPTION 'Escribí un motivo concreto para que la corrección quede auditada.';
  END IF;
  IF pg_catalog.char_length(v_motivo)>1000 THEN
    RAISE EXCEPTION 'El motivo no puede superar los 1000 caracteres.';
  END IF;
  IF pg_catalog.jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_items)=0 THEN
    RAISE EXCEPTION 'Incluí todos los productos del remito con sus precios.';
  END IF;
  IF pg_catalog.jsonb_array_length(p_items)>500 THEN
    RAISE EXCEPTION 'El remito supera el máximo de 500 productos corregibles.';
  END IF;

  -- Orden de locks compatible con anular_venta: cabecera, ítems y movimiento.
  SELECT v.* INTO v_venta
  FROM public.ventas AS v
  WHERE v.id=p_venta_id
  FOR UPDATE;
  IF NOT FOUND
     OR (NOT v_es_admin AND v_venta.sucursal_id IS DISTINCT FROM v_actor_sucursal) THEN
    RAISE EXCEPTION 'El remito seleccionado no existe o no está disponible.';
  END IF;

  IF v_venta.tipo_comprobante NOT IN ('REMITO','REMITO_OBRA') THEN
    RAISE EXCEPTION 'Sólo se pueden corregir precios de remitos de cuenta corriente o de obra.';
  END IF;
  IF v_venta.estado<>'ACTIVA' THEN
    RAISE EXCEPTION 'No se puede corregir un remito anulado.';
  END IF;
  IF v_venta.condicion_venta<>'CTA_CTE' THEN
    RAISE EXCEPTION 'El remito debe estar vinculado a cuenta corriente.';
  END IF;
  IF v_venta.total_pagado<>0
     OR EXISTS (SELECT 1 FROM public.venta_pagos AS vp WHERE vp.venta_id=v_venta.id) THEN
    RAISE EXCEPTION 'El remito tiene pagos directos y no se puede corregir por este medio.';
  END IF;
  IF v_venta.correccion_precios_version<>p_version_esperada THEN
    RAISE EXCEPTION 'Otra persona corrigió este remito. Cerralo, revisá los cambios y volvé a intentarlo.';
  END IF;

  PERFORM 1
  FROM public.venta_items AS i
  WHERE i.venta_id=v_venta.id
  ORDER BY i.id
  FOR UPDATE;
  GET DIAGNOSTICS v_cantidad_items=ROW_COUNT;
  v_cantidad_payload:=pg_catalog.jsonb_array_length(p_items);
  IF v_cantidad_items=0 OR v_cantidad_payload<>v_cantidad_items THEN
    RAISE EXCEPTION 'Incluí todos los productos del remito antes de guardar.';
  END IF;

  SELECT pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'item_id',i.id,
             'producto_id',i.producto_id,
             'codigo',i.codigo,
             'descripcion',i.descripcion,
             'cantidad',i.cantidad,
             'precio_unitario_sin_iva',i.precio_unitario_sin_iva,
             'precio_lista_sin_iva',i.precio_lista_sin_iva,
             'iva_porcentaje',i.iva_porcentaje,
             'descuento_porcentaje',i.descuento_porcentaje,
             'subtotal_sin_iva',i.subtotal_sin_iva,
             'iva_monto',i.iva_monto,
             'subtotal_con_iva',i.subtotal_con_iva
           )
           ORDER BY i.id
         )
  INTO v_items_anteriores
  FROM public.venta_items AS i
  WHERE i.venta_id=v_venta.id;

  FOR v_payload_item IN
    SELECT value FROM pg_catalog.jsonb_array_elements(p_items)
  LOOP
    IF pg_catalog.jsonb_typeof(v_payload_item) IS DISTINCT FROM 'object'
       OR NOT (v_payload_item ?& ARRAY[
         'item_id','precio_unitario_sin_iva','descuento_porcentaje'
       ])
       OR (
         SELECT count(*) FROM pg_catalog.jsonb_object_keys(v_payload_item)
       )<>3
       OR pg_catalog.jsonb_typeof(v_payload_item->'item_id') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_payload_item->'precio_unitario_sin_iva')
            IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_payload_item->'descuento_porcentaje')
            IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Cada producto debe incluir sólo ítem, precio y descuento válidos.';
    END IF;

    BEGIN
      v_item_id:=(v_payload_item->>'item_id')::uuid;
      v_precio:=(v_payload_item->>'precio_unitario_sin_iva')::numeric;
      v_descuento:=(v_payload_item->>'descuento_porcentaje')::numeric;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Cada producto debe incluir sólo ítem, precio y descuento válidos.';
    END;

    IF v_item_id=ANY(v_ids_vistos) THEN
      RAISE EXCEPTION 'Cada producto del remito debe aparecer una sola vez.';
    END IF;
    v_ids_vistos:=pg_catalog.array_append(v_ids_vistos,v_item_id);

    SELECT i.* INTO v_item
    FROM public.venta_items AS i
    WHERE i.id=v_item_id
      AND i.venta_id=v_venta.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Incluí todos los productos del remito antes de guardar.';
    END IF;

    IF v_precio<=0 OR v_precio>999999999999.99
       OR v_precio<>pg_catalog.round(v_precio,2) THEN
      RAISE EXCEPTION 'Cada precio debe ser mayor a cero y tener hasta dos decimales.';
    END IF;
    IF v_descuento<0 OR v_descuento>100
       OR v_descuento<>pg_catalog.round(v_descuento,2) THEN
      RAISE EXCEPTION 'Cada descuento debe estar entre 0 y 100 y tener hasta dos decimales.';
    END IF;
    IF v_item.cantidad<0 THEN
      RAISE EXCEPTION 'El remito contiene una cantidad inválida y no puede corregirse.';
    END IF;

    v_cambio:=v_cambio
      OR v_item.precio_unitario_sin_iva IS DISTINCT FROM v_precio
      OR v_item.descuento_porcentaje IS DISTINCT FROM v_descuento;
    v_sub_item:=pg_catalog.round(
      v_precio*(1-v_descuento/100)*v_item.cantidad,
      2
    );
    v_iva_item:=pg_catalog.round(v_sub_item*v_item.iva_porcentaje/100,2);

    UPDATE public.venta_items AS i
    SET precio_unitario_sin_iva=v_precio,
        descuento_porcentaje=v_descuento,
        subtotal_sin_iva=v_sub_item,
        iva_monto=v_iva_item,
        subtotal_con_iva=pg_catalog.round(v_sub_item+v_iva_item,2)
    WHERE i.id=v_item.id;

    v_subtotal_nuevo:=v_subtotal_nuevo+v_sub_item;
    v_iva_nuevo:=v_iva_nuevo+v_iva_item;
  END LOOP;

  IF NOT v_cambio THEN
    RAISE EXCEPTION 'No cambió ningún precio ni descuento.';
  END IF;

  v_subtotal_nuevo:=pg_catalog.round(v_subtotal_nuevo,2);
  v_iva_nuevo:=pg_catalog.round(v_iva_nuevo,2);
  v_total_nuevo:=pg_catalog.round(
    v_subtotal_nuevo+v_iva_nuevo+v_venta.percepciones,
    2
  );
  IF v_total_nuevo<=0 OR v_total_nuevo>999999999999.99 THEN
    RAISE EXCEPTION 'El total corregido debe ser mayor a cero y estar dentro del rango permitido.';
  END IF;

  SELECT m.* INTO v_movimiento
  FROM public.cuenta_corriente_movimientos AS m
  WHERE m.venta_id=v_venta.id
  FOR UPDATE;
  IF NOT FOUND
     OR v_movimiento.tipo<>'DEBITO'
     OR v_movimiento.estado<>'CONFIRMADO'
     OR v_movimiento.cliente_id IS DISTINCT FROM v_venta.cliente_id
     OR v_movimiento.sucursal_id IS DISTINCT FROM v_venta.sucursal_id THEN
    RAISE EXCEPTION 'La deuda del remito no está íntegra. No se guardó ningún cambio.';
  END IF;

  SELECT pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'item_id',i.id,
             'producto_id',i.producto_id,
             'codigo',i.codigo,
             'descripcion',i.descripcion,
             'cantidad',i.cantidad,
             'precio_unitario_sin_iva',i.precio_unitario_sin_iva,
             'precio_lista_sin_iva',i.precio_lista_sin_iva,
             'iva_porcentaje',i.iva_porcentaje,
             'descuento_porcentaje',i.descuento_porcentaje,
             'subtotal_sin_iva',i.subtotal_sin_iva,
             'iva_monto',i.iva_monto,
             'subtotal_con_iva',i.subtotal_con_iva
           )
           ORDER BY i.id
         )
  INTO v_items_nuevos
  FROM public.venta_items AS i
  WHERE i.venta_id=v_venta.id;

  v_subtotal_anterior:=v_venta.subtotal_sin_iva;
  v_iva_anterior:=v_venta.iva_total;
  v_total_anterior:=v_venta.total;
  v_version_anterior:=v_venta.correccion_precios_version;

  UPDATE public.ventas AS v
  SET subtotal_sin_iva=v_subtotal_nuevo,
      iva_total=v_iva_nuevo,
      total=v_total_nuevo,
      correccion_precios_version=v.correccion_precios_version+1
  WHERE v.id=v_venta.id
    AND v.correccion_precios_version=p_version_esperada
  RETURNING v.* INTO v_venta;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Otra persona corrigió este remito. Cerralo, revisá los cambios y volvé a intentarlo.';
  END IF;

  UPDATE public.cuenta_corriente_movimientos AS m
  SET monto=v_total_nuevo
  WHERE m.id=v_movimiento.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La deuda del remito no pudo actualizarse. No se guardó ningún cambio.';
  END IF;

  INSERT INTO public.remito_precio_correcciones(
    venta_id,corregida_por,motivo,version_anterior,version_nueva,
    items_anteriores,items_nuevos,subtotal_anterior,subtotal_nuevo,
    iva_anterior,iva_nuevo,total_anterior,total_nuevo
  ) VALUES (
    v_venta.id,v_uid,v_motivo,v_version_anterior,v_venta.correccion_precios_version,
    v_items_anteriores,v_items_nuevos,v_subtotal_anterior,v_subtotal_nuevo,
    v_iva_anterior,v_iva_nuevo,v_total_anterior,v_total_nuevo
  );

  RETURN QUERY SELECT
    v_venta.id,
    v_venta.subtotal_sin_iva,
    v_venta.iva_total,
    v_venta.percepciones,
    v_venta.total,
    v_venta.correccion_precios_version;
END;
$$;

REVOKE ALL ON FUNCTION public.corregir_precios_remito(uuid,jsonb,text,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.corregir_precios_remito(uuid,jsonb,text,integer)
  TO authenticated;

COMMENT ON COLUMN public.ventas.correccion_precios_version IS
  'Versión optimista de las correcciones de precios de remitos comerciales.';
COMMENT ON TABLE public.remito_precio_correcciones IS
  'Historial inmutable de precios y totales antes/después de corregir un remito comercial.';
COMMENT ON FUNCTION public.corregir_precios_remito(uuid,jsonb,text,integer) IS
  'Corrige sólo precios/descuentos de REMITO o REMITO_OBRA y actualiza su débito de cuenta corriente en la misma transacción.';
