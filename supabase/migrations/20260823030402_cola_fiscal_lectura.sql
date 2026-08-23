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
      ) AS claim_vencido,
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
                 AND vf.afip_snapshot->>'version'='2'
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
                 AND vf.afip_snapshot->>'version'='2'
                 AND COALESCE(vf.afip_snapshot#>>'{emisor,id}','')
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                  THEN (vf.afip_snapshot#>>'{emisor,id}')::uuid
                WHEN vf.afip_version>=2
                 AND pg_catalog.jsonb_typeof(vf.afip_snapshot)='object'
                 AND vf.afip_snapshot->>'version'='2' THEN NULL
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
      v.afip_snapshot,
      (
        v.afip_version>=2
        AND pg_catalog.jsonb_typeof(v.afip_snapshot)='object'
        AND v.afip_snapshot->>'version'='2'
      ) AS tiene_snapshot_v2
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
      CASE WHEN pb.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{receptor,razonSocial}'),'')
        ELSE NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{receptor,razon_social}'),'')
      END AS receptor_razon_social,
      CASE WHEN pb.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{receptor,tipoDocumento}'),'')
        ELSE NULL
      END AS receptor_tipo_documento,
      CASE WHEN pb.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.regexp_replace(
          COALESCE(pb.afip_snapshot#>>'{receptor,numeroDocumento}',''),'[^0-9]','','g'
        ),'')
        ELSE NULLIF(pg_catalog.regexp_replace(
          COALESCE(pb.afip_snapshot#>>'{receptor,cuit_dni}',''),'[^0-9]','','g'
        ),'')
      END AS receptor_numero_documento,
      CASE WHEN pb.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{receptor,condicionIva}'),'')
        ELSE NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{receptor,condicion_iva}'),'')
      END AS receptor_condicion_iva,
      CASE
        WHEN pb.tiene_snapshot_v2
         AND COALESCE(pb.afip_snapshot#>>'{emisor,id}','')
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN (pb.afip_snapshot#>>'{emisor,id}')::uuid
        WHEN pb.tiene_snapshot_v2 THEN NULL
        ELSE pb.emisor_vivo_id
      END AS emisor_id,
      CASE WHEN pb.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.btrim(pb.afip_snapshot#>>'{emisor,razonSocial}'),'')
        ELSE pb.emisor_vivo_razon_social
      END AS emisor_razon_social,
      CASE WHEN pb.tiene_snapshot_v2
        THEN NULLIF(pg_catalog.regexp_replace(
          COALESCE(pb.afip_snapshot#>>'{emisor,cuit}',''),'[^0-9]','','g'
        ),'')
        ELSE pb.emisor_vivo_cuit
      END AS emisor_cuit,
      CASE
        WHEN pb.tiene_snapshot_v2
         AND COALESCE(pb.afip_snapshot#>>'{sucursal,id}','')
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN (pb.afip_snapshot#>>'{sucursal,id}')::uuid
        WHEN pb.tiene_snapshot_v2 THEN NULL
        ELSE pb.sucursal_viva_id
      END AS sucursal_id,
      CASE WHEN pb.tiene_snapshot_v2
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
      ) AS claim_vencido,
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
$$;

REVOKE ALL ON FUNCTION public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
) TO authenticated;

COMMENT ON FUNCTION public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
) IS 'Cola fiscal paginada user-bound. Filtra y cuenta candidatos angostos antes de expandir sólo los IDs de la página.';

CREATE OR REPLACE FUNCTION public.guardar_receptor_fiscal_desde_venta(
  p_venta_id uuid
)
RETURNS TABLE (
  id uuid,
  sucursal_id uuid,
  cliente_comercial_id uuid,
  tipo_documento text,
  numero_documento text,
  razon_social text,
  condicion_iva text,
  domicilio text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
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
  v_venta public.ventas%ROWTYPE;
  v_receptor jsonb;
  v_tipo_documento text;
  v_numero_documento text;
  v_razon_social text;
  v_condicion_iva text;
  v_domicilio text;
  v_favorito public.receptores_fiscales%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE='42501';
  END IF;

  SELECT public.is_admin(v_uid) INTO v_es_admin;
  IF NOT v_es_admin THEN
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

    IF NOT FOUND
       OR NOT COALESCE(v_perfil_activo,false)
       OR NOT COALESCE(v_puede_facturar,false)
       OR v_sucursal_perfil IS NULL
       OR NOT COALESCE(v_sucursal_activa,false)
       OR NOT COALESCE(v_sucursal_asignada,false) THEN
      RAISE EXCEPTION 'Perfil o sucursal sin capacidad fiscal activa'
        USING ERRCODE='42501';
    END IF;
  END IF;

  SELECT v.* INTO v_venta
    FROM public.ventas v
   WHERE v.id=p_venta_id
   FOR SHARE;

  IF NOT FOUND
     OR (NOT v_es_admin AND v_venta.sucursal_id IS DISTINCT FROM v_sucursal_perfil) THEN
    RAISE EXCEPTION 'Venta inexistente o no visible para el operador'
      USING ERRCODE='42501';
  END IF;
  IF v_venta.afip_estado IS DISTINCT FROM 'APROBADO'
     OR v_venta.afip_fase IS DISTINCT FROM 'PERSISTIDO'
     OR v_venta.afip_version<2
     OR v_venta.afip_legacy_incompleto
     OR v_venta.cae IS NULL
     OR pg_catalog.btrim(v_venta.cae)=''
     OR pg_catalog.jsonb_typeof(v_venta.afip_snapshot) IS DISTINCT FROM 'object'
     OR v_venta.afip_snapshot->>'version' IS DISTINCT FROM '2'
     OR v_venta.afip_snapshot->>'hash' IS DISTINCT FROM v_venta.afip_snapshot_hash THEN
    RAISE EXCEPTION 'Sólo se guarda desde evidencia v2 APROBADO/PERSISTIDO'
      USING ERRCODE='42501';
  END IF;

  PERFORM public.validar_snapshot_fiscal_v2(v_venta.afip_snapshot);

  IF v_venta.afip_snapshot#>>'{venta,id}' IS DISTINCT FROM v_venta.id::text
     OR v_venta.afip_snapshot#>>'{sucursal,id}' IS DISTINCT FROM v_venta.sucursal_id::text THEN
    RAISE EXCEPTION 'La evidencia fiscal no corresponde a la venta o sucursal'
      USING ERRCODE='42501';
  END IF;

  v_receptor := v_venta.afip_snapshot->'receptor';
  IF v_receptor->>'origen' IS DISTINCT FROM 'MANUAL'
     OR pg_catalog.jsonb_typeof(v_receptor->'origenId') IS DISTINCT FROM 'null'
     OR v_receptor->>'tipoDocumento' NOT IN ('CUIT','CUIL','DNI','CDI') THEN
    RAISE EXCEPTION 'Sólo se guarda un receptor manual identificado'
      USING ERRCODE='42501';
  END IF;

  v_tipo_documento := v_receptor->>'tipoDocumento';
  v_numero_documento := v_receptor->>'numeroDocumento';
  v_razon_social := pg_catalog.btrim(v_receptor->>'razonSocial');
  v_condicion_iva := v_receptor->>'condicionIva';
  v_domicilio := NULLIF(pg_catalog.btrim(v_receptor->>'domicilio'),'');

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_venta.sucursal_id::text||':'||v_tipo_documento||':'||v_numero_documento,
      0
    )
  );

  SELECT rf.* INTO v_favorito
    FROM public.receptores_fiscales rf
   WHERE rf.sucursal_id=v_venta.sucursal_id
     AND rf.tipo_documento=v_tipo_documento
     AND rf.numero_documento=v_numero_documento
     AND rf.activo
   ORDER BY rf.created_at,rf.id
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.receptores_fiscales(
      sucursal_id,creado_por,cliente_comercial_id,tipo_documento,
      numero_documento,razon_social,condicion_iva,domicilio,activo
    ) VALUES (
      v_venta.sucursal_id,v_uid,v_venta.cliente_id,v_tipo_documento,
      v_numero_documento,v_razon_social,v_condicion_iva,v_domicilio,true
    )
    RETURNING * INTO v_favorito;
  END IF;

  RETURN QUERY SELECT
    v_favorito.id,
    v_favorito.sucursal_id,
    v_favorito.cliente_comercial_id,
    v_favorito.tipo_documento,
    v_favorito.numero_documento,
    v_favorito.razon_social,
    v_favorito.condicion_iva,
    v_favorito.domicilio;
END;
$$;

REVOKE ALL ON FUNCTION public.guardar_receptor_fiscal_desde_venta(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.guardar_receptor_fiscal_desde_venta(uuid)
  TO authenticated;

COMMENT ON FUNCTION public.guardar_receptor_fiscal_desde_venta(uuid)
  IS 'Guarda idempotentemente un receptor manual desde evidencia v2 APROBADO/PERSISTIDO; no acepta campos públicos derivables.';

CREATE OR REPLACE FUNCTION public.desactivar_receptor_fiscal(
  p_receptor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
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
  v_receptor public.receptores_fiscales%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE='42501';
  END IF;

  SELECT rf.* INTO v_receptor
    FROM public.receptores_fiscales rf
   WHERE rf.id=p_receptor_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Favorito fiscal inexistente o no autorizado'
      USING ERRCODE='42501';
  END IF;

  SELECT public.is_admin(v_uid) INTO v_es_admin;
  IF NOT v_es_admin THEN
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

    IF NOT FOUND
       OR NOT COALESCE(v_perfil_activo,false)
       OR NOT COALESCE(v_puede_facturar,false)
       OR v_sucursal_perfil IS NULL
       OR NOT COALESCE(v_sucursal_activa,false)
       OR NOT COALESCE(v_sucursal_asignada,false)
       OR v_receptor.sucursal_id IS DISTINCT FROM v_sucursal_perfil
       OR v_receptor.creado_por IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'No puede desactivar este favorito fiscal'
        USING ERRCODE='42501';
    END IF;
  END IF;

  UPDATE public.receptores_fiscales rf
     SET activo=false
   WHERE rf.id=p_receptor_id
     AND rf.activo;
END;
$$;

REVOKE ALL ON FUNCTION public.desactivar_receptor_fiscal(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.desactivar_receptor_fiscal(uuid)
  TO authenticated;

REVOKE INSERT,UPDATE,DELETE ON TABLE public.receptores_fiscales FROM authenticated;
DROP POLICY IF EXISTS "receptores fiscales admin insert" ON public.receptores_fiscales;
DROP POLICY IF EXISTS "receptores fiscales empleado insert" ON public.receptores_fiscales;
DROP POLICY IF EXISTS "receptores fiscales admin update" ON public.receptores_fiscales;
DROP POLICY IF EXISTS "receptores fiscales empleado update" ON public.receptores_fiscales;
DROP POLICY IF EXISTS "receptores fiscales admin delete" ON public.receptores_fiscales;

DROP INDEX IF EXISTS public.idx_ventas_cola_fiscal;
CREATE INDEX idx_ventas_cola_fiscal
  ON public.ventas (sucursal_id,fecha DESC,id DESC)
  WHERE afip_estado IN (
    'SIN_FACTURAR','EMITIENDO','APROBADO','ERROR_CORREGIBLE',
    'RECONCILIAR','CANCELADO','BLOQUEADO','PENDIENTE','ERROR'
  );

DROP INDEX IF EXISTS public.idx_ventas_cola_fiscal_global;
CREATE INDEX idx_ventas_cola_fiscal_global
  ON public.ventas (fecha DESC,id DESC)
  WHERE afip_estado IN (
    'SIN_FACTURAR','EMITIENDO','APROBADO','ERROR_CORREGIBLE',
    'RECONCILIAR','CANCELADO','BLOQUEADO','PENDIENTE','ERROR'
  );
