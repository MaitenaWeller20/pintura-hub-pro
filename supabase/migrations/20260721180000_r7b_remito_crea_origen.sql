-- ============================================================
-- R7b (hallazgo de review Codex) — quien CREA un remito debe ser el ORIGEN.
--
-- La policy de INSERT de remitos sólo exigía creado_por = auth.uid(), sin validar
-- la sucursal de origen. Con R7 (el DESTINO aprueba), esto habilita una separación
-- de poderes rota: un empleado de la sucursal B podía crear un remito
-- origen=A → destino=B y, como destino, aprobarlo él mismo, sacando stock de A sin
-- que A intervenga.
--
-- Regla correcta: el remito lo crea el ORIGEN (quien saca la mercadería) o un
-- admin; el DESTINO lo aprueba. Reforzamos la policy de INSERT para exigir que el
-- creador pertenezca a sucursal_origen_id (o sea admin). Así crear+aprobar exige
-- dos sucursales distintas o el admin.
-- ============================================================

DROP POLICY IF EXISTS "remitos insert" ON public.remitos;

CREATE POLICY "remitos insert" ON public.remitos
  FOR INSERT TO authenticated
  WITH CHECK (
    creado_por = auth.uid()
    AND (
      public.is_admin(auth.uid())
      -- IS NOT DISTINCT FROM es NULL-safe: un empleado sin sucursal (NULL) no puede
      -- crear remitos de ninguna sucursal (queda sólo para admin).
      OR sucursal_origen_id IS NOT DISTINCT FROM public.current_sucursal_id()
    )
  );
