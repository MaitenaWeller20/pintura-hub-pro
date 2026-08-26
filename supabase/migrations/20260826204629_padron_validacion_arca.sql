ALTER TABLE public.credenciales_arca
  ADD COLUMN padron_probado_at timestamptz,
  ADD COLUMN padron_validacion_activa boolean NOT NULL DEFAULT false,
  ADD COLUMN padron_ultimo_error_codigo text,
  ADD COLUMN padron_ultimo_error_at timestamptz,
  ADD CONSTRAINT ck_credenciales_arca_padron_codigo
    CHECK (
      padron_ultimo_error_codigo IS NULL OR
      padron_ultimo_error_codigo IN (
        'PADRON_ARCA_CAIDO',
        'PADRON_NO_AUTORIZADO',
        'PADRON_CONFIG_INVALIDA',
        'CUIT_INVALIDO',
        'CUIT_NO_ENCONTRADO',
        'CUIT_INACTIVO',
        'RESPUESTA_PADRON_INVALIDA',
        'CONDICION_FISCAL_INCOMPATIBLE'
      )
    ),
  ADD CONSTRAINT ck_credenciales_arca_padron_activo_probado
    CHECK (NOT padron_validacion_activa OR padron_probado_at IS NOT NULL),
  ADD CONSTRAINT ck_credenciales_arca_padron_error_completo
    CHECK (
      (padron_ultimo_error_codigo IS NULL) =
      (padron_ultimo_error_at IS NULL)
    );

CREATE FUNCTION public.reset_padron_arca_por_credencial()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF OLD.arca_key_enc IS DISTINCT FROM NEW.arca_key_enc
     OR OLD.arca_cert_enc IS DISTINCT FROM NEW.arca_cert_enc
     OR OLD.ambiente IS DISTINCT FROM NEW.ambiente THEN
    NEW.padron_probado_at := NULL;
    NEW.padron_validacion_activa := false;
    NEW.padron_ultimo_error_codigo := NULL;
    NEW.padron_ultimo_error_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_credenciales_arca_reset_padron
  BEFORE UPDATE OF arca_key_enc, arca_cert_enc, ambiente
  ON public.credenciales_arca
  FOR EACH ROW
  EXECUTE FUNCTION public.reset_padron_arca_por_credencial();

CREATE FUNCTION public.reset_padron_arca_por_cuit_emisor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF OLD.cuit IS DISTINCT FROM NEW.cuit THEN
    UPDATE public.credenciales_arca
    SET
      padron_probado_at = NULL,
      padron_validacion_activa = false,
      padron_ultimo_error_codigo = NULL,
      padron_ultimo_error_at = NULL
    WHERE emisor_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_emisores_reset_padron_por_cuit
  AFTER UPDATE OF cuit
  ON public.emisores
  FOR EACH ROW
  EXECUTE FUNCTION public.reset_padron_arca_por_cuit_emisor();

REVOKE ALL ON FUNCTION public.reset_padron_arca_por_credencial() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_padron_arca_por_cuit_emisor() FROM PUBLIC;
