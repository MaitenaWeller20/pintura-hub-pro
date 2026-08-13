-- ============================================================
-- Un empleado que trabaja en más de una sucursal.
--
-- Mauro atiende en O'Higgins y en General Paz, y hasta ahora cada empleado
-- estaba atado a una sola: `profiles.sucursal_id` era LA sucursal, y
-- `current_sucursal_id()` la devolvía.
--
-- Cambia el SIGNIFICADO de esa columna, no la columna: pasa a ser "en cuál está
-- trabajando ahora". En cuáles PUEDE trabajar se guarda en `profile_sucursales`.
--
-- Por qué así y no cambiando las policies: 28 policies de RLS en 17 tablas y
-- varias RPC comparan contra `current_sucursal_id()`. Reescribirlas para que
-- acepten una lista es muchísima superficie de seguridad, y además haría que los
-- listados mezclen las dos sucursales salvo que cada pantalla filtre a mano.
-- Como `current_sucursal_id()` no cambia, todo eso sigue funcionando igual.
--
-- Ver docs/superpowers/specs/2026-08-13-multi-sucursal-design.md
-- ============================================================

-- ------------------------------------------------------------
-- 1. En qué sucursales puede trabajar cada uno
-- ------------------------------------------------------------
-- Tabla y no un `uuid[]` en profiles: el array no tiene integridad referencial
-- (borrar una sucursal deja ids colgados), no impide duplicados ni NULL adentro,
-- hay que unnest para preguntar quién trabaja en tal lado, y un CHECK no puede
-- consultar `sucursales` para validar que exista.
CREATE TABLE IF NOT EXISTS public.profile_sucursales (
  profile_id  uuid NOT NULL REFERENCES public.profiles(id)   ON DELETE CASCADE,
  sucursal_id uuid NOT NULL REFERENCES public.sucursales(id) ON DELETE RESTRICT,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, sucursal_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_sucursales_sucursal
  ON public.profile_sucursales (sucursal_id);

COMMENT ON TABLE public.profile_sucursales IS
  'En qué sucursales PUEDE trabajar cada usuario. La que está usando ahora es '
  'profiles.sucursal_id (la "activa"), y tiene que estar en esta tabla.';

-- Backfill: cada perfil que hoy tiene sucursal queda habilitado en esa. Así
-- nadie cambia de comportamiento el día que se aplica.
INSERT INTO public.profile_sucursales (profile_id, sucursal_id)
SELECT id, sucursal_id FROM public.profiles WHERE sucursal_id IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE public.profile_sucursales ENABLE ROW LEVEL SECURITY;

-- Todos leen (el menú necesita saber entre cuáles puede elegir); sólo admin
-- escribe. Si un empleado pudiera escribir, se auto-habilitaría todas.
DROP POLICY IF EXISTS "profile_sucursales select" ON public.profile_sucursales;
CREATE POLICY "profile_sucursales select" ON public.profile_sucursales
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "profile_sucursales admin" ON public.profile_sucursales;
CREATE POLICY "profile_sucursales admin" ON public.profile_sucursales
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

GRANT SELECT ON public.profile_sucursales TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.profile_sucursales TO authenticated; -- la policy de arriba lo limita a admin
GRANT ALL ON public.profile_sucursales TO service_role;

-- ------------------------------------------------------------
-- 2. Registro de los cambios de sucursal
-- ------------------------------------------------------------
-- En un sistema con caja y stock, "quién estaba dónde y desde cuándo" es la
-- primera pregunta cuando una venta aparece en el lugar equivocado.
CREATE TABLE IF NOT EXISTS public.sucursal_activa_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  desde_sucursal_id uuid REFERENCES public.sucursales(id),
  hacia_sucursal_id uuid NOT NULL REFERENCES public.sucursales(id),
  cambiado_en       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sucursal_activa_log_perfil
  ON public.sucursal_activa_log (profile_id, cambiado_en DESC);

ALTER TABLE public.sucursal_activa_log ENABLE ROW LEVEL SECURITY;

-- Lo escribe el trigger (SECURITY DEFINER). Nadie lo edita a mano; sólo un admin
-- lo lee. Sin policy de escritura, no hay forma de falsear el historial.
DROP POLICY IF EXISTS "sucursal_activa_log admin lee" ON public.sucursal_activa_log;
CREATE POLICY "sucursal_activa_log admin lee" ON public.sucursal_activa_log
  FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));

GRANT SELECT ON public.sucursal_activa_log TO authenticated;
GRANT ALL ON public.sucursal_activa_log TO service_role;

-- ------------------------------------------------------------
-- 3. No se puede sacar la habilitación que está en uso
-- ------------------------------------------------------------
-- Si no, el perfil queda apuntando a una sucursal donde ya no puede trabajar:
-- current_sucursal_id() devolvería algo que las policies aceptan pero que ya no
-- le corresponde.
--
-- Cubre DELETE **y UPDATE**. Sólo con DELETE quedaba el agujero de mover la fila
-- (`UPDATE profile_sucursales SET sucursal_id = otra` sobre la que está activa,
-- o un UPSERT con DO UPDATE): la habilitación desaparecía igual, por la ventana.
CREATE OR REPLACE FUNCTION public.guard_sacar_sucursal_habilitada()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Un UPDATE que no mueve la fila (por ejemplo tocar `creado_en`) no saca nada.
  IF TG_OP = 'UPDATE'
     AND NEW.profile_id = OLD.profile_id
     AND NEW.sucursal_id = OLD.sucursal_id THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = OLD.profile_id AND sucursal_id = OLD.sucursal_id
  ) THEN
    RAISE EXCEPTION 'No se puede quitar la sucursal en la que la persona está trabajando. Cambiala de sucursal primero.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profile_sucursales_borrar ON public.profile_sucursales;
