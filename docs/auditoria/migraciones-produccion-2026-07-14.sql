-- ============================================================================
-- Quimex — migraciones a aplicar en PRODUCCIÓN (proyecto gagrdirwlcunygtztiuk)
-- Pegá TODO este archivo en: Supabase Dashboard -> SQL Editor -> New query -> Run
-- Es seguro re-correrlo (usa IF NOT EXISTS / DROP IF EXISTS / CREATE OR REPLACE).
-- Generado: 2026-07-14
-- ============================================================================


-- ══════════════════════════════════════════════════════════════════════════
-- 20260714200000_seguridad_cerrar_tablas_plata.sql
-- ══════════════════════════════════════════════════════════════════════════
-- ============================================================
-- SEGURIDAD: cerrar el perímetro de escritura de las tablas de plata
--
-- Contexto: toda la lógica de negocio se fortificó dentro de RPC SECURITY
-- DEFINER (crear_venta, anular_venta, registrar_cobranza). Pero las tablas
-- hijas quedaron con GRANT de escritura directa a `authenticated` y policies
-- `FOR ALL` filtradas sólo por sucursal. Eso deja un agujero real:
--
--   Un cajero autenticado podía, desde la consola del navegador:
--     DELETE FROM venta_pagos WHERE venta_id = <una venta de su sucursal>
--   La venta seguía intacta (total/total_pagado viven en `ventas`, ya blindada
--   por guard_ventas_columnas), pero el pago desaparecía. En la rendición de
--   caja, que suma venta_pagos, la caja pasaba a esperar MENOS efectivo → el
--   cajero se quedaba la diferencia y el arqueo "cuadraba".
--
-- La tabla cuenta_corriente_movimientos ya se había cerrado a sólo-SELECT
-- (migración 20260713140000). Esta migración aplica el MISMO criterio a las
-- otras tres tablas de plata. Las RPC son SECURITY DEFINER, así que corren con
-- los privilegios del owner y siguen escribiendo sin problema; el frontend sólo
-- lee estas tablas (verificado: todas sus referencias son .select()).
-- ============================================================

-- 1) venta_pagos, venta_items, cobranzas_cta_cte: sólo lectura para authenticated.
--    La escritura queda exclusivamente en manos de las RPC SECURITY DEFINER.
REVOKE INSERT, UPDATE, DELETE ON public.venta_pagos      FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.venta_items      FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.cobranzas_cta_cte FROM authenticated;

-- Las policies `FOR ALL` quedan sin efecto para escritura (ya no hay grant que
-- habilite INSERT/UPDATE/DELETE), pero las dejamos: siguen gobernando el SELECT.
-- No se tocan porque el filtro por sucursal del SELECT es correcto.

-- 2) profiles: un empleado puede editar SU perfil (nombre), pero no puede
--    reasignarse de sucursal, reactivarse ni cambiar su username. Eso es una
--    decisión administrativa. RLS no filtra por columna → trigger guard, igual
--    que guard_clientes_credito / guard_ventas_columnas.
CREATE OR REPLACE FUNCTION public.guard_profiles_columnas()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- La service_role key (auth.uid() IS NULL) es el canal administrativo del
  -- backend: no lo bloqueamos. Un admin autenticado tampoco.
  IF auth.uid() IS NULL OR public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF NEW.sucursal_id IS DISTINCT FROM OLD.sucursal_id THEN
    RAISE EXCEPTION 'Sólo un administrador puede cambiar la sucursal de un usuario';
  END IF;
  IF NEW.activo IS DISTINCT FROM OLD.activo THEN
    RAISE EXCEPTION 'Sólo un administrador puede activar o desactivar un usuario';
  END IF;
  IF NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'El nombre de usuario no se puede cambiar';
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_profiles_guard_columnas ON public.profiles;
CREATE TRIGGER trg_profiles_guard_columnas
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profiles_columnas();


-- ══════════════════════════════════════════════════════════════════════════
-- 20260714210000_arqueo_de_caja.sql
-- ══════════════════════════════════════════════════════════════════════════
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


