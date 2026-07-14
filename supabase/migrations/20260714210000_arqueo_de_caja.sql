-- ============================================================
-- ARQUEO DE CAJA — sesión de caja con conteo ciego y diferencia por forma de pago
--
-- Hasta ahora sólo existía "rendiciones_caja": un REPORTE diario de lectura que
-- suma los pagos del día y guarda diferencia = 0 fija. No es un arqueo: nunca se
-- le pregunta al cajero cuánta plata contó físicamente, no hay apertura ni turno,
-- y el cierre se puede reescribir.
--
-- Este módulo implementa un arqueo de verdad, con el patrón de MesaYa 2.0
-- adaptado a Postgres/Supabase:
--
--   1. ABRIR: el cajero declara el fondo inicial. Una sola sesión ABIERTA por
--      sucursal (índice único parcial + advisory lock).
--   2. OPERAR: cada venta y cobranza se ata a la sesión ABIERTA en el momento de
--      registrarse (trigger de estampado — NO se toca la RPC crear_venta), no por
--      rango de fecha. Los gastos/retiros/ingresos van a caja_movimientos.
--   3. ESPERADO: se DERIVA de esos movimientos (función caja_esperado), nunca es
--      un contador incremental. Se congela en la fila al cerrar.
--   4. CERRAR: el cajero declara lo CONTADO por forma de pago. El sistema calcula
--      la DIFERENCIA (contado − esperado) y la persiste. El cierre es inmutable.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ENUMS
-- ------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.caja_sesion_estado AS ENUM ('ABIERTA', 'CERRADA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- INICIAL = fondo de apertura. INGRESO = plata que entra fuera de una venta
  -- (aporte del dueño). GASTO = pago menor (flete, librería). RETIRO = plata que
  -- sale a tesorería / al banco.
  CREATE TYPE public.caja_mov_tipo AS ENUM ('INICIAL', 'INGRESO', 'GASTO', 'RETIRO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 2. TABLAS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.caja_sesiones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id    uuid NOT NULL REFERENCES public.sucursales(id),
  estado         public.caja_sesion_estado NOT NULL DEFAULT 'ABIERTA',
  abierta_por    uuid NOT NULL REFERENCES auth.users(id),
  abierta_en     timestamptz NOT NULL DEFAULT now(),
  fondo_inicial  numeric(14,2) NOT NULL DEFAULT 0 CHECK (fondo_inicial >= 0),
  cerrada_por    uuid REFERENCES auth.users(id),
  cerrada_en     timestamptz,
  -- Congelados al cerrar. Mapa {forma_pago: monto}.
  esperado         jsonb,
  contado          jsonb,
  diferencia       jsonb,
  total_esperado   numeric(14,2),
  total_contado    numeric(14,2),
  total_diferencia numeric(14,2),
  notas          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Una sola caja ABIERTA por sucursal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_caja_una_abierta_por_sucursal
  ON public.caja_sesiones (sucursal_id) WHERE estado = 'ABIERTA';
CREATE INDEX IF NOT EXISTS idx_caja_sesiones_suc_estado
  ON public.caja_sesiones (sucursal_id, estado, abierta_en DESC);

CREATE TABLE IF NOT EXISTS public.caja_movimientos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caja_sesion_id  uuid NOT NULL REFERENCES public.caja_sesiones(id) ON DELETE CASCADE,
  tipo            public.caja_mov_tipo NOT NULL,
  forma_pago      public.forma_pago NOT NULL DEFAULT 'EFECTIVO',
  -- Siempre POSITIVO; el signo lo da `tipo` (INICIAL/INGRESO suman, GASTO/RETIRO restan).
  monto           numeric(14,2) NOT NULL CHECK (monto > 0),
  descripcion     text NOT NULL,
  usuario_id      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_caja_mov_sesion ON public.caja_movimientos (caja_sesion_id);

-- Vínculo explícito de ventas/cobranzas con la sesión (lo completa el trigger).
ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS caja_sesion_id uuid REFERENCES public.caja_sesiones(id);
ALTER TABLE public.cobranzas_cta_cte
  ADD COLUMN IF NOT EXISTS caja_sesion_id uuid REFERENCES public.caja_sesiones(id);
CREATE INDEX IF NOT EXISTS idx_ventas_caja_sesion ON public.ventas (caja_sesion_id);
CREATE INDEX IF NOT EXISTS idx_cobranzas_caja_sesion ON public.cobranzas_cta_cte (caja_sesion_id);

CREATE TRIGGER trg_caja_sesiones_upd BEFORE UPDATE ON public.caja_sesiones
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------
-- 3. TRIGGER DE ESTAMPADO
--    Ata cada venta / cobranza a la sesión ABIERTA de su sucursal, en el momento
--    de insertar. No se toca crear_venta ni registrar_cobranza: el vínculo es un
--    efecto del INSERT. Si no hay caja abierta, queda NULL (no se bloquea la venta
--    para no romper el flujo actual; la pantalla de arqueo avisa de las ventas
--    sin sesión).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.estampar_caja_sesion()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.caja_sesion_id IS NULL THEN
    SELECT id INTO NEW.caja_sesion_id
      FROM public.caja_sesiones
     WHERE sucursal_id = NEW.sucursal_id AND estado = 'ABIERTA'
     ORDER BY abierta_en DESC
     LIMIT 1;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_ventas_estampar_caja ON public.ventas;
CREATE TRIGGER trg_ventas_estampar_caja
  BEFORE INSERT ON public.ventas
  FOR EACH ROW EXECUTE FUNCTION public.estampar_caja_sesion();

DROP TRIGGER IF EXISTS trg_cobranzas_estampar_caja ON public.cobranzas_cta_cte;
CREATE TRIGGER trg_cobranzas_estampar_caja
  BEFORE INSERT ON public.cobranzas_cta_cte
  FOR EACH ROW EXECUTE FUNCTION public.estampar_caja_sesion();

-- ------------------------------------------------------------
-- 4. caja_esperado(sesion) → jsonb {forma_pago: monto esperado}
--    Deriva lo que DEBERÍA haber por forma de pago:
--      + venta_pagos de ventas ACTIVAS de la sesión (ya vienen con signo)
--      + cobranzas de cuenta corriente de la sesión (ya vienen con signo)
--      + movimientos manuales: INICIAL/INGRESO suman, GASTO/RETIRO restan
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caja_esperado(_sesion_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH mov AS (
    -- Pagos de ventas de contado atadas a la sesión (venta activa)
    SELECT vp.forma_pago::text AS forma, vp.monto AS monto
      FROM public.venta_pagos vp
      JOIN public.ventas v ON v.id = vp.venta_id
     WHERE v.caja_sesion_id = _sesion_id AND v.estado = 'ACTIVA'
    UNION ALL
    -- Cobranzas de cuenta corriente atadas a la sesión
    SELECT c.forma_pago::text AS forma, c.monto AS monto
      FROM public.cobranzas_cta_cte c
     WHERE c.caja_sesion_id = _sesion_id
    UNION ALL
    -- Movimientos manuales: el signo lo da el tipo
    SELECT cm.forma_pago::text AS forma,
           CASE WHEN cm.tipo IN ('INICIAL', 'INGRESO') THEN cm.monto ELSE -cm.monto END AS monto
      FROM public.caja_movimientos cm
     WHERE cm.caja_sesion_id = _sesion_id
  )
  SELECT COALESCE(
           jsonb_object_agg(forma, ROUND(total, 2)),
           '{}'::jsonb
         )
    FROM (
      SELECT forma, SUM(monto) AS total
        FROM mov
       GROUP BY forma
    ) t;
$$;

-- ------------------------------------------------------------
-- 5. abrir_caja(sucursal, fondo) → sesion_id
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.abrir_caja(
  p_sucursal_id   uuid,
  p_fondo_inicial numeric DEFAULT 0
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_sesion uuid;
  v_fondo  numeric(14,2) := ROUND(COALESCE(p_fondo_inicial, 0), 2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés abrir la caja de una sucursal que no es la tuya';
  END IF;
  IF v_fondo < 0 THEN
    RAISE EXCEPTION 'El fondo inicial no puede ser negativo';
  END IF;

  -- Serializa aperturas concurrentes de la misma sucursal: dos requests no crean
  -- dos turnos ABIERTOS (además del índice único, que sería la última red).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_sucursal_id::text, 0));

  IF EXISTS (SELECT 1 FROM public.caja_sesiones
              WHERE sucursal_id = p_sucursal_id AND estado = 'ABIERTA') THEN
    RAISE EXCEPTION 'Ya hay una caja abierta en esta sucursal. Cerrala antes de abrir otra.';
  END IF;

  INSERT INTO public.caja_sesiones (sucursal_id, estado, abierta_por, fondo_inicial)
  VALUES (p_sucursal_id, 'ABIERTA', v_uid, v_fondo)
  RETURNING id INTO v_sesion;

  IF v_fondo > 0 THEN
    INSERT INTO public.caja_movimientos (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
    VALUES (v_sesion, 'INICIAL', 'EFECTIVO', v_fondo, 'Fondo inicial de caja', v_uid);
  END IF;

  RETURN v_sesion;
END; $$;

-- ------------------------------------------------------------
-- 6. registrar_movimiento_caja(sesion, tipo, forma, monto, descripcion)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_movimiento_caja(
  p_sesion_id   uuid,
  p_tipo        public.caja_mov_tipo,
  p_forma_pago  public.forma_pago,
  p_monto       numeric,
  p_descripcion text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_ses   public.caja_sesiones%ROWTYPE;
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

  INSERT INTO public.caja_movimientos (caja_sesion_id, tipo, forma_pago, monto, descripcion, usuario_id)
  VALUES (p_sesion_id, p_tipo, p_forma_pago, v_monto, btrim(p_descripcion), v_uid)
  RETURNING id INTO v_mov;

  RETURN v_mov;
END; $$;

-- ------------------------------------------------------------
-- 7. cerrar_caja(sesion, contado jsonb, notas)
--    contado = {"EFECTIVO": 11500, "TARJETA_CREDITO": 5000, ...}
--    Calcula esperado, congela esperado/contado/diferencia y cierra.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cerrar_caja(
  p_sesion_id uuid,
  p_contado   jsonb DEFAULT '{}'::jsonb,
  p_notas     text  DEFAULT NULL
)
RETURNS TABLE (total_esperado numeric, total_contado numeric, total_diferencia numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
        ROUND(COALESCE((v_contado->>k)::numeric, 0) - COALESCE((v_esperado->>k)::numeric, 0), 2)
      );
    END LOOP;
  END IF;

  SELECT COALESCE(SUM((value)::numeric), 0) INTO v_tot_esp   FROM jsonb_each_text(v_esperado);
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
    notas            = p_notas
  WHERE id = p_sesion_id;

  RETURN QUERY SELECT v_tot_esp, v_tot_cont, ROUND(v_tot_cont - v_tot_esp, 2);
END; $$;

-- ------------------------------------------------------------
-- 8. RLS + GRANTS
--    Lectura por sucursal (o admin). Escritura SÓLO por las RPC SECURITY DEFINER.
-- ------------------------------------------------------------
ALTER TABLE public.caja_sesiones   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.caja_movimientos ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.caja_sesiones   TO authenticated;
GRANT SELECT ON public.caja_movimientos TO authenticated;
GRANT ALL    ON public.caja_sesiones   TO service_role;
GRANT ALL    ON public.caja_movimientos TO service_role;

DROP POLICY IF EXISTS "caja_sesiones select" ON public.caja_sesiones;
CREATE POLICY "caja_sesiones select" ON public.caja_sesiones FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id());

DROP POLICY IF EXISTS "caja_movimientos select" ON public.caja_movimientos;
CREATE POLICY "caja_movimientos select" ON public.caja_movimientos FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.caja_sesiones s
     WHERE s.id = caja_sesion_id
       AND (public.is_admin(auth.uid()) OR s.sucursal_id = public.current_sucursal_id())
  ));

-- Permisos de ejecución
REVOKE ALL ON FUNCTION public.abrir_caja(uuid, numeric) FROM public;
REVOKE ALL ON FUNCTION public.registrar_movimiento_caja(uuid, public.caja_mov_tipo, public.forma_pago, numeric, text) FROM public;
REVOKE ALL ON FUNCTION public.cerrar_caja(uuid, jsonb, text) FROM public;
REVOKE ALL ON FUNCTION public.caja_esperado(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.abrir_caja(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_movimiento_caja(uuid, public.caja_mov_tipo, public.forma_pago, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cerrar_caja(uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.caja_esperado(uuid) TO authenticated;
