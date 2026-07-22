-- ============================================================
-- R11 (fix de review) — el cierre sólo cuenta el EFECTIVO; el resto se cierra
-- con el esperado recalculado en el servidor.
--
-- Problema detectado en el review adversarial: cerrar_caja recalcula el esperado
-- en vivo, pero la UI armaba el "contado" de las formas no-efectivo con un
-- snapshot de caja_esperado que pudo cachearse ANTES de que entrara más plata en
-- la misma sesión (dos terminales comparten sesión por sucursal). Si algo se
-- cobraba en el medio, el server grababa una diferencia fantasma en, p.ej.,
-- Transferencia, mientras la UI mostraba "Diferencia $0" — invisible para el
-- cajero hasta ver el PDF/historial.
--
-- Fix: la UI manda en p_contado SÓLO el efectivo. Acá, para toda forma ausente
-- en p_contado, el "contado" se completa con el ESPERADO recalculado en esta
-- misma transacción → su diferencia es 0 por definición y no hay carrera. El
-- efectivo (lo único físico que puede diferir) sigue viniendo de p_contado.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cerrar_caja(
  p_sesion_id       uuid,
  p_contado         jsonb DEFAULT '{}'::jsonb,
  p_notas           text  DEFAULT NULL::text,
  p_efectivo_dejado numeric DEFAULT NULL::numeric
)
 RETURNS TABLE(total_esperado numeric, total_contado numeric, total_diferencia numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_ses       public.caja_sesiones%ROWTYPE;
  v_esperado  jsonb;
  v_contado   jsonb := COALESCE(p_contado, '{}'::jsonb);
  v_diferencia jsonb := '{}'::jsonb;
  v_tot_esp   numeric(14,2) := 0;
  v_tot_cont  numeric(14,2) := 0;
  k           text;
  v_formas    text[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_ses FROM public.caja_sesiones WHERE id = p_sesion_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sesión de caja no existe';
  END IF;
  IF v_ses.estado <> 'ABIERTA' THEN
    RAISE EXCEPTION 'La caja ya fue cerrada';
  END IF;
  IF NOT public.is_admin(v_uid) AND v_ses.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'Esa caja es de otra sucursal';
  END IF;

  v_esperado := public.caja_esperado(p_sesion_id);

  -- Validar que las claves de `contado` sean formas de pago reales.
  FOR k IN SELECT jsonb_object_keys(v_contado) LOOP
    BEGIN
      PERFORM k::public.forma_pago;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Forma de pago desconocida en el conteo: %', k;
    END;
  END LOOP;

  SELECT array_agg(DISTINCT f) INTO v_formas FROM (
    SELECT jsonb_object_keys(v_esperado) AS f
    UNION
    SELECT jsonb_object_keys(v_contado) AS f
  ) u;

  -- R11: SÓLO el efectivo se cuenta a mano. Toda otra forma se cierra con su
  -- ESPERADO recalculado, SOBREESCRIBIENDO cualquier valor entrante (autoritativo
  -- server-side): así ni un cliente desactualizado ni una llamada directa pueden
  -- inyectar una diferencia fantasma en una forma electrónica. Sólo EFECTIVO
  -- sobrevive de p_contado.
  IF v_formas IS NOT NULL THEN
    FOREACH k IN ARRAY v_formas LOOP
      IF k <> 'EFECTIVO' THEN
        v_contado := v_contado || jsonb_build_object(
          k, ROUND(COALESCE((v_esperado->k->>'neto')::numeric, 0), 2)
        );
      END IF;
    END LOOP;
  END IF;

  -- diferencia = contado − esperado, sobre la UNIÓN de formas.
  IF v_formas IS NOT NULL THEN
    FOREACH k IN ARRAY v_formas LOOP
      v_diferencia := v_diferencia || jsonb_build_object(
        k,
        ROUND(COALESCE((v_contado->>k)::numeric, 0) - COALESCE((v_esperado->k->>'neto')::numeric, 0), 2)
      );
    END LOOP;
  END IF;

  SELECT COALESCE(SUM((value->>'neto')::numeric), 0) INTO v_tot_esp FROM jsonb_each(v_esperado);
  SELECT COALESCE(SUM((value)::numeric), 0) INTO v_tot_cont  FROM jsonb_each_text(v_contado);

  UPDATE public.caja_sesiones SET
    estado           = 'CERRADA',
    cerrada_por      = v_uid,
    cerrada_en       = now(),
    esperado         = v_esperado,
    contado          = v_contado,
    diferencia       = v_diferencia,
    total_esperado   = v_tot_esp,
    total_contado    = v_tot_cont,
    total_diferencia = ROUND(v_tot_cont - v_tot_esp, 2),
    efectivo_dejado  = GREATEST(ROUND(COALESCE(p_efectivo_dejado, 0), 2), 0),
    notas            = p_notas
  WHERE id = p_sesion_id;

  RETURN QUERY SELECT v_tot_esp, v_tot_cont, ROUND(v_tot_cont - v_tot_esp, 2);
END; $function$;

REVOKE ALL ON FUNCTION public.cerrar_caja(uuid, jsonb, text, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.cerrar_caja(uuid, jsonb, text, numeric) TO authenticated, service_role;
