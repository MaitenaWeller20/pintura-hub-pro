-- LIBERAR es una recuperación administrativa de un claim abandonado antes de
-- reservar identidad. Nunca puede reutilizarse para soltar un número fiscal.
--
-- La RPC serializa cada transición con FOR UPDATE. Este guard queda en la
-- tabla para que la comprobación use el OLD realmente bloqueado incluso si dos
-- sesiones intentan RESERVAR y LIBERAR con la misma versión al mismo tiempo.
CREATE OR REPLACE FUNCTION public.proteger_liberacion_claim_fiscal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $$
BEGIN
  IF OLD.afip_estado IS DISTINCT FROM 'EMITIENDO'
     OR OLD.afip_fase IS DISTINCT FROM 'PREFLIGHT' THEN
    RAISE EXCEPTION USING
      ERRCODE='PT422',
      MESSAGE=pg_catalog.format(
        'LIBERAR sólo admite PREFLIGHT sin identidad; estado/fase vigente: %s/%s',
        COALESCE(OLD.afip_estado,'NULL'),
        COALESCE(OLD.afip_fase,'NULL')
      );
  END IF;

  IF OLD.afip_numero IS NOT NULL
     OR OLD.afip_emisor_cuit IS NOT NULL
     OR OLD.afip_punto_venta IS NOT NULL
     OR OLD.afip_cbte_tipo IS NOT NULL
     OR OLD.afip_modo IS NOT NULL
     OR OLD.afip_simulado IS DISTINCT FROM false
     OR OLD.afip_validez IS NOT NULL
     OR OLD.afip_fecha_comprobante IS NOT NULL
     OR OLD.afip_snapshot IS NOT NULL
     OR OLD.afip_snapshot_hash IS NOT NULL
     OR OLD.afip_imp_total IS NOT NULL
     OR OLD.cae IS NOT NULL
     OR OLD.cae_vencimiento IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE='PT422',
      MESSAGE='LIBERAR está prohibido porque existe identidad fiscal reservada';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proteger_liberacion_claim_fiscal()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_proteger_liberacion_claim_fiscal ON public.ventas;
CREATE TRIGGER trg_proteger_liberacion_claim_fiscal
  BEFORE UPDATE ON public.ventas
  FOR EACH ROW
  WHEN (
    OLD.afip_claim_token IS NOT NULL
    AND NEW.afip_claim_token IS NULL
    AND NEW.afip_error_clase IS NOT DISTINCT FROM 'LEASE'
    AND NEW.afip_error_codigo IS NOT DISTINCT FROM 'LIBERADO'
  )
  EXECUTE FUNCTION public.proteger_liberacion_claim_fiscal();

COMMENT ON FUNCTION public.proteger_liberacion_claim_fiscal() IS
  'Guard interno: LIBERAR sólo desde EMITIENDO/PREFLIGHT sin identidad fiscal reservada.';
