-- Impide cerrar una caja declarando como "dejado para mañana" más efectivo
-- del que se contó. Además corrige el único cierre histórico reportado, con
-- guardas sobre el UUID y todos los importes afectados.

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
  v_uid                uuid := auth.uid();
  v_ses                public.caja_sesiones%ROWTYPE;
  v_esperado           jsonb;
  v_contado            jsonb := COALESCE(p_contado, '{}'::jsonb);
  v_diferencia         jsonb := '{}'::jsonb;
  v_tot_esp            numeric(14,2) := 0;
  v_tot_cont           numeric(14,2) := 0;
  v_efectivo_contado   numeric(14,2);
  v_efectivo_dejado    numeric(14,2);
  k                    text;
  v_formas             text[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_ses
  FROM public.caja_sesiones
  WHERE id = p_sesion_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sesión de caja no existe';
  END IF;
  IF v_ses.estado <> 'ABIERTA' THEN
    RAISE EXCEPTION 'La caja ya fue cerrada';
  END IF;
  IF NOT public.is_admin(v_uid)
     AND v_ses.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'Esa caja es de otra sucursal';
  END IF;

  v_esperado := public.caja_esperado(p_sesion_id);

  -- Validar que las claves de contado sean formas de pago reales.
  FOR k IN SELECT jsonb_object_keys(v_contado) LOOP
    BEGIN
      PERFORM k::public.forma_pago;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Forma de pago desconocida en el conteo: %', k;
    END;
  END LOOP;

  IF NOT (v_contado ? 'EFECTIVO')
     OR jsonb_typeof(v_contado->'EFECTIVO') <> 'number' THEN
    RAISE EXCEPTION 'Tenés que informar el efectivo contado antes de cerrar';
  END IF;

  v_efectivo_contado := ROUND((v_contado->>'EFECTIVO')::numeric, 2);
  v_efectivo_dejado := ROUND(COALESCE(p_efectivo_dejado, 0), 2);

  IF v_efectivo_contado < 0 OR v_efectivo_dejado < 0 THEN
    RAISE EXCEPTION 'El efectivo contado y el dejado no pueden ser negativos';
  END IF;
  IF v_efectivo_dejado > v_efectivo_contado THEN
    RAISE EXCEPTION
      'El efectivo dejado (%) no puede superar al efectivo contado (%)',
      v_efectivo_dejado,
      v_efectivo_contado;
  END IF;

  -- Normalizar el valor autoritativo a centavos antes de calcular totales.
  v_contado := v_contado || jsonb_build_object('EFECTIVO', v_efectivo_contado);

  SELECT array_agg(DISTINCT f) INTO v_formas
  FROM (
    SELECT jsonb_object_keys(v_esperado) AS f
    UNION
    SELECT jsonb_object_keys(v_contado) AS f
  ) u;

  -- Sólo el efectivo se cuenta a mano. El resto se cierra con el esperado
  -- recalculado en esta misma transacción, evitando diferencias por caché.
  IF v_formas IS NOT NULL THEN
    FOREACH k IN ARRAY v_formas LOOP
      IF k <> 'EFECTIVO' THEN
        v_contado := v_contado || jsonb_build_object(
          k,
          ROUND(COALESCE((v_esperado->k->>'neto')::numeric, 0), 2)
        );
      END IF;
    END LOOP;
  END IF;

  -- Diferencia = contado - esperado, sobre la unión de formas.
  IF v_formas IS NOT NULL THEN
    FOREACH k IN ARRAY v_formas LOOP
      v_diferencia := v_diferencia || jsonb_build_object(
        k,
        ROUND(
          COALESCE((v_contado->>k)::numeric, 0)
          - COALESCE((v_esperado->k->>'neto')::numeric, 0),
          2
        )
      );
    END LOOP;
  END IF;

  SELECT COALESCE(SUM((value->>'neto')::numeric), 0)
  INTO v_tot_esp
  FROM jsonb_each(v_esperado);

  SELECT COALESCE(SUM(value::numeric), 0)
  INTO v_tot_cont
  FROM jsonb_each_text(v_contado);

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
    efectivo_dejado  = v_efectivo_dejado,
    notas            = p_notas
  WHERE id = p_sesion_id;

  RETURN QUERY
  SELECT v_tot_esp, v_tot_cont, ROUND(v_tot_cont - v_tot_esp, 2);
END;
$function$;

REVOKE ALL ON FUNCTION public.cerrar_caja(uuid, jsonb, text, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.cerrar_caja(uuid, jsonb, text, numeric)
  TO authenticated, service_role;

DO $correccion$
DECLARE
  v_filas integer;
BEGIN
  UPDATE public.caja_sesiones
  SET
    contado = jsonb_set(
      contado,
      '{EFECTIVO}',
      to_jsonb(125933.17::numeric),
      true
    ),
    diferencia = jsonb_set(
      diferencia,
      '{EFECTIVO}',
      to_jsonb(0::numeric),
      true
    ),
    total_contado = 2346322.08,
    total_diferencia = 0
  WHERE id = 'ff666de1-64f9-44c1-a00f-ee8e80a6b92a'::uuid
    AND estado = 'CERRADA'
    AND cerrada_en = '2026-08-21T20:50:45.331471+00:00'::timestamptz
    AND ROUND((contado->>'EFECTIVO')::numeric, 2) = 12533.17
    AND ROUND((diferencia->>'EFECTIVO')::numeric, 2) = -113400
    AND total_esperado = 2346322.08
    AND total_contado = 2232922.08
    AND total_diferencia = -113400
    AND efectivo_dejado = 25933.17;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas = 1 THEN
    RAISE NOTICE 'Cierre ff666de1 corregido: contado 125933.17, retirado 100000.00, dejado 25933.17, diferencia 0.00';
  ELSE
    RAISE NOTICE 'Cierre ff666de1 no modificado: no existe en este entorno o ya no coincide con el estado original';
  END IF;
END;
$correccion$;
