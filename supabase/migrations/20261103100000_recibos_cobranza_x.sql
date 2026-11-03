-- Un Recibo X documenta una cobranza existente. No crea pagos, ventas ni movimientos.
CREATE TABLE public.recibos_cobranza (
  cobranza_id uuid PRIMARY KEY REFERENCES public.cobranzas_cta_cte(id) ON DELETE RESTRICT,
  sucursal_id uuid NOT NULL REFERENCES public.sucursales(id),
  numero text NOT NULL UNIQUE,
  emitido_at timestamptz NOT NULL DEFAULT now(),
  datos jsonb NOT NULL
);

ALTER TABLE public.recibos_cobranza ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recibos_cobranza FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.recibos_cobranza TO service_role;

CREATE OR REPLACE FUNCTION public.emitir_recibo_cobranza(p_cobranza_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cobro public.cobranzas_cta_cte%ROWTYPE;
  v_movimiento public.cuenta_corriente_movimientos%ROWTYPE;
  v_recibo public.recibos_cobranza%ROWTYPE;
  v_sucursal public.sucursales%ROWTYPE;
  v_cliente public.clientes%ROWTYPE;
  v_emisor public.emisores%ROWTYPE;
  v_datos jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  -- El mismo cobro se bloquea en anular_cobranza: emisión y anulación no se cruzan.
  SELECT * INTO v_cobro FROM public.cobranzas_cta_cte
   WHERE id = p_cobranza_id FOR UPDATE;
  IF NOT FOUND OR v_cobro.monto <= 0 THEN
    RAISE EXCEPTION 'Cobro no disponible';
  END IF;
  IF NOT public.is_admin(v_uid)
     AND v_cobro.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés emitir recibos de otra sucursal';
  END IF;
  -- La conversión a letras del PDF admite hasta 999.999.999 pesos.
  IF v_cobro.monto > 999999999 THEN
    RAISE EXCEPTION 'El importe supera el máximo imprimible del Recibo X';
  END IF;

  SELECT * INTO v_movimiento FROM public.cuenta_corriente_movimientos
   WHERE cobranza_id = p_cobranza_id AND tipo = 'CREDITO';
  IF NOT FOUND OR v_movimiento.cliente_id IS DISTINCT FROM v_cobro.cliente_id
     OR v_movimiento.sucursal_id IS DISTINCT FROM v_cobro.sucursal_id
     OR v_movimiento.monto IS DISTINCT FROM v_cobro.monto THEN
    RAISE EXCEPTION 'El cobro no coincide con la cuenta corriente';
  END IF;

  SELECT * INTO v_recibo FROM public.recibos_cobranza
   WHERE cobranza_id = p_cobranza_id;
  IF FOUND THEN
    RETURN jsonb_build_object('numero', v_recibo.numero, 'emitido_at', v_recibo.emitido_at,
      'datos', v_recibo.datos, 'anulado', v_movimiento.estado = 'ANULADO');
  END IF;
  IF v_movimiento.estado <> 'CONFIRMADO' THEN
    RAISE EXCEPTION 'No se emite un recibo nuevo para un cobro anulado';
  END IF;

  SELECT * INTO v_sucursal FROM public.sucursales WHERE id = v_cobro.sucursal_id;
  SELECT * INTO v_cliente FROM public.clientes WHERE id = v_cobro.cliente_id;
  SELECT * INTO v_emisor FROM public.emisores WHERE id = v_sucursal.emisor_id;
  IF v_sucursal.id IS NULL OR v_cliente.id IS NULL
     OR v_emisor.id IS NULL OR NULLIF(trim(v_emisor.razon_social), '') IS NULL
     OR NULLIF(trim(v_emisor.cuit), '') IS NULL THEN
    RAISE EXCEPTION 'Completá la razón social y el CUIT del emisor antes de emitir recibos';
  END IF;

  v_datos := jsonb_build_object(
    'cobranza_id', v_cobro.id,
    'fecha_cobro', v_cobro.fecha,
    'monto', v_cobro.monto,
    'forma_pago', v_cobro.forma_pago,
    'detalle', v_cobro.detalle,
    'observaciones', v_cobro.observaciones,
    'cliente', jsonb_build_object('razon_social', v_cliente.razon_social,
      'cuit_dni', v_cliente.cuit_dni, 'direccion', v_cliente.direccion,
      'tipo', v_cliente.tipo),
    'sucursal', jsonb_build_object('nombre', v_sucursal.nombre,
      'numero', v_sucursal.numero, 'direccion', v_sucursal.direccion,
      'telefono', v_sucursal.telefono),
    'emisor', jsonb_build_object('razon_social', v_emisor.razon_social,
      'cuit', v_emisor.cuit, 'domicilio_fiscal', v_emisor.domicilio_fiscal,
      'condicion_iva', v_emisor.condicion_iva,
      'ingresos_brutos', v_emisor.ingresos_brutos,
      'inicio_actividades', v_emisor.inicio_actividades,
      'logo', v_emisor.logo)
  );

  INSERT INTO public.recibos_cobranza (cobranza_id, sucursal_id, numero, datos)
  VALUES (p_cobranza_id, v_cobro.sucursal_id,
    public.next_documento_numero(v_cobro.sucursal_id, 'RECIBO_CLIENTE', 'RX'), v_datos)
  RETURNING * INTO v_recibo;

  RETURN jsonb_build_object('numero', v_recibo.numero, 'emitido_at', v_recibo.emitido_at,
    'datos', v_recibo.datos, 'anulado', false);
END;
$$;

REVOKE ALL ON FUNCTION public.emitir_recibo_cobranza(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emitir_recibo_cobranza(uuid) TO authenticated, service_role;

-- La pantalla consulta solo qué cobros anulados tienen un recibo previo para reimprimirlo.
CREATE FUNCTION public.recibos_cobranza_emitidos(p_cobranza_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT r.cobranza_id FROM public.recibos_cobranza AS r
   WHERE auth.uid() IS NOT NULL
     AND r.cobranza_id = ANY(p_cobranza_ids)
     AND (public.is_admin(auth.uid()) OR r.sucursal_id = public.current_sucursal_id())
$$;
REVOKE ALL ON FUNCTION public.recibos_cobranza_emitidos(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recibos_cobranza_emitidos(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
