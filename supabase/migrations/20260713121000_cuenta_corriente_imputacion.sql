-- ============================================================
-- Cuenta corriente: imputar los cobros contra los comprobantes
--
-- Problema actual: cobranzas_cta_cte es un libro paralelo que nunca toca
-- ventas.total_pagado. Consecuencia:
--   * La pantalla de Cta Cte calcula bien el saldo por cliente (suma ventas
--     menos suma cobranzas).
--   * Pero la solapa "Cuentas corrientes" de Reportes lista comprobantes
--     filtrando por estado_pago <> 'PAGADO', y como estado_pago nunca cambia,
--     muestra deuda que NO baja aunque el cliente haya pagado todo.
--   * Y el Dashboard ("Pendiente hoy") arrastra el mismo error.
--
-- Solución: cada cobro se imputa contra los comprobantes abiertos del cliente,
-- del más viejo al más nuevo (FIFO), actualizando total_pagado y estado_pago.
-- Queda un registro de qué cobro pagó qué comprobante, que es lo que después
-- permite explicarle al cliente por qué debe lo que debe.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cobranza_imputaciones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cobranza_id  uuid NOT NULL REFERENCES public.cobranzas_cta_cte(id) ON DELETE CASCADE,
  venta_id     uuid NOT NULL REFERENCES public.ventas(id),
  monto        numeric(14,2) NOT NULL CHECK (monto > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cobranza_id, venta_id)
);
CREATE INDEX IF NOT EXISTS idx_cimp_venta ON public.cobranza_imputaciones (venta_id);
CREATE INDEX IF NOT EXISTS idx_cimp_cobranza ON public.cobranza_imputaciones (cobranza_id);

GRANT SELECT ON public.cobranza_imputaciones TO authenticated;
GRANT ALL ON public.cobranza_imputaciones TO service_role;
ALTER TABLE public.cobranza_imputaciones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "imputaciones select" ON public.cobranza_imputaciones
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.ventas v
       WHERE v.id = venta_id
         AND (public.is_admin(auth.uid()) OR v.sucursal_id = public.current_sucursal_id())
    )
  );
-- Sólo se escribe desde registrar_cobranza() (SECURITY DEFINER). Nadie imputa a mano.


-- ------------------------------------------------------------
-- Cobranza atómica con imputación FIFO
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_cobranza(
  p_cliente_id    uuid,
  p_sucursal_id   uuid,
  p_monto         numeric,
  p_forma_pago    text,
  p_detalle       jsonb DEFAULT '{}'::jsonb,
  p_observaciones text  DEFAULT NULL
)
RETURNS TABLE (cobranza_id uuid, imputado numeric, a_cuenta numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_cobranza_id  uuid;
  v_restante     numeric(14,2);
  v_imputado     numeric(14,2) := 0;
  v_aplicar      numeric(14,2);
  v_saldo_venta  numeric(14,2);
  r              RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés cobrar en una sucursal que no es la tuya';
  END IF;

  IF COALESCE(p_monto, 0) <= 0 THEN
    RAISE EXCEPTION 'El monto del cobro debe ser mayor a cero';
  END IF;

  INSERT INTO public.cobranzas_cta_cte (
    cliente_id, sucursal_id, usuario_id, monto, forma_pago, detalle, observaciones
  ) VALUES (
    p_cliente_id, p_sucursal_id, v_uid, p_monto, p_forma_pago,
    COALESCE(p_detalle, '{}'::jsonb), p_observaciones
  ) RETURNING id INTO v_cobranza_id;

  v_restante := ROUND(p_monto, 2);

  -- Imputación FIFO contra los comprobantes de cuenta corriente abiertos.
  -- FOR UPDATE serializa dos cobros simultáneos del mismo cliente, así no se
  -- imputa dos veces sobre el mismo saldo.
  FOR r IN
    SELECT id, total, total_pagado
      FROM public.ventas
     WHERE cliente_id = p_cliente_id
       AND condicion_venta = 'CTA_CTE'
       AND estado = 'ACTIVA'
       AND total > 0                     -- las notas de crédito no se "cobran"
       AND total_pagado < total
     ORDER BY fecha ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_restante <= 0;

    v_saldo_venta := ROUND(r.total - r.total_pagado, 2);
    v_aplicar := LEAST(v_restante, v_saldo_venta);
    CONTINUE WHEN v_aplicar <= 0;

    UPDATE public.ventas
       SET total_pagado = ROUND(total_pagado + v_aplicar, 2),
           estado_pago  = CASE
             WHEN ROUND(total_pagado + v_aplicar, 2) >= total - 0.01 THEN 'PAGADO'::public.estado_pago
             ELSE 'PARCIAL'::public.estado_pago
           END
     WHERE id = r.id;

    INSERT INTO public.cobranza_imputaciones (cobranza_id, venta_id, monto)
    VALUES (v_cobranza_id, r.id, v_aplicar);

    v_restante := ROUND(v_restante - v_aplicar, 2);
    v_imputado := ROUND(v_imputado + v_aplicar, 2);
  END LOOP;

  -- Si sobra plata (pagó más de lo que debía) queda como saldo a favor: la
  -- cobranza existe por su monto completo, pero sin comprobante al que imputar.
  RETURN QUERY SELECT v_cobranza_id, v_imputado, v_restante;
END; $$;

REVOKE ALL ON FUNCTION public.registrar_cobranza(uuid, uuid, numeric, text, jsonb, text) FROM public;
GRANT EXECUTE ON FUNCTION public.registrar_cobranza(uuid, uuid, numeric, text, jsonb, text) TO authenticated;


-- ------------------------------------------------------------
-- Backfill: reparar el estado de los comprobantes ya existentes
-- ------------------------------------------------------------
-- Las cobranzas históricas nunca se imputaron, así que hoy hay comprobantes
-- marcados PENDIENTE que en realidad están cobrados. Los imputamos FIFO con
-- la misma regla, para que las tres vistas (Cta Cte, Reportes, Dashboard)
-- pasen a coincidir.
DO $$
DECLARE
  c     RECORD;
  r     RECORD;
  rest  numeric(14,2);
  apl   numeric(14,2);
BEGIN
  FOR c IN
    SELECT id, cliente_id, monto
      FROM public.cobranzas_cta_cte co
     WHERE NOT EXISTS (
       SELECT 1 FROM public.cobranza_imputaciones i WHERE i.cobranza_id = co.id
     )
     ORDER BY fecha ASC
  LOOP
    rest := ROUND(c.monto, 2);

    FOR r IN
      SELECT id, total, total_pagado
        FROM public.ventas
       WHERE cliente_id = c.cliente_id
         AND condicion_venta = 'CTA_CTE'
         AND estado = 'ACTIVA'
         AND total > 0
         AND total_pagado < total
       ORDER BY fecha ASC
    LOOP
      EXIT WHEN rest <= 0;
      apl := LEAST(rest, ROUND(r.total - r.total_pagado, 2));
      CONTINUE WHEN apl <= 0;

      UPDATE public.ventas
         SET total_pagado = ROUND(total_pagado + apl, 2),
             estado_pago  = CASE
               WHEN ROUND(total_pagado + apl, 2) >= total - 0.01 THEN 'PAGADO'::public.estado_pago
               ELSE 'PARCIAL'::public.estado_pago
             END
       WHERE id = r.id;

      INSERT INTO public.cobranza_imputaciones (cobranza_id, venta_id, monto)
      VALUES (c.id, r.id, apl)
      ON CONFLICT (cobranza_id, venta_id) DO NOTHING;

      rest := ROUND(rest - apl, 2);
    END LOOP;
  END LOOP;
END $$;