-- ══════════════════════════════════════════════════════════════════════════
-- 20260714220000_fix_sobrepago_y_anulacion_caja.sql
-- ══════════════════════════════════════════════════════════════════════════
-- ============================================================
-- FIX: sobrepago electrónico + anulación que revierte la caja
--
-- (1) crear_venta: el vuelto sólo tiene sentido en EFECTIVO. Un pago electrónico
--     (tarjeta/transferencia/MP/cheque) por encima del total no es vuelto: es un
--     descuadre que después infla el arqueo. Ahora se rechaza. Verificado e2e:
--     antes, transferir $20.000 por una venta de $13.310 registraba $20.000 en
--     venta_pagos y la caja cerraba con $6.690 de más.
--
-- (2) anular_venta: la NC de anulación ahora copia los pagos originales NEGADOS,
--     así la plata devuelta al cliente SALE de la caja (la NC se estampa a la
--     sesión abierta por el trigger de arqueo). total_pagado de la NC = -original.
--
-- (3) caja_esperado: deja de filtrar por estado='ACTIVA'. El signo lo dan los
--     venta_pagos (venta = +, NC de anulación = −), así una venta anulada y su NC
--     en la MISMA sesión se compensan a cero sin doble descuento; y una venta
--     anulada en OTRA sesión no altera la sesión ya cerrada.
--
-- Los cuerpos de crear_venta / anular_venta se extrajeron con pg_get_functiondef
-- de la versión vigente (migración 20260713140000) y se les aplicó SÓLO el cambio
-- descrito, para no arrastrar regresiones al reescribir a mano.
-- ============================================================

-- ---------- crear_venta (con guarda de sobrepago electrónico) ----------
CREATE OR REPLACE FUNCTION public.crear_venta(p_sucursal_id uuid, p_cliente_id uuid, p_tipo_comprobante tipo_comprobante, p_condicion_venta condicion_venta, p_items jsonb, p_pagos jsonb, p_percepciones numeric DEFAULT 0, p_observaciones text DEFAULT NULL::text, p_nombre_obra text DEFAULT NULL::text, p_fecha timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cbte_asoc_id uuid DEFAULT NULL::uuid)
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
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés facturar en una sucursal que no es la tuya';
  END IF;

  SELECT * INTO v_cliente FROM public.clientes WHERE id = p_cliente_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  IF COALESCE(p_percepciones, 0) < 0 THEN
    RAISE EXCEPTION 'Las percepciones no pueden ser negativas';
  END IF;

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg
    FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);

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

  v_es_cta_cte := p_tipo_comprobante IN ('REMITO', 'REMITO_OBRA', 'FAC_INTERNA_CTA_CTE')
                  OR p_condicion_venta = 'CTA_CTE';

  IF v_es_cta_cte AND p_tipo_comprobante NOT IN ('NOTA_CREDITO', 'NOTA_DEBITO')
     AND NOT COALESCE(v_cliente.condicion_cta_cte, false) THEN
    RAISE EXCEPTION 'El cliente % no tiene cuenta corriente habilitada', v_cliente.razon_social;
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
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

  IF NOT v_es_cta_cte THEN
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := COALESCE((pg->>'monto')::numeric, 0);
      IF v_monto < 0 THEN
        RAISE EXCEPTION 'Un pago no puede ser negativo';
      END IF;
      v_pagos_suma := v_pagos_suma + v_monto;
      -- Sólo el EFECTIVO admite pagar de más (vuelto físico). Un pago
      -- electrónico (tarjeta/transferencia/MP/cheque) por encima del total no es
      -- vuelto: es un descuadre que después infla la caja. Se rechaza.
      IF (pg->>'forma_pago')::public.forma_pago <> 'EFECTIVO' THEN
        v_pagos_no_efec := v_pagos_no_efec + v_monto;
      END IF;
    END LOOP;

    IF v_pagos_no_efec > ABS(v_total) + 0.01 THEN
      RAISE EXCEPTION 'Los pagos electrónicos (%) superan el total del comprobante (%). Sólo el efectivo admite vuelto.',
        v_pagos_no_efec, ABS(v_total);
    END IF;

    IF v_pagos_suma > ABS(v_total) THEN
      v_vuelto := ROUND(v_pagos_suma - ABS(v_total), 2);
    END IF;
    v_total_pagado := ROUND(LEAST(v_pagos_suma, ABS(v_total)), 2) * v_signo;
  END IF;

  v_estado_pago := CASE
    WHEN v_es_cta_cte THEN 'PENDIENTE'::public.estado_pago
    WHEN ABS(v_total_pagado) >= ABS(v_total) - 0.01 THEN 'PAGADO'::public.estado_pago
    WHEN ABS(v_total_pagado) > 0 THEN 'PARCIAL'::public.estado_pago
    ELSE 'PENDIENTE'::public.estado_pago
  END;

  -- Límite de crédito: se compara contra el SALDO del libro de movimientos.
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
    estado_pago, observaciones, nombre_obra, afip_cbte_asoc_id
  ) VALUES (
    p_sucursal_id, p_cliente_id, v_uid, COALESCE(p_fecha, now()), v_numero, p_tipo_comprobante,
    CASE WHEN v_es_cta_cte THEN 'CTA_CTE'::public.condicion_venta ELSE p_condicion_venta END,
    v_sub_sin_iva, v_iva_total, v_percepciones, v_total, v_total_pagado,
    v_estado_pago, p_observaciones, p_nombre_obra, p_cbte_asoc_id
  ) RETURNING id INTO v_venta_id;

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

    CONTINUE WHEN p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') OR v_cant = 0;

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

      IF v_vuelto > 0 AND v_forma = 'EFECTIVO' THEN
        IF v_monto >= v_vuelto THEN
          v_monto := v_monto - v_vuelto;
          v_vuelto := 0;
        ELSE
          v_vuelto := v_vuelto - v_monto;
          v_monto := 0;
        END IF;
      END IF;

      CONTINUE WHEN v_monto = 0;

      INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
      VALUES (v_venta_id, v_forma, v_monto * v_signo, COALESCE(pg->'detalle', '{}'::jsonb));
    END LOOP;
  END IF;

  -- LIBRO DE CUENTA CORRIENTE: si va a cuenta, registra el movimiento.
  IF v_es_cta_cte THEN
    PERFORM public.cc_registrar_por_venta(v_venta_id);
  END IF;

  RETURN QUERY SELECT v_venta_id, v_numero, v_es_cta_cte;
