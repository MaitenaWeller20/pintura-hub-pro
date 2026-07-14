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
