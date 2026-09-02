-- Mantiene el cambio del punto de venta y la invalidación de sus evidencias
-- dentro de la misma sentencia/transacción. Si el reset falla, PostgreSQL
-- revierte también el INSERT/UPDATE que disparó este trigger.
CREATE FUNCTION public.reset_credenciales_arca_por_punto_venta()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_cambio_relevante boolean;
  v_reset_padron boolean;
BEGIN
  v_cambio_relevante :=
    TG_OP = 'INSERT'
    OR OLD.sucursal_id IS DISTINCT FROM NEW.sucursal_id
    OR OLD.emisor_id IS DISTINCT FROM NEW.emisor_id
    OR OLD.numero IS DISTINCT FROM NEW.numero
    OR OLD.modo IS DISTINCT FROM NEW.modo
    OR OLD.activo IS DISTINCT FROM NEW.activo;

  IF NOT v_cambio_relevante THEN
    RETURN NULL;
  END IF;

  v_reset_padron :=
    TG_OP = 'INSERT'
    OR OLD.emisor_id IS DISTINCT FROM NEW.emisor_id
    OR OLD.modo IS DISTINCT FROM NEW.modo;

  -- El orden explícito evita que dos cambios que abarcan más de una
  -- credencial tomen los locks de fila en orden opuesto.
  PERFORM c.id
  FROM public.credenciales_arca AS c
  WHERE
    (c.emisor_id = NEW.emisor_id AND c.ambiente = NEW.modo)
    OR (
      TG_OP = 'UPDATE'
      AND c.emisor_id = OLD.emisor_id
      AND c.ambiente = OLD.modo
    )
  ORDER BY c.emisor_id, c.ambiente
  FOR UPDATE;

  UPDATE public.credenciales_arca AS c
  SET
    probada_at = NULL,
    habilitada = false,
    padron_probado_at = CASE WHEN v_reset_padron THEN NULL ELSE c.padron_probado_at END,
    padron_validacion_activa = CASE
      WHEN v_reset_padron THEN false
      ELSE c.padron_validacion_activa
    END,
    padron_ultimo_error_codigo = CASE
      WHEN v_reset_padron THEN NULL
      ELSE c.padron_ultimo_error_codigo
    END,
    padron_ultimo_error_at = CASE
      WHEN v_reset_padron THEN NULL
      ELSE c.padron_ultimo_error_at
    END
  WHERE
    (c.emisor_id = NEW.emisor_id AND c.ambiente = NEW.modo)
    OR (
      TG_OP = 'UPDATE'
      AND c.emisor_id = OLD.emisor_id
      AND c.ambiente = OLD.modo
    );

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_puntos_venta_reset_credenciales_arca
  AFTER INSERT OR UPDATE
  ON public.puntos_venta
  FOR EACH ROW
  EXECUTE FUNCTION public.reset_credenciales_arca_por_punto_venta();

REVOKE ALL ON FUNCTION public.reset_credenciales_arca_por_punto_venta() FROM PUBLIC;
