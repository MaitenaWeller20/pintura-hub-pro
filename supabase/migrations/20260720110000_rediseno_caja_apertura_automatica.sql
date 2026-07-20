-- ============================================================
-- 20260720110000_rediseno_caja_apertura_automatica.sql
--
-- REDISEÑO DE CAJA — apertura automática y fondo heredado del cierre anterior.
--
--   1. La caja se abre SOLA con la primera operación del día de la sucursal
--      (venta, cobranza, compra o pago). Ya no se aprieta "abrir caja".
--   2. Al abrirse, el fondo_inicial = efectivo_dejado del ÚLTIMO cierre de esa
--      sucursal (0 si no hay cierre previo). No se carga a mano.
--   3. El cierre guarda cuánto efectivo se deja para el día siguiente
--      (nueva columna efectivo_dejado), que alimenta el fondo del próximo turno.
--   4. Las RPC que exigían "Abrí la caja antes de..." ahora AUTO-ABREN vía
--      caja_sesion_actual().
--
-- Como el trigger estampar_caja_sesion está atado a ventas, cobranzas, compras y
-- proveedor_pagos, la auto-apertura también aplica a compras contado y a la
-- anulación de ventas (devoluciones): es coherente (cualquier operación de plata
-- abre el día). El guard "Abrí la caja..." de crear_compra queda inalcanzable (la
-- compra auto-abre la caja en la misma transacción) — es benigno.
--
-- OJO DE DESPLIEGUE: esta migración debe ir JUNTO con la UI que manda
-- p_efectivo_dejado al cerrar. Si se aplica sola, cerrar_caja guardaría 0 y el
-- fondo del día siguiente saldría en 0.
--
-- abrir_caja() se conserva (apertura manual con fondo explícito sigue siendo
-- válida); el flujo normal ya no la necesita.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Nueva columna: efectivo que se deja para el próximo turno.
-- ------------------------------------------------------------
ALTER TABLE public.caja_sesiones
  ADD COLUMN IF NOT EXISTS efectivo_dejado numeric(14,2);

COMMENT ON COLUMN public.caja_sesiones.efectivo_dejado IS
  'Efectivo físico que el cajero deja en la caja al cerrar, para el día siguiente. '
  'Se setea en cerrar_caja y alimenta el fondo_inicial de la próxima apertura '
  'automática de la sucursal (ver caja_sesion_actual). NULL en cajas aún abiertas.';

