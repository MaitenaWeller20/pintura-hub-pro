-- Auditoría de rollout fiscal. Sólo produce result sets; no llama ARCA ni ejecuta backfill.
-- Puede pegarse completa en SQL Editor. La transacción READ ONLY hace fallar cualquier escritura
-- accidental agregada en una revisión futura.

BEGIN;
SET TRANSACTION READ ONLY;

-- Identidad mínima de la ejecución. No imprime secretos ni cadenas de conexión.
SELECT
  pg_catalog.clock_timestamp() AS auditada_at,
  pg_catalog.current_database() AS base,
  current_user AS rol,
  pg_catalog.current_setting('server_version') AS postgres_version,
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only;

-- Ledger esperado para esta entrega. El SHA-256 se verifica contra archivos fuera de PostgreSQL.
WITH requeridas(version,nombre) AS (
  VALUES
    ('20260822133249','venta_fiscal_neutra_enum'),
    ('20260822133911','receptor_fiscal_outbox'),
    ('20260822144846','maquina_estados_emision_fiscal'),
    ('20260822161644','venta_fiscal_atomica'),
    ('20260822195131','proteger_evidencia_factura_a_emisores'),
    ('20260822203901','snapshot_fiscal_v2_completo'),
    ('20260822215956','snapshot_fiscal_v2_fechas_cuit_canonicos'),
    ('20260822232541','recuperar_cae_emision_fiscal'),
    ('20260822232546','lectura_exacta_emision_fiscal'),
    ('20260823030402','cola_fiscal_lectura'),
    ('20260823081724','conflictos_emision_no_reintentables'),
    ('20260823103551','bloquear_notas_debito_v2'),
    ('20260823121146','cercar_notas_en_crear_venta'),
    ('20260823121846','liberar_claim_ante_reserva_fiscal_ajena'),
    ('20260823130734','recomputar_maximo_fiscal_bajo_lock'),
    ('20260823143000','crear_remito_atomico'),
    ('20260823160000','remitos_integridad_idempotencia'),
    ('20260823162000','fix_venta_idempotencia_autorizacion'),
    ('20260823164000','restringir_liberacion_claim_fiscal'),
    ('20260823165000','nota_credito_idempotente')
)
SELECT
  r.version,
  r.nombre,
  EXISTS (
    SELECT 1
      FROM supabase_migrations.schema_migrations AS sm
     WHERE sm.version=r.version
       AND sm.name=r.nombre
  ) AS aplicada_exacta
FROM requeridas AS r
ORDER BY r.version;

-- Banderas. Antes del corte: false/true. Durante mantenimiento y rollback: false/false.
SELECT
  s.facturacion_receptor_v2_enabled,
  s.facturacion_legacy_writer_enabled,
  NOT (
    s.facturacion_receptor_v2_enabled
    AND s.facturacion_legacy_writer_enabled
  ) AS combinacion_valida
FROM public.settings AS s
WHERE s.id=true;

-- Instancias/transacciones de otras sesiones. No muestra el SQL ni sus parámetros.
SELECT
  a.application_name,
  a.state,
  a.wait_event_type,
  pg_catalog.count(*) AS sesiones,
  pg_catalog.min(a.xact_start) AS transaccion_mas_antigua
FROM pg_catalog.pg_stat_activity AS a
WHERE a.datname=pg_catalog.current_database()
  AND a.pid<>pg_catalog.pg_backend_pid()
  AND a.backend_type='client backend'
  AND a.state IS DISTINCT FROM 'idle'
GROUP BY a.application_name,a.state,a.wait_event_type
ORDER BY a.application_name,a.state,a.wait_event_type;

-- Firmas exactas: `cantidad=1` y `firma_exacta=true` son obligatorios.
WITH esperadas(nombre,argumentos) AS (
  VALUES
    ('transicionar_emision_fiscal','p_venta_id uuid, p_accion text, p_claim_token uuid, p_payload jsonb'),
    ('leer_venta_fiscal_exacta','p_venta_id uuid'),
    ('cola_fiscal_lectura','p_tab text, p_page integer, p_page_size integer, p_desde date, p_hasta date, p_sucursal_id uuid, p_emisor_id uuid, p_documento text, p_estado text, p_venta_id uuid'),
    ('crear_venta','p_sucursal_id uuid, p_cliente_id uuid, p_tipo_comprobante tipo_comprobante, p_condicion_venta condicion_venta, p_items jsonb, p_pagos jsonb, p_percepciones numeric, p_observaciones text, p_nombre_obra text, p_fecha timestamp with time zone, p_cbte_asoc_id uuid, p_idempotency_key uuid'),
    ('convertir_presupuesto_en_venta_neutral','p_presupuesto_id uuid, p_cliente_id uuid, p_condicion_venta condicion_venta, p_pagos jsonb, p_idempotency_key uuid'),
    ('anular_venta','p_venta_id uuid, p_idempotency_key uuid'),
    ('crear_remito','p_sucursal_origen_id uuid, p_sucursal_destino_id uuid, p_observaciones text, p_items jsonb, p_idempotency_key uuid'),
    ('next_comprobante_numero','_sucursal_id uuid, _tipo tipo_comprobante'),
    ('backfill_cola_fiscal','p_aplicar boolean')
), actuales AS (
  SELECT
    p.proname AS nombre,
    pg_catalog.count(*) AS cantidad,
    pg_catalog.string_agg(
      pg_catalog.pg_get_function_identity_arguments(p.oid),
      ' | ' ORDER BY pg_catalog.pg_get_function_identity_arguments(p.oid)
    ) AS firmas
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN (SELECT nombre FROM esperadas)
  GROUP BY p.proname
)
SELECT
  e.nombre,
  e.argumentos AS firma_esperada,
  COALESCE(a.cantidad,0) AS cantidad,
  a.firmas,
  COALESCE(a.cantidad=1 AND a.firmas=e.argumentos,false) AS firma_exacta
