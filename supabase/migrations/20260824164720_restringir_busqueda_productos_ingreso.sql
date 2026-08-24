-- En proyectos hospedados, Supabase concede EXECUTE sobre funciones nuevas a
-- anon mediante ALTER DEFAULT PRIVILEGES. La migración anterior revocó PUBLIC,
-- pero ese grant explícito sobrevivió. El buscador de ingresos requiere sesión.
REVOKE ALL ON FUNCTION public.buscar_productos_similares(text, text, integer, uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.buscar_productos_similares(text, text, integer, uuid)
  TO authenticated, service_role;
