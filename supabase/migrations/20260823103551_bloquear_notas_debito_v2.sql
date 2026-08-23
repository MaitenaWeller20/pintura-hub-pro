-- T13 review: durante el rollout v2 la nota de débito nueva queda diferida.
-- El guard vive antes del INSERT para que incluso una llamada directa a la RPC
-- pública se revierta dentro de la misma transacción, sin venta/stock/caja/deuda.
-- Legacy conserva su contrato mientras sea el único writer habilitado.
CREATE FUNCTION public.bloquear_nota_debito_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_v2_enabled boolean;
BEGIN
  SELECT s.facturacion_receptor_v2_enabled
    INTO v_v2_enabled
    FROM public.settings AS s
   WHERE s.id=true;

  IF COALESCE(v_v2_enabled,false) THEN
    RAISE EXCEPTION 'La nota de débito nueva queda fuera de alcance fiscal';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bloquear_nota_debito_v2()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER bloquear_nota_debito_v2_antes_de_mutar
BEFORE INSERT OR UPDATE OF tipo_comprobante ON public.ventas
FOR EACH ROW
WHEN (NEW.tipo_comprobante='NOTA_DEBITO')
EXECUTE FUNCTION public.bloquear_nota_debito_v2();
