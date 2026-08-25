-- Los administradores deciden desde Usuarios > Permisos qué empleados pueden
-- crear o modificar cuentas corrientes y límites de crédito. La capacidad no
-- cambia el rol ni habilita otras acciones administrativas.

ALTER TABLE public.profiles
  ADD COLUMN puede_gestionar_credito_clientes boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.puede_gestionar_credito_clientes IS
  'Permite a un perfil activo no admin configurar cuenta corriente y límite de crédito de clientes.';

-- Renzo necesita esta capacidad desde el despliegue inicial. A partir de acá,
-- cualquier cambio posterior se administra desde Usuarios > Permisos.
UPDATE public.profiles
   SET puede_gestionar_credito_clientes=true
 WHERE id='82b5fd2e-0dfd-447b-a26f-42ad4c4a218b'::uuid;

CREATE OR REPLACE FUNCTION public.puede_gestionar_credito_clientes(
  _uid uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=''
AS $$
  SELECT public.is_admin(_uid)
      OR EXISTS (
        SELECT 1
          FROM public.profiles AS p
         WHERE p.id=_uid
           AND p.activo
           AND p.puede_gestionar_credito_clientes
      )
$$;

REVOKE ALL ON FUNCTION public.puede_gestionar_credito_clientes(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.puede_gestionar_credito_clientes(uuid)
  TO authenticated,service_role;

-- Barrera de columna. El permiso sólo puede cambiarlo un admin autenticado;
-- service_role sin JWT no se usa como atajo de elevación.
CREATE OR REPLACE FUNCTION public.guard_profiles_columnas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
BEGIN
  IF NEW.puede_facturar IS DISTINCT FROM OLD.puede_facturar
     AND (auth.uid() IS NULL OR NOT public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'No puede modificar el permiso fiscal de su propio perfil';
  END IF;

  IF NEW.puede_gestionar_credito_clientes
       IS DISTINCT FROM OLD.puede_gestionar_credito_clientes
     AND (auth.uid() IS NULL OR NOT public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'Sólo un administrador autenticado puede cambiar el permiso de cuenta corriente';
  END IF;

  IF auth.uid() IS NULL OR public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF NEW.sucursal_id IS DISTINCT FROM OLD.sucursal_id THEN
    IF NEW.sucursal_id IS NULL THEN
      RAISE EXCEPTION 'No te podés quedar sin sucursal: elegí en cuál estás trabajando';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.profile_sucursales AS ps
       WHERE ps.profile_id=NEW.id
         AND ps.sucursal_id=NEW.sucursal_id
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
END;
$$;

REVOKE ALL ON FUNCTION public.guard_profiles_columnas()
  FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.administrar_puede_gestionar_credito_clientes(
  p_profile_id uuid,
  p_puede boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador autenticado puede cambiar el permiso de cuenta corriente'
      USING ERRCODE='42501';
  END IF;

  UPDATE public.profiles
     SET puede_gestionar_credito_clientes=p_puede
   WHERE id=p_profile_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil inexistente';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.administrar_puede_gestionar_credito_clientes(uuid,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.administrar_puede_gestionar_credito_clientes(uuid,boolean)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_clientes_credito()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_puede_credito boolean;
BEGIN
  -- Backend interno y administradores mantienen su comportamiento histórico.
  IF v_uid IS NULL OR public.is_admin(v_uid) THEN
    RETURN NEW;
  END IF;

  v_puede_credito := public.puede_gestionar_credito_clientes(v_uid);

  IF TG_OP='INSERT' THEN
    IF (
      COALESCE(NEW.condicion_cta_cte,false)
      OR NEW.limite_credito IS NOT NULL
    ) AND NOT v_puede_credito THEN
      RAISE EXCEPTION 'Necesitás el permiso para gestionar cuenta corriente de clientes';
    END IF;
  ELSIF TG_OP='UPDATE' THEN
    -- El cliente genérico sigue siendo exclusivamente administrativo: esta
    -- capacidad sólo cubre cuenta corriente y límite.
    IF NEW.es_generico IS DISTINCT FROM OLD.es_generico THEN
      RAISE EXCEPTION 'Sólo un administrador puede cambiar el flag de cliente genérico';
    END IF;
    IF (
      NEW.condicion_cta_cte IS DISTINCT FROM OLD.condicion_cta_cte
      OR NEW.limite_credito IS DISTINCT FROM OLD.limite_credito
    ) AND NOT v_puede_credito THEN
      RAISE EXCEPTION 'Necesitás el permiso para gestionar cuenta corriente de clientes';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_clientes_credito()
  FROM PUBLIC,anon,authenticated;

COMMENT ON FUNCTION public.puede_gestionar_credito_clientes(uuid) IS
  'Capacidad efectiva: admin o perfil activo con permiso explícito para cuenta corriente de clientes.';
COMMENT ON FUNCTION public.administrar_puede_gestionar_credito_clientes(uuid,boolean) IS
  'Otorga o revoca la capacidad de cuenta corriente; exige un admin activo en el JWT.';
