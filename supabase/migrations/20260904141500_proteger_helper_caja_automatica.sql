-- caja_sesion_actual es un helper interno: no valida que la sucursal pedida sea
-- la del operador. Las RPC comerciales SECURITY DEFINER lo ejecutan como su
-- owner, por lo que el cliente no necesita (ni debe tener) acceso directo.
REVOKE ALL ON FUNCTION public.caja_sesion_actual(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.caja_sesion_actual(uuid)
TO service_role;

COMMENT ON FUNCTION public.caja_sesion_actual(uuid) IS
  'Helper interno get-or-create de caja; no invocable directamente por clientes.';
