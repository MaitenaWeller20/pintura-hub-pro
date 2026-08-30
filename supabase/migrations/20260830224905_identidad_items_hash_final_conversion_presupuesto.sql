-- Segunda ola de compatibilidad: cada snapshot usa una identidad explícita
-- durante la inserción y la huella idempotente describe el payload final, no el
-- marker interno. El helper no forma parte de la API: sólo el owner puede
-- invocarlo desde el conversor autenticado.

CREATE OR REPLACE FUNCTION public._crear_venta_desde_presupuesto_20260830(
  p_presupuesto_id uuid,
  p_cliente_id uuid,
  p_condicion_venta public.condicion_venta,
  p_pagos jsonb,
  p_idempotency_key uuid
)
RETURNS TABLE(
  venta_id uuid,
  numero text,
  es_cta_cte boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_actor_sucursal uuid;
  v_actor_activo boolean;
  v_es_admin boolean;
  v_p public.presupuestos%ROWTYPE;
  v_items_final jsonb;
  v_items_marcados jsonb;
  v_payload jsonb;
  v_payload_hash text;
  v_ex public.ventas%ROWTYPE;
  v_es_replay boolean := false;
  v_venta_id uuid;
  v_numero text;
  v_es_cta_cte boolean;
  v_copiadas integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'La conversión necesita una clave de idempotencia';
  END IF;

  SELECT p.sucursal_id,p.activo
    INTO v_actor_sucursal,v_actor_activo
    FROM public.profiles AS p
   WHERE p.id=v_uid;
  IF NOT FOUND OR v_actor_activo IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'El perfil autenticado no existe o está inactivo';
  END IF;
  v_es_admin := COALESCE(public.is_admin(v_uid),false);

  SELECT p.*
    INTO v_p
    FROM public.presupuestos AS p
   WHERE p.id=p_presupuesto_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Presupuesto inexistente o sin acceso';
  END IF;
  PERFORM 1
    FROM public.sucursales AS s
   WHERE s.id=v_p.sucursal_id
     AND s.activa;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sucursal no existe o está inactiva';
  END IF;
  IF NOT v_es_admin AND v_p.sucursal_id IS DISTINCT FROM v_actor_sucursal THEN
    RAISE EXCEPTION 'Presupuesto inexistente o sin acceso';
  END IF;

  -- La identidad UUID del snapshot viaja como marker único por el core. El
  -- payload final usa exactamente las claves/valores que reproducen los
  -- venta_items persistidos y nunca somete el texto histórico al validador
  -- público. El orden por id es explícito y estable aun con producto repetido.
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'producto_id',i.producto_id,
               'cantidad',i.cantidad,
               'precio_unitario_sin_iva',i.precio_sin_iva,
               'descuento_porcentaje',0,
               'descripcion',i.descripcion
             )
             ORDER BY i.id
           ),
           '[]'::jsonb
         ),
         COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'producto_id',i.producto_id,
               'cantidad',i.cantidad,
               'precio_unitario_sin_iva',i.precio_sin_iva,
               'descuento_porcentaje',0,
               'descripcion','__presupuesto_item__:'||
                 pg_catalog.replace(i.id::text,'-','')
             )
             ORDER BY i.id
           ),
           '[]'::jsonb
         )
    INTO v_items_final,v_items_marcados
    FROM public.presupuesto_items AS i
   WHERE i.presupuesto_id=p_presupuesto_id;
  IF pg_catalog.jsonb_array_length(v_items_final)=0 THEN
    RAISE EXCEPTION 'El presupuesto no tiene productos';
  END IF;

  -- Debe permanecer byte-lógicamente alineado con crear_venta v1. La única
  -- diferencia interna, los markers, no participa de la huella durable.
  v_payload := pg_catalog.jsonb_build_object(
    'version',1,
    'actor_id',v_uid,
    'sucursal_id',v_p.sucursal_id,
    'cliente_id',p_cliente_id,
    'tipo_comprobante','VENTA'::public.tipo_comprobante,
    'condicion_venta',p_condicion_venta,
    'items',v_items_final,
    'pagos',p_pagos,
    'percepciones',0::numeric,
    'observaciones','Presupuesto '||v_p.numero,
    'nombre_obra',NULL::text,
    'fecha',NULL::timestamptz,
    'cbte_asoc_id',NULL::uuid,
    'idempotency_key',p_idempotency_key
  );
  v_payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_payload::text,'UTF8'),
      'sha256'
    ),
    'hex'
  );

  -- El mismo lock y chequeo cerrado del wrapper público ocurren antes del
  -- core. Un replay sólo puede recuperar la operación exacta del mismo actor y
  -- sucursal; cualquier omisión/cambio de descripción produce el error opaco.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_idempotency_key::text,0)
  );
  SELECT v.*
    INTO v_ex
    FROM public.ventas AS v
   WHERE v.idempotency_key=p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    v_es_replay := true;
    IF v_ex.usuario_id IS DISTINCT FROM v_uid
       OR v_ex.sucursal_id IS DISTINCT FROM v_p.sucursal_id
       OR v_ex.idempotency_payload_hash IS NULL
       OR v_ex.idempotency_payload_hash IS DISTINCT FROM v_payload_hash THEN
      RAISE EXCEPTION 'La clave de idempotencia no corresponde a esta operación';
    END IF;
  END IF;

  SELECT r.venta_id,r.numero,r.es_cta_cte
    INTO v_venta_id,v_numero,v_es_cta_cte
    FROM public._crear_venta_core_20260823(
      v_p.sucursal_id,p_cliente_id,'VENTA',p_condicion_venta,
      v_items_marcados,p_pagos,0,
      'Presupuesto '||v_p.numero,NULL,NULL,NULL,p_idempotency_key
    ) AS r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La creación de la venta no devolvió resultado';
  END IF;

  IF NOT v_es_replay THEN
    -- El marker conserva la identidad de origen hasta este UPDATE. Además de
    -- esa identidad se verifican producto, cantidad, neto y descuento final;
    -- cualquier divergencia revierte venta, stock, caja y presupuesto juntos.
    UPDATE public.venta_items AS destino
       SET descripcion=origen.descripcion
      FROM public.presupuesto_items AS origen
     WHERE origen.presupuesto_id=p_presupuesto_id
       AND destino.venta_id=v_venta_id
       AND destino.descripcion='__presupuesto_item__:'||
         pg_catalog.replace(origen.id::text,'-','')
       AND destino.producto_id IS NOT DISTINCT FROM origen.producto_id
       AND destino.cantidad IS NOT DISTINCT FROM origen.cantidad
       AND destino.precio_unitario_sin_iva IS NOT DISTINCT FROM origen.precio_sin_iva
       AND destino.descuento_porcentaje IS NOT DISTINCT FROM 0;
    GET DIAGNOSTICS v_copiadas=ROW_COUNT;
    IF v_copiadas IS DISTINCT FROM pg_catalog.jsonb_array_length(v_items_final)
       OR v_copiadas IS DISTINCT FROM (
         SELECT pg_catalog.count(*)::integer
           FROM public.venta_items AS i
          WHERE i.venta_id=v_venta_id
       ) THEN
      RAISE EXCEPTION 'No se pudieron vincular todas las descripciones congeladas del presupuesto';
    END IF;

    UPDATE public.ventas AS v
       SET idempotency_payload_hash=v_payload_hash
     WHERE v.id=v_venta_id
       AND v.usuario_id=v_uid
       AND v.sucursal_id=v_p.sucursal_id
       AND v.idempotency_key=p_idempotency_key
       AND v.idempotency_payload_hash IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No se pudo vincular la huella idempotente final a la venta';
    END IF;
  END IF;

  RETURN QUERY SELECT v_venta_id,v_numero,v_es_cta_cte;
