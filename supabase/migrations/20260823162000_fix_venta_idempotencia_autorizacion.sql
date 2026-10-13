-- La clave idempotente es una credencial de reintento, no una referencia pública.
-- Antes de esta migración crear_venta buscaba (y hasta reparaba) la venta por la
-- clave antes de comprobar actor/sucursal, y tampoco verificaba que el segundo
-- intento representara la misma operación comercial.

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS idempotency_payload_hash text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS c
     WHERE c.conrelid='public.ventas'::regclass
       AND c.conname='ventas_idempotency_payload_hash_check'
  ) THEN
    ALTER TABLE public.ventas
      ADD CONSTRAINT ventas_idempotency_payload_hash_check
      CHECK (
        idempotency_payload_hash IS NULL
        OR idempotency_payload_hash ~ '^[0-9a-f]{64}$'
      );
  END IF;
END;
$$;

COMMENT ON COLUMN public.ventas.idempotency_payload_hash IS
  'SHA-256 del input completo y actor que creó la venta. NULL identifica operaciones anteriores que no pueden reintentarse de forma verificable.';

-- Conservamos el escritor comercial probado como core owner-only. La RPC
-- exterior adquiere primero la autorización y la identidad idempotente; recién
-- entonces permite que el core lea/repare un replay o cree la operación.
ALTER FUNCTION public.crear_venta(
  uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,
  numeric,text,text,timestamptz,uuid,uuid
) RENAME TO _crear_venta_core_20260823;

REVOKE ALL ON FUNCTION public._crear_venta_core_20260823(
  uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,
  numeric,text,text,timestamptz,uuid,uuid
) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.crear_venta(
  p_sucursal_id uuid,
  p_cliente_id uuid,
  p_tipo_comprobante public.tipo_comprobante,
  p_condicion_venta public.condicion_venta,
  p_items jsonb,
  p_pagos jsonb,
  p_percepciones numeric DEFAULT 0,
  p_observaciones text DEFAULT NULL::text,
  p_nombre_obra text DEFAULT NULL::text,
  p_fecha timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_cbte_asoc_id uuid DEFAULT NULL::uuid,
  p_idempotency_key uuid DEFAULT NULL::uuid
)
RETURNS TABLE(venta_id uuid,numero text,es_cta_cte boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_actor_sucursal uuid;
  v_actor_activo boolean;
  v_es_admin boolean;
  v_payload jsonb;
  v_payload_hash text;
  v_ex public.ventas%ROWTYPE;
  v_es_replay boolean := false;
  v_venta_id uuid;
  v_numero text;
  v_es_cta_cte boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT p.sucursal_id,p.activo
    INTO v_actor_sucursal,v_actor_activo
    FROM public.profiles AS p
   WHERE p.id=v_uid;
  IF NOT FOUND OR v_actor_activo IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'El perfil autenticado no existe o está inactivo';
  END IF;

  v_es_admin := COALESCE(public.is_admin(v_uid),false);

  PERFORM 1
    FROM public.sucursales AS s
   WHERE s.id=p_sucursal_id AND s.activa;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sucursal no existe o está inactiva';
  END IF;

  IF NOT v_es_admin AND p_sucursal_id IS DISTINCT FROM v_actor_sucursal THEN
    RAISE EXCEPTION 'No podés facturar en una sucursal que no es la tuya';
  END IF;

  -- jsonb da una representación canónica (orden estable de claves y números).
  -- La versión permite evolucionar el contrato sin aceptar hashes ambiguos. Se
  -- incluyen todos los parámetros, la propia clave y el actor autenticado.
  v_payload := pg_catalog.jsonb_build_object(
    'version',1,
    'actor_id',v_uid,
    'sucursal_id',p_sucursal_id,
    'cliente_id',p_cliente_id,
    'tipo_comprobante',p_tipo_comprobante,
    'condicion_venta',p_condicion_venta,
    'items',p_items,
    'pagos',p_pagos,
    'percepciones',p_percepciones,
    'observaciones',p_observaciones,
    'nombre_obra',p_nombre_obra,
    'fecha',p_fecha,
    'cbte_asoc_id',p_cbte_asoc_id,
    'idempotency_key',p_idempotency_key
  );
  v_payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_payload::text,'UTF8'),
      'sha256'
    ),
    'hex'
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_idempotency_key::text,0)
    );
    SELECT v.* INTO v_ex
      FROM public.ventas AS v
     WHERE v.idempotency_key=p_idempotency_key
     FOR UPDATE;
    IF FOUND THEN
      v_es_replay := true;
      IF v_ex.usuario_id IS DISTINCT FROM v_uid
         OR v_ex.sucursal_id IS DISTINCT FROM p_sucursal_id
         OR v_ex.idempotency_payload_hash IS NULL
         OR v_ex.idempotency_payload_hash IS DISTINCT FROM v_payload_hash THEN
        -- Un único error deliberadamente opaco: no revela si la clave existe,
        -- si pertenece a otro actor/sucursal o si el payload fue alterado.
        RAISE EXCEPTION 'La clave de idempotencia no corresponde a esta operación';
      END IF;
    END IF;
  END IF;

  SELECT r.venta_id,r.numero,r.es_cta_cte
    INTO v_venta_id,v_numero,v_es_cta_cte
    FROM public._crear_venta_core_20260823(
      p_sucursal_id,p_cliente_id,p_tipo_comprobante,p_condicion_venta,
      p_items,p_pagos,p_percepciones,p_observaciones,p_nombre_obra,p_fecha,
      p_cbte_asoc_id,p_idempotency_key
    ) AS r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La creación de la venta no devolvió resultado';
  END IF;

  IF p_idempotency_key IS NOT NULL AND NOT v_es_replay THEN
    UPDATE public.ventas AS v
       SET idempotency_payload_hash=v_payload_hash
     WHERE v.id=v_venta_id
       AND v.idempotency_key=p_idempotency_key
       AND v.idempotency_payload_hash IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No se pudo vincular la huella idempotente a la venta';
    END IF;
  END IF;

  RETURN QUERY SELECT v_venta_id,v_numero,v_es_cta_cte;
END;
$$;

REVOKE ALL ON FUNCTION public.crear_venta(
  uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,
  numeric,text,text,timestamptz,uuid,uuid
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.crear_venta(
  uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,
  numeric,text,text,timestamptz,uuid,uuid
) TO authenticated,service_role;

COMMENT ON FUNCTION public.crear_venta(
  uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,
  numeric,text,text,timestamptz,uuid,uuid
) IS
  'Escritor comercial atómico con replay ligado a actor, sucursal y SHA-256 del payload completo.';

COMMENT ON FUNCTION public._crear_venta_core_20260823(
  uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,jsonb,
  numeric,text,text,timestamptz,uuid,uuid
) IS
  'Core owner-only de crear_venta. No exponer: la envoltura pública aplica autorización y fingerprint idempotente.';
