-- ============================================================
-- La caja no puede quedar en rojo, y las ventas a medio cobrar se cobran.
--
-- Dos correcciones que salieron de probar el sistema de punta a punta el 04/08.
-- Ver docs/superpowers/specs/2026-08-04-caja-negativa-y-saldos-de-venta-design.md
--
--   1. Con $47.671 cobrados, el sistema dejaba pagar $221.000 en efectivo. La
--      caja terminaba en -$173.328 y el arqueo del día perdía sentido.
--
--   2. Una venta al contado cobrada a medias quedaba en PARCIAL para siempre:
--      no aparecía en Cuentas Corrientes y —lo grave— NO HABÍA NINGUNA FORMA
--      de cobrar el saldo cuando el cliente volvía con la plata.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Un pago puede caer en una caja distinta de la de su venta
--
-- Hasta hoy el arqueo atribuía cada pago a la caja POR LA VENTA. Mientras el
-- pago es simultáneo da igual, pero el saldo de una venta parcial se cobra otro
-- día: ese efectivo entra el jueves y no puede sumarse a la caja del lunes, que
-- ya está cerrada.
--
-- La columna es NULLABLE a propósito: los pagos ya guardados quedan en NULL y el
-- COALESCE los sigue contando exactamente donde contaban. Ningún arqueo pasado
-- cambia.
-- ------------------------------------------------------------
ALTER TABLE public.venta_pagos
  ADD COLUMN IF NOT EXISTS caja_sesion_id uuid REFERENCES public.caja_sesiones(id),
  ADD COLUMN IF NOT EXISTS cobro_idempotency_key uuid;

COMMENT ON COLUMN public.venta_pagos.caja_sesion_id IS
  'Caja donde entró ESTE pago. NULL = el pago se hizo junto con la venta y vale '
  'la caja de la venta (ver el COALESCE de caja_esperado). Lo llena cobrar_saldo_venta.';

-- Idempotencia del cobro de saldo: un doble click manda la misma clave y la
-- segunda rebota contra el índice. Parcial porque los pagos normales van en NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_venta_pagos_cobro_idem
  ON public.venta_pagos (cobro_idempotency_key)
  WHERE cobro_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_venta_pagos_caja
  ON public.venta_pagos (caja_sesion_id) WHERE caja_sesion_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Cuánto efectivo hay en una caja
--
-- La MISMA agregación que ya hace caja_esperado, filtrada a EFECTIVO. Se escribe
-- una vez y no se copia en cada RPC: si mañana aparece otra vía de plata, hay un
-- solo lugar donde agregarla. Que las dos puedan divergir es el riesgo real, y
-- por eso el test compara una contra otra en varios escenarios.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.efectivo_en_caja(_sesion_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH mov AS (
    SELECT GREATEST(vp.monto, 0) AS entra, GREATEST(-vp.monto, 0) AS sale
      FROM public.venta_pagos vp
      JOIN public.ventas v ON v.id = vp.venta_id
     WHERE COALESCE(vp.caja_sesion_id, v.caja_sesion_id) = _sesion_id
       AND vp.forma_pago = 'EFECTIVO'
    UNION ALL
    SELECT GREATEST(c.monto, 0), GREATEST(-c.monto, 0)
      FROM public.cobranzas_cta_cte c
     WHERE c.caja_sesion_id = _sesion_id AND c.forma_pago = 'EFECTIVO'
    UNION ALL
    SELECT CASE WHEN cm.tipo IN ('INICIAL', 'INGRESO') THEN cm.monto ELSE 0 END,
           CASE WHEN cm.tipo IN ('GASTO', 'RETIRO')    THEN cm.monto ELSE 0 END
      FROM public.caja_movimientos cm
     WHERE cm.caja_sesion_id = _sesion_id AND cm.forma_pago = 'EFECTIVO'
    UNION ALL
    SELECT 0, pp.monto
      FROM public.proveedor_pagos pp
     WHERE pp.caja_sesion_id = _sesion_id AND pp.estado = 'CONFIRMADO'
       AND pp.forma_pago = 'EFECTIVO'
  )
  SELECT ROUND(COALESCE(SUM(entra) - SUM(sale), 0), 2) FROM mov;
$$;

-- ------------------------------------------------------------
-- 3. El guard
--
-- SOBRE LA CONCURRENCIA: verificar y después descontar es un TOCTOU de manual —
-- dos salidas simultáneas leen "hay $100.000", las dos pasan, y salen $200.000.
--
-- Se resuelve con el MISMO advisory lock por sucursal que ya toma
-- caja_sesion_actual(). Es por transacción y re-entrante, así que tomarlo de
-- nuevo acá no cuesta nada cuando el llamador ya lo tiene (que es casi siempre:
-- los triggers de estampado lo toman al insertar).
--
-- Deliberadamente NO se usa `SELECT ... FOR UPDATE` sobre caja_sesiones: las RPC
-- que llaman a caja_sesion_actual() ya salen de ahí con un FOR SHARE sobre esa
-- misma fila, y pedir después un FOR UPDATE sería una escalada de lock — dos
-- salidas simultáneas, cada una con su SHARE, esperándose para subir a UPDATE.
-- Eso es un deadlock, no una protección.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exigir_efectivo(
  _sucursal_id uuid,
  _sesion_id   uuid,
  _monto       numeric,
  _para_que    text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_hay numeric(14,2);
BEGIN
  IF _sesion_id IS NULL OR COALESCE(_monto, 0) <= 0 THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_sucursal_id::text, 0));

  v_hay := public.efectivo_en_caja(_sesion_id);

  IF _monto > v_hay + 0.01 THEN
    -- El mensaje ofrece las dos salidas reales. Un "no se puede" a secas dejaría
    -- a alguien trabado un sábado a la mañana sin saber qué hacer.
    RAISE EXCEPTION
      'No hay suficiente efectivo en la caja para %: hay $%, y estás sacando $%. '
      'Registralo como transferencia o cheque, o cargá el efectivo que había al abrir el turno.',
      _para_que, TRIM(TO_CHAR(v_hay, 'FM999999990.00')), TRIM(TO_CHAR(_monto, 'FM999999990.00'));
  END IF;
END; $$;

