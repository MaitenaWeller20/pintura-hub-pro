-- El remito sigue siendo la misma venta: stock, cuenta corriente y pagos conservan venta_id.
ALTER TABLE public.ventas
  ADD COLUMN remito_facturado_at timestamptz,
  ADD COLUMN remito_facturado_por uuid REFERENCES auth.users(id),
  ADD CONSTRAINT ventas_remito_facturado_integridad CHECK (
    (remito_facturado_at IS NULL AND remito_facturado_por IS NULL)
    OR (remito_facturado_at IS NOT NULL AND remito_facturado_por IS NOT NULL
        AND tipo_comprobante = 'VENTA')
  );

CREATE OR REPLACE FUNCTION public.convertir_remito_a_venta(p_venta_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_venta public.ventas%ROWTYPE;
  v_movimiento public.cuenta_corriente_movimientos%ROWTYPE;
  v_v2 boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  PERFORM 1 FROM public.profiles WHERE id = v_uid AND activo;
  IF NOT FOUND OR NOT public.is_admin(v_uid) OR NOT public.puede_facturar(v_uid) THEN
    RAISE EXCEPTION 'Solo un administrador puede facturar remitos existentes';
  END IF;

  SELECT * INTO v_venta FROM public.ventas WHERE id = p_venta_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Remito no disponible'; END IF;

  -- La misma fila bloqueada hace que dos clics o dos sesiones devuelvan un único resultado.
  IF v_venta.remito_facturado_at IS NOT NULL THEN
    IF v_venta.tipo_comprobante <> 'VENTA' THEN
      RAISE EXCEPTION 'La conversión del remito tiene datos inconsistentes';
    END IF;
    RETURN jsonb_build_object('venta_id', v_venta.id,
      'numero_remito', v_venta.numero_comprobante, 'afip_estado', v_venta.afip_estado);
  END IF;

  SELECT facturacion_receptor_v2_enabled INTO v_v2 FROM public.settings WHERE id = true;
  IF NOT COALESCE(v_v2, false) THEN
    RAISE EXCEPTION 'El flujo de facturación fiscal v2 está deshabilitado';
  END IF;
  IF v_venta.tipo_comprobante <> 'REMITO'
     OR v_venta.condicion_venta <> 'CTA_CTE'
     OR v_venta.estado <> 'ACTIVA'
     OR v_venta.total <= 0
     OR v_venta.afip_estado NOT IN ('NO_APLICA', 'PENDIENTE')
     OR v_venta.cae IS NOT NULL
     OR v_venta.afip_numero IS NOT NULL
     OR v_venta.afip_snapshot IS NOT NULL
     OR v_venta.afip_claim_token IS NOT NULL
     OR v_venta.afip_fase IS NOT NULL
     OR v_venta.afip_intentos <> 0 THEN
    RAISE EXCEPTION 'Solo se puede facturar un remito activo de cuenta corriente sin trámite fiscal previo';
  END IF;

  SELECT * INTO v_movimiento FROM public.cuenta_corriente_movimientos
   WHERE venta_id = p_venta_id FOR UPDATE;
  IF NOT FOUND OR v_movimiento.tipo <> 'DEBITO'
     OR v_movimiento.estado <> 'CONFIRMADO'
     OR v_movimiento.cliente_id IS DISTINCT FROM v_venta.cliente_id
     OR v_movimiento.sucursal_id IS DISTINCT FROM v_venta.sucursal_id
     OR v_movimiento.monto IS DISTINCT FROM v_venta.total THEN
    RAISE EXCEPTION 'El remito no coincide con la deuda de cuenta corriente';
  END IF;
  PERFORM 1 FROM public.venta_items WHERE venta_id = p_venta_id LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'El remito no tiene productos'; END IF;

  UPDATE public.ventas
     SET tipo_comprobante = 'VENTA',
         afip_estado = 'SIN_FACTURAR',
         remito_facturado_at = now(),
         remito_facturado_por = v_uid
   WHERE id = p_venta_id;

  RETURN jsonb_build_object('venta_id', v_venta.id,
    'numero_remito', v_venta.numero_comprobante, 'afip_estado', 'SIN_FACTURAR');
END;
$$;

REVOKE ALL ON FUNCTION public.convertir_remito_a_venta(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.convertir_remito_a_venta(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