END; $function$

;
REVOKE ALL ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid) TO authenticated;

-- ---------- anular_venta (revierte la caja con pagos negados) ----------
CREATE OR REPLACE FUNCTION public.anular_venta(p_venta_id uuid)
 RETURNS TABLE(nc_id uuid, nc_numero text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_v         public.ventas%ROWTYPE;
  v_numero    text;
  v_nc_id     uuid;
  r           RECORD;
  v_stock_ant numeric(14,2);
  v_stock_nue numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_v FROM public.ventas WHERE id = p_venta_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  IF NOT public.is_admin(v_uid) AND v_v.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés anular una venta de otra sucursal';
  END IF;

  IF v_v.estado = 'ANULADA' THEN
    RAISE EXCEPTION 'La venta ya fue anulada';
  END IF;

  IF v_v.tipo_comprobante NOT IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C',
                                  'REMITO', 'REMITO_OBRA', 'FAC_INTERNA_CTA_CTE') THEN
    RAISE EXCEPTION 'Una % no se anula (las notas se corrigen con otra nota)', v_v.tipo_comprobante;
  END IF;

  v_numero := public.next_comprobante_numero(v_v.sucursal_id, 'NOTA_CREDITO');

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, numero_comprobante, tipo_comprobante,
    condicion_venta, subtotal_sin_iva, iva_total, percepciones, total, total_pagado,
    estado_pago, observaciones, afip_cbte_asoc_id
  ) VALUES (
    v_v.sucursal_id, v_v.cliente_id, v_uid, v_numero, 'NOTA_CREDITO',
    'CONTADO', -v_v.subtotal_sin_iva, -v_v.iva_total, -v_v.percepciones,
    -v_v.total, -v_v.total_pagado, 'PENDIENTE',
    'Nota de crédito por anulación de ' || v_v.numero_comprobante,
    v_v.id
  ) RETURNING id INTO v_nc_id;

  -- La plata que se le devuelve al cliente SALE de la caja. Copiamos los pagos
  -- originales con el signo invertido: el arqueo (caja_esperado) los resta de la
  -- sesión donde ocurre la anulación (la NC se estampa a la caja abierta por el
  -- trigger). Sin esto, anular una venta cobrada en efectivo dejaba la caja
  -- esperando plata que ya no estaba. Una venta a cuenta corriente no tiene
  -- pagos, así que este INSERT no copia nada (la reversión va por el libro).
  INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
  SELECT v_nc_id, forma_pago, -monto, detalle
    FROM public.venta_pagos WHERE venta_id = v_v.id;

  INSERT INTO public.venta_items (
    venta_id, producto_id, codigo, descripcion, cantidad,
    precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
    subtotal_sin_iva, iva_monto, subtotal_con_iva
  )
  SELECT
    v_nc_id, producto_id, codigo, descripcion, cantidad,
    precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
    -subtotal_sin_iva, -iva_monto, -subtotal_con_iva
  FROM public.venta_items WHERE venta_id = v_v.id;

  UPDATE public.ventas
     SET estado = 'ANULADA', venta_anulada_por = v_nc_id
   WHERE id = v_v.id;

  -- Anula el movimiento de cuenta corriente que había generado la venta original.
  UPDATE public.cuenta_corriente_movimientos
     SET estado = 'ANULADO'
   WHERE venta_id = v_v.id AND estado = 'CONFIRMADO';

  FOR r IN SELECT producto_id, cantidad FROM public.venta_items WHERE venta_id = v_v.id
  LOOP
    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
    VALUES (r.producto_id, v_v.sucursal_id, r.cantidad)
    ON CONFLICT (producto_id, sucursal_id)
    DO UPDATE SET cantidad = stock_sucursal.cantidad + r.cantidad
    RETURNING cantidad - r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      r.producto_id, v_v.sucursal_id, 'ANULACION_VENTA', r.cantidad, v_stock_ant, v_stock_nue,
      'Anulación ' || v_v.numero_comprobante, v_v.id, v_uid
    );
  END LOOP;

  RETURN QUERY SELECT v_nc_id, v_numero;
