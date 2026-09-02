-- Final-review hardening: close the public queue projection and remove direct
-- authenticated reads of backend-only fiscal evidence. Forward-only migration.

CREATE OR REPLACE FUNCTION public.cola_fiscal_lectura(p_tab text, p_page integer, p_page_size integer, p_desde date DEFAULT NULL::date, p_hasta date DEFAULT NULL::date, p_sucursal_id uuid DEFAULT NULL::uuid, p_emisor_id uuid DEFAULT NULL::uuid, p_documento text DEFAULT NULL::text, p_estado text DEFAULT NULL::text, p_venta_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(filas jsonb, pagina integer, tamano_pagina integer, total bigint, paginas integer, conteo_pendientes bigint, conteo_revisar bigint, conteo_emitidas bigint, conteo_historial bigint, filtros_disponibles jsonb)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_pagina_efectiva integer;
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

  v_pagina_efectiva := CASE WHEN p_venta_id IS NULL THEN p_page ELSE 1 END;

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
    v_sucursal_efectiva := v_sucursal_perfil;
  END IF;

  RETURN QUERY
  WITH scope_ids AS MATERIALIZED (
    -- La rama exacta conserva acceso por ventas_pkey y omite sólo el rango de
    -- fechas. Autorización, estado y todos los demás filtros siguen vigentes.
    SELECT
      v.id AS venta_id,
      v.sucursal_id AS sucursal_autorizacion_id,
      v.fecha AS fecha_comercial,
      v.afip_estado,
      v.afip_fase,
      v.afip_claimed_at,
      v.afip_numero,
      v.afip_legacy_incompleto
    FROM public.ventas v
    WHERE p_venta_id IS NOT NULL
      AND v.id=p_venta_id
      AND v.afip_estado IN (
        'SIN_FACTURAR','EMITIENDO','ERROR_CORREGIBLE','RECONCILIAR',
        'PENDIENTE','ERROR','BLOQUEADO','APROBADO','CANCELADO'
      )
      AND (v_sucursal_efectiva IS NULL OR v.sucursal_id=v_sucursal_efectiva)
      AND (p_estado IS NULL OR v.afip_estado=p_estado)

    UNION ALL

    SELECT
      v.id AS venta_id,
      v.sucursal_id AS sucursal_autorizacion_id,
      v.fecha AS fecha_comercial,
      v.afip_estado,
      v.afip_fase,
      v.afip_claimed_at,
      v.afip_numero,
      v.afip_legacy_incompleto
    FROM public.ventas v
    WHERE p_venta_id IS NULL
      AND v.afip_estado IN (
        'SIN_FACTURAR','EMITIENDO','ERROR_CORREGIBLE','RECONCILIAR',
        'PENDIENTE','ERROR','BLOQUEADO','APROBADO','CANCELADO'
      )
      AND (v_sucursal_efectiva IS NULL OR v.sucursal_id=v_sucursal_efectiva)
      AND (p_estado IS NULL OR v.afip_estado=p_estado)
      AND (
        p_desde IS NULL
        OR v.fecha >= (p_desde::timestamp AT TIME ZONE 'America/Argentina/Cordoba')
      )
      AND (
        p_hasta IS NULL
        OR v.fecha < ((p_hasta+1)::timestamp AT TIME ZONE 'America/Argentina/Cordoba')
      )
  ),
  clasificadas AS MATERIALIZED (
    SELECT s.*,
      (
        s.afip_estado='EMITIENDO'
        AND (
          s.afip_claimed_at IS NULL
          OR s.afip_claimed_at+pg_catalog.make_interval(secs=>300)
             <=pg_catalog.statement_timestamp()
        )
      ) AS reclamo_vencido,
      CASE
        WHEN s.afip_estado='SIN_FACTURAR' THEN 'pendientes'
        WHEN s.afip_estado='EMITIENDO' AND NOT (
          s.afip_claimed_at IS NULL
          OR s.afip_claimed_at+pg_catalog.make_interval(secs=>300)
             <=pg_catalog.statement_timestamp()
        ) THEN 'pendientes'
        WHEN s.afip_estado IN (
          'EMITIENDO','ERROR_CORREGIBLE','RECONCILIAR',
          'PENDIENTE','ERROR','BLOQUEADO'
        ) THEN 'revisar'
        WHEN s.afip_estado='APROBADO' THEN 'emitidas'
        WHEN s.afip_estado='CANCELADO' THEN 'historial'
      END AS tab
    FROM scope_ids s
  ),
  filtradas AS MATERIALIZED (
    SELECT c.*
      FROM clasificadas c
     WHERE (
       (p_emisor_id IS NULL AND v_documento IS NULL)
       OR EXISTS (
         SELECT 1
           FROM public.ventas vf
           JOIN public.clientes cf ON cf.id=vf.cliente_id
           JOIN public.sucursales sf ON sf.id=vf.sucursal_id
          WHERE vf.id=c.venta_id
            AND (
              v_documento IS NULL
              OR pg_catalog.regexp_replace(
                   COALESCE(cf.cuit_dni,''),'[^0-9]','','g'
                 )=v_documento
              OR CASE
                WHEN vf.afip_version>=2
                 AND pg_catalog.jsonb_typeof(vf.afip_snapshot)='object'
                 AND vf.afip_snapshot->>'version' IN ('2','3')
                 AND public.validar_snapshot_fiscal_persistido(vf.afip_snapshot)=((vf.afip_snapshot->>'version')::integer)
                  THEN NULLIF(pg_catalog.regexp_replace(
                    COALESCE(vf.afip_snapshot#>>'{receptor,numeroDocumento}',''),
                    '[^0-9]','','g'
                  ),'')
                ELSE NULLIF(pg_catalog.regexp_replace(
                  COALESCE(vf.afip_snapshot#>>'{receptor,cuit_dni}',''),
                  '[^0-9]','','g'
                ),'')
              END=v_documento
            )
            AND (
              p_emisor_id IS NULL
              OR CASE
                WHEN vf.afip_version>=2
                 AND pg_catalog.jsonb_typeof(vf.afip_snapshot)='object'
                 AND vf.afip_snapshot->>'version' IN ('2','3')
                 AND public.validar_snapshot_fiscal_persistido(vf.afip_snapshot)=((vf.afip_snapshot->>'version')::integer)
                 AND COALESCE(vf.afip_snapshot#>>'{emisor,id}','')
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                  THEN (vf.afip_snapshot#>>'{emisor,id}')::uuid
                WHEN vf.afip_version>=2
                 AND pg_catalog.jsonb_typeof(vf.afip_snapshot)='object'
                 AND vf.afip_snapshot->>'version' IN ('2','3')
                 AND public.validar_snapshot_fiscal_persistido(vf.afip_snapshot)=((vf.afip_snapshot->>'version')::integer) THEN NULL
                ELSE sf.emisor_id
              END=p_emisor_id
            )
       )
     )
  ),
  conteos AS (
    SELECT
      pg_catalog.count(*) FILTER (WHERE f.tab='pendientes')::bigint AS pendientes,
      pg_catalog.count(*) FILTER (WHERE f.tab='revisar')::bigint AS revisar,
      pg_catalog.count(*) FILTER (WHERE f.tab='emitidas')::bigint AS emitidas,
      pg_catalog.count(*) FILTER (WHERE f.tab='historial')::bigint AS historial
    FROM filtradas f
  ),
  de_pestana_ids AS MATERIALIZED (
    SELECT f.venta_id,f.fecha_comercial
      FROM filtradas f
     WHERE p_venta_id IS NOT NULL OR f.tab=p_tab
  ),
  total_pestana AS (
    SELECT pg_catalog.count(*)::bigint AS cantidad FROM de_pestana_ids
  ),
  pagina_ids AS MATERIALIZED (
    SELECT d.venta_id,d.fecha_comercial
      FROM de_pestana_ids d
     ORDER BY d.fecha_comercial DESC,d.venta_id DESC
     LIMIT p_page_size
    OFFSET ((v_pagina_efectiva-1)::bigint*p_page_size::bigint)
  ),
  pagina_base AS (
    SELECT
      p.venta_id,
      p.fecha_comercial,
      v.sucursal_id AS sucursal_autorizacion_id,
      v.tipo_comprobante::text AS tipo_comprobante,
      v.numero_comprobante,
      v.afip_fecha_comprobante AS fecha_fiscal,
      v.cliente_id,
      c.razon_social AS cliente_razon_social,
      c.cuit_dni AS documento_comercial,
      s.id AS sucursal_viva_id,
      s.nombre AS sucursal_viva_nombre,
      s.emisor_id AS emisor_vivo_id,
      e.razon_social AS emisor_vivo_razon_social,
      e.cuit AS emisor_vivo_cuit,
      v.total,
      v.total_pagado,
      v.afip_estado,
      v.afip_fase,
      v.afip_claimed_at,
      v.afip_legacy_incompleto,
      v.afip_validez,
      v.afip_punto_venta,
      v.afip_cbte_tipo,
      v.afip_numero,
      v.cae,
      v.cae_vencimiento,
      v.periodo_asoc_desde,
      v.periodo_asoc_hasta,
      v.nc_periodo_modalidad::text AS nc_periodo_modalidad,
      v.motivo_nota_credito,
      v.nc_resolucion::text AS nc_resolucion,
      v.nc_efectos_aplicados_at,
      v.afip_snapshot,
      (
        v.afip_version>=2
        AND pg_catalog.jsonb_typeof(v.afip_snapshot)='object'
        AND v.afip_snapshot->>'version' IN ('2','3')
        AND public.validar_snapshot_fiscal_persistido(v.afip_snapshot)=((v.afip_snapshot->>'version')::integer)
      ) AS tiene_snapshot_persistido
    FROM pagina_ids p
    JOIN public.ventas v ON v.id=p.venta_id
    JOIN public.clientes c ON c.id=v.cliente_id
    JOIN public.sucursales s ON s.id=v.sucursal_id
    JOIN public.emisores e ON e.id=s.emisor_id
  ),
  pagina_detalle AS (
    SELECT
      pb.venta_id,
      pb.tipo_comprobante,
      pb.numero_comprobante,
      pb.fecha_comercial,
      pb.fecha_fiscal,
      pb.cliente_id,
      pb.cliente_razon_social,
      pb.documento_comercial,
      CASE WHEN pb.tiene_snapshot_persistido
        THEN NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{receptor,razonSocial}'),'')
        ELSE NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{receptor,razon_social}'),'')
      END AS receptor_razon_social,
      CASE WHEN pb.tiene_snapshot_persistido
        THEN NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{receptor,tipoDocumento}'),'')
        ELSE NULL
      END AS receptor_tipo_documento,
      CASE WHEN pb.tiene_snapshot_persistido
        THEN NULLIF(pg_catalog.regexp_replace(
          COALESCE(pb.afip_snapshot#>>'{receptor,numeroDocumento}',''),'[^0-9]','','g'
        ),'')
        ELSE NULLIF(pg_catalog.regexp_replace(
          COALESCE(pb.afip_snapshot#>>'{receptor,cuit_dni}',''),'[^0-9]','','g'
        ),'')
      END AS receptor_numero_documento,
      CASE WHEN pb.tiene_snapshot_persistido
        THEN NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{receptor,condicionIva}'),'')
        ELSE NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{receptor,condicion_iva}'),'')
      END AS receptor_condicion_iva,
      CASE
        WHEN pb.tiene_snapshot_persistido
         AND COALESCE(pb.afip_snapshot#>>'{emisor,id}','')
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN (pb.afip_snapshot#>>'{emisor,id}')::uuid
        WHEN pb.tiene_snapshot_persistido THEN NULL
        ELSE pb.emisor_vivo_id
      END AS emisor_id,
      CASE WHEN pb.tiene_snapshot_persistido
        THEN NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{emisor,razonSocial}'),'')
        ELSE pb.emisor_vivo_razon_social
      END AS emisor_razon_social,
      CASE WHEN pb.tiene_snapshot_persistido
        THEN NULLIF(pg_catalog.regexp_replace(
          COALESCE(pb.afip_snapshot#>>'{emisor,cuit}',''),'[^0-9]','','g'
        ),'')
        ELSE pb.emisor_vivo_cuit
      END AS emisor_cuit,
      CASE
        WHEN pb.tiene_snapshot_persistido
         AND COALESCE(pb.afip_snapshot#>>'{sucursal,id}','')
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN (pb.afip_snapshot#>>'{sucursal,id}')::uuid
        WHEN pb.tiene_snapshot_persistido THEN NULL
        ELSE pb.sucursal_viva_id
      END AS sucursal_id,
      CASE WHEN pb.tiene_snapshot_persistido
        THEN NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{sucursal,nombre}'),'')
        ELSE pb.sucursal_viva_nombre
      END AS sucursal_nombre,
      pb.total::text AS total,
      pb.total_pagado::text AS total_pagado,
      (pb.total-pb.total_pagado)::numeric(14,2)::text AS saldo,
      pb.afip_estado,
      pb.afip_fase,
      pb.afip_legacy_incompleto,
      (
        pb.afip_estado='EMITIENDO'
        AND (
          pb.afip_claimed_at IS NULL
          OR pb.afip_claimed_at+pg_catalog.make_interval(secs=>300)
             <=pg_catalog.statement_timestamp()
        )
      ) AS reclamo_vencido,
      (
        (pb.fecha_comercial AT TIME ZONE 'America/Argentina/Cordoba')::date
          < (pg_catalog.statement_timestamp() AT TIME ZONE 'America/Argentina/Cordoba')::date-5
      ) AS venta_antigua,
      pb.afip_validez,
      pb.afip_punto_venta,
      pb.afip_cbte_tipo,
      pb.afip_numero,
      pb.cae,
      pb.cae_vencimiento,
      pb.periodo_asoc_desde,
      pb.periodo_asoc_hasta,
      pb.nc_periodo_modalidad,
      pb.motivo_nota_credito,
      pb.nc_resolucion,
      pb.nc_efectos_aplicados_at,
      CASE
        WHEN pb.afip_estado='SIN_FACTURAR' THEN 'pendientes'
        WHEN pb.afip_estado='EMITIENDO' AND NOT (
          pb.afip_claimed_at IS NULL
          OR pb.afip_claimed_at+pg_catalog.make_interval(secs=>300)
             <=pg_catalog.statement_timestamp()
        ) THEN 'pendientes'
        WHEN pb.afip_estado IN (
          'EMITIENDO','ERROR_CORREGIBLE','RECONCILIAR',
          'PENDIENTE','ERROR','BLOQUEADO'
        ) THEN 'revisar'
        WHEN pb.afip_estado='APROBADO' THEN 'emitidas'
        WHEN pb.afip_estado='CANCELADO' THEN 'historial'
      END AS tab
    FROM pagina_base pb
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
        'afip_legacy_incompleto',p.afip_legacy_incompleto,
        'reclamo_vencido',p.reclamo_vencido,
        'venta_antigua',p.venta_antigua,
        'afip_validez',p.afip_validez,
        'afip_punto_venta',p.afip_punto_venta,
        'afip_cbte_tipo',p.afip_cbte_tipo,
        'afip_numero',p.afip_numero,
        'cae',p.cae,
        'cae_vencimiento',p.cae_vencimiento,
        'periodo_asoc_desde',p.periodo_asoc_desde,
        'periodo_asoc_hasta',p.periodo_asoc_hasta,
        'nc_periodo_modalidad',p.nc_periodo_modalidad,
        'motivo_nota_credito',p.motivo_nota_credito,
        'nc_resolucion',p.nc_resolucion,
        'nc_efectos_aplicados_at',p.nc_efectos_aplicados_at,
        'tab',p.tab
      ) ORDER BY p.fecha_comercial DESC,p.venta_id DESC
    ),'[]'::jsonb) AS valor
    FROM pagina_detalle p
  )
  SELECT
    pj.valor,
    v_pagina_efectiva,
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
$function$;

ALTER FUNCTION public.cola_fiscal_lectura(text,integer,integer,date,date,uuid,uuid,text,text,uuid)
  OWNER TO postgres;

COMMENT ON FUNCTION public.cola_fiscal_lectura(text,integer,integer,date,date,uuid,uuid,text,text,uuid) IS
  'Cola fiscal auth-first con proyección cerrada: no serializa snapshots, hashes, claims, idempotencia ni payloads.';

REVOKE ALL ON FUNCTION public.cola_fiscal_lectura(text,integer,integer,date,date,uuid,uuid,text,text,uuid)
  FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.cola_fiscal_lectura(text,integer,integer,date,date,uuid,uuid,text,text,uuid)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cola_fiscal_lectura(text,integer,integer,date,date,uuid,uuid,text,text,uuid)
  TO authenticated;

REVOKE SELECT (
  afip_claim_token,
  afip_claimed_at,
  afip_snapshot,
  afip_snapshot_hash,
  idempotency_key,
  idempotency_payload_hash,
  anulacion_idempotency_key,
  anulacion_idempotency_payload_hash
) ON TABLE public.ventas FROM PUBLIC,anon,authenticated;
