BEGIN;

DO $migration$
DECLARE
  v_actualizadas bigint;
BEGIN
  -- Decisión explícita del administrador del negocio (2026-08-24):
  -- APLICACIONES Y SERVICIOS S.R.L. opera como Responsable Inscripto y debe
  -- poder emitir Factura A estándar a receptores RI, además de Factura B al
  -- resto de las condiciones fiscales admitidas por el sistema.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('confirmar-factura-a-estandar:30714199664', 0)
  );

  UPDATE public.emisores
  SET factura_a_modalidad = 'ESTANDAR_CONFIRMADA',
      factura_a_confirmada_at = pg_catalog.clock_timestamp(),
      -- Esta liberación fue autorizada directamente por el dueño y no desde
      -- una sesión administrativa de la aplicación. Evitamos conservar una
      -- atribución anterior que ya no describiría esta decisión.
      factura_a_confirmada_por = NULL,
      factura_a_revalidar_at = DATE '2027-08-24',
      factura_a_evidencia =
        'Confirmación expresa del administrador del negocio el 2026-08-24: '
        'APLICACIONES Y SERVICIOS S.R.L. opera como RI y se habilita A/B.',
      updated_at = pg_catalog.clock_timestamp()
  WHERE cuit = '30714199664'
    AND condicion_iva = 'RESPONSABLE_INSCRIPTO'
    AND activo IS TRUE;

  GET DIAGNOSTICS v_actualizadas = ROW_COUNT;

  IF v_actualizadas <> 1 THEN
    RAISE EXCEPTION
      'Se esperaba confirmar exactamente un emisor RI activo para el CUIT 30714199664; filas actualizadas: %',
      v_actualizadas;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.emisores
    WHERE cuit = '30714199664'
      AND factura_a_modalidad = 'ESTANDAR_CONFIRMADA'
      AND factura_a_revalidar_at >= DATE '2027-08-24'
  ) THEN
    RAISE EXCEPTION 'No quedó confirmada la modalidad Factura A estándar para General Paz';
  END IF;
END
$migration$;

COMMIT;