-- NO se otorgan a `authenticated`, a propósito. Son helpers INTERNOS: las RPC
-- que los llaman son SECURITY DEFINER, así que corren como el dueño y los ven
-- igual. Otorgarlos los expondría por PostgREST, y ninguno de los dos valida
-- acceso: efectivo_en_caja diría cuánta plata hay en cualquier caja con sólo
-- saber su UUID, y exigir_efectivo filtraría lo mismo por el mensaje de error.
REVOKE ALL ON FUNCTION public.efectivo_en_caja(uuid) FROM public, authenticated, anon;
REVOKE ALL ON FUNCTION public.exigir_efectivo(uuid, uuid, numeric, text) FROM public, authenticated, anon;

-- ------------------------------------------------------------
-- 4. Los cinco caminos por los que sale efectivo, con el guard puesto.
--
-- Cada función se reescribe sobre su definición VIGENTE (sacada con
-- pg_get_functiondef y verificada con diff): el único cambio es el guard.
-- Reescribir de memoria ya borró validaciones dos veces en este repo.
--
-- anular_venta NO lleva guard, a propósito: anular es cómo se corrige una
-- venta mal cargada. Si lo bloqueáramos, alguien podría quedar atrapado con
-- una venta falsa que no puede deshacer. Entre una caja en rojo —que se ve
-- en el arqueo— y un comprobante equivocado inmortal, el mal menor es claro.
-- ------------------------------------------------------------

-- ---------- caja_esperado ----------
CREATE OR REPLACE FUNCTION public.caja_esperado(_sesion_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.caja_sesiones s
     WHERE s.id = _sesion_id
       AND (public.is_admin(v_uid) OR s.sucursal_id = public.current_sucursal_id())
  ) THEN
    RAISE EXCEPTION 'Sin acceso a esa sesión de caja';
  END IF;

  RETURN (
    WITH mov AS (
      -- COALESCE: los pagos hechos JUNTO con la venta no traen sesión propia y
      -- valen por la de la venta (así fue siempre, y así siguen contando los
      -- ~miles de pagos ya guardados). Un cobro POSTERIOR —el saldo de una
      -- venta parcial que el cliente vuelve a pagar otro día— sí trae la suya, y
      -- tiene que caer en la caja de ESE día, no en la de la venta original.
      -- El COALESCE va también en el WHERE: si sólo estuviera en el SELECT, el
      -- pago del jueves seguiría filtrándose por la caja del lunes.
      SELECT vp.forma_pago::text AS forma,
             GREATEST(vp.monto, 0) AS entra, GREATEST(-vp.monto, 0) AS sale
        FROM public.venta_pagos vp
        JOIN public.ventas v ON v.id = vp.venta_id
       WHERE COALESCE(vp.caja_sesion_id, v.caja_sesion_id) = _sesion_id
      UNION ALL
      SELECT c.forma_pago::text, GREATEST(c.monto, 0), GREATEST(-c.monto, 0)
        FROM public.cobranzas_cta_cte c
       WHERE c.caja_sesion_id = _sesion_id
      UNION ALL
      SELECT cm.forma_pago::text,
             CASE WHEN cm.tipo IN ('INICIAL', 'INGRESO') THEN cm.monto ELSE 0 END,
             CASE WHEN cm.tipo IN ('GASTO', 'RETIRO')    THEN cm.monto ELSE 0 END
        FROM public.caja_movimientos cm
       WHERE cm.caja_sesion_id = _sesion_id
      UNION ALL
      SELECT pp.forma_pago, 0, pp.monto
        FROM public.proveedor_pagos pp
       WHERE pp.caja_sesion_id = _sesion_id AND pp.estado = 'CONFIRMADO'
    )
    SELECT COALESCE(
             jsonb_object_agg(forma, jsonb_build_object('entra', e, 'sale', s, 'neto', e - s)),
             '{}'::jsonb
           )
      FROM (
        SELECT forma, ROUND(SUM(entra), 2) AS e, ROUND(SUM(sale), 2) AS s
          FROM mov GROUP BY forma
      ) t
  );
END; $function$;