FROM esperadas AS e
LEFT JOIN actuales AS a USING (nombre)
ORDER BY e.nombre;

-- Superficie de remitos después de la ventana incompatible.
SELECT
  pg_catalog.has_table_privilege('authenticated','public.remitos','insert') AS remitos_insert_auth,
  pg_catalog.has_table_privilege('authenticated','public.remitos','update') AS remitos_update_auth,
  pg_catalog.has_table_privilege('authenticated','public.remitos','delete') AS remitos_delete_auth,
  pg_catalog.has_table_privilege('authenticated','public.remito_items','insert') AS items_insert_auth,
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.next_comprobante_numero(uuid,public.tipo_comprobante)',
    'execute'
  ) AS helper_auth,
  pg_catalog.has_function_privilege(
    'service_role',
    'public.next_comprobante_numero(uuid,public.tipo_comprobante)',
    'execute'
  ) AS helper_service_role_temporal;

-- ACL efectiva exacta de las tablas de remitos. `privilegios_efectivos` debe
-- ser solamente SELECT y `acl_exacto=true` en las cuatro combinaciones.
-- TRUNCATE se enumera expresamente: no alcanza con auditar INSERT/UPDATE/DELETE.
WITH roles(rol) AS (
  VALUES ('anon'::name),('authenticated'::name)
), tablas(tabla) AS (
  VALUES ('public.remitos'::regclass),('public.remito_items'::regclass)
), privilegios(privilegio) AS (
  VALUES
    ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
    ('TRUNCATE'),('REFERENCES'),('TRIGGER')
), superficie AS (
  SELECT
    r.rol,
    t.tabla,
    p.privilegio,
    pg_catalog.has_table_privilege(r.rol,t.tabla,p.privilegio) AS concedido
  FROM roles AS r
  CROSS JOIN tablas AS t
  CROSS JOIN privilegios AS p
)
SELECT
  s.rol,
  s.tabla::text AS tabla,
  pg_catalog.string_agg(
    s.privilegio,',' ORDER BY s.privilegio
  ) FILTER (WHERE s.concedido) AS privilegios_efectivos,
  pg_catalog.bool_and(
    s.concedido IS NOT DISTINCT FROM (s.privilegio='SELECT')
  ) AS acl_exacto
FROM superficie AS s
GROUP BY s.rol,s.tabla
ORDER BY s.rol,s.tabla::text;

-- RLS y privilegios sensibles. `emision_fiscal_intentos` no es una API de navegador.
SELECT
  c.relname AS tabla,
  c.relrowsecurity AS rls,
  pg_catalog.has_table_privilege('anon',c.oid,'select') AS anon_select,
  pg_catalog.has_table_privilege('authenticated',c.oid,'select') AS authenticated_select,
  pg_catalog.has_table_privilege('service_role',c.oid,'select') AS service_role_select
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
WHERE n.nspname='public'
  AND c.relname IN ('credenciales_arca','emision_fiscal_intentos','receptores_fiscales')
ORDER BY c.relname;

-- Estado operativo agregado. No expone receptor, certificado, CAE ni payloads.
SELECT
  v.afip_estado,
  COALESCE(v.afip_validez,'SIN_VALIDEZ') AS validez,
  pg_catalog.count(*) AS cantidad,
  COALESCE(pg_catalog.sum(v.total),0) AS importe_total
FROM public.ventas AS v
GROUP BY v.afip_estado,COALESCE(v.afip_validez,'SIN_VALIDEZ')
ORDER BY v.afip_estado,validez;

-- Identidades locales ocupadas por tipo 1/6. Esto NO consulta ARCA y no prueba Factura A estándar.
SELECT
  v.afip_emisor_cuit,
  v.afip_modo,
  v.afip_punto_venta,
  v.afip_cbte_tipo,
  pg_catalog.max(v.afip_numero) AS maximo_local,
  pg_catalog.count(*) AS filas_locales
