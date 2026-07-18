-- ============================================================
-- Aprobación de remitos atómica (RPC transaccional).
--
-- aprobarRemito (src/lib/stock.functions.ts) movía stock entre sucursales con
-- select→upsert sueltos por PostgREST, SIN transacción y SIN chequear error:
--   (a) read-modify-write → lost-update si una venta/otra transferencia concurrente
--       tocaba el mismo (producto,sucursal) entre el read y el upsert;
--   (b) permitía stock NEGATIVO ignorando settings.permitir_stock_negativo;
--   (c) doble-aprobación: el UPDATE final a 'APROBADO' no era atómico ni tenía guard
--       de estado, dos clicks movían stock dos veces.
--
-- Ahora todo pasa por esta RPC SECURITY DEFINER, en UNA transacción:
--   - bloquea el remito (FOR UPDATE) y valida estado='PENDIENTE' → serializa
--     aprobaciones concurrentes del mismo remito;
--   - descuenta origen con UPDATE ... WHERE cantidad >= it.cantidad (guarda de
--     negativo, salvo permitir_stock_negativo) verificando filas afectadas;
--   - suma destino con INSERT ... ON CONFLICT DO UPDATE (atómico);
--   - graba kardex por ambos lados (TRANSFERENCIA_OUT / TRANSFERENCIA_IN).
-- Mismo patrón de guarda que crear_venta.
-- ============================================================

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
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo el administrador puede aprobar remitos';
  END IF;

  -- Lock del remito: una segunda aprobación concurrente espera al COMMIT y luego
  -- ve estado='APROBADO' → falla. Elimina la doble-aprobación.
  SELECT * INTO v_remito
    FROM public.remitos
   WHERE id = p_remito_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Remito inexistente';
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
      -- Se permite dejar el stock negativo (misma política que crear_venta).
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES (v_item.producto_id, v_remito.sucursal_origen_id, -v_item.cantidad)
      ON CONFLICT (producto_id, sucursal_id)
      DO UPDATE SET cantidad = stock_sucursal.cantidad - v_item.cantidad
      RETURNING cantidad + v_item.cantidad, cantidad INTO v_ant_o, v_nue_o;
    ELSE
      -- Descuento atómico con guarda de no-negativo: read-modify-write en un solo
      -- statement (sin lost-update). Si no hay stock suficiente, 0 filas → NOT FOUND.
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
    -- Suma atómica: crea la fila si no existe, o acumula. old = cantidad - it.cantidad.
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

-- Sólo usuarios autenticados (la RPC valida is_admin adentro).
REVOKE ALL ON FUNCTION public.aprobar_remito(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.aprobar_remito(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_remito(uuid) TO service_role;

COMMENT ON FUNCTION public.aprobar_remito(uuid) IS
  'Aprueba un remito PENDIENTE y transfiere stock origen→destino atómicamente (kardex por ambos lados). Idempotente por estado: rechaza doble-aprobación.';