-- ---------- crear_compra ----------
CREATE OR REPLACE FUNCTION public.crear_compra(p_proveedor_id uuid, p_sucursal_id uuid, p_tipo_comprobante text, p_numero text, p_fecha_comprobante date, p_fecha_vencimiento date, p_subtotal_sin_iva numeric, p_iva_total numeric, p_percepciones numeric, p_pagos jsonb, p_condicion text DEFAULT 'CONTADO'::text, p_observaciones text DEFAULT NULL::text)
 RETURNS TABLE(compra_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_prov      public.proveedores%ROWTYPE;
  v_compra_id uuid;
  v_sub       numeric(14,2) := ROUND(COALESCE(p_subtotal_sin_iva, 0), 2);
  v_iva       numeric(14,2) := ROUND(COALESCE(p_iva_total, 0), 2);
  v_perc      numeric(14,2) := ROUND(COALESCE(p_percepciones, 0), 2);
  v_total     numeric(14,2);
  v_sesion    uuid;
  v_monto     numeric(14,2);
  v_efectivo  numeric(14,2);
  v_forma     text;
  pg          jsonb;
  LIMITE      constant numeric := 999999999;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés registrar una compra en una sucursal que no es la tuya';
  END IF;
  IF p_condicion NOT IN ('CONTADO', 'CTA_CTE') THEN
    RAISE EXCEPTION 'Condición inválida: %', p_condicion;
  END IF;
  IF p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') THEN
    RAISE EXCEPTION 'Las notas de crédito/débito del proveedor no se cargan como compra';
  END IF;

  -- Las dos validaciones que se habían perdido.
  SELECT * INTO v_prov FROM public.proveedores WHERE id = p_proveedor_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proveedor inexistente o inactivo';
  END IF;
  IF p_condicion = 'CTA_CTE' AND NOT COALESCE(v_prov.condicion_cta_cte, false) THEN
    RAISE EXCEPTION 'El proveedor % no tiene cuenta corriente habilitada', v_prov.razon_social;
  END IF;

  IF v_sub < 0 OR v_iva < 0 OR v_perc < 0 THEN
    RAISE EXCEPTION 'Los montos de la compra no pueden ser negativos';
  END IF;
  v_total := ROUND(v_sub + v_iva + v_perc, 2);
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'El total de la compra tiene que ser mayor a cero';
  END IF;
  IF v_total > LIMITE THEN
    RAISE EXCEPTION 'El total (%) no parece un monto válido. Revisá los números.', v_total;
  END IF;

  INSERT INTO public.compras (
    proveedor_id, sucursal_id, usuario_id, tipo_comprobante, numero_comprobante,
    fecha_comprobante, fecha_vencimiento, subtotal_sin_iva, iva_total, percepciones,
    total, condicion, estado, observaciones
  ) VALUES (
    p_proveedor_id, p_sucursal_id, v_uid, p_tipo_comprobante, p_numero,
    p_fecha_comprobante, p_fecha_vencimiento, v_sub, v_iva, v_perc,
    v_total, p_condicion, 'ACTIVA', p_observaciones
  ) RETURNING id INTO v_compra_id;

  -- Deliberadamente NO se escriben compra_items ni stock_movimientos: esta RPC
  -- registra PLATA. La mercadería entra por Ingresos de mercadería.

  IF p_condicion = 'CTA_CTE' THEN
    IF (SELECT COALESCE(SUM((x->>'monto')::numeric), 0)
          FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb)) x) > 0 THEN
      RAISE EXCEPTION 'Una compra a cuenta corriente no lleva pagos: quedan como deuda';
    END IF;
    INSERT INTO public.proveedor_cc_movimientos (
      proveedor_id, sucursal_id, tipo, monto, estado, compra_id, descripcion, usuario_id
    ) VALUES (
      p_proveedor_id, p_sucursal_id, 'DEBITO', v_total, 'CONFIRMADO', v_compra_id,
      'Compra ' || p_tipo_comprobante || ' ' || p_numero, v_uid
    );
  ELSE
    SELECT id INTO v_sesion FROM public.caja_sesiones
      WHERE sucursal_id = p_sucursal_id AND estado = 'ABIERTA'
      ORDER BY abierta_en DESC LIMIT 1
      FOR SHARE;
    IF v_sesion IS NULL THEN
      RAISE EXCEPTION 'Abrí la caja antes de registrar una compra al contado (la plata sale de la caja)';
    END IF;

    v_monto := 0;
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_forma := pg->>'forma_pago';
      IF v_forma = 'CTA_CTE' THEN
        RAISE EXCEPTION 'CTA_CTE no es una forma de pago. Para comprar a cuenta usá la condición CTA_CTE.';
      END IF;
      IF COALESCE((pg->>'monto')::numeric, 0) < 0 THEN
        RAISE EXCEPTION 'Un pago no puede ser negativo';
      END IF;
      v_monto := v_monto + ROUND(COALESCE((pg->>'monto')::numeric, 0), 2);
    END LOOP;
    IF ABS(v_monto - v_total) > 0.01 THEN
      RAISE EXCEPTION 'Los pagos (%) no cubren el total de la compra (%). Una compra contado se paga completa.',
        v_monto, v_total;
    END IF;

    -- No se saca de la caja plata que no está. Sólo la parte en EFECTIVO: una
    -- transferencia o un cheque no vacían el cajón.
    v_efectivo := (
      SELECT COALESCE(SUM(ROUND(COALESCE((x->>'monto')::numeric, 0), 2)), 0)
        FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb)) x
       WHERE x->>'forma_pago' = 'EFECTIVO'
    );
    IF v_efectivo > 0 THEN
      PERFORM public.exigir_efectivo(p_sucursal_id, v_sesion, v_efectivo, 'pagar esta compra');
    END IF;

    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := ROUND(COALESCE((pg->>'monto')::numeric, 0), 2);
      IF v_monto <= 0 THEN CONTINUE; END IF;
      -- Estos pagos NO llevan número de recibo: son el pago de la propia compra,
      -- no un pago suelto a cuenta. El recibo se emite desde Pagos a proveedores.
      INSERT INTO public.proveedor_pagos (
        proveedor_id, sucursal_id, usuario_id, monto, forma_pago, detalle, compra_id, caja_sesion_id
      ) VALUES (
        p_proveedor_id, p_sucursal_id, v_uid, v_monto, pg->>'forma_pago',
        COALESCE(pg->'detalle', '{}'::jsonb), v_compra_id, v_sesion
      );
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_compra_id;
END; $function$;

-- ---------- registrar_pago_proveedor ----------
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

  IF p_forma_pago = 'EFECTIVO' THEN
    PERFORM public.exigir_efectivo(p_sucursal_id, v_sesion, v_monto, 'pagarle al proveedor');
  END IF;

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
END; $function$;