FROM public.ventas AS v
WHERE v.afip_cbte_tipo IN (1,6)
  AND v.afip_numero IS NOT NULL
GROUP BY v.afip_emisor_cuit,v.afip_modo,v.afip_punto_venta,v.afip_cbte_tipo
ORDER BY v.afip_emisor_cuit,v.afip_modo,v.afip_punto_venta,v.afip_cbte_tipo;

-- Configuración sin material criptográfico ni evidencia libre.
SELECT
  e.cuit,
  e.razon_social,
  e.factura_a_modalidad,
  e.factura_a_confirmada_at,
  e.factura_a_revalidar_at,
  (e.factura_a_evidencia IS NOT NULL) AS tiene_evidencia_a,
  p.numero AS punto_venta,
  p.modo,
  p.activo AS pv_activo,
  c.habilitada AS credencial_habilitada,
  c.probada_at,
  c.cert_vence_at
FROM public.emisores AS e
LEFT JOIN public.puntos_venta AS p ON p.emisor_id=e.id
LEFT JOIN public.credenciales_arca AS c
  ON c.emisor_id=e.id
 AND c.ambiente=p.modo
ORDER BY e.cuit,p.modo,p.numero;

-- Clasificación independiente del backfill: no llama la función y no muta filas.
WITH clasificadas AS MATERIALIZED (
  SELECT
    v.id,
    CASE
      WHEN v.cae IS NOT NULL THEN 'APROBADO'
      WHEN v.afip_numero IS NOT NULL
           AND v.afip_version>=2
           AND v.afip_snapshot IS NOT NULL
           AND v.afip_snapshot->>'version'='2'
           AND v.afip_snapshot_hash IS NOT NULL
        THEN 'RECONCILIAR'
      WHEN v.afip_numero IS NOT NULL THEN 'BLOQUEADO'
      WHEN v.afip_estado='ERROR' AND v.afip_numero IS NULL THEN 'ERROR_CORREGIBLE'
      WHEN v.estado='ACTIVA'
           AND v.tipo_comprobante IN ('FACTURA_A','FACTURA_B','FACTURA_C')
           AND v.afip_numero IS NULL
           AND v.cae IS NULL
        THEN 'SIN_FACTURAR'
      WHEN v.estado='ANULADA' AND v.cae IS NULL THEN 'CANCELADO'
      WHEN v.tipo_comprobante IN ('REMITO','REMITO_OBRA','FAC_INTERNA_CTA_CTE')
        THEN 'NO_APLICA'
      WHEN v.tipo_comprobante IN ('NOTA_CREDITO','NOTA_DEBITO')
           AND (
             v.afip_cbte_asoc_id IS NULL
             OR NOT EXISTS (
               SELECT 1
                 FROM public.ventas AS original
                WHERE original.id=v.afip_cbte_asoc_id
                  AND original.cae IS NOT NULL
                  AND original.afip_numero IS NOT NULL
             )
           )
        THEN 'BLOQUEADO'
      ELSE NULL
    END AS destino
  FROM public.ventas AS v
  WHERE v.afip_version=0 OR v.afip_estado IN ('PENDIENTE','ERROR')
)
SELECT
  COALESCE(c.destino,'SIN_CLASIFICAR') AS destino,
  pg_catalog.count(*) AS cantidad,
  pg_catalog.md5(
    COALESCE(pg_catalog.string_agg(c.id::text,',' ORDER BY c.id),'')
  ) AS digest_ids
FROM clasificadas AS c
GROUP BY COALESCE(c.destino,'SIN_CLASIFICAR')
ORDER BY destino;

-- Invariantes que deben dar cero. Sólo devuelve cantidades agregadas.
SELECT 'cae_sin_numero' AS control,pg_catalog.count(*) AS cantidad
  FROM public.ventas WHERE cae IS NOT NULL AND afip_numero IS NULL
UNION ALL
SELECT 'aprobado_sin_cae',pg_catalog.count(*)
  FROM public.ventas WHERE afip_estado='APROBADO' AND cae IS NULL
UNION ALL
SELECT 'reconciliar_sin_identidad_v2',pg_catalog.count(*)
  FROM public.ventas
 WHERE afip_estado='RECONCILIAR'
   AND (
     afip_numero IS NULL OR afip_snapshot IS NULL OR afip_snapshot_hash IS NULL
     OR afip_version<2 OR afip_snapshot->>'version' IS DISTINCT FROM '2'
   )
UNION ALL
SELECT 'claim_partido',pg_catalog.count(*)
  FROM public.ventas
 WHERE (afip_claim_token IS NULL) IS DISTINCT FROM (afip_claimed_at IS NULL)
UNION ALL
SELECT 'idempotencia_remito_partida',pg_catalog.count(*)
  FROM public.remitos
 WHERE (idempotency_key IS NULL) IS DISTINCT FROM (request_fingerprint IS NULL)
ORDER BY control;

COMMIT;
