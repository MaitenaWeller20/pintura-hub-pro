-- Un access token de GoTrue puede seguir siendo criptograficamente valido
-- despues de desactivar al usuario o borrar su perfil. Las policies historicas
-- de tablas maestras como clientes/proveedores aceptan al rol authenticated sin
-- consultar el perfil, por lo que corregir helpers puntuales no alcanza.
--
-- PostgREST ejecuta este pre-request despues de validar el JWT e impersonar su
-- rol, pero antes de resolver cualquier tabla, vista o RPC. Asi existe una sola
-- barrera para toda la Data API. GoTrue/Auth no pasa por PostgREST; anon y
-- service_role se excluyen expresamente para conservar sus contratos actuales.

CREATE OR REPLACE FUNCTION public.validar_perfil_activo_postgrest()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_rol text := NULLIF(pg_catalog.current_setting('role',true),'');
  v_uid uuid := auth.uid();
BEGIN
  IF v_rol IS DISTINCT FROM 'authenticated' THEN
    RETURN;
  END IF;

  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.profiles AS p
     WHERE p.id=v_uid
       AND p.activo
  ) THEN
    RAISE insufficient_privilege
      USING MESSAGE='El perfil autenticado no existe o está inactivo';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.validar_perfil_activo_postgrest()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.validar_perfil_activo_postgrest()
  TO authenticator,anon,authenticated,service_role;

COMMENT ON FUNCTION public.validar_perfil_activo_postgrest() IS
  'Pre-request de la Data API: todo JWT authenticated exige un perfil existente y activo; anon y service_role conservan su acceso actual.';

ALTER ROLE authenticator
  SET pgrst.db_pre_request='public.validar_perfil_activo_postgrest';

NOTIFY pgrst,'reload config';