END;
$$;

ALTER FUNCTION public._crear_venta_desde_presupuesto_20260830(
  uuid,uuid,public.condicion_venta,jsonb,uuid
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public._crear_venta_desde_presupuesto_20260830(
  uuid,uuid,public.condicion_venta,jsonb,uuid
) FROM PUBLIC,anon,authenticated,service_role;

COMMENT ON FUNCTION public._crear_venta_desde_presupuesto_20260830(
  uuid,uuid,public.condicion_venta,jsonb,uuid
) IS
  'Writer owner-only para conversión: identidad explícita por snapshot y hash v1 de los valores finales.';

CREATE OR REPLACE FUNCTION public.convertir_presupuesto_en_venta_neutral(
  p_presupuesto_id uuid,
  p_cliente_id uuid,
  p_condicion_venta public.condicion_venta,
  p_pagos jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS TABLE(
  venta_id uuid,
  numero text,
  es_cta_cte boolean,
  cliente_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p public.presupuestos%ROWTYPE;
  v_payload jsonb;
  v_payload_hash text;
  v_pagos jsonb := COALESCE(p_pagos,'[]'::jsonb);
  v_pagos_canonicos jsonb;
  v_clientes uuid[];
  v_cliente_efectivo uuid;
  v_cliente_generico boolean;
  v_cajas uuid[];
  v_caja_prevalidada uuid;
  v_caja_real uuid;
  v_res record;
  v_cambio text;
  v_clave uuid;
  v_pagado numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'conversion-presupuesto:'||COALESCE(p_presupuesto_id::text,''),
      20260830
    )
  );

  SELECT p.*
    INTO v_p
    FROM public.presupuestos AS p
   WHERE p.id=p_presupuesto_id
     AND (
       public.is_admin(v_uid)
       OR p.sucursal_id=public.current_sucursal_id()
     )
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Presupuesto inexistente o sin acceso';
  END IF;

  IF pg_catalog.jsonb_typeof(v_pagos) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Los pagos de la conversión tienen un formato inválido';
  END IF;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             CASE
               WHEN pago.valor ? 'monto' THEN
                 pg_catalog.jsonb_set(
                   pago.valor,
                   '{monto}',
                   pg_catalog.to_jsonb(
                     pg_catalog.trim_scale((pago.valor->>'monto')::numeric)
                   ),
                   false
                 )
               ELSE pago.valor
             END
             ORDER BY pago.orden
           ),
           '[]'::jsonb
         )
    INTO v_pagos_canonicos
    FROM pg_catalog.jsonb_array_elements(v_pagos)
         WITH ORDINALITY AS pago(valor,orden);

  v_payload := pg_catalog.jsonb_build_object(
    'modo',CASE WHEN p_cliente_id IS NULL THEN 'ANONIMO' ELSE 'IDENTIFICADO' END,
    'clienteId',p_cliente_id,
    'condicionVenta',p_condicion_venta,
    'pagos',v_pagos_canonicos
  );
  v_payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_payload::text,'UTF8'),
      'sha256'
    ),
    'hex'
  );

  IF v_p.estado='CONVERTIDO' AND v_p.venta_id IS NOT NULL THEN
    IF v_p.conversion_payload_hash IS NULL
       OR v_p.conversion_payload_hash IS DISTINCT FROM v_payload_hash THEN
      RAISE EXCEPTION 'Este presupuesto ya fue convertido con otros datos';
    END IF;

    RETURN QUERY
    SELECT v.id,v.numero_comprobante,(v.condicion_venta='CTA_CTE'),v.cliente_id
      FROM public.ventas AS v
     WHERE v.id=v_p.venta_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La conversión guardada no tiene una venta válida';
    END IF;
    RETURN;
  END IF;

  IF v_p.estado<>'ABIERTO' THEN
    RAISE EXCEPTION 'Este presupuesto ya está %',pg_catalog.lower(v_p.estado);
  END IF;

  IF p_cliente_id IS NULL THEN
    IF p_condicion_venta IS DISTINCT FROM 'CONTADO'::public.condicion_venta THEN
      RAISE EXCEPTION 'Para vender a cuenta corriente identificá un cliente';
    END IF;

    SELECT pg_catalog.array_agg(candidato.id ORDER BY candidato.id)
      INTO v_clientes
      FROM (
        SELECT c.id
          FROM public.clientes AS c
         WHERE c.activo
           AND c.es_generico
           AND c.tipo='CONSUMIDOR_FINAL'
           AND c.sucursal_habitual_id IS NULL
           AND NOT COALESCE(c.es_obra,false)
         ORDER BY c.id
         LIMIT 2
         FOR SHARE OF c
      ) AS candidato;
    IF COALESCE(pg_catalog.cardinality(v_clientes),0)<>1 THEN
      RAISE EXCEPTION 'No hay un único Consumidor Final global activo';
    END IF;
    v_cliente_efectivo := v_clientes[1];
  ELSE
    SELECT c.id,c.es_generico
      INTO v_cliente_efectivo,v_cliente_generico
      FROM public.clientes AS c
     WHERE c.id=p_cliente_id
       AND c.activo
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cliente inexistente o inactivo';
    END IF;
    IF COALESCE(v_cliente_generico,false) THEN
      RAISE EXCEPTION 'El modo Consumidor Final se indica sin cliente';
    END IF;
  END IF;

  IF p_condicion_venta<>'CTA_CTE' AND v_p.total>=0.01 THEN
    SELECT COALESCE(pg_catalog.sum((x->>'monto')::numeric),0)
      INTO v_pagado
      FROM pg_catalog.jsonb_array_elements(v_pagos) AS x;
    IF v_pagado<0.01 THEN
      RAISE EXCEPTION 'Una venta al contado se cobra, aunque sea una parte. Si se lo lleva sin pagar nada, poné cuenta corriente.';
    END IF;
  END IF;

  PERFORM 1
    FROM public.productos AS p
   WHERE p.id IN (
     SELECT i.producto_id
       FROM public.presupuesto_items AS i
      WHERE i.presupuesto_id=p_presupuesto_id
   )
   ORDER BY p.id
   FOR UPDATE;

  SELECT pg_catalog.string_agg(i.codigo,', ')
    INTO v_cambio
    FROM public.presupuesto_items AS i
    JOIN public.productos AS p ON p.id=i.producto_id
   WHERE i.presupuesto_id=p_presupuesto_id
     AND p.iva_porcentaje IS DISTINCT FROM i.iva_porcentaje;
  IF v_cambio IS NOT NULL THEN
    RAISE EXCEPTION 'Cambió el IVA de: %. El total del presupuesto ya no es el que se cobraría: hacé un presupuesto nuevo.',
      v_cambio;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.presupuesto_items AS i
     WHERE i.presupuesto_id=p_presupuesto_id
  ) THEN
    RAISE EXCEPTION 'El presupuesto no tiene productos';
  END IF;

  PERFORM p_idempotency_key;
  v_clave := pg_catalog.md5('presupuesto:'||p_presupuesto_id::text)::uuid;
  IF EXISTS (
    SELECT 1 FROM public.ventas AS v WHERE v.idempotency_key=v_clave
  ) THEN
    RAISE EXCEPTION 'Ya hay una venta cargada con la clave de este presupuesto. Revisala antes de convertirlo.';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_p.sucursal_id::text,0)
  );
  SELECT pg_catalog.array_agg(caja.id ORDER BY caja.id)
    INTO v_cajas
    FROM (
      SELECT cs.id
        FROM public.caja_sesiones AS cs
       WHERE cs.sucursal_id=v_p.sucursal_id
         AND cs.estado='ABIERTA'
       ORDER BY cs.abierta_en DESC,cs.id
       LIMIT 2
       FOR SHARE OF cs
    ) AS caja;
  IF COALESCE(pg_catalog.cardinality(v_cajas),0)<>1 THEN
    RAISE EXCEPTION 'No hay una única caja abierta en la sucursal del presupuesto';
  END IF;
  v_caja_prevalidada := v_cajas[1];

  SELECT r.venta_id,r.numero,r.es_cta_cte
    INTO v_res
    FROM public._crear_venta_desde_presupuesto_20260830(
      p_presupuesto_id,v_cliente_efectivo,p_condicion_venta,v_pagos,v_clave
    ) AS r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La creación de la venta no devolvió resultado';
  END IF;

  SELECT v.caja_sesion_id
    INTO v_caja_real
    FROM public.ventas AS v
   WHERE v.id=v_res.venta_id
     AND v.sucursal_id=v_p.sucursal_id;
  IF v_caja_real IS DISTINCT FROM v_caja_prevalidada THEN
    RAISE EXCEPTION 'La venta no quedó vinculada a la caja prevalidada';
  END IF;

  UPDATE public.presupuestos
     SET estado='CONVERTIDO',
         venta_id=v_res.venta_id,
         conversion_payload_hash=v_payload_hash
   WHERE id=p_presupuesto_id;

  RETURN QUERY
  SELECT v_res.venta_id,v_res.numero,v_res.es_cta_cte,v_cliente_efectivo;
END;
$$;

ALTER FUNCTION public.convertir_presupuesto_en_venta_neutral(
  uuid,uuid,public.condicion_venta,jsonb,uuid
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.convertir_presupuesto_en_venta_neutral(
  uuid,uuid,public.condicion_venta,jsonb,uuid
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.convertir_presupuesto_en_venta_neutral(
  uuid,uuid,public.condicion_venta,jsonb,uuid
) TO authenticated,service_role;

COMMENT ON FUNCTION public.convertir_presupuesto_en_venta_neutral(
  uuid,uuid,public.condicion_venta,jsonb,uuid
) IS
  'Convierte un presupuesto con identidad explícita por renglón, hash final, caja preexistente y replay canónico.';
