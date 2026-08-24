-- Retiro de las capacidades ejecutables del escritor fiscal legacy.
-- Conserva lectores históricos, CAE, snapshots, números e intentos.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '1min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('quimex:facturacion:v2-cutover',0)
);

DO $retiro$
DECLARE
  v_settings public.settings%ROWTYPE;
BEGIN
  SELECT *
    INTO v_settings
    FROM public.settings
   WHERE id=true
   FOR UPDATE;

  IF NOT FOUND
     OR v_settings.facturacion_receptor_v2_enabled
     OR v_settings.facturacion_legacy_writer_enabled THEN
    RAISE EXCEPTION
      'Retiro legacy abortado: se requieren ambos escritores fiscales apagados';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger
     WHERE tgrelid='public.ventas'::regclass
       AND tgname='trg_ventas_fiscales_legacy_retirado'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Retiro legacy abortado: falta el guard positivo del corte';
  END IF;

END
$retiro$;

LOCK TABLE public.ventas,public.emision_fiscal_intentos
  IN SHARE ROW EXCLUSIVE MODE;

DO $vuelo$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.ventas
     WHERE afip_estado='EMITIENDO'
  ) OR EXISTS (
    SELECT 1
      FROM public.emision_fiscal_intentos
     WHERE resultado IS NULL
  ) THEN
    RAISE EXCEPTION 'Retiro legacy abortado: existe trabajo fiscal en vuelo';
  END IF;
END
$vuelo$;

DO $firma$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.convertir_presupuesto_en_venta(uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Retiro legacy abortado: falta la firma legacy esperada';
  END IF;
END
$firma$;

DROP FUNCTION public.convertir_presupuesto_en_venta(
  uuid,
  uuid,
  public.tipo_comprobante,
  public.condicion_venta,
  jsonb,
  uuid
);

REVOKE ALL ON FUNCTION public.next_comprobante_numero(
  uuid,
  public.tipo_comprobante
) FROM PUBLIC,anon,authenticated,service_role;

COMMENT ON FUNCTION public.next_comprobante_numero(uuid,public.tipo_comprobante) IS
  'Helper owner-only para RPC atómicas. El escritor fiscal legacy ya no tiene permiso directo.';

ALTER TABLE public.settings
  ALTER COLUMN facturacion_legacy_writer_enabled SET DEFAULT false;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid='public.settings'::regclass
       AND conname='ck_settings_legacy_writer_retirado'
  ) THEN
    ALTER TABLE public.settings
      ADD CONSTRAINT ck_settings_legacy_writer_retirado
      CHECK (NOT facturacion_legacy_writer_enabled);
  END IF;
END
$constraint$;

DO $post$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.convertir_presupuesto_en_venta(uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,uuid)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'Retiro legacy incompleto: la firma antigua sigue expuesta';
  END IF;

  IF pg_catalog.has_function_privilege(
    'service_role',
    'public.next_comprobante_numero(uuid,public.tipo_comprobante)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Retiro legacy incompleto: service_role conserva el helper fiscal';
  END IF;
END
$post$;

COMMIT;