END; $function$

;
REVOKE ALL ON FUNCTION public.anular_venta(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid) TO authenticated;

-- ---------- caja_esperado sin filtro por estado (el signo lo dan los pagos) ----------
CREATE OR REPLACE FUNCTION public.caja_esperado(_sesion_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH mov AS (
    SELECT vp.forma_pago::text AS forma, vp.monto AS monto
      FROM public.venta_pagos vp
      JOIN public.ventas v ON v.id = vp.venta_id
     WHERE v.caja_sesion_id = _sesion_id
    UNION ALL
    SELECT c.forma_pago::text AS forma, c.monto AS monto
      FROM public.cobranzas_cta_cte c
     WHERE c.caja_sesion_id = _sesion_id
    UNION ALL
    SELECT cm.forma_pago::text AS forma,
           CASE WHEN cm.tipo IN ('INICIAL', 'INGRESO') THEN cm.monto ELSE -cm.monto END AS monto
      FROM public.caja_movimientos cm
     WHERE cm.caja_sesion_id = _sesion_id
  )
  SELECT COALESCE(jsonb_object_agg(forma, ROUND(total, 2)), '{}'::jsonb)
    FROM (SELECT forma, SUM(monto) AS total FROM mov GROUP BY forma) t;
$$;
REVOKE ALL ON FUNCTION public.caja_esperado(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.caja_esperado(uuid) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════════
-- 20260714230000_correcciones_revision_codex.sql
-- ══════════════════════════════════════════════════════════════════════════
-- ============================================================
-- Correcciones surgidas de la revisión de código (Codex)
--
-- #1 (crítico) Race estampado/cierre: estampar_caja_sesion hacía un SELECT normal
--     mientras cerrar_caja bloqueaba la fila con FOR UPDATE. Una venta concurrente
--     podía atarse a la caja "ABIERTA" justo cuando se cerraba, quedando en una
--     sesión cerrada sin entrar en los totales congelados (plata perdida del
--     arqueo). Ahora el trigger lee la sesión con FOR SHARE: se serializa contra
--     el cierre. Si el cierre gana, la venta queda sin sesión (no en una cerrada).
--
-- #3 (alto) Perímetro de `ventas`: authenticated todavía podía INSERT/UPDATE/DELETE
--     directo sobre ventas (el guard sólo corría en UPDATE, no en INSERT), pudiendo
--     crear una cabecera de venta fuera de crear_venta. Se revoca. Las RPC son
--     SECURITY DEFINER y fiscal.functions usa service_role: no se rompe nada.
--
-- #4 (alto) crear_venta rechaza CTA_CTE como forma de pago (no es un cobro).
-- #5 (medio) cobranzas_cta_cte.forma_pago: CHECK contra las formas válidas.
-- #6 (medio) crear_venta: sobrepago electrónico sin tolerancia de centavo.
-- #7 (medio) anular_venta: la NC de una venta cobrada queda PAGADO, no PENDIENTE.
-- ============================================================

-- #3: cerrar la escritura directa de ventas (sólo lectura para authenticated).
REVOKE INSERT, UPDATE, DELETE ON public.ventas FROM authenticated;

-- #5: forma de pago de cobranzas validada a nivel tabla (defensa en profundidad,
--     por si se llama la RPC con una forma inválida).
ALTER TABLE public.cobranzas_cta_cte DROP CONSTRAINT IF EXISTS chk_cobranza_forma_pago;
ALTER TABLE public.cobranzas_cta_cte ADD CONSTRAINT chk_cobranza_forma_pago
  CHECK (forma_pago IS NULL OR forma_pago IN
    ('EFECTIVO','TRANSFERENCIA','TARJETA_DEBITO','TARJETA_CREDITO','MERCADO_PAGO','CHEQUE','CTA_CTE'));

-- #1: estampado serializado contra el cierre.
CREATE OR REPLACE FUNCTION public.estampar_caja_sesion()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sesion uuid;
BEGIN
  IF NEW.caja_sesion_id IS NULL THEN
    -- FOR SHARE: si cerrar_caja está cerrando esta sesión (FOR UPDATE), esperamos.
    -- Cuando libera, re-evaluamos el WHERE estado='ABIERTA': si ya cerró, no la
    -- tomamos (la venta queda sin sesión en vez de atarse a una caja cerrada).
    SELECT id INTO v_sesion
      FROM public.caja_sesiones
     WHERE sucursal_id = NEW.sucursal_id AND estado = 'ABIERTA'
     ORDER BY abierta_en DESC
     LIMIT 1
     FOR SHARE;
    NEW.caja_sesion_id := v_sesion;
  END IF;
  RETURN NEW;
END; $$;

-- #4/#6: crear_venta (rechazo CTA_CTE + sobrepago sin tolerancia) --
CREATE OR REPLACE FUNCTION public.crear_venta(p_sucursal_id uuid, p_cliente_id uuid, p_tipo_comprobante tipo_comprobante, p_condicion_venta condicion_venta, p_items jsonb, p_pagos jsonb, p_percepciones numeric DEFAULT 0, p_observaciones text DEFAULT NULL::text, p_nombre_obra text DEFAULT NULL::text, p_fecha timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cbte_asoc_id uuid DEFAULT NULL::uuid)
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
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés facturar en una sucursal que no es la tuya';
  END IF;

  SELECT * INTO v_cliente FROM public.clientes WHERE id = p_cliente_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  IF COALESCE(p_percepciones, 0) < 0 THEN
    RAISE EXCEPTION 'Las percepciones no pueden ser negativas';
  END IF;

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg
    FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);

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

  v_es_cta_cte := p_tipo_comprobante IN ('REMITO', 'REMITO_OBRA', 'FAC_INTERNA_CTA_CTE')
                  OR p_condicion_venta = 'CTA_CTE';

  IF v_es_cta_cte AND p_tipo_comprobante NOT IN ('NOTA_CREDITO', 'NOTA_DEBITO')
     AND NOT COALESCE(v_cliente.condicion_cta_cte, false) THEN
    RAISE EXCEPTION 'El cliente % no tiene cuenta corriente habilitada', v_cliente.razon_social;
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
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

  IF NOT v_es_cta_cte THEN
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      v_monto := COALESCE((pg->>'monto')::numeric, 0);
      IF v_monto < 0 THEN
        RAISE EXCEPTION 'Un pago no puede ser negativo';
      END IF;
      -- CTA_CTE no es una forma de COBRO: es una condición de venta. Aceptarla
      -- como pago de una venta de contado marcaría la venta como pagada sin que
      -- entre plata ni se genere deuda, y además inflaría el arqueo con una
      -- "forma" que no es caja. Se rechaza.
      IF (pg->>'forma_pago')::public.forma_pago = 'CTA_CTE' THEN
        RAISE EXCEPTION 'CTA_CTE no es una forma de pago. Para vender a cuenta corriente usá la condición de venta CTA_CTE.';
      END IF;
      v_pagos_suma := v_pagos_suma + v_monto;
      -- Sólo el EFECTIVO admite pagar de más (vuelto físico). Un pago
      -- electrónico (tarjeta/transferencia/MP/cheque) por encima del total no es
      -- vuelto: es un descuadre que después infla la caja. Se rechaza.
      IF (pg->>'forma_pago')::public.forma_pago <> 'EFECTIVO' THEN
        v_pagos_no_efec := v_pagos_no_efec + v_monto;
      END IF;
    END LOOP;

    -- Los montos son numeric(14,2): cualquier excedente electrónico es real,
    -- no un artefacto de redondeo. Sin tolerancia.
    IF v_pagos_no_efec > ABS(v_total) THEN
      RAISE EXCEPTION 'Los pagos electrónicos (%) superan el total del comprobante (%). Sólo el efectivo admite vuelto.',
        v_pagos_no_efec, ABS(v_total);
    END IF;

    IF v_pagos_suma > ABS(v_total) THEN
      v_vuelto := ROUND(v_pagos_suma - ABS(v_total), 2);
    END IF;
    v_total_pagado := ROUND(LEAST(v_pagos_suma, ABS(v_total)), 2) * v_signo;
  END IF;

  v_estado_pago := CASE
    WHEN v_es_cta_cte THEN 'PENDIENTE'::public.estado_pago
    WHEN ABS(v_total_pagado) >= ABS(v_total) - 0.01 THEN 'PAGADO'::public.estado_pago
    WHEN ABS(v_total_pagado) > 0 THEN 'PARCIAL'::public.estado_pago
    ELSE 'PENDIENTE'::public.estado_pago
  END;

  -- Límite de crédito: se compara contra el SALDO del libro de movimientos.
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
    estado_pago, observaciones, nombre_obra, afip_cbte_asoc_id
  ) VALUES (
    p_sucursal_id, p_cliente_id, v_uid, COALESCE(p_fecha, now()), v_numero, p_tipo_comprobante,
    CASE WHEN v_es_cta_cte THEN 'CTA_CTE'::public.condicion_venta ELSE p_condicion_venta END,
    v_sub_sin_iva, v_iva_total, v_percepciones, v_total, v_total_pagado,
    v_estado_pago, p_observaciones, p_nombre_obra, p_cbte_asoc_id
  ) RETURNING id INTO v_venta_id;

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

    CONTINUE WHEN p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') OR v_cant = 0;

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

      IF v_vuelto > 0 AND v_forma = 'EFECTIVO' THEN
        IF v_monto >= v_vuelto THEN
          v_monto := v_monto - v_vuelto;
          v_vuelto := 0;
        ELSE
          v_vuelto := v_vuelto - v_monto;
          v_monto := 0;
        END IF;
      END IF;

      CONTINUE WHEN v_monto = 0;

      INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
      VALUES (v_venta_id, v_forma, v_monto * v_signo, COALESCE(pg->'detalle', '{}'::jsonb));
    END LOOP;
  END IF;

  -- LIBRO DE CUENTA CORRIENTE: si va a cuenta, registra el movimiento.
  IF v_es_cta_cte THEN
    PERFORM public.cc_registrar_por_venta(v_venta_id);
  END IF;

  RETURN QUERY SELECT v_venta_id, v_numero, v_es_cta_cte;