DROP TRIGGER IF EXISTS trg_profile_sucursales_sacar ON public.profile_sucursales;
CREATE TRIGGER trg_profile_sucursales_sacar
  BEFORE DELETE OR UPDATE ON public.profile_sucursales
  FOR EACH ROW EXECUTE FUNCTION public.guard_sacar_sucursal_habilitada();

-- La versión anterior sólo cubría DELETE; se limpia para no dejarla colgada.
DROP FUNCTION IF EXISTS public.guard_borrar_sucursal_habilitada();

-- ------------------------------------------------------------
-- 4. El guard de profiles: la barrera de verdad
-- ------------------------------------------------------------
-- ACÁ y no en una RPC. `profiles` tiene GRANT UPDATE para el propio usuario, así
-- que cualquiera puede mandar un PATCH directo a la API sin pasar por ninguna
-- función: una regla que viva sólo en la RPC es decoración.
--
-- Se parte de la versión vigente (20260803180000_permisos_por_seccion.sql) y el
-- único cambio es la sucursal: antes se prohibía siempre, ahora se permite
-- cambiar la ACTIVA a una habilitada.
--
-- Con NULL hay que ser explícito: en SQL, `NULL` no es `false`, así que un
-- `IF NOT (x = ANY(...))` con NULL adentro NO entra y dejaría pasar el cambio.
-- Por eso se pregunta con EXISTS y se rechaza el NULL aparte.
CREATE OR REPLACE FUNCTION public.guard_profiles_columnas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- La service_role key (auth.uid() IS NULL) es el canal administrativo del
  -- backend: no se bloquea. Un admin autenticado tampoco.
  IF auth.uid() IS NULL OR public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  -- Cambiar de sucursal ACTIVA sí se permite, pero sólo a una habilitada.
  IF NEW.sucursal_id IS DISTINCT FROM OLD.sucursal_id THEN
    IF NEW.sucursal_id IS NULL THEN
      RAISE EXCEPTION 'No te podés quedar sin sucursal: elegí en cuál estás trabajando';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profile_sucursales
       WHERE profile_id = NEW.id AND sucursal_id = NEW.sucursal_id
    ) THEN
      RAISE EXCEPTION 'No trabajás en esa sucursal. Pedile a un administrador que te habilite.';
    END IF;
  END IF;

  IF NEW.activo IS DISTINCT FROM OLD.activo THEN
    RAISE EXCEPTION 'Sólo un administrador puede activar o desactivar un usuario';
  END IF;
  IF NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'El nombre de usuario no se puede cambiar';
  END IF;
  IF NEW.permite_venta_sin_stock IS DISTINCT FROM OLD.permite_venta_sin_stock THEN
    RAISE EXCEPTION 'Sólo un administrador puede cambiar el permiso de venta sin stock';
  END IF;
  IF NEW.secciones IS DISTINCT FROM OLD.secciones THEN
    RAISE EXCEPTION 'Sólo un administrador puede cambiar las secciones de un usuario';
  END IF;

  RETURN NEW;
END; $$;

-- ------------------------------------------------------------
-- 5. Dejar registrado el cambio
-- ------------------------------------------------------------
-- Trigger aparte y AFTER: el de arriba autoriza, éste anota. Separados para que
-- el registro no dependa de en qué rama termine la autorización.
CREATE OR REPLACE FUNCTION public.log_sucursal_activa()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sucursal_id IS DISTINCT FROM OLD.sucursal_id AND NEW.sucursal_id IS NOT NULL THEN
    INSERT INTO public.sucursal_activa_log (profile_id, desde_sucursal_id, hacia_sucursal_id)
    VALUES (NEW.id, OLD.sucursal_id, NEW.sucursal_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_log_sucursal ON public.profiles;
CREATE TRIGGER trg_profiles_log_sucursal
  AFTER UPDATE OF sucursal_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.log_sucursal_activa();

-- ------------------------------------------------------------
-- 6. Cambiar de sucursal desde la app
-- ------------------------------------------------------------
-- La barrera es el trigger; esto existe para dar un error claro y para que el
-- frontend tenga una sola forma de hacerlo.
CREATE OR REPLACE FUNCTION public.cambiar_sucursal_activa(p_sucursal_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF p_sucursal_id IS NULL THEN
    RAISE EXCEPTION 'Elegí una sucursal';
  END IF;

  -- SECURITY INVOKER a propósito: corre como quien llama, así el guard de
  -- profiles se aplica igual que si hubiera mandado el UPDATE a mano. Si fuera
  -- DEFINER, saltearía la validación que justamente queremos que corra.
  UPDATE public.profiles SET sucursal_id = p_sucursal_id WHERE id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.cambiar_sucursal_activa(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.cambiar_sucursal_activa(uuid) TO authenticated;

COMMENT ON FUNCTION public.cambiar_sucursal_activa(uuid) IS
  'Cambia la sucursal en la que trabaja el usuario logueado. La validación real '
  'la hace el trigger guard_profiles_columnas, que también corre si alguien '
  'manda el UPDATE por fuera de esta función.';
