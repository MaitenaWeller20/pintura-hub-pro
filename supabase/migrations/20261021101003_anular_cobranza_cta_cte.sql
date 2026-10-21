-- Una cobranza equivocada se compensa en una caja abierta y se anula en la cuenta.
-- El cobro original permanece visible; la reversa y una copia auditada conservan el rastro.
-- Las FK restringen borrados posteriores de cualquiera de los dos asientos;
-- cualquier reset transaccional debe tratar explícitamente esta auditoría.
CREATE TABLE public.cobranza_anulaciones (
  cobranza_id uuid PRIMARY KEY REFERENCES public.cobranzas_cta_cte(id),
  reversa_id uuid NOT NULL UNIQUE REFERENCES public.cobranzas_cta_cte(id),
  cobranza jsonb NOT NULL,
  movimiento jsonb NOT NULL,
  motivo text NOT NULL CHECK (length(trim(motivo)) BETWEEN 3 AND 200),
  anulada_por uuid NOT NULL REFERENCES auth.users(id),
  anulada_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cobranza_anulaciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cobranza_anulaciones FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cobranza_anulaciones TO service_role;

CREATE FUNCTION public.anular_cobranza(
  p_cobranza_id uuid,
  p_cliente_id uuid,
  p_monto numeric,
  p_motivo text
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sucursal_id uuid;
  v_cobranza public.cobranzas_cta_cte%ROWTYPE;
  v_movimiento public.cuenta_corriente_movimientos%ROWTYPE;
  v_sesion uuid;
  v_reversa_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Solo un administrador puede anular cobros';
  END IF;
  IF length(trim(COALESCE(p_motivo, ''))) NOT BETWEEN 3 AND 200 THEN
    RAISE EXCEPTION 'Ingresá un motivo de entre 3 y 200 caracteres';
  END IF;

  SELECT sucursal_id INTO v_sucursal_id
    FROM public.cobranzas_cta_cte WHERE id = p_cobranza_id;
  IF v_sucursal_id IS NULL THEN
    RAISE EXCEPTION 'Cobro no disponible';
  END IF;

  -- Serializa con aperturas y operaciones de efectivo de la sucursal.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_sucursal_id::text, 0));

  SELECT * INTO v_cobranza
    FROM public.cobranzas_cta_cte
   WHERE id = p_cobranza_id
   FOR UPDATE;
  IF NOT FOUND OR v_cobranza.sucursal_id IS DISTINCT FROM v_sucursal_id THEN
    RAISE EXCEPTION 'Cobro no disponible';
  END IF;

  IF v_cobranza.cliente_id IS DISTINCT FROM p_cliente_id OR
     v_cobranza.monto IS DISTINCT FROM ROUND(p_monto, 2) OR
     v_cobranza.monto <= 0 THEN
    RAISE EXCEPTION 'El cobro cambió. Actualizá la cuenta e intentá de nuevo';
  END IF;

  SELECT id INTO v_sesion
    FROM public.caja_sesiones
   WHERE id = v_cobranza.caja_sesion_id
     AND sucursal_id = v_cobranza.sucursal_id
     AND estado = 'ABIERTA'
   FOR SHARE;
  -- Un cierre anterior no se modifica: la corrección se registra en la caja
  -- actual de la misma sucursal y queda ligada al cobro mediante la auditoría.
  IF v_sesion IS NULL THEN
    v_sesion := public.caja_sesion_actual(v_cobranza.sucursal_id);
  END IF;
  IF v_sesion IS NULL THEN
    RAISE EXCEPTION 'No se pudo abrir la caja para registrar la corrección';
  END IF;

  SELECT * INTO v_movimiento
    FROM public.cuenta_corriente_movimientos
   WHERE cobranza_id = p_cobranza_id
   FOR UPDATE;
  IF NOT FOUND OR v_movimiento.cliente_id IS DISTINCT FROM v_cobranza.cliente_id OR
     v_movimiento.sucursal_id IS DISTINCT FROM v_cobranza.sucursal_id OR
     v_movimiento.tipo <> 'CREDITO' OR v_movimiento.estado <> 'CONFIRMADO' OR
     v_movimiento.monto IS DISTINCT FROM v_cobranza.monto THEN
    RAISE EXCEPTION 'El movimiento de cuenta no coincide con el cobro';
  END IF;

  -- Quitar un cobro en efectivo también quita efectivo disponible de la caja.
  IF v_cobranza.forma_pago = 'EFECTIVO' THEN
    PERFORM public.exigir_efectivo(v_cobranza.sucursal_id, v_sesion, v_cobranza.monto, 'anular este cobro');
  END IF;

  INSERT INTO public.cobranzas_cta_cte (
    cliente_id, sucursal_id, usuario_id, caja_sesion_id, monto,
    forma_pago, detalle, observaciones
  ) VALUES (
    v_cobranza.cliente_id, v_cobranza.sucursal_id, v_uid, v_sesion, -v_cobranza.monto,
    v_cobranza.forma_pago,
    jsonb_build_object('anulacion_de', p_cobranza_id, 'motivo', trim(p_motivo)),
    'Reversa de cobro ' || p_cobranza_id::text
  ) RETURNING id INTO v_reversa_id;

  INSERT INTO public.cobranza_anulaciones
    (cobranza_id, reversa_id, cobranza, movimiento, motivo, anulada_por)
  VALUES
    (p_cobranza_id, v_reversa_id, to_jsonb(v_cobranza), to_jsonb(v_movimiento), trim(p_motivo), v_uid);

  UPDATE public.cuenta_corriente_movimientos
     SET estado = 'ANULADO', descripcion = COALESCE(descripcion, 'Cobro cuenta corriente') || ' · Anulado: ' || trim(p_motivo)
   WHERE id = v_movimiento.id;

  RETURN public.cc_saldo(v_cobranza.cliente_id);
END;
$$;

REVOKE ALL ON FUNCTION public.anular_cobranza(uuid, uuid, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anular_cobranza(uuid, uuid, numeric, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
