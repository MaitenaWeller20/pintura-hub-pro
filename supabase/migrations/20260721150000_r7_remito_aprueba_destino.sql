-- ============================================================
-- R7 — El remito interno lo aprueba (o rechaza) el DESTINATARIO.
--
-- Antes cualquier admin aprobaba cualquier remito. El negocio pide que sólo la
-- sucursal DESTINO pueda aprobarlo/rechazarlo, con override para el admin (que
-- suele tener sucursal_id NULL y quedaría bloqueado con una regla estricta).
--
--   - aprobar_remito: la autorización pasa a "admin OR el que aprueba pertenece a
--     la sucursal destino". Se mueve DESPUÉS del SELECT del remito porque necesita
--     sucursal_destino_id. El resto (transferencia atómica de stock) no cambia.
--   - rechazar_remito: NUEVA RPC transaccional con la misma autorización y guarda
--     de estado. Reemplaza el UPDATE suelto por PostgREST de rechazarRemito, que
--     no verificaba error ni filas afectadas y sólo chequeaba is_admin.
-- ============================================================

-- 1) aprobar_remito — autorización por sucursal destino (o admin).
CREATE OR REPLACE FUNCTION public.aprobar_remito(p_remito_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_remito      public.remitos%ROWTYPE;
  v_permite_neg boolean;
  v_item        record;
  v_ant_o       numeric(14,2);
  v_nue_o       numeric(14,2);
  v_ant_d       numeric(14,2);
  v_nue_d       numeric(14,2);
  v_n_items     integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- Lock del remito PRIMERO: además de serializar aprobaciones concurrentes,
  -- necesitamos sucursal_destino_id para autorizar.
  SELECT * INTO v_remito
    FROM public.remitos
   WHERE id = p_remito_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Remito inexistente';
  END IF;

  -- R7: sólo la sucursal DESTINO (o un administrador) puede aprobar.
  IF NOT (public.is_admin(v_uid) OR public.current_sucursal_id() = v_remito.sucursal_destino_id) THEN
    RAISE EXCEPTION 'Sólo la sucursal destino (o un administrador) puede aprobar este remito';
  END IF;

  IF v_remito.estado <> 'PENDIENTE' THEN
    RAISE EXCEPTION 'El remito % ya fue procesado (estado %)', v_remito.numero, v_remito.estado;
  END IF;
  IF v_remito.sucursal_origen_id = v_remito.sucursal_destino_id THEN
    RAISE EXCEPTION 'Origen y destino no pueden coincidir';
  END IF;

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg
    FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);

  FOR v_item IN
    SELECT producto_id, cantidad
      FROM public.remito_items
     WHERE remito_id = p_remito_id
  LOOP
    v_n_items := v_n_items + 1;

    IF v_item.cantidad IS NULL OR v_item.cantidad <= 0 THEN
      RAISE EXCEPTION 'Cantidad inválida en un ítem del remito %', v_remito.numero;
    END IF;

    -- ── SALIDA ORIGEN ──────────────────────────────────────────────
    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES (v_item.producto_id, v_remito.sucursal_origen_id, -v_item.cantidad)
      ON CONFLICT (producto_id, sucursal_id)
      DO UPDATE SET cantidad = stock_sucursal.cantidad - v_item.cantidad
      RETURNING cantidad + v_item.cantidad, cantidad INTO v_ant_o, v_nue_o;
    ELSE
      UPDATE public.stock_sucursal
         SET cantidad = cantidad - v_item.cantidad
       WHERE producto_id = v_item.producto_id
         AND sucursal_id = v_remito.sucursal_origen_id
         AND cantidad >= v_item.cantidad
      RETURNING cantidad + v_item.cantidad, cantidad INTO v_ant_o, v_nue_o;

      IF NOT FOUND THEN
        SELECT COALESCE(cantidad, 0) INTO v_ant_o
          FROM public.stock_sucursal
         WHERE producto_id = v_item.producto_id
           AND sucursal_id = v_remito.sucursal_origen_id;
        RAISE EXCEPTION 'Stock insuficiente en origen para el producto %: hay %, se piden %',
          v_item.producto_id, COALESCE(v_ant_o, 0), v_item.cantidad;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      v_item.producto_id, v_remito.sucursal_origen_id, 'TRANSFERENCIA_OUT',
      -v_item.cantidad, v_ant_o, v_nue_o,
      'Remito ' || v_remito.numero, v_remito.id, v_uid
    );

    -- ── ENTRADA DESTINO ────────────────────────────────────────────
    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
    VALUES (v_item.producto_id, v_remito.sucursal_destino_id, v_item.cantidad)
    ON CONFLICT (producto_id, sucursal_id)
    DO UPDATE SET cantidad = stock_sucursal.cantidad + v_item.cantidad
    RETURNING cantidad - v_item.cantidad, cantidad INTO v_ant_d, v_nue_d;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      v_item.producto_id, v_remito.sucursal_destino_id, 'TRANSFERENCIA_IN',
      v_item.cantidad, v_ant_d, v_nue_d,
      'Remito ' || v_remito.numero, v_remito.id, v_uid
    );
  END LOOP;

  IF v_n_items = 0 THEN
    RAISE EXCEPTION 'El remito % no tiene ítems', v_remito.numero;
  END IF;

  UPDATE public.remitos
     SET estado = 'APROBADO',
         aprobado_por = v_uid,
         fecha_aprobacion = now()
   WHERE id = p_remito_id;
END;
$$;

REVOKE ALL ON FUNCTION public.aprobar_remito(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.aprobar_remito(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_remito(uuid) TO service_role;

COMMENT ON FUNCTION public.aprobar_remito(uuid) IS
  'Aprueba un remito PENDIENTE (sólo la sucursal destino o un admin) y transfiere stock origen→destino atómicamente. Idempotente por estado.';

-- 2) rechazar_remito — RPC transaccional con la misma autorización.
CREATE OR REPLACE FUNCTION public.rechazar_remito(p_remito_id uuid, p_motivo text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_remito public.remitos%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_remito
    FROM public.remitos
   WHERE id = p_remito_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Remito inexistente';
  END IF;

  -- R7: sólo la sucursal DESTINO (o un administrador) puede rechazar.
  IF NOT (public.is_admin(v_uid) OR public.current_sucursal_id() = v_remito.sucursal_destino_id) THEN
    RAISE EXCEPTION 'Sólo la sucursal destino (o un administrador) puede rechazar este remito';
  END IF;

  IF v_remito.estado <> 'PENDIENTE' THEN
    RAISE EXCEPTION 'El remito % ya fue procesado (estado %)', v_remito.numero, v_remito.estado;
  END IF;

  -- Un rechazo NO mueve stock (el remito nunca se aprobó).
  UPDATE public.remitos
     SET estado = 'RECHAZADO',
         aprobado_por = v_uid,
         fecha_aprobacion = now(),
         motivo_rechazo = p_motivo
   WHERE id = p_remito_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rechazar_remito(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.rechazar_remito(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rechazar_remito(uuid, text) TO service_role;

COMMENT ON FUNCTION public.rechazar_remito(uuid, text) IS
  'Rechaza un remito PENDIENTE (sólo la sucursal destino o un admin). No mueve stock. Transaccional, con guarda de estado.';
