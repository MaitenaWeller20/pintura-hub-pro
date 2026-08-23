import { puedeAbrirRuta, type UsuarioPermisos } from "./secciones";

export function destinoColaFiscalVentaConvertida(
  ventaId: string,
  acceso: UsuarioPermisos,
): string | null {
  if (!puedeAbrirRuta("/facturacion/cola", acceso)) return null;
  return `/facturacion/cola?venta=${encodeURIComponent(ventaId)}`;
}

export type AccionFiscalDespuesDeConvertirPresupuesto =
  | "PERMANECER"
  | "FACTURAR_AHORA"
  | "ABRIR_COLA";

/**
 * Decide el paso fiscal posterior a la conversión con la misma guarda que
 * protege el enlace y la ruta de la cola. Si el usuario no puede abrirla, el
 * presupuesto convertido queda visible y no se lo manda a una ruta que lo va
 * a expulsar al inicio.
 */
export function accionFiscalDespuesDeConvertirPresupuesto(
  resultado: { ventaId: string; facturarAhora: boolean },
  acceso: UsuarioPermisos,
): AccionFiscalDespuesDeConvertirPresupuesto {
  if (destinoColaFiscalVentaConvertida(resultado.ventaId, acceso) === null) {
    return "PERMANECER";
  }
  return resultado.facturarAhora ? "FACTURAR_AHORA" : "ABRIR_COLA";
}