-- ------------------------------------------------------------
-- 2. Helper get-or-create con APERTURA AUTOMÁTICA.
--    Devuelve la sesión ABIERTA de la sucursal; si no hay, la abre sola con
--    fondo = efectivo dejado en el último cierre.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caja_sesion_actual(p_sucursal_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_sesion uuid;
  v_fondo  numeric(14,2);
BEGIN
  -- Llamada sin usuario (service_role sin JWT): no podemos setear abierta_por
  -- (NOT NULL), así que NO creamos una sesión. Pero si ya hay una abierta, atamos
  -- la operación a ella (preserva el estampado del trigger viejo).
  IF v_uid IS NULL THEN
    RETURN (SELECT id FROM public.caja_sesiones
             WHERE sucursal_id = p_sucursal_id AND estado = 'ABIERTA'
             ORDER BY abierta_en DESC LIMIT 1);
  END IF;

  -- Serializa aperturas concurrentes de la misma sucursal (igual que abrir_caja):
  -- dos operaciones simultáneas no crean dos turnos ABIERTOS.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_sucursal_id::text, 0));

  -- ¿Ya hay caja abierta? FOR SHARE serializa contra cerrar_caja (FOR UPDATE): si
  -- se está cerrando esta sesión, esperamos; al liberar re-evaluamos estado='ABIERTA',
  -- de modo que una caja recién cerrada no se reutiliza (se abre una nueva abajo).
  SELECT id INTO v_sesion
    FROM public.caja_sesiones
   WHERE sucursal_id = p_sucursal_id AND estado = 'ABIERTA'
   ORDER BY abierta_en DESC
   LIMIT 1
   FOR SHARE;

  IF v_sesion IS NOT NULL THEN
    RETURN v_sesion;
  END IF;

  -- Sin caja abierta => apertura automática. El fondo es el efectivo dejado en el
  -- último cierre de la sucursal (0 si no hay cierre previo). GREATEST(...,0) evita
  -- violar el CHECK (fondo_inicial >= 0) ante un valor inesperado.
  v_fondo := GREATEST(COALESCE((
    SELECT efectivo_dejado
      FROM public.caja_sesiones
     WHERE sucursal_id = p_sucursal_id AND estado = 'CERRADA'
     ORDER BY cerrada_en DESC NULLS LAST
     LIMIT 1
  ), 0), 0);

  INSERT INTO public.caja_sesiones (sucursal_id, estado, abierta_por, fondo_inicial)
  VALUES (p_sucursal_id, 'ABIERTA', v_uid, v_fondo)
  RETURNING id INTO v_sesion;

  IF v_fondo > 0 THEN
    INSERT INTO public.caja_movimientos (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
    VALUES (v_sesion, 'INICIAL', 'EFECTIVO', v_fondo, 'Fondo inicial de caja (apertura automática)', v_uid);
  END IF;

  RETURN v_sesion;
END; $function$;

-- Solo interno (lo llaman el trigger y las RPC, que son SECURITY DEFINER y corren
-- como el dueño). No se expone a authenticated: abre caja sin el control de
-- sucursal de abrir_caja, así que no debe ser invocable directo por el cliente.
REVOKE ALL ON FUNCTION public.caja_sesion_actual(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.caja_sesion_actual(uuid) TO service_role;

-- ------------------------------------------------------------
-- 3. Trigger de estampado: la PRIMERA operación abre la caja.
--    Antes sólo ataba a una sesión ABIERTA existente (si no había, dejaba NULL).
--    Ahora delega en caja_sesion_actual, que la abre sola si hace falta.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.estampar_caja_sesion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.caja_sesion_id IS NULL THEN
    NEW.caja_sesion_id := public.caja_sesion_actual(NEW.sucursal_id);
  END IF;
  RETURN NEW;
END; $function$;

-- ------------------------------------------------------------
-- 4. cerrar_caja: firma nueva con p_efectivo_dejado. DROP + CREATE porque el
--    nuevo parámetro cambia la firma (no es un simple REPLACE).
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.cerrar_caja(uuid, jsonb, text);

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

  -- diferencia = contado − esperado, sobre la UNIÓN de las formas presentes en
  -- cualquiera de los dos (una forma sólo esperada cuenta como faltante total;
  -- una sólo contada, como sobrante).
  SELECT array_agg(DISTINCT f) INTO v_formas FROM (
    SELECT jsonb_object_keys(v_esperado) AS f
    UNION
    SELECT jsonb_object_keys(v_contado) AS f
  ) u;

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

-- ------------------------------------------------------------
-- 5. RPC que exigían caja abierta => ahora AUTO-ABREN vía caja_sesion_actual.
--    Sólo cambia ese bloque; el resto del cuerpo es idéntico al vigente.
-- ------------------------------------------------------------

-- 5.1 registrar_cobranza -------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_cobranza(p_cliente_id uuid, p_sucursal_id uuid, p_monto numeric, p_forma_pago text, p_detalle jsonb DEFAULT '{}'::jsonb, p_observaciones text DEFAULT NULL::text)
 RETURNS TABLE(cobranza_id uuid, saldo numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid         uuid := auth.uid();
  v_cobranza_id uuid;
  v_sesion      uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés cobrar en una sucursal que no es la tuya';
  END IF;

  IF COALESCE(p_monto, 0) <= 0 THEN
    RAISE EXCEPTION 'El monto del cobro debe ser mayor a cero';
  END IF;

  IF p_forma_pago = 'CTA_CTE' THEN
    RAISE EXCEPTION 'CTA_CTE no es una forma de pago';
  END IF;

  -- (4) El cliente tiene que existir, estar activo y tener cuenta corriente
  -- habilitada (mismo criterio que crear_venta; no se cobra cta cte a quien no la tiene).
  IF NOT EXISTS (
    SELECT 1 FROM public.clientes
     WHERE id = p_cliente_id AND activo AND COALESCE(condicion_cta_cte, false)
  ) THEN
    RAISE EXCEPTION 'Cliente inexistente, inactivo o sin cuenta corriente habilitada';
  END IF;

  -- (3) El cobro entra a la caja: APERTURA AUTOMÁTICA. Si es la primera operación
  -- del día de la sucursal, caja_sesion_actual abre la caja sola (fondo = efectivo
  -- dejado en el último cierre) y devuelve su id; si ya hay caja abierta, la usa.
  v_sesion := public.caja_sesion_actual(p_sucursal_id);

  INSERT INTO public.cobranzas_cta_cte (
    cliente_id, sucursal_id, usuario_id, monto, forma_pago, detalle, observaciones, caja_sesion_id
  ) VALUES (
    p_cliente_id, p_sucursal_id, v_uid, p_monto, p_forma_pago,
    COALESCE(p_detalle, '{}'::jsonb), p_observaciones, v_sesion
  ) RETURNING id INTO v_cobranza_id;

  -- El cobro es un CRÉDITO: baja la deuda del cliente.
  INSERT INTO public.cuenta_corriente_movimientos (
    cliente_id, sucursal_id, tipo, monto, cobranza_id, forma_pago, descripcion, usuario_id
  ) VALUES (
    p_cliente_id, p_sucursal_id, 'CREDITO', ROUND(p_monto, 2), v_cobranza_id, p_forma_pago,
    'Cobro cuenta corriente', v_uid
  );

  RETURN QUERY SELECT v_cobranza_id, public.cc_saldo(p_cliente_id);
END; $function$;

REVOKE ALL ON FUNCTION public.registrar_cobranza(uuid, uuid, numeric, text, jsonb, text) FROM public;
GRANT EXECUTE ON FUNCTION public.registrar_cobranza(uuid, uuid, numeric, text, jsonb, text) TO authenticated;

-- 5.2 registrar_pago_proveedor -------------------------------
CREATE OR REPLACE FUNCTION public.registrar_pago_proveedor(p_proveedor_id uuid, p_sucursal_id uuid, p_monto numeric, p_forma_pago text, p_detalle jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_monto  numeric(14,2) := ROUND(COALESCE(p_monto, 0), 2);
  v_pago   uuid;
  v_sesion uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés pagar desde una sucursal que no es la tuya';
  END IF;
  IF v_monto <= 0 THEN RAISE EXCEPTION 'El monto tiene que ser mayor a cero'; END IF;
  IF p_forma_pago = 'CTA_CTE' THEN RAISE EXCEPTION 'CTA_CTE no es una forma de pago'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.proveedores WHERE id = p_proveedor_id AND activo) THEN
    RAISE EXCEPTION 'Proveedor inexistente o inactivo';
  END IF;

  -- La plata sale de la caja: APERTURA AUTOMÁTICA (auto-abre en la primera
  -- operación del día de la sucursal).
  v_sesion := public.caja_sesion_actual(p_sucursal_id);

  INSERT INTO public.proveedor_pagos (proveedor_id, sucursal_id, usuario_id, monto, forma_pago, detalle, caja_sesion_id)
  VALUES (p_proveedor_id, p_sucursal_id, v_uid, v_monto, p_forma_pago, COALESCE(p_detalle, '{}'::jsonb), v_sesion)
  RETURNING id INTO v_pago;

  INSERT INTO public.proveedor_cc_movimientos (
    proveedor_id, sucursal_id, tipo, monto, estado, pago_id, forma_pago, descripcion, usuario_id
  ) VALUES (
    p_proveedor_id, p_sucursal_id, 'CREDITO', v_monto, 'CONFIRMADO', v_pago, p_forma_pago,
    'Pago a proveedor', v_uid
  );

  RETURN v_pago;
END; $function$;

REVOKE ALL ON FUNCTION public.registrar_pago_proveedor(uuid, uuid, numeric, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.registrar_pago_proveedor(uuid, uuid, numeric, text, jsonb) TO authenticated, service_role;

-- 5.3 anular_compra ------------------------------------------
CREATE OR REPLACE FUNCTION public.anular_compra(p_compra_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid := auth.uid();
  v_c              public.compras%ROWTYPE;
  v_permite_neg    boolean;
  r                RECORD;
  v_pago           RECORD;
  v_sesion_abierta uuid;
  v_stock_ant      numeric(14,2);
  v_stock_nue      numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) THEN RAISE EXCEPTION 'Sólo un administrador puede anular una compra'; END IF;

  SELECT * INTO v_c FROM public.compras WHERE id = p_compra_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compra no encontrada'; END IF;
  IF v_c.estado = 'ANULADA' THEN RAISE EXCEPTION 'La compra ya fue anulada'; END IF;

  -- Tomamos el advisory lock de la sucursal ANTES de bloquear filas de stock, en el
  -- MISMO orden que crear_venta (advisory -> stock). El orden inverso (stock ->
  -- advisory al auto-abrir la caja más abajo) haría un deadlock ABBA con una venta
  -- concurrente del mismo producto. El lock es re-entrante: caja_sesion_actual lo
  -- vuelve a tomar sin bloquearse.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_c.sucursal_id::text, 0));

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);

  -- Revierte stock por ítem. Si ya se vendió parte de esa mercadería y quedaría
  -- negativo, no deja anular (salvo que la política de stock negativo lo permita).
  FOR r IN SELECT producto_id, cantidad, codigo FROM public.compra_items WHERE compra_id = p_compra_id
  LOOP
    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES (r.producto_id, v_c.sucursal_id, 0)
      ON CONFLICT (producto_id, sucursal_id) DO NOTHING;
      UPDATE public.stock_sucursal SET cantidad = cantidad - r.cantidad
       WHERE producto_id = r.producto_id AND sucursal_id = v_c.sucursal_id
      RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
    ELSE
      UPDATE public.stock_sucursal SET cantidad = cantidad - r.cantidad
       WHERE producto_id = r.producto_id AND sucursal_id = v_c.sucursal_id AND cantidad >= r.cantidad
      RETURNING cantidad + r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No se puede anular: ya se vendió parte de % (no alcanza el stock para revertir)', r.codigo;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      r.producto_id, v_c.sucursal_id, 'ANULACION_COMPRA', -r.cantidad, v_stock_ant, v_stock_nue,
      'Anulación compra ' || v_c.numero_comprobante, p_compra_id, v_uid
    );
  END LOOP;

  UPDATE public.compras SET estado = 'ANULADA' WHERE id = p_compra_id;

  -- Deuda (CTA_CTE): anula el DEBITO.
  UPDATE public.proveedor_cc_movimientos SET estado = 'ANULADO'
    WHERE compra_id = p_compra_id AND estado = 'CONFIRMADO';

  -- CONTADO: la plata pagada VUELVE a la caja. Igual que anular_venta reinyecta los
  -- pagos negados a la sesión abierta. La caja se AUTO-ABRE y se compensan sólo los
  -- pagos que NO son de esa misma sesión (los que sí, se revierten con el 'ANULADO').
  IF v_c.condicion = 'CONTADO'
     AND EXISTS (SELECT 1 FROM public.proveedor_pagos
                  WHERE compra_id = p_compra_id AND estado = 'CONFIRMADO') THEN
    -- La plata vuelve a la caja: APERTURA AUTOMÁTICA.
    v_sesion_abierta := public.caja_sesion_actual(v_c.sucursal_id);

    FOR v_pago IN
      SELECT caja_sesion_id, forma_pago, monto
        FROM public.proveedor_pagos
       WHERE compra_id = p_compra_id AND estado = 'CONFIRMADO'
    LOOP
      IF v_pago.caja_sesion_id IS DISTINCT FROM v_sesion_abierta THEN
        INSERT INTO public.caja_movimientos
          (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
        VALUES
          (v_sesion_abierta, 'INGRESO', v_pago.forma_pago::public.forma_pago, v_pago.monto,
           'Reversa de compra anulada ' || v_c.numero_comprobante, v_uid);
      END IF;
    END LOOP;
  END IF;

  -- Contado: los pagos dejan de restar del esperado en vivo de su propia sesión.
  UPDATE public.proveedor_pagos SET estado = 'ANULADO'
    WHERE compra_id = p_compra_id AND estado = 'CONFIRMADO';
END; $function$;

REVOKE ALL ON FUNCTION public.anular_compra(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_compra(uuid) TO authenticated, service_role;

-- 5.4 anular_pago_proveedor ----------------------------------
CREATE OR REPLACE FUNCTION public.anular_pago_proveedor(p_pago_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid := auth.uid();
  v_p              public.proveedor_pagos%ROWTYPE;
  v_sesion_abierta uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  -- (1) Sólo un administrador puede anular un pago (coherente con anular_compra).
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede anular un pago';
  END IF;

  SELECT * INTO v_p FROM public.proveedor_pagos WHERE id = p_pago_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pago no encontrado'; END IF;
  IF v_p.estado = 'ANULADO' THEN RAISE EXCEPTION 'El pago ya fue anulado'; END IF;
  IF v_p.compra_id IS NOT NULL THEN
    RAISE EXCEPTION 'Este pago es de una compra contado: anulá la compra, no el pago';
  END IF;

  -- (2) La plata pagada al proveedor VUELVE a la caja: APERTURA AUTOMÁTICA de la
  -- sucursal del pago.
  v_sesion_abierta := public.caja_sesion_actual(v_p.sucursal_id);

  -- Sólo compensar si el pago NO es de la sesión abierta actual (si lo es, el
  -- 'ANULADO' de abajo ya lo saca del esperado en vivo => compensar sería doble).
  IF v_p.caja_sesion_id IS DISTINCT FROM v_sesion_abierta THEN
    INSERT INTO public.caja_movimientos
      (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
    VALUES
      (v_sesion_abierta, 'INGRESO', v_p.forma_pago::public.forma_pago, v_p.monto,
       'Reversa de pago a proveedor anulado', v_uid);
  END IF;

  UPDATE public.proveedor_pagos SET estado = 'ANULADO' WHERE id = p_pago_id;
  UPDATE public.proveedor_cc_movimientos SET estado = 'ANULADO'
    WHERE pago_id = p_pago_id AND estado = 'CONFIRMADO';
END; $function$;

REVOKE ALL ON FUNCTION public.anular_pago_proveedor(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_pago_proveedor(uuid) TO authenticated, service_role;