-- ---------- registrar_gasto ----------
CREATE OR REPLACE FUNCTION public.registrar_gasto(p_sucursal_id uuid, p_monto numeric, p_forma_pago text, p_descripcion text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_sesion uuid;
  v_mov    uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés cargar un gasto en una sucursal que no es la tuya';
  END IF;
  IF COALESCE(p_monto, 0) <= 0 THEN
    RAISE EXCEPTION 'El monto del gasto debe ser mayor a cero';
  END IF;
  IF COALESCE(TRIM(p_descripcion), '') = '' THEN
    RAISE EXCEPTION 'Poné una descripción (para qué fue el gasto)';
  END IF;
  IF p_forma_pago = 'CTA_CTE' THEN
    RAISE EXCEPTION 'CTA_CTE no es una forma de pago';
  END IF;

  -- La plata sale de la caja: APERTURA AUTOMÁTICA (auto-abre en la primera
  -- operación del día de la sucursal).
  v_sesion := public.caja_sesion_actual(p_sucursal_id);
  IF v_sesion IS NULL THEN
    RAISE EXCEPTION 'No se pudo abrir la caja para registrar el gasto';
  END IF;

  IF p_forma_pago = 'EFECTIVO' THEN
    PERFORM public.exigir_efectivo(p_sucursal_id, v_sesion, ROUND(p_monto, 2), 'cargar este gasto');
  END IF;

  INSERT INTO public.caja_movimientos (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
  VALUES (v_sesion, 'GASTO', p_forma_pago::public.forma_pago, ROUND(p_monto, 2), TRIM(p_descripcion), v_uid)
  RETURNING id INTO v_mov;

  RETURN v_mov;
END;
$function$;

-- ---------- registrar_movimiento_caja ----------
CREATE OR REPLACE FUNCTION public.registrar_movimiento_caja(p_sesion_id uuid, p_tipo caja_mov_tipo, p_forma_pago forma_pago, p_monto numeric, p_descripcion text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_ses   public.caja_sesiones%ROWTYPE;
  v_suc   uuid;
  v_monto numeric(14,2) := ROUND(COALESCE(p_monto, 0), 2);
  v_mov   uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF p_tipo = 'INICIAL' THEN
    RAISE EXCEPTION 'El fondo inicial se carga al abrir la caja, no como movimiento';
  END IF;
  IF v_monto <= 0 THEN
    RAISE EXCEPTION 'El monto tiene que ser mayor a cero';
  END IF;
  IF COALESCE(btrim(p_descripcion), '') = '' THEN
    RAISE EXCEPTION 'El movimiento necesita una descripción (para qué fue)';
  END IF;

  -- ORDEN DE LOCKS: primero el advisory de la sucursal, DESPUÉS la fila.
  --
  -- Tiene que ser el mismo orden que usa caja_sesion_actual() (advisory y luego
  -- FOR SHARE). Si acá se tomara la fila primero y el advisory después —como
  -- estaba— quedaría un ABBA de manual: esta transacción con la fila esperando
  -- el advisory, y cualquier otra RPC con el advisory esperando la fila.
  --
  -- Para saber de qué sucursal es hay que leerla antes, sin lock. Esa lectura
  -- sucia no decide nada: sólo elige qué advisory tomar, y el FOR UPDATE de
  -- abajo vuelve a leer la fila ya protegida.
  SELECT sucursal_id INTO v_suc FROM public.caja_sesiones WHERE id = p_sesion_id;
  IF v_suc IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_suc::text, 0));
  END IF;

  -- FOR UPDATE: bloquea la fila del turno; resuelve la carrera contra cerrar_caja
  -- y valida pertenencia de sucursal en una sola query.
  SELECT * INTO v_ses FROM public.caja_sesiones WHERE id = p_sesion_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sesión de caja no existe';
  END IF;
  IF v_ses.estado <> 'ABIERTA' THEN
    RAISE EXCEPTION 'La caja ya está cerrada: no se pueden registrar movimientos';
  END IF;
  IF NOT public.is_admin(v_uid) AND v_ses.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'Esa caja es de otra sucursal';
  END IF;

  -- GASTO y RETIRO sacan plata; INGRESO la mete. Sólo los dos primeros.
  IF p_tipo IN ('GASTO', 'RETIRO') AND p_forma_pago = 'EFECTIVO' THEN
    PERFORM public.exigir_efectivo(v_ses.sucursal_id, p_sesion_id, v_monto,
                                   CASE WHEN p_tipo = 'GASTO' THEN 'cargar este gasto'
                                        ELSE 'retirar plata de la caja' END);
  END IF;

  INSERT INTO public.caja_movimientos (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
  VALUES (p_sesion_id, p_tipo, p_forma_pago, v_monto, btrim(p_descripcion), v_uid)
  RETURNING id INTO v_mov;

  RETURN v_mov;
END; $function$;

-- ---------- crear_venta ----------
CREATE OR REPLACE FUNCTION public.crear_venta(p_sucursal_id uuid, p_cliente_id uuid, p_tipo_comprobante tipo_comprobante, p_condicion_venta condicion_venta, p_items jsonb, p_pagos jsonb, p_percepciones numeric DEFAULT 0, p_observaciones text DEFAULT NULL::text, p_nombre_obra text DEFAULT NULL::text, p_fecha timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cbte_asoc_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS TABLE(venta_id uuid, numero text, es_cta_cte boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid := auth.uid();
  v_permite_neg    boolean;
  v_numero         text;
  v_venta_id       uuid;
  v_es_cta_cte     boolean;
  v_sesion_caja    uuid;
  v_signo          integer;
  v_cliente        public.clientes%ROWTYPE;
  v_sub_sin_iva    numeric(14,2) := 0;
  v_iva_total      numeric(14,2) := 0;
  v_total          numeric(14,2);
  v_percepciones   numeric(14,2);
  v_total_pagado   numeric(14,2) := 0;
  v_pagos_suma     numeric(14,2) := 0;
  v_pagos_no_efec  numeric(14,2) := 0;
  v_vuelto         numeric(14,2) := 0;
  v_no_efec_ins    numeric(14,2) := 0;   -- R3: acumulador de pagos no-efectivo ya insertados
  v_estado_pago    public.estado_pago;
  it               jsonb;
  pg               jsonb;
  v_prod           public.productos%ROWTYPE;
  v_cant           numeric(14,2);
  v_desc           numeric(5,2);
  v_precio         numeric(14,2);
  v_precio_lista   numeric(14,2);
  v_sub_item       numeric(14,2);
  v_iva_item       numeric(14,2);
  v_stock_ant      numeric(14,2);
  v_stock_nue      numeric(14,2);
  v_calc           jsonb := '[]'::jsonb;
  v_saldo_actual   numeric(14,2);
  v_monto          numeric(14,2);
  v_forma          public.forma_pago;
  v_iva_libre      numeric(5,2);   -- R5: IVA de una línea de concepto libre (recargo)
  v_qty_total      numeric(14,2) := 0;
  v_es_fiscal      boolean;
  v_ex_id          uuid;
  v_ex_num         text;
  v_ex_cta         boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
    SELECT id, numero_comprobante, (condicion_venta = 'CTA_CTE')
      INTO v_ex_id, v_ex_num, v_ex_cta
      FROM public.ventas
     WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN QUERY SELECT v_ex_id, v_ex_num, v_ex_cta;
      RETURN;
    END IF;
  END IF;

  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés facturar en una sucursal que no es la tuya';
  END IF;

  SELECT * INTO v_cliente FROM public.clientes WHERE id = p_cliente_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  -- R2.a: la "Factura interna" ya NO es de cuenta corriente. Es un documento
  -- interno de CONTADO (impacta caja como cualquier venta). Forzamos la condición
  -- acá para que, aunque el front mande CTA_CTE, nunca vaya a cuenta corriente.
  IF p_tipo_comprobante = 'FAC_INTERNA_CTA_CTE' THEN
    p_condicion_venta := 'CONTADO';
  END IF;

  IF p_tipo_comprobante = 'FACTURA_A' AND v_cliente.tipo <> 'RESPONSABLE_INSCRIPTO' THEN
    RAISE EXCEPTION 'No se puede emitir Factura A a % (condición %): la Factura A es sólo para Responsables Inscriptos',
      v_cliente.razon_social, v_cliente.tipo;
  END IF;

  IF p_fecha IS NOT NULL THEN
    IF p_fecha > now() + interval '1 day' THEN
      RAISE EXCEPTION 'La fecha del comprobante no puede ser futura';
    END IF;
    IF p_fecha < now() - interval '5 years' THEN
      RAISE EXCEPTION 'La fecha del comprobante es demasiado antigua';
    END IF;
  END IF;

  IF COALESCE(p_percepciones, 0) < 0 THEN
    RAISE EXCEPTION 'Las percepciones no pueden ser negativas';
  END IF;

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg
    FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);
  -- R6: además del flag GLOBAL, un perfil habilitado (o un admin) puede vender
  -- productos sin stock disponible. El permiso vive en profiles y lo resuelve
  -- puede_vender_sin_stock() (SECURITY DEFINER), server-authoritative.
  v_permite_neg := v_permite_neg OR public.puede_vender_sin_stock(v_uid);

  v_signo := CASE WHEN p_tipo_comprobante = 'NOTA_CREDITO' THEN -1 ELSE 1 END;

  IF p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') THEN
    IF p_cbte_asoc_id IS NULL THEN
      RAISE EXCEPTION 'Una nota de crédito/débito tiene que indicar el comprobante que rectifica';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.ventas
       WHERE id = p_cbte_asoc_id AND cliente_id = p_cliente_id
         AND tipo_comprobante IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C')
    ) THEN
      RAISE EXCEPTION 'El comprobante a rectificar no existe o no es una factura de este cliente';
    END IF;
  END IF;

  v_es_cta_cte := p_tipo_comprobante IN ('REMITO', 'REMITO_OBRA')
                  OR p_condicion_venta = 'CTA_CTE';

  IF v_es_cta_cte AND p_tipo_comprobante NOT IN ('NOTA_CREDITO', 'NOTA_DEBITO')
     AND NOT COALESCE(v_cliente.condicion_cta_cte, false) THEN
    RAISE EXCEPTION 'El cliente % no tiene cuenta corriente habilitada', v_cliente.razon_social;
  END IF;

  -- Todos los productos de la venta, lockeados EN ORDEN DE id antes del loop.
  -- El loop los toma en el orden en que vengan en p_items: dos ventas
  -- simultáneas con los mismos productos en distinto orden se pedían los locks
  -- cruzados y Postgres abortaba una por deadlock. Con el prelock el orden es
  -- siempre el mismo, venga de donde venga el array. Es aditivo: adentro del
  -- loop el FOR UPDATE de cada producto ya no espera a nadie.
  PERFORM 1 FROM public.productos p
    WHERE p.id IN (
      SELECT (value->>'producto_id')::uuid
        FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
       WHERE value->>'producto_id' IS NOT NULL)
    ORDER BY p.id FOR UPDATE;

  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    -- R5: línea de CONCEPTO LIBRE (recargo/interés), sin producto. Sólo NOTA_DEBITO.
    IF (it->>'producto_id') IS NULL THEN
      IF p_tipo_comprobante <> 'NOTA_DEBITO' THEN
        RAISE EXCEPTION 'Sólo la Nota de Débito admite líneas sin producto (recargo/interés)';
      END IF;

      v_cant := COALESCE((it->>'cantidad')::numeric, 1);
      IF v_cant <= 0 THEN
        RAISE EXCEPTION 'La línea de recargo necesita una cantidad mayor a cero';
      END IF;

      v_precio := (it->>'precio_unitario_sin_iva')::numeric;
      IF v_precio IS NULL OR v_precio < 0 THEN
        RAISE EXCEPTION 'La línea de recargo necesita un precio válido';
      END IF;

      v_iva_libre := COALESCE((it->>'iva_porcentaje')::numeric, 21);
      IF v_iva_libre < 0 OR v_iva_libre > 100 THEN
        RAISE EXCEPTION 'IVA inválido en la línea de recargo';
      END IF;

      v_qty_total := v_qty_total + v_cant;

      -- ND siempre suma (v_signo = 1); sin descuento.
      v_sub_item := ROUND(v_precio * v_cant, 2);
      v_iva_item := ROUND(v_sub_item * v_iva_libre / 100, 2);

      v_sub_sin_iva := v_sub_sin_iva + v_sub_item;
      v_iva_total   := v_iva_total   + v_iva_item;

      v_calc := v_calc || jsonb_build_object(
        'producto_id', NULL, 'codigo', 'RECARGO',
        'descripcion', COALESCE(NULLIF(it->>'descripcion', ''), 'Recargo'),
        'cantidad', v_cant, 'precio', v_precio, 'precio_lista', v_precio,
        'iva_porcentaje', v_iva_libre, 'descuento', 0,
        'sub_item', v_sub_item, 'iva_item', v_iva_item
      );

      CONTINUE;
    END IF;

    -- Rama normal: ítem con producto del catálogo.
    SELECT * INTO v_prod FROM public.productos
      WHERE id = (it->>'producto_id')::uuid AND activo
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto % inexistente o inactivo', it->>'producto_id';
    END IF;

    v_cant := COALESCE((it->>'cantidad')::numeric, 0);
    v_desc := LEAST(GREATEST(COALESCE((it->>'descuento_porcentaje')::numeric, 0), 0), 100);
    IF v_cant < 0 THEN
      RAISE EXCEPTION 'Cantidad negativa en el producto %', v_prod.codigo;
    END IF;

    v_qty_total := v_qty_total + v_cant;

    v_precio_lista := v_prod.precio_sin_iva;
    v_precio := COALESCE((it->>'precio_unitario_sin_iva')::numeric, v_precio_lista);
    IF v_precio < 0 THEN
      RAISE EXCEPTION 'Precio negativo en el producto %', v_prod.codigo;
    END IF;

    v_sub_item := ROUND(v_precio * (1 - v_desc / 100) * v_cant, 2) * v_signo;
    v_iva_item := ROUND(v_sub_item * v_prod.iva_porcentaje / 100, 2);

    v_sub_sin_iva := v_sub_sin_iva + v_sub_item;
    v_iva_total   := v_iva_total   + v_iva_item;

    v_calc := v_calc || jsonb_build_object(
      'producto_id', v_prod.id, 'codigo', v_prod.codigo, 'descripcion', v_prod.nombre,
      'cantidad', v_cant, 'precio', v_precio, 'precio_lista', v_precio_lista,
      'iva_porcentaje', v_prod.iva_porcentaje, 'descuento', v_desc,
      'sub_item', v_sub_item, 'iva_item', v_iva_item
    );
  END LOOP;

  v_percepciones := ROUND(COALESCE(p_percepciones, 0), 2) * v_signo;
  v_total := ROUND(v_sub_sin_iva + v_iva_total + v_percepciones, 2);

  v_es_fiscal := p_tipo_comprobante IN ('FACTURA_A','FACTURA_B','FACTURA_C','NOTA_CREDITO','NOTA_DEBITO');
  IF v_qty_total <= 0 THEN
    RAISE EXCEPTION 'El comprobante necesita al menos un ítem con cantidad mayor a cero';
  END IF;
  IF v_es_fiscal AND ABS(v_total) < 0.01 THEN
    RAISE EXCEPTION 'El total de un comprobante fiscal debe ser distinto de cero';
  END IF;

  IF NOT v_es_cta_cte THEN
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := COALESCE((pg->>'monto')::numeric, 0);
      IF v_monto < 0 THEN
        RAISE EXCEPTION 'Un pago no puede ser negativo';
      END IF;
      IF (pg->>'forma_pago')::public.forma_pago = 'CTA_CTE' THEN
        RAISE EXCEPTION 'CTA_CTE no es una forma de pago. Para vender a cuenta corriente usá la condición de venta CTA_CTE.';
      END IF;
      v_pagos_suma := v_pagos_suma + v_monto;
      IF (pg->>'forma_pago')::public.forma_pago <> 'EFECTIVO' THEN
        v_pagos_no_efec := v_pagos_no_efec + v_monto;
      END IF;
    END LOOP;

    -- R3: tolerancia de 1 centavo. Un electrónico que supera el total por una
    -- desalineación de redondeo (<= 0,01) no se rechaza; el excedente NO se
    -- persiste (se capa abajo, en el loop de inserción).
    IF v_pagos_no_efec > ABS(v_total) + 0.01 THEN
      RAISE EXCEPTION 'Los pagos electrónicos (%) superan el total del comprobante (%). Sólo el efectivo admite vuelto.',
        v_pagos_no_efec, ABS(v_total);
    END IF;

    IF v_pagos_suma > ABS(v_total) THEN
      v_vuelto := ROUND(v_pagos_suma - ABS(v_total), 2);
    END IF;
    v_total_pagado := ROUND(LEAST(v_pagos_suma, ABS(v_total)), 2) * v_signo;

    -- AL CONTADO SE COBRA ALGO.
    -- Una venta al contado sin NINGÚN pago quedaba PENDIENTE con
    -- total_pagado = 0 y el stock ya descontado: la mercadería salía, la plata
    -- no entraba a la caja y tampoco generaba deuda en la cuenta corriente. No
    -- estaba en ningún lado. Si el cliente no paga nada, eso es cuenta
    -- corriente, que para eso está: ahí la deuda queda a nombre de alguien.
    --
    -- El pago PARCIAL sí se permite: es el mostrador de verdad (paga una parte
    -- ahora y el resto después). La venta queda en PARCIAL y el saldo se ve.
    --
    -- Quedan afuera a propósito:
    --   · las notas de crédito y débito, que se acreditan o cargan a la cuenta y
    --     no se pagan en el momento;
    --   · los remitos, que ya entran por la rama de cuenta corriente;
    --   · los comprobantes en cero (la pantalla los permite).
    IF p_tipo_comprobante NOT IN ('NOTA_CREDITO', 'NOTA_DEBITO')
       AND ABS(v_total) >= 0.01
       AND v_pagos_suma < 0.01 THEN
      RAISE EXCEPTION 'Una venta al contado se cobra, aunque sea una parte. Si se lo lleva sin pagar nada, hacela por cuenta corriente.';
    END IF;
  END IF;

  v_estado_pago := CASE
    WHEN v_es_cta_cte THEN 'PENDIENTE'::public.estado_pago
    WHEN ABS(v_total_pagado) >= ABS(v_total) - 0.01 THEN 'PAGADO'::public.estado_pago
    WHEN ABS(v_total_pagado) > 0 THEN 'PARCIAL'::public.estado_pago
    ELSE 'PENDIENTE'::public.estado_pago
  END;

  IF v_es_cta_cte AND v_cliente.limite_credito IS NOT NULL AND v_signo > 0
     AND p_tipo_comprobante <> 'NOTA_CREDITO' THEN
    v_saldo_actual := public.cc_saldo(p_cliente_id);
    IF v_saldo_actual + ABS(v_total) > v_cliente.limite_credito THEN
      RAISE EXCEPTION 'Supera el límite de crédito del cliente (límite %, saldo actual %, esta venta %)',
        v_cliente.limite_credito, v_saldo_actual, ABS(v_total);
    END IF;
  END IF;

  v_numero := public.next_comprobante_numero(p_sucursal_id, p_tipo_comprobante);

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, fecha, numero_comprobante, tipo_comprobante,
    condicion_venta, subtotal_sin_iva, iva_total, percepciones, total, total_pagado,
    estado_pago, observaciones, nombre_obra, afip_cbte_asoc_id, idempotency_key
  ) VALUES (
    p_sucursal_id, p_cliente_id, v_uid, COALESCE(p_fecha, now()), v_numero, p_tipo_comprobante,
    CASE WHEN v_es_cta_cte THEN 'CTA_CTE'::public.condicion_venta ELSE p_condicion_venta END,
    v_sub_sin_iva, v_iva_total, v_percepciones, v_total, v_total_pagado,
    v_estado_pago, p_observaciones, p_nombre_obra, p_cbte_asoc_id, p_idempotency_key
  ) RETURNING id, caja_sesion_id INTO v_venta_id, v_sesion_caja;

  FOR it IN SELECT * FROM jsonb_array_elements(v_calc)
  LOOP
    v_cant := (it->>'cantidad')::numeric;

    INSERT INTO public.venta_items (
      venta_id, producto_id, codigo, descripcion, cantidad,
      precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
      subtotal_sin_iva, iva_monto, subtotal_con_iva
    ) VALUES (
      v_venta_id, (it->>'producto_id')::uuid, it->>'codigo', it->>'descripcion', v_cant,
      (it->>'precio')::numeric, (it->>'precio_lista')::numeric,
      (it->>'iva_porcentaje')::numeric, (it->>'descuento')::numeric,
      (it->>'sub_item')::numeric, (it->>'iva_item')::numeric,
      (it->>'sub_item')::numeric + (it->>'iva_item')::numeric
    );

    CONTINUE WHEN v_cant = 0;
    CONTINUE WHEN p_tipo_comprobante = 'NOTA_DEBITO';

    IF p_tipo_comprobante = 'NOTA_CREDITO' THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES ((it->>'producto_id')::uuid, p_sucursal_id, v_cant)
      ON CONFLICT (producto_id, sucursal_id)
      DO UPDATE SET cantidad = stock_sucursal.cantidad + v_cant
      RETURNING cantidad - v_cant, cantidad INTO v_stock_ant, v_stock_nue;

      INSERT INTO public.stock_movimientos (
        producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
        motivo, referencia_id, usuario_id
      ) VALUES (
        (it->>'producto_id')::uuid, p_sucursal_id, 'DEVOLUCION', v_cant, v_stock_ant, v_stock_nue,
        p_tipo_comprobante::text || ' ' || v_numero, v_venta_id, v_uid
      );
      CONTINUE;
    END IF;

    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES ((it->>'producto_id')::uuid, p_sucursal_id, -v_cant)
      ON CONFLICT (producto_id, sucursal_id)
      DO UPDATE SET cantidad = stock_sucursal.cantidad - v_cant
      RETURNING cantidad + v_cant, cantidad INTO v_stock_ant, v_stock_nue;
    ELSE
      UPDATE public.stock_sucursal
         SET cantidad = cantidad - v_cant
       WHERE producto_id = (it->>'producto_id')::uuid
         AND sucursal_id = p_sucursal_id
         AND cantidad >= v_cant
      RETURNING cantidad + v_cant, cantidad INTO v_stock_ant, v_stock_nue;

      IF NOT FOUND THEN
        SELECT COALESCE(cantidad, 0) INTO v_stock_ant
          FROM public.stock_sucursal
         WHERE producto_id = (it->>'producto_id')::uuid AND sucursal_id = p_sucursal_id;
        RAISE EXCEPTION 'Stock insuficiente de % (%): hay %, se piden %',
          it->>'descripcion', it->>'codigo', COALESCE(v_stock_ant, 0), v_cant;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      (it->>'producto_id')::uuid, p_sucursal_id, 'VENTA', -v_cant, v_stock_ant, v_stock_nue,
      p_tipo_comprobante::text || ' ' || v_numero, v_venta_id, v_uid
    );
  END LOOP;

  IF NOT v_es_cta_cte THEN
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := ROUND(ABS(COALESCE((pg->>'monto')::numeric, 0)), 2);
      v_forma := (pg->>'forma_pago')::public.forma_pago;

      IF v_forma = 'EFECTIVO' THEN
        -- El vuelto físico (efectivo pagado de más) sale del efectivo, como siempre.
        IF v_vuelto > 0 THEN
          IF v_monto >= v_vuelto THEN
            v_monto := v_monto - v_vuelto;
            v_vuelto := 0;
          ELSE
            v_vuelto := v_vuelto - v_monto;
            v_monto := 0;
          END IF;
        END IF;
      ELSE
        -- R3: un pago electrónico no admite vuelto. Capamos la suma de pagos no
        -- efectivo al total del comprobante: así una desalineación de redondeo de
        -- hasta 1 centavo (tolerada arriba) no queda persistida inflando la caja.
        v_monto := GREATEST(LEAST(v_monto, ABS(v_total) - v_no_efec_ins), 0);
        v_no_efec_ins := v_no_efec_ins + v_monto;
      END IF;

      CONTINUE WHEN v_monto = 0;

      -- En una NOTA DE CRÉDITO el pago va con signo NEGATIVO: es plata que se le
      -- devuelve al cliente y sale de la caja. Se verifica igual que cualquier
      -- otra salida. (Una venta normal SUMA, así que no necesita el guard.)
      IF v_signo < 0 AND v_forma = 'EFECTIVO' THEN
        PERFORM public.exigir_efectivo(p_sucursal_id, v_sesion_caja, v_monto,
                                       'devolverle la plata al cliente');
      END IF;

      INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
      VALUES (v_venta_id, v_forma, v_monto * v_signo, COALESCE(pg->'detalle', '{}'::jsonb));
    END LOOP;
  END IF;

  IF v_es_cta_cte THEN
    PERFORM public.cc_registrar_por_venta(v_venta_id);
  END IF;

  RETURN QUERY SELECT v_venta_id, v_numero, v_es_cta_cte;
