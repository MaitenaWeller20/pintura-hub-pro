-- Lectura operativa user-bound de la cola fiscal. La función no eleva
-- privilegios: RLS sigue siendo la primera barrera y las mismas reglas de
-- capacidad/sucursal se repiten adentro para que una llamada RPC directa no
-- pueda depender de los filtros del navegador.

DROP FUNCTION IF EXISTS public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
);

CREATE FUNCTION public.cola_fiscal_lectura(
  p_tab text,
  p_page integer,
  p_page_size integer,
  p_desde date DEFAULT NULL,
  p_hasta date DEFAULT NULL,
  p_sucursal_id uuid DEFAULT NULL,
  p_emisor_id uuid DEFAULT NULL,
  p_documento text DEFAULT NULL,
  p_estado text DEFAULT NULL,
  p_venta_id uuid DEFAULT NULL
)
RETURNS TABLE (
  filas jsonb,
  pagina integer,
  tamano_pagina integer,
  total bigint,
  paginas integer,
  conteo_pendientes bigint,
  conteo_revisar bigint,
  conteo_emitidas bigint,
  conteo_historial bigint,
  filtros_disponibles jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_es_admin boolean := false;
  v_perfil_activo boolean;
  v_puede_facturar boolean;
  v_sucursal_perfil uuid;
  v_sucursal_activa boolean;
  v_sucursal_asignada boolean;
  v_sucursal_efectiva uuid;
  v_documento text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE='42501';
  END IF;
  IF p_tab IS NULL OR p_tab NOT IN ('pendientes','revisar','emitidas','historial') THEN
    RAISE EXCEPTION 'Pestaña fiscal inválida' USING ERRCODE='22023';
  END IF;
  IF p_page IS NULL OR p_page<1 THEN
    RAISE EXCEPTION 'La página fiscal debe ser mayor o igual a 1' USING ERRCODE='22023';
  END IF;
  IF p_page_size IS NULL OR p_page_size<1 OR p_page_size>100 THEN
    RAISE EXCEPTION 'El tamaño de página fiscal debe estar entre 1 y 100'
      USING ERRCODE='22023';
  END IF;
  IF p_desde IS NOT NULL AND p_hasta IS NOT NULL AND p_desde>p_hasta THEN
    RAISE EXCEPTION 'El rango de fechas fiscal es inválido' USING ERRCODE='22023';
  END IF;
  IF p_estado IS NOT NULL AND p_estado NOT IN (
    'SIN_FACTURAR','EMITIENDO','ERROR_CORREGIBLE','RECONCILIAR',
    'PENDIENTE','ERROR','BLOQUEADO','APROBADO','CANCELADO'
  ) THEN
    RAISE EXCEPTION 'Estado fiscal inválido' USING ERRCODE='22023';
  END IF;

  IF p_documento IS NOT NULL THEN
    IF pg_catalog.btrim(p_documento)='' OR p_documento !~ '^[0-9 .-]+$' THEN
      RAISE EXCEPTION 'Documento fiscal inválido' USING ERRCODE='22023';
    END IF;
    v_documento := pg_catalog.regexp_replace(p_documento,'[^0-9]','','g');
    IF v_documento='' THEN
      RAISE EXCEPTION 'Documento fiscal inválido' USING ERRCODE='22023';
    END IF;
  END IF;

  SELECT public.is_admin(v_uid)
    INTO v_es_admin;

  IF v_es_admin THEN
    v_sucursal_efectiva := p_sucursal_id;
  ELSE
    SELECT p.activo,p.puede_facturar,p.sucursal_id,s.activa,
           EXISTS (
             SELECT 1
               FROM public.profile_sucursales ps
              WHERE ps.profile_id=p.id
                AND ps.sucursal_id=p.sucursal_id
           )
      INTO v_perfil_activo,v_puede_facturar,v_sucursal_perfil,
           v_sucursal_activa,v_sucursal_asignada
      FROM public.profiles p
      LEFT JOIN public.sucursales s ON s.id=p.sucursal_id
     WHERE p.id=v_uid;

    IF NOT FOUND OR NOT COALESCE(v_perfil_activo,false) THEN
      RAISE EXCEPTION 'El perfil fiscal está inactivo o no existe' USING ERRCODE='42501';
    END IF;
    IF NOT COALESCE(v_puede_facturar,false) THEN
      RAISE EXCEPTION 'El perfil no tiene la capacidad fiscal puede_facturar'
        USING ERRCODE='42501';
    END IF;
    IF v_sucursal_perfil IS NULL
       OR NOT COALESCE(v_sucursal_activa,false)
       OR NOT COALESCE(v_sucursal_asignada,false) THEN
      RAISE EXCEPTION 'La sucursal activa del operador no está habilitada'
        USING ERRCODE='42501';
    END IF;
    -- Nunca se confía en el filtro de sucursal enviado por un empleado.
    v_sucursal_efectiva := v_sucursal_perfil;
  END IF;

  RETURN QUERY
  WITH ventas_autorizadas AS MATERIALIZED (
    SELECT
      v.*,
      c.razon_social AS cliente_razon_social,
      c.cuit_dni AS documento_comercial,
      s.id AS sucursal_viva_id,
      s.nombre AS sucursal_viva_nombre,
      s.emisor_id AS emisor_vivo_id,
      e.razon_social AS emisor_vivo_razon_social,
      e.cuit AS emisor_vivo_cuit,
      (
        v.afip_version>=2
        AND pg_catalog.jsonb_typeof(v.afip_snapshot)='object'
        AND v.afip_snapshot->>'version'='2'
      ) AS tiene_snapshot_v2
    FROM public.ventas v
    JOIN public.clientes c ON c.id=v.cliente_id
    JOIN public.sucursales s ON s.id=v.sucursal_id
    JOIN public.emisores e ON e.id=s.emisor_id
    WHERE v.afip_estado IN (
      'SIN_FACTURAR','EMITIENDO','ERROR_CORREGIBLE','RECONCILIAR',
      'PENDIENTE','ERROR','BLOQUEADO','APROBADO','CANCELADO'
    )
      AND (v_sucursal_efectiva IS NULL OR v.sucursal_id=v_sucursal_efectiva)
  ),
  normalizadas AS MATERIALIZED (
    SELECT
      va.id AS venta_id,
      -- El scope de autorización siempre usa la FK viva ya validada arriba.
      -- La ficha congelada de sucursal se proyecta aparte y puede ser NULL si
      -- una evidencia v2 quedó incompleta; eso no debe ocultar el incidente.
      va.sucursal_viva_id AS sucursal_autorizacion_id,
      va.tipo_comprobante::text AS tipo_comprobante,
      va.numero_comprobante,
      va.fecha AS fecha_comercial,
      va.afip_fecha_comprobante AS fecha_fiscal,
      va.cliente_id,
      va.cliente_razon_social,
      va.documento_comercial,
      CASE WHEN va.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.btrim(va.afip_snapshot#>>'{receptor,razonSocial}'),'')
        ELSE NULLIF(pg_catalog.btrim(va.afip_snapshot#>>'{receptor,razon_social}'),'')
      END AS receptor_razon_social,
      CASE WHEN va.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.btrim(va.afip_snapshot#>>'{receptor,tipoDocumento}'),'')
        ELSE NULL
      END AS receptor_tipo_documento,
      CASE WHEN va.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.regexp_replace(
          COALESCE(va.afip_snapshot#>>'{receptor,numeroDocumento}',''),'[^0-9]','','g'
        ),'')
        ELSE NULLIF(pg_catalog.regexp_replace(
          COALESCE(va.afip_snapshot#>>'{receptor,cuit_dni}',''),'[^0-9]','','g'
        ),'')
      END AS receptor_numero_documento,
      CASE WHEN va.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.btrim(va.afip_snapshot#>>'{receptor,condicionIva}'),'')
        ELSE NULLIF(pg_catalog.btrim(va.afip_snapshot#>>'{receptor,condicion_iva}'),'')
      END AS receptor_condicion_iva,
      CASE
        WHEN va.tiene_snapshot_v2
         AND COALESCE(va.afip_snapshot#>>'{emisor,id}','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN (va.afip_snapshot#>>'{emisor,id}')::uuid
        WHEN va.tiene_snapshot_v2 THEN NULL
        ELSE va.emisor_vivo_id
      END AS emisor_id,
      CASE WHEN va.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.btrim(va.afip_snapshot#>>'{emisor,razonSocial}'),'')
        ELSE va.emisor_vivo_razon_social
      END AS emisor_razon_social,
      CASE WHEN va.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.regexp_replace(
          COALESCE(va.afip_snapshot#>>'{emisor,cuit}',''),'[^0-9]','','g'
        ),'')
        ELSE va.emisor_vivo_cuit
      END AS emisor_cuit,
      CASE
        WHEN va.tiene_snapshot_v2
         AND COALESCE(va.afip_snapshot#>>'{sucursal,id}','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN (va.afip_snapshot#>>'{sucursal,id}')::uuid
        WHEN va.tiene_snapshot_v2 THEN NULL
        ELSE va.sucursal_viva_id
      END AS sucursal_id,
      CASE WHEN va.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.btrim(va.afip_snapshot#>>'{sucursal,nombre}'),'')
        ELSE va.sucursal_viva_nombre
      END AS sucursal_nombre,
      va.total::text AS total,
      va.total_pagado::text AS total_pagado,
      (va.total-va.total_pagado)::numeric(14,2)::text AS saldo,
      va.afip_estado,
      va.afip_fase,
      (
        va.afip_estado='EMITIENDO'
        AND (
          va.afip_claimed_at IS NULL
          OR va.afip_claimed_at+pg_catalog.make_interval(secs=>300)
             <=pg_catalog.statement_timestamp()
        )
      ) AS claim_vencido,
      (
        (va.fecha AT TIME ZONE 'America/Argentina/Cordoba')::date
          < (pg_catalog.statement_timestamp() AT TIME ZONE 'America/Argentina/Cordoba')::date-5
      ) AS venta_antigua,
      va.afip_validez,
      va.afip_punto_venta,
      va.afip_cbte_tipo,
      va.afip_numero,
      va.cae,
      va.cae_vencimiento
    FROM ventas_autorizadas va
  ),
  clasificadas AS MATERIALIZED (
    SELECT n.*,
      CASE
        WHEN n.afip_estado='SIN_FACTURAR' THEN 'pendientes'
        WHEN n.afip_estado='EMITIENDO' AND NOT n.claim_vencido THEN 'pendientes'
        WHEN n.afip_estado IN (
          'EMITIENDO','ERROR_CORREGIBLE','RECONCILIAR',
          'PENDIENTE','ERROR','BLOQUEADO'
        ) THEN 'revisar'
        WHEN n.afip_estado='APROBADO' THEN 'emitidas'
        WHEN n.afip_estado='CANCELADO' THEN 'historial'
      END AS tab
    FROM normalizadas n
  ),
  filtradas AS MATERIALIZED (
    SELECT c.*
      FROM clasificadas c
     WHERE (
       p_venta_id IS NOT NULL
       OR (
         (p_desde IS NULL OR c.fecha_comercial >= (p_desde::timestamp AT TIME ZONE 'America/Argentina/Cordoba'))
         AND (p_hasta IS NULL OR c.fecha_comercial < ((p_hasta+1)::timestamp AT TIME ZONE 'America/Argentina/Cordoba'))
       )
     )
       AND (p_venta_id IS NULL OR c.venta_id=p_venta_id)
       AND (
         v_sucursal_efectiva IS NULL
         OR c.sucursal_autorizacion_id=v_sucursal_efectiva
       )
       AND (p_emisor_id IS NULL OR c.emisor_id=p_emisor_id)
       AND (
         v_documento IS NULL
         OR pg_catalog.regexp_replace(COALESCE(c.documento_comercial,''),'[^0-9]','','g')=v_documento
         OR c.receptor_numero_documento=v_documento
       )
       AND (p_estado IS NULL OR c.afip_estado=p_estado)
  ),
  conteos AS (
    SELECT
      pg_catalog.count(*) FILTER (WHERE f.tab='pendientes')::bigint AS pendientes,
      pg_catalog.count(*) FILTER (WHERE f.tab='revisar')::bigint AS revisar,
      pg_catalog.count(*) FILTER (WHERE f.tab='emitidas')::bigint AS emitidas,
      pg_catalog.count(*) FILTER (WHERE f.tab='historial')::bigint AS historial
    FROM filtradas f
  ),
  de_pestana AS MATERIALIZED (
    SELECT f.*
      FROM filtradas f
     WHERE p_venta_id IS NOT NULL OR f.tab=p_tab
  ),
  total_pestana AS (
    SELECT pg_catalog.count(*)::bigint AS cantidad FROM de_pestana
  ),
  pagina_filas AS MATERIALIZED (
    SELECT d.*
      FROM de_pestana d
     ORDER BY d.fecha_comercial DESC,d.venta_id DESC
     LIMIT p_page_size
    OFFSET ((p_page-1)*p_page_size)
  ),
  sucursales_opcion AS (
    SELECT s.id,s.nombre
      FROM public.sucursales s
     WHERE v_es_admin OR s.id=v_sucursal_efectiva
     ORDER BY s.nombre,s.id
  ),
  emisores_opcion AS (
    SELECT DISTINCT e.id,e.razon_social,e.cuit
      FROM public.sucursales s
      JOIN public.emisores e ON e.id=s.emisor_id
     WHERE v_es_admin OR s.id=v_sucursal_efectiva
  ),
  opciones AS (
    SELECT pg_catalog.jsonb_build_object(
      'sucursales',COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('id',so.id,'nombre',so.nombre)
          ORDER BY so.nombre,so.id
        ) FROM sucursales_opcion so
      ),'[]'::jsonb),
      'emisores',COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id',eo.id,'razon_social',eo.razon_social,'cuit',eo.cuit
          ) ORDER BY eo.razon_social,eo.id
        ) FROM emisores_opcion eo
      ),'[]'::jsonb)
    ) AS valor
  ),
  pagina_json AS (
    SELECT COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'venta_id',p.venta_id,
        'tipo_comprobante',p.tipo_comprobante,
        'numero_comprobante',p.numero_comprobante,
        'fecha_comercial',p.fecha_comercial,
        'fecha_fiscal',p.fecha_fiscal,
        'cliente_id',p.cliente_id,
        'cliente_razon_social',p.cliente_razon_social,
        'documento_comercial',p.documento_comercial,
        'receptor_razon_social',p.receptor_razon_social,
        'receptor_tipo_documento',p.receptor_tipo_documento,
        'receptor_numero_documento',p.receptor_numero_documento,
        'receptor_condicion_iva',p.receptor_condicion_iva,
        'emisor_id',p.emisor_id,
        'emisor_razon_social',p.emisor_razon_social,
        'emisor_cuit',p.emisor_cuit,
        'sucursal_id',p.sucursal_id,
        'sucursal_nombre',p.sucursal_nombre,
        'total',p.total,
        'total_pagado',p.total_pagado,
        'saldo',p.saldo,
        'afip_estado',p.afip_estado,
        'afip_fase',p.afip_fase,
        'claim_vencido',p.claim_vencido,
        'venta_antigua',p.venta_antigua,
        'afip_validez',p.afip_validez,
        'afip_punto_venta',p.afip_punto_venta,
        'afip_cbte_tipo',p.afip_cbte_tipo,
        'afip_numero',p.afip_numero,
        'cae',p.cae,
        'cae_vencimiento',p.cae_vencimiento,
        'tab',p.tab
      ) ORDER BY p.fecha_comercial DESC,p.venta_id DESC
    ),'[]'::jsonb) AS valor
    FROM pagina_filas p
  )
  SELECT
    pj.valor,
    p_page,
    p_page_size,
    tp.cantidad,
    CASE WHEN tp.cantidad=0 THEN 0
      ELSE pg_catalog.ceil(tp.cantidad::numeric/p_page_size)::integer
    END,
    co.pendientes,co.revisar,co.emitidas,co.historial,
    op.valor
  FROM pagina_json pj
  CROSS JOIN total_pestana tp
  CROSS JOIN conteos co
  CROSS JOIN opciones op;
END;
$$;

REVOKE ALL ON FUNCTION public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
) TO authenticated;

COMMENT ON FUNCTION public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
) IS 'Cola fiscal paginada user-bound. Devuelve sólo proyección segura, conteos coherentes y filtros operativos públicos.';

-- La cola debe incluir coexistencia legacy hasta el corte definitivo y usar
-- un desempate total estable para la paginación por offset.
DROP INDEX IF EXISTS public.idx_ventas_cola_fiscal;
CREATE INDEX idx_ventas_cola_fiscal
  ON public.ventas (sucursal_id,afip_estado,fecha DESC,id DESC)
  WHERE afip_estado IN (
    'SIN_FACTURAR','EMITIENDO','APROBADO','ERROR_CORREGIBLE',
    'RECONCILIAR','CANCELADO','BLOQUEADO','PENDIENTE','ERROR'
  );

-- La baja de favoritos es lógica e idempotente por la RPC existente.
REVOKE DELETE ON TABLE public.receptores_fiscales FROM authenticated;
DROP POLICY IF EXISTS "receptores fiscales admin delete" ON public.receptores_fiscales;