END; $function$

;
REVOKE ALL ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid) TO authenticated;

-- #7: anular_venta (NC de venta cobrada queda PAGADO) --
CREATE OR REPLACE FUNCTION public.anular_venta(p_venta_id uuid)
 RETURNS TABLE(nc_id uuid, nc_numero text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_v         public.ventas%ROWTYPE;
  v_numero    text;
  v_nc_id     uuid;
  r           RECORD;
  v_stock_ant numeric(14,2);
  v_stock_nue numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_v FROM public.ventas WHERE id = p_venta_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  IF NOT public.is_admin(v_uid) AND v_v.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés anular una venta de otra sucursal';
  END IF;

  IF v_v.estado = 'ANULADA' THEN
    RAISE EXCEPTION 'La venta ya fue anulada';
  END IF;

  IF v_v.tipo_comprobante NOT IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C',
                                  'REMITO', 'REMITO_OBRA', 'FAC_INTERNA_CTA_CTE') THEN
    RAISE EXCEPTION 'Una % no se anula (las notas se corrigen con otra nota)', v_v.tipo_comprobante;
  END IF;

  v_numero := public.next_comprobante_numero(v_v.sucursal_id, 'NOTA_CREDITO');

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, numero_comprobante, tipo_comprobante,
    condicion_venta, subtotal_sin_iva, iva_total, percepciones, total, total_pagado,
    estado_pago, observaciones, afip_cbte_asoc_id
  ) VALUES (
    v_v.sucursal_id, v_v.cliente_id, v_uid, v_numero, 'NOTA_CREDITO',
    'CONTADO', -v_v.subtotal_sin_iva, -v_v.iva_total, -v_v.percepciones,
    -v_v.total, -v_v.total_pagado,
    -- Si la venta original estaba cobrada, la NC representa una devolución ya
    -- efectuada (plata que salió de la caja) → PAGADO. Si era a cuenta (no se
    -- cobró), la NC sólo baja la deuda → PENDIENTE.
    CASE WHEN v_v.total_pagado <> 0 THEN 'PAGADO'::public.estado_pago ELSE 'PENDIENTE'::public.estado_pago END,
    'Nota de crédito por anulación de ' || v_v.numero_comprobante,
    v_v.id
  ) RETURNING id INTO v_nc_id;

  -- La plata que se le devuelve al cliente SALE de la caja. Copiamos los pagos
  -- originales con el signo invertido: el arqueo (caja_esperado) los resta de la
  -- sesión donde ocurre la anulación (la NC se estampa a la caja abierta por el
  -- trigger). Sin esto, anular una venta cobrada en efectivo dejaba la caja
  -- esperando plata que ya no estaba. Una venta a cuenta corriente no tiene
  -- pagos, así que este INSERT no copia nada (la reversión va por el libro).
  INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
  SELECT v_nc_id, forma_pago, -monto, detalle
    FROM public.venta_pagos WHERE venta_id = v_v.id;

  INSERT INTO public.venta_items (
    venta_id, producto_id, codigo, descripcion, cantidad,
    precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
    subtotal_sin_iva, iva_monto, subtotal_con_iva
  )
  SELECT
    v_nc_id, producto_id, codigo, descripcion, cantidad,
    precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
    -subtotal_sin_iva, -iva_monto, -subtotal_con_iva
  FROM public.venta_items WHERE venta_id = v_v.id;

  UPDATE public.ventas
     SET estado = 'ANULADA', venta_anulada_por = v_nc_id
   WHERE id = v_v.id;

  -- Anula el movimiento de cuenta corriente que había generado la venta original.
  UPDATE public.cuenta_corriente_movimientos
     SET estado = 'ANULADO'
   WHERE venta_id = v_v.id AND estado = 'CONFIRMADO';

  FOR r IN SELECT producto_id, cantidad FROM public.venta_items WHERE venta_id = v_v.id
  LOOP
    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
    VALUES (r.producto_id, v_v.sucursal_id, r.cantidad)
    ON CONFLICT (producto_id, sucursal_id)
    DO UPDATE SET cantidad = stock_sucursal.cantidad + r.cantidad
    RETURNING cantidad - r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      r.producto_id, v_v.sucursal_id, 'ANULACION_VENTA', r.cantidad, v_stock_ant, v_stock_nue,
      'Anulación ' || v_v.numero_comprobante, v_v.id, v_uid
    );
  END LOOP;

  RETURN QUERY SELECT v_nc_id, v_numero;
