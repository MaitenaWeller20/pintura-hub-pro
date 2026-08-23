import { puedeAbrirRuta, type UsuarioPermisos } from "./secciones";

export function destinoColaFiscalVentaConvertida(
  ventaId: string,
  acceso: UsuarioPermisos,
): string | null {
  if (!puedeAbrirRuta("/facturacion/cola", acceso)) return null;
  return `/facturacion/cola?venta=${encodeURIComponent(ventaId)}`;
}
