-- ============================================================
-- PERMISOS POR SECCIÓN — qué pantallas ve cada usuario.
--
-- El pedido: "permitime crear usuarios y asignarles a estos usuarios qué cosas
-- o secciones querés que vean, porque hay ciertos permisos según el rol".
--
-- Hasta hoy había exactamente DOS menús posibles en todo el sistema (admin y
-- empleado), decididos por un booleano hardcodeado en el front. Para que un
-- empleado viera Ventas pero no Compras había que tocar el código y desplegar.
--
-- ESTO ES VISIBILIDAD, NO UNA FRONTERA DE SEGURIDAD. Lo que protege los datos
-- sigue siendo RLS y los is_admin() adentro de las RPC; acá no se toca ninguna
-- policy. Esconder una pantalla del menú no impide que alguien con la sesión
-- abierta consulte PostgREST a mano. La pantalla de permisos lo dice con todas
-- las letras, para que nadie crea que oculta la plata.
--
-- Ver docs/superpowers/specs/2026-08-03-permisos-por-seccion-design.md
-- ============================================================

-- ------------------------------------------------------------
-- 1. La columna
--
-- Se copia el molde de permite_venta_sin_stock (20260721140000): columna en
-- profiles + guard de columnas + server function con is_admin. No se inventa un
-- mecanismo nuevo para un permiso más.
--
-- SEMÁNTICA DEL NULL, que es la decisión de fondo:
--
--   NULL          -> "las de siempre" (el menú de empleado de hoy)
--   '{}'          -> ninguna sección
--   '{ventas,…}'  -> exactamente ésas
--
-- Se deja NULL como default en vez de rellenar cada perfil con la lista
-- completa: así, cuando mañana se agregue una sección nueva, los usuarios
-- existentes la ven sin que nadie tenga que reabrir 8 perfiles. Rellenar la
-- columna acá congelaría a cada usuario en el menú de hoy — es la clase de
-- decisión que se paga seis meses después.
-- ------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS secciones text[];

COMMENT ON COLUMN public.profiles.secciones IS
  'Qué secciones del menú ve el usuario. NULL = las de siempre (SECCIONES_DEFAULT '
  'en src/lib/secciones.ts). Array vacío = ninguna. Es VISIBILIDAD, no seguridad: '
  'los permisos de fondo los siguen mandando is_admin() y RLS. Sólo un admin la '
  'puede cambiar (ver guard_profiles_columnas).';

-- ------------------------------------------------------------
-- 2. Sanidad del contenido
--
-- No se valida contra el catálogo de secciones a propósito: eso obligaría a una
-- migración cada vez que se agrega una pantalla, y el front ya filtra contra el
-- catálogo al leer (una key desconocida se ignora). Lo que sí se corta acá es la
-- basura: strings raros, arrays gigantes, NULLs sueltos adentro del array.
--
-- Va con `array_to_string(...) ~ regex` y no con `NOT EXISTS (SELECT … unnest)`
-- porque un CHECK no admite subconsultas ("cannot use subquery in check
-- constraint"). Pegar los elementos con coma y validar la cadena entera contra
-- `^clave(,clave)*$` chequea el juego de caracteres de todos de una sola vez.
--
-- OJO con el delimitador: pegar con coma pierde la frontera entre elementos, así
-- que ARRAY['ventas','stock'] y ARRAY['ventas,stock'] dan la MISMA cadena y el
-- regex solo no los distingue — o sea que un elemento con una coma adentro se
-- colaba. Por eso la tercera condición: si al volver a cortar por coma salen más
-- pedazos que elementos tenía el array, es que alguno traía una coma.
-- ------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_secciones_sanas CHECK (
      secciones IS NULL OR (
        coalesce(array_length(secciones, 1), 0) <= 50
        AND array_position(secciones, NULL) IS NULL
        AND (
          coalesce(array_length(secciones, 1), 0) = 0
          OR (
            array_to_string(secciones, ',') ~ '^[a-z_]{2,40}(,[a-z_]{2,40})*$'
            AND array_length(string_to_array(array_to_string(secciones, ','), ','), 1)
                = array_length(secciones, 1)
          )
        )
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 3. Que un empleado no se auto-otorgue secciones
--
-- profiles tiene GRANT UPDATE a authenticated y la policy "user update own
-- profile (id = auth.uid())". Sin esto, cualquier empleado se daría todas las
-- pantallas con un PATCH de una línea. RLS no filtra por columna, así que va por
-- trigger — igual que sucursal_id, activo, username y permite_venta_sin_stock.
--
-- Se reescribe la función ENTERA mirando la versión vigente (20260721140000),
-- no una vieja: reescribir con CREATE OR REPLACE sobre una copia desactualizada
-- es lo que ya borró validaciones dos veces en este repo.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profiles_columnas()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $g$
BEGIN
  -- La service_role key (auth.uid() IS NULL) es el canal administrativo del
  -- backend: no se bloquea. Un admin autenticado tampoco.
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
  IF NEW.permite_venta_sin_stock IS DISTINCT FROM OLD.permite_venta_sin_stock THEN
    RAISE EXCEPTION 'Sólo un administrador puede cambiar el permiso de venta sin stock';
  END IF;
  IF NEW.secciones IS DISTINCT FROM OLD.secciones THEN
    RAISE EXCEPTION 'Sólo un administrador puede cambiar las secciones de un usuario';
  END IF;

  RETURN NEW;
END; $g$;

-- El trigger ya existe desde 20260714200000; se re-crea por idempotencia.
DROP TRIGGER IF EXISTS trg_profiles_guard_columnas ON public.profiles;
CREATE TRIGGER trg_profiles_guard_columnas
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profiles_columnas();