END; $function$

;
REVOKE ALL ON FUNCTION public.anular_venta(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════════
-- 20260714240000_correcciones_revision_codex_2.sql
-- ══════════════════════════════════════════════════════════════════════════
-- ============================================================
-- Segunda pasada de revisión (Codex): dos ajustes finales.
--
-- #A anular_venta: la NC de una venta PARCIAL quedaba PAGADO. Ahora replica la
--    lógica de crear_venta: PAGADO si la devolución cubre el total, PARCIAL si
--    cubre algo, PENDIENTE si no se había cobrado nada.
--
-- #B GRANT EXECUTE a service_role en las RPC de venta y caja. El patrón
--    "REVOKE ALL FROM public; GRANT TO authenticated" dejaba a service_role sin
--    EXECUTE. Las RPC son SECURITY DEFINER, pero si un proceso backend las llama
--    con la service_role key, necesita el permiso. Se agrega por robustez.
-- ============================================================

-- #A: anular_venta con estado de NC correcto --
CREATE OR REPLACE FUNCTION public.anular_venta(p_venta_id uuid)
 RETURNS TABLE(nc_id uuid, nc_numero text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_v         public.ventas%ROWTYPE;
  v_numero    text;
  v_nc_id     uuid;
  r           RECORD;
  v_stock_ant numeric(14,2);
  v_stock_nue numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_v FROM public.ventas WHERE id = p_venta_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  IF NOT public.is_admin(v_uid) AND v_v.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés anular una venta de otra sucursal';
  END IF;

  IF v_v.estado = 'ANULADA' THEN
    RAISE EXCEPTION 'La venta ya fue anulada';
  END IF;

  IF v_v.tipo_comprobante NOT IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C',
                                  'REMITO', 'REMITO_OBRA', 'FAC_INTERNA_CTA_CTE') THEN
    RAISE EXCEPTION 'Una % no se anula (las notas se corrigen con otra nota)', v_v.tipo_comprobante;
  END IF;

  v_numero := public.next_comprobante_numero(v_v.sucursal_id, 'NOTA_CREDITO');

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, numero_comprobante, tipo_comprobante,
    condicion_venta, subtotal_sin_iva, iva_total, percepciones, total, total_pagado,
    estado_pago, observaciones, afip_cbte_asoc_id
  ) VALUES (
    v_v.sucursal_id, v_v.cliente_id, v_uid, v_numero, 'NOTA_CREDITO',
    'CONTADO', -v_v.subtotal_sin_iva, -v_v.iva_total, -v_v.percepciones,
    -v_v.total, -v_v.total_pagado,
    -- El estado de la NC replica cuánto se devolvió respecto de su total (misma
    -- lógica que crear_venta): si la venta original estaba totalmente cobrada, la
    -- devolución es total → PAGADO; si estaba PARCIAL, la NC queda PARCIAL; si era
    -- a cuenta (no se cobró), la NC sólo baja la deuda → PENDIENTE.
    CASE
      WHEN ABS(v_v.total_pagado) >= ABS(v_v.total) - 0.01 THEN 'PAGADO'::public.estado_pago
      WHEN ABS(v_v.total_pagado) > 0 THEN 'PARCIAL'::public.estado_pago
      ELSE 'PENDIENTE'::public.estado_pago
    END,
    'Nota de crédito por anulación de ' || v_v.numero_comprobante,
    v_v.id
  ) RETURNING id INTO v_nc_id;

  -- La plata que se le devuelve al cliente SALE de la caja. Copiamos los pagos
  -- originales con el signo invertido: el arqueo (caja_esperado) los resta de la
  -- sesión donde ocurre la anulación (la NC se estampa a la caja abierta por el
  -- trigger). Sin esto, anular una venta cobrada en efectivo dejaba la caja
  -- esperando plata que ya no estaba. Una venta a cuenta corriente no tiene
  -- pagos, así que este INSERT no copia nada (la reversión va por el libro).
  INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
  SELECT v_nc_id, forma_pago, -monto, detalle
    FROM public.venta_pagos WHERE venta_id = v_v.id;

  INSERT INTO public.venta_items (
    venta_id, producto_id, codigo, descripcion, cantidad,
    precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
    subtotal_sin_iva, iva_monto, subtotal_con_iva
  )
  SELECT
    v_nc_id, producto_id, codigo, descripcion, cantidad,
    precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
    -subtotal_sin_iva, -iva_monto, -subtotal_con_iva
  FROM public.venta_items WHERE venta_id = v_v.id;

  UPDATE public.ventas
     SET estado = 'ANULADA', venta_anulada_por = v_nc_id
   WHERE id = v_v.id;

  -- Anula el movimiento de cuenta corriente que había generado la venta original.
  UPDATE public.cuenta_corriente_movimientos
     SET estado = 'ANULADO'
   WHERE venta_id = v_v.id AND estado = 'CONFIRMADO';

  FOR r IN SELECT producto_id, cantidad FROM public.venta_items WHERE venta_id = v_v.id
  LOOP
    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
    VALUES (r.producto_id, v_v.sucursal_id, r.cantidad)
    ON CONFLICT (producto_id, sucursal_id)
    DO UPDATE SET cantidad = stock_sucursal.cantidad + r.cantidad
    RETURNING cantidad - r.cantidad, cantidad INTO v_stock_ant, v_stock_nue;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      r.producto_id, v_v.sucursal_id, 'ANULACION_VENTA', r.cantidad, v_stock_ant, v_stock_nue,
      'Anulación ' || v_v.numero_comprobante, v_v.id, v_uid
    );
  END LOOP;

  RETURN QUERY SELECT v_nc_id, v_numero;
END; $function$

;
REVOKE ALL ON FUNCTION public.anular_venta(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.anular_venta(uuid) TO service_role;

-- #B: service_role puede ejecutar las RPC de venta y caja.
GRANT EXECUTE ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.abrir_caja(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.cerrar_caja(uuid, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.registrar_movimiento_caja(uuid, public.caja_mov_tipo, public.forma_pago, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.caja_esperado(uuid) TO service_role;

