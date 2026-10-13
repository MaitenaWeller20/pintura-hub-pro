-- Corte controlado de la cola fiscal legacy hacia el modelo receptor v2.
--
-- Precondición operacional: la aplicación está en mantenimiento y ambos
-- escritores fiscales ya fueron apagados. Esta migración no habilita v2 ni
-- llama a ARCA; sólo clasifica historia existente e instala el guard del corte.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('quimex:facturacion:v2-cutover',0)
);

DO $corte$
DECLARE
  v_settings public.settings%ROWTYPE;
  v_ventas bigint;
BEGIN
  SELECT *
    INTO v_settings
    FROM public.settings
   WHERE id=true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Corte v2 abortado: falta settings.id=true';
  END IF;

  SELECT count(*) INTO v_ventas FROM public.ventas;

  -- Permite reconstruir una base nueva desde cero: antes del seed no existe
  -- historia que drenar. En producción con historia, false/false sigue siendo
  -- una precondición operacional obligatoria y nunca se infiere.
  IF v_ventas=0
     AND NOT v_settings.facturacion_receptor_v2_enabled
     AND v_settings.facturacion_legacy_writer_enabled THEN
    UPDATE public.settings
       SET facturacion_receptor_v2_enabled=false,
           facturacion_legacy_writer_enabled=false,
           updated_at=pg_catalog.clock_timestamp()
     WHERE id=true
     RETURNING * INTO v_settings;
  END IF;

  IF v_settings.facturacion_receptor_v2_enabled
     OR v_settings.facturacion_legacy_writer_enabled THEN
    RAISE EXCEPTION
      'Corte v2 abortado: se requieren ambos escritores fiscales apagados';
  END IF;

  IF (SELECT count(*) FROM public.settings WHERE id=true) <> 1 THEN
    RAISE EXCEPTION 'Corte v2 abortado: settings.id=true no es una fila única';
  END IF;

END
$corte$;

-- El volumen actual es pequeño y el mantenimiento ya está activo. Este lock
-- mantiene estable la clasificación entre preview y aplicación, sin bloquear
-- lecturas. Si quedó un writer vivo, lock_timeout aborta en vez de esperar.
LOCK TABLE public.ventas,public.emision_fiscal_intentos
  IN SHARE ROW EXCLUSIVE MODE;

DO $vuelo$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.ventas
     WHERE afip_estado='EMITIENDO'
  ) THEN
    RAISE EXCEPTION
      'Corte v2 abortado: hay comprobantes fiscales en vuelo';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.emision_fiscal_intentos
     WHERE resultado IS NULL
  ) THEN
    RAISE EXCEPTION
      'Corte v2 abortado: hay intentos fiscales sin resultado terminal';
  END IF;
END
$vuelo$;

CREATE TEMP TABLE corte_v2_clasificacion (
  id uuid PRIMARY KEY,
  estado_destino text
) ON COMMIT DROP;

INSERT INTO corte_v2_clasificacion (id,estado_destino)
SELECT
  v.id,
  CASE
    WHEN v.cae IS NOT NULL THEN 'APROBADO'
    WHEN v.afip_numero IS NOT NULL
         AND v.afip_version >= 2
         AND v.afip_snapshot IS NOT NULL
         AND v.afip_snapshot->>'version'='2'
         AND v.afip_snapshot_hash IS NOT NULL
      THEN 'RECONCILIAR'
    WHEN v.afip_numero IS NOT NULL THEN 'BLOQUEADO'
    WHEN v.afip_estado='ERROR' AND v.afip_numero IS NULL
      THEN 'ERROR_CORREGIBLE'
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
               FROM public.ventas original
              WHERE original.id=v.afip_cbte_asoc_id
                AND original.cae IS NOT NULL
                AND original.afip_numero IS NOT NULL
           )
         )
      THEN 'BLOQUEADO'
    ELSE NULL
  END
FROM public.ventas v;

