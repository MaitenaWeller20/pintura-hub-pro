-- La capacidad fiscal específica no se infiere de booleanos huérfanos: para
-- empleados requiere además el rol durable `empleado`. Los administradores
-- conservan la semántica efectiva existente mediante `is_admin`.
CREATE OR REPLACE FUNCTION public.puede_emitir_nc_periodo(
  _uid uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path=''
AS $$
  SELECT COALESCE(public.is_admin(_uid),false)
      OR EXISTS (
        SELECT 1
          FROM public.profiles AS p
         WHERE p.id=_uid
           AND p.activo
           AND p.puede_facturar
           AND p.puede_emitir_nc_periodo
           AND EXISTS (
             SELECT 1
               FROM public.user_roles AS ur
              WHERE ur.user_id=p.id
                AND ur.role='empleado'::public.app_role
           )
      );
$$;

ALTER FUNCTION public.puede_emitir_nc_periodo(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.puede_emitir_nc_periodo(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.puede_emitir_nc_periodo(uuid)
  TO authenticated,service_role;

-- Sólo la habilitación exige el rol: deshabilitar sigue permitido para que un
-- admin pueda limpiar un booleano stale después de remover el rol empleado.
CREATE OR REPLACE FUNCTION public.administrar_puede_emitir_nc_periodo(
  p_profile_id uuid,
  p_habilitado boolean
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
    RAISE EXCEPTION 'Sólo un administrador activo puede cambiar esta capacidad'
      USING ERRCODE='42501';
  END IF;

  PERFORM 1
    FROM public.profiles AS p
   WHERE p.id=p_profile_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil inexistente'
      USING ERRCODE='PNC02';
  END IF;

  IF p_habilitado IS TRUE THEN
    PERFORM 1
      FROM public.user_roles AS ur
     WHERE ur.user_id=p_profile_id
       AND ur.role='empleado'::public.app_role
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'El permiso de NC por período sólo se puede asignar a empleados'
        USING ERRCODE='PNC01';
    END IF;
  END IF;

  UPDATE public.profiles
     SET puede_emitir_nc_periodo=p_habilitado
   WHERE id=p_profile_id;
END;
$$;

ALTER FUNCTION public.administrar_puede_emitir_nc_periodo(uuid,boolean)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.administrar_puede_emitir_nc_periodo(uuid,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.administrar_puede_emitir_nc_periodo(uuid,boolean)
  TO authenticated,service_role;
