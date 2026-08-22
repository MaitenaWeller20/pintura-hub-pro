-- La policy RLS de lectura general sigue vigente para la identidad fiscal que
-- necesitan los impresos. La evidencia administrativa de Factura A, en cambio,
-- sólo debe salir por server functions que ya comprobaron el rol admin.
REVOKE SELECT ON TABLE public.emisores FROM authenticated;

GRANT SELECT (
  id,
  razon_social,
  cuit,
  domicilio_fiscal,
  condicion_iva,
  ingresos_brutos,
  inicio_actividades,
  logo,
  activo,
  created_at,
  updated_at,
  nombre_fantasia
) ON TABLE public.emisores TO authenticated;

-- Se explicita la continuidad del canal privilegiado sin tocar ni deshabilitar
-- RLS. service_role conserva el acceso completo que usa el backend admin.
GRANT SELECT ON TABLE public.emisores TO service_role;
