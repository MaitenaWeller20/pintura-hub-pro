-- El listado de Ventas consulta public.ventas como usuario autenticado.
-- Restablece el permiso de lectura previsto en la migración inicial; las
-- políticas RLS de ventas siguen limitando las filas por sucursal.
GRANT SELECT ON TABLE public.ventas TO authenticated;