DO $clasificacion$
BEGIN
  IF EXISTS (
    SELECT 1 FROM corte_v2_clasificacion WHERE estado_destino IS NULL
  ) OR (SELECT count(*) FROM corte_v2_clasificacion)
       <> (SELECT count(*) FROM public.ventas) THEN
    RAISE EXCEPTION
      'Corte v2 abortado: existe al menos una venta sin clasificación determinista';
  END IF;
END
$clasificacion$;

CREATE TEMP TABLE corte_v2_preview (
  estado_destino text PRIMARY KEY,
  cantidad bigint NOT NULL
) ON COMMIT DROP;

INSERT INTO corte_v2_preview (estado_destino,cantidad)
SELECT * FROM public.backfill_cola_fiscal(false);

DO $preview$
BEGIN
  IF EXISTS (
    (SELECT estado_destino,count(*)::bigint
       FROM corte_v2_clasificacion
      GROUP BY estado_destino
     EXCEPT
     SELECT estado_destino,cantidad FROM corte_v2_preview)
    UNION ALL
    (SELECT estado_destino,cantidad FROM corte_v2_preview
     EXCEPT
     SELECT estado_destino,count(*)::bigint
       FROM corte_v2_clasificacion
      GROUP BY estado_destino)
  ) THEN
    RAISE EXCEPTION
      'Corte v2 abortado: el preview no coincide con la clasificación independiente';
  END IF;
END
$preview$;

CREATE TEMP TABLE corte_v2_aplicado (
  estado_destino text PRIMARY KEY,
  cantidad bigint NOT NULL
) ON COMMIT DROP;

INSERT INTO corte_v2_aplicado (estado_destino,cantidad)
SELECT * FROM public.backfill_cola_fiscal(true);

DO $resultado$
BEGIN
  IF EXISTS (
    (SELECT * FROM corte_v2_preview EXCEPT SELECT * FROM corte_v2_aplicado)
    UNION ALL
    (SELECT * FROM corte_v2_aplicado EXCEPT SELECT * FROM corte_v2_preview)
  ) THEN
    RAISE EXCEPTION 'Corte v2 abortado: aplicar y preview difieren';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM corte_v2_clasificacion c
      JOIN public.ventas v ON v.id=c.id
     WHERE v.afip_estado IS DISTINCT FROM c.estado_destino
  ) THEN
    RAISE EXCEPTION 'Corte v2 abortado: el estado aplicado no coincide';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ventas
     WHERE (cae IS NOT NULL AND afip_estado<>'APROBADO')
        OR (afip_estado='APROBADO' AND cae IS NULL)
        OR (
          afip_estado='SIN_FACTURAR'
          AND NOT (
            estado='ACTIVA'
            AND tipo_comprobante IN ('FACTURA_A','FACTURA_B','FACTURA_C')
            AND afip_numero IS NULL
            AND cae IS NULL
          )
        )
  ) THEN
    RAISE EXCEPTION 'Corte v2 abortado: falló una invariante fiscal posterior';
  END IF;
END
$resultado$;

CREATE OR REPLACE FUNCTION public.guard_ventas_fiscales_legacy_retirado()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $guard$
BEGIN
  IF (TG_OP='INSERT' OR NEW.tipo_comprobante IS DISTINCT FROM OLD.tipo_comprobante)
     AND NEW.tipo_comprobante IN ('FACTURA_A','FACTURA_B','FACTURA_C') THEN
    RAISE EXCEPTION
      'El escritor fiscal legacy está retirado; registre una venta neutral y use la cola v2'
      USING ERRCODE='55000';
  END IF;

  RETURN NEW;
END
$guard$;

REVOKE ALL ON FUNCTION public.guard_ventas_fiscales_legacy_retirado()
  FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS trg_ventas_fiscales_legacy_retirado ON public.ventas;
CREATE TRIGGER trg_ventas_fiscales_legacy_retirado
BEFORE INSERT OR UPDATE OF tipo_comprobante ON public.ventas
FOR EACH ROW
EXECUTE FUNCTION public.guard_ventas_fiscales_legacy_retirado();

COMMENT ON FUNCTION public.guard_ventas_fiscales_legacy_retirado() IS
  'Guard irreversible del corte: impide crear FACTURA_A/B/C; v2 registra VENTA neutral.';

COMMIT;