END; $function$;

-- ------------------------------------------------------------
-- 5. Cobrar el saldo de una venta que quedó a medias
--
-- Antes de esto no existía: una venta al contado cobrada en parte quedaba en
-- PARCIAL para siempre y cuando el cliente volvía con la plata no había dónde
-- registrarla.
--
-- Deliberadamente NO se manda el saldo a cuenta corriente, que sería lo obvio:
--   * la cuenta corriente exige clientes.condicion_cta_cte, y la venta al
--     contado típica es a Consumidor Final, que es un cliente GENÉRICO Y
--     COMPARTIDO — cargarle deuda juntaría en una ficha lo que deben veinte
--     personas distintas;
--   * y porque una venta a medio pagar no es una cuenta abierta: es ESTE
--     comprobante el que quedó a medias. La deuda es del comprobante.
--
-- Un pago acá SUMA a la caja, así que no lleva el guard de la parte 2.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cobrar_saldo_venta(
  p_venta_id        uuid,
  p_forma_pago      text,
  p_monto           numeric,
  p_detalle         jsonb DEFAULT '{}'::jsonb,
  p_idempotency_key uuid  DEFAULT NULL
)
RETURNS TABLE (pagado numeric, saldo numeric, estado text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_v      public.ventas%ROWTYPE;
  v_monto  numeric(14,2) := ROUND(COALESCE(p_monto, 0), 2);
  v_saldo  numeric(14,2);
  v_sesion uuid;
  v_nuevo  numeric(14,2);
  v_estado public.estado_pago;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF v_monto <= 0 THEN RAISE EXCEPTION 'El monto a cobrar tiene que ser mayor a cero'; END IF;
  IF p_forma_pago = 'CTA_CTE' THEN
    RAISE EXCEPTION 'CTA_CTE no es una forma de pago. El saldo de una venta al contado se cobra, no se pasa a cuenta.';
  END IF;

  -- FOR UPDATE sobre la VENTA: es el lock que importa acá. Dos cobros
  -- simultáneos del mismo saldo leerían los dos "faltan $10.000" y entrarían los
  -- dos. El lock de caja no sirve para esto porque el cobro suma, no resta.
  SELECT * INTO v_v FROM public.ventas WHERE id = p_venta_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La venta no existe'; END IF;

  -- IDEMPOTENCIA DE VERDAD: si esta clave ya cobró, se devuelve el estado actual
  -- en vez de un error. El índice único solo alcanzaría para no cobrar dos
  -- veces, pero ante un timeout o un reintento de red el cliente vería un error
  -- de una operación que en realidad SÍ entró — y volvería a intentarla.
  IF p_idempotency_key IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.venta_pagos
                  WHERE cobro_idempotency_key = p_idempotency_key) THEN
    RETURN QUERY SELECT COALESCE(v_v.total_pagado, 0),
                        ROUND(v_v.total - COALESCE(v_v.total_pagado, 0), 2),
                        v_v.estado_pago::text;
    RETURN;
  END IF;

  IF NOT public.is_admin(v_uid) AND v_v.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés cobrar una venta de otra sucursal';
  END IF;
  IF v_v.estado <> 'ACTIVA' THEN
    RAISE EXCEPTION 'La venta está %: no se puede cobrar', lower(v_v.estado::text);
  END IF;
  IF v_v.tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') THEN
    RAISE EXCEPTION 'Una nota de crédito o débito no se cobra por acá';
  END IF;
  IF v_v.condicion_venta = 'CTA_CTE' THEN
    RAISE EXCEPTION 'Esta venta es a cuenta corriente: cobrala desde Cuentas corrientes';
  END IF;

  v_saldo := ROUND(v_v.total - COALESCE(v_v.total_pagado, 0), 2);
  IF v_saldo <= 0.01 THEN
    RAISE EXCEPTION 'Esta venta ya está cobrada';
  END IF;
  IF v_monto > v_saldo + 0.01 THEN
    RAISE EXCEPTION 'Estás cobrando $% y el saldo es $%. El vuelto se da en el mostrador, no se carga de más.',
      TRIM(TO_CHAR(v_monto, 'FM999999990.00')), TRIM(TO_CHAR(v_saldo, 'FM999999990.00'));
  END IF;

  -- La plata entra HOY: la caja es la de hoy, no la de la venta.
  v_sesion := public.caja_sesion_actual(v_v.sucursal_id);
  IF v_sesion IS NULL THEN
    RAISE EXCEPTION 'No se pudo abrir la caja para registrar el cobro';
  END IF;

  INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle, caja_sesion_id, cobro_idempotency_key)
  VALUES (p_venta_id, p_forma_pago::public.forma_pago, v_monto,
          COALESCE(p_detalle, '{}'::jsonb), v_sesion, p_idempotency_key);

  v_nuevo := ROUND(COALESCE(v_v.total_pagado, 0) + v_monto, 2);
  v_estado := CASE WHEN v_nuevo >= v_v.total - 0.01 THEN 'PAGADO'::public.estado_pago
                   ELSE 'PARCIAL'::public.estado_pago END;

  -- total_pagado se mantiene al día porque anular_venta lo usa para armar la
  -- nota de crédito: si quedara viejo, anular una venta cobrada en dos veces
  -- devolvería de menos.
  UPDATE public.ventas SET total_pagado = v_nuevo, estado_pago = v_estado WHERE id = p_venta_id;

  RETURN QUERY SELECT v_nuevo, ROUND(v_v.total - v_nuevo, 2), v_estado::text;
