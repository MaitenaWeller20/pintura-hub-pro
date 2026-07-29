-- ============================================================
-- Correcciones del review adversarial de los pagos a proveedores.
-- ============================================================

-- ------------------------------------------------------------
-- 1. El número de recibo tiene que ser único
--
-- `next_documento_numero` mapea sólo OHIGGINS y GENERALPAZ; cualquier sucursal
-- nueva cae en el prefijo 'SUC', así que dos sucursales nuevas emitirían las dos
-- "SUC-PAGO-0001". Hoy no pasa, pero nada lo impedía — y un número de recibo
-- repetido es exactamente lo que un número de recibo no puede ser.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_proveedor_pagos_numero
  ON public.proveedor_pagos (numero) WHERE numero IS NOT NULL;

-- El prefijo sale del código de la sucursal en vez de una lista cerrada: una
-- sucursal nueva numera con SU código y no choca con las demás.
CREATE OR REPLACE FUNCTION public.next_documento_numero(
  _sucursal_id uuid, _tipo text, _prefijo text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _next integer; _pref_suc text;
BEGIN
  INSERT INTO public.documento_secuencias (sucursal_id, tipo, ultimo_numero)
  VALUES (_sucursal_id, _tipo, 1)
  ON CONFLICT (sucursal_id, tipo)
  DO UPDATE SET ultimo_numero = documento_secuencias.ultimo_numero + 1
  RETURNING ultimo_numero INTO _next;

  -- `sucursales.codigo` es un ENUM, no texto: hay que castearlo para tratarlo
  -- como string en el ELSE.
  SELECT CASE codigo::text
           WHEN 'OHIGGINS'   THEN 'OHI'
           WHEN 'GENERALPAZ' THEN 'GPZ'
           -- Una sucursal nueva usa las 3 primeras letras de su código, no un
           -- 'SUC' genérico que colisionaría con cualquier otra sucursal nueva.
           ELSE upper(left(regexp_replace(codigo::text, '[^A-Za-z]', '', 'g'), 3))
         END
    INTO _pref_suc FROM public.sucursales WHERE id = _sucursal_id;

  RETURN COALESCE(NULLIF(_pref_suc, ''), 'SUC') || '-' || _prefijo || '-' || lpad(_next::text, 4, '0');
END; $$;

-- ------------------------------------------------------------
-- 2. Un pago tiene tope, como la compra
--
-- crear_compra valida LIMITE; el pago sólo validaba > 0. Un cero de más al
-- tipear entraba entero: proveedor_pagos.monto es numeric(14,2), o sea hasta
-- 999.999.999.999,99.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_pago_proveedor(
  p_proveedor_id uuid,
  p_sucursal_id  uuid,
  p_monto        numeric,
  p_forma_pago   text,
  p_detalle      jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_monto  numeric(14,2) := ROUND(COALESCE(p_monto, 0), 2);
  v_pago   uuid;
  v_sesion uuid;
  v_saldo  numeric(14,2);
  v_numero text;
  LIMITE   constant numeric := 999999999;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés pagar desde una sucursal que no es la tuya';
  END IF;
  IF v_monto <= 0 THEN RAISE EXCEPTION 'El monto tiene que ser mayor a cero'; END IF;
  IF v_monto > LIMITE THEN
    RAISE EXCEPTION 'El monto (%) no parece un pago válido. Revisá los números.', v_monto;
  END IF;
  IF p_forma_pago = 'CTA_CTE' THEN RAISE EXCEPTION 'CTA_CTE no es una forma de pago'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.proveedores WHERE id = p_proveedor_id AND activo) THEN
    RAISE EXCEPTION 'Proveedor inexistente o inactivo';
  END IF;

  v_sesion := public.caja_sesion_actual(p_sucursal_id);
  v_numero := public.next_documento_numero(p_sucursal_id, 'PAGO_PROVEEDOR', 'PAGO');

  INSERT INTO public.proveedor_pagos (
    proveedor_id, sucursal_id, usuario_id, monto, forma_pago, detalle,
    caja_sesion_id, numero
  ) VALUES (
    p_proveedor_id, p_sucursal_id, v_uid, v_monto, p_forma_pago,
    COALESCE(p_detalle, '{}'::jsonb), v_sesion, v_numero
  ) RETURNING id INTO v_pago;

  INSERT INTO public.proveedor_cc_movimientos (
    proveedor_id, sucursal_id, tipo, monto, estado, pago_id, forma_pago, descripcion, usuario_id
  ) VALUES (
    p_proveedor_id, p_sucursal_id, 'CREDITO', v_monto, 'CONFIRMADO', v_pago, p_forma_pago,
    'Pago a proveedor ' || v_numero, v_uid
  );

  -- Se bloquea al proveedor antes de leer el saldo: dos sucursales pagándole al
  -- mismo proveedor en el mismo instante no se ven bajo READ COMMITTED, y el
  -- saldo congelado de uno de los dos recibos saldría equivocado.
  PERFORM 1 FROM public.proveedores WHERE id = p_proveedor_id FOR UPDATE;

  SELECT COALESCE(SUM(CASE WHEN tipo = 'DEBITO' THEN monto ELSE -monto END), 0)
    INTO v_saldo
    FROM public.proveedor_cc_movimientos
   WHERE proveedor_id = p_proveedor_id AND estado = 'CONFIRMADO';
  UPDATE public.proveedor_pagos SET saldo_posterior = v_saldo WHERE id = v_pago;

  RETURN v_pago;
END; $$;

REVOKE ALL ON FUNCTION public.registrar_pago_proveedor(uuid, uuid, numeric, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.registrar_pago_proveedor(uuid, uuid, numeric, text, jsonb) TO authenticated, service_role;
