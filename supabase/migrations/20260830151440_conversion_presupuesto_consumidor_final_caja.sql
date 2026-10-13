-- Conversión v2 de presupuestos: el modo sin cliente resuelve un único
-- Consumidor Final global, pero la venta siempre conserva cliente_id NOT NULL.
-- La sucursal nace exclusivamente del presupuesto y la caja debe existir antes
-- de entrar al escritor comercial: este flujo nunca usa la autoapertura.

DO $preflight_consumidor_final$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM public.clientes AS c
     WHERE c.activo
       AND c.es_generico
       AND c.tipo='CONSUMIDOR_FINAL'
       AND c.sucursal_habitual_id IS NULL
       AND NOT COALESCE(c.es_obra,false)
  ) > 1 THEN
    RAISE EXCEPTION 'Hay más de un Consumidor Final global activo; corregí los clientes antes de continuar';
  END IF;
END;
$preflight_consumidor_final$;

CREATE UNIQUE INDEX uq_cliente_consumidor_final_global_activo
  ON public.clientes ((true))
  WHERE activo
    AND es_generico
    AND tipo='CONSUMIDOR_FINAL'
    AND sucursal_habitual_id IS NULL
    AND NOT COALESCE(es_obra,false);

ALTER TABLE public.presupuestos
  ADD COLUMN conversion_payload_hash text,
  ADD CONSTRAINT presupuestos_conversion_payload_hash_sha256
    CHECK (
      conversion_payload_hash IS NULL
      OR conversion_payload_hash~'^[0-9a-f]{64}$'
    );

COMMENT ON COLUMN public.presupuestos.conversion_payload_hash IS
  'SHA-256 canónico de modo, cliente declarado, condición y pagos usados al convertir. NULL identifica presupuestos abiertos o conversiones históricas sin replay verificable.';

-- RETURNS TABLE cambia para devolver el receptor efectivo: PostgreSQL exige
-- recrear la firma, aunque los argumentos sigan siendo exactamente los mismos.
DROP FUNCTION public.convertir_presupuesto_en_venta_neutral(
  uuid,uuid,public.condicion_venta,jsonb,uuid
);

CREATE FUNCTION public.convertir_presupuesto_en_venta_neutral(
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
  v_items jsonb;
  v_res record;
  v_cambio text;
  v_clave uuid;
  v_pagado numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- Una misma identidad de presupuesto serializa lectura, creación y replay.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'conversion-presupuesto:'||COALESCE(p_presupuesto_id::text,''),
      20260830
    )
  );

  -- Autorización y existencia forman una sola frontera BOLA. SECURITY DEFINER
  -- no puede leer primero y explicar después si la fila existe en otra sucursal.
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

  -- jsonb ordena claves, pero conserva la escala textual de numeric (121 y
  -- 121.00 comparan igual aunque se serializan distinto). trim_scale evita que
  -- dos reintentos comerciales equivalentes produzcan huellas diferentes.
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

  -- jsonb aporta además orden estable para las claves del objeto exterior.
  -- La key de transporte no participa: la identidad durable sigue derivándose
  -- del presupuesto y sólo estos cuatro datos definen un replay comercial.
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

  -- El replay se resuelve antes de volver a exigir candidato o caja actuales.
  -- Así un reintento de una operación ya confirmada nunca duplica efectos.
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

    -- LIMIT 2 conserva una comprobación fail-closed aunque el índice se haya
    -- dañado; FOR SHARE bloquea toda mutación de elegibilidad hasta confirmar.
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

  -- Conserva las validaciones comerciales de la definición efectiva anterior.
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

  SELECT COALESCE(
           pg_catalog.jsonb_agg(item.payload ORDER BY item.payload->>'producto_id'),
           '[]'::jsonb
         )
    INTO v_items
    FROM (
      SELECT pg_catalog.jsonb_build_object(
               'producto_id',i.producto_id,
               'cantidad',i.cantidad,
               'precio_unitario_sin_iva',i.precio_sin_iva,
               'descripcion',i.descripcion
             ) AS payload
        FROM public.presupuesto_items AS i
       WHERE i.presupuesto_id=p_presupuesto_id
    ) AS item;
  IF pg_catalog.jsonb_array_length(v_items)=0 THEN
    RAISE EXCEPTION 'El presupuesto no tiene productos';
  END IF;

  -- La firma conserva la key enviada por compatibilidad, pero la venta usa una
  -- identidad determinística por presupuesto y el hash de arriba no la incluye.
  PERFORM p_idempotency_key;
  v_clave := pg_catalog.md5('presupuesto:'||p_presupuesto_id::text)::uuid;
  IF EXISTS (
    SELECT 1 FROM public.ventas AS v WHERE v.idempotency_key=v_clave
  ) THEN
    RAISE EXCEPTION 'Ya hay una venta cargada con la clave de este presupuesto. Revisala antes de convertirlo.';
  END IF;

  -- crear_venta toma productos antes de caja. La conversión conserva el mismo
  -- orden: recién después de bloquear/construir los ítems toma el advisory y la
  -- fila ABIERTA. Si cerrar_caja ganó se reevalúa a cero; si esta transacción
  -- ganó, el cierre espera. Nada comercial se mutó antes de esta prevalidación.
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
    FROM public.crear_venta(
      v_p.sucursal_id,v_cliente_efectivo,'VENTA',p_condicion_venta,
      v_items,v_pagos,0,
      'Presupuesto '||v_p.numero,NULL,NULL,NULL,v_clave
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
  'Convierte un presupuesto con receptor efectivo, caja preexistente de su sucursal y replay ligado al payload canónico.';