END; $$;

REVOKE ALL ON FUNCTION public.cobrar_saldo_venta(uuid, text, numeric, jsonb, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.cobrar_saldo_venta(uuid, text, numeric, jsonb, uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Dónde se ven las ventas a medio cobrar
--
-- Vista aparte y NO mezclada con cuenta_corriente_saldos, a propósito: son dos
-- cosas distintas. Una es una cuenta abierta con un cliente habilitado; la otra
-- es un comprobante puntual que quedó a medias y puede ser de Consumidor Final.
-- Sumarlas en la misma columna haría que "Saldo" signifique dos cosas.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.ventas_saldo_pendiente
WITH (security_invoker = true) AS
  SELECT v.id AS venta_id,
         v.numero_comprobante,
         v.fecha,
         v.sucursal_id,
         s.nombre AS sucursal_nombre,
         v.cliente_id,
         COALESCE(c.razon_social, 'Consumidor Final') AS cliente,
         v.total,
         COALESCE(v.total_pagado, 0) AS cobrado,
         ROUND(v.total - COALESCE(v.total_pagado, 0), 2) AS saldo
    FROM public.ventas v
    JOIN public.sucursales s ON s.id = v.sucursal_id
    LEFT JOIN public.clientes c ON c.id = v.cliente_id
   WHERE v.estado = 'ACTIVA'
     AND v.condicion_venta <> 'CTA_CTE'
     AND v.tipo_comprobante NOT IN ('NOTA_CREDITO', 'NOTA_DEBITO')
     AND ROUND(v.total - COALESCE(v.total_pagado, 0), 2) > 0.01;

GRANT SELECT ON public.ventas_saldo_pendiente TO authenticated;
