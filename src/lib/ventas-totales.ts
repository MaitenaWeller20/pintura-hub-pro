// R3 — Totales de un comprobante en la UI de ventas.
//
// El invariante es el mismo que exige AFIP y que aplica la RPC crear_venta:
// se redondea a 2 decimales UNA VEZ POR ÍTEM (base y su IVA) y de ahí todo es
// suma de exactos. Reutilizamos calcularTotales() de fiscal/iva.ts —la MISMA
// fórmula validada contra AFIP— para que el total que ve el cajero coincida al
// centavo con el que calcula el servidor. Antes el front sumaba el IVA sin
// redondear por línea y quedaba 1 centavo por encima, lo que hacía que un pago
// electrónico por "el total" fuera rechazado por la RPC.
import { calcularTotales, round2, type ItemFiscal } from "./fiscal/iva";

// Item tal como lo maneja el formulario de ventas: el precio puede venir null
// ("usá el de lista", NO es 0), y siempre hay un precio_lista de catálogo.
export interface ItemTotales {
  precio_unitario_sin_iva: number | null;
  precio_lista: number;
  cantidad: number;
  descuento_porcentaje?: number | null;
  iva_porcentaje: number;
}

export interface TotalesComprobante {
  sub: number;
  iva: number;
  total: number;
}

/**
 * Subtotal / IVA / total de un comprobante, con el signo ya aplicado.
 * @param signo 1 para facturas/notas de débito, -1 para nota de crédito (devuelve).
 */
export function calcTotalesComprobante(
  items: ItemTotales[],
  percepciones: number | null | undefined,
  signo: number,
): TotalesComprobante {
  const fiscales: ItemFiscal[] = items.map((it) => ({
    // null = usá el precio de lista. Vacío en el input NO es 0.
    precio_unitario_sin_iva: it.precio_unitario_sin_iva ?? it.precio_lista ?? 0,
    cantidad: it.cantidad || 0,
    descuento_porcentaje: it.descuento_porcentaje ?? 0,
    iva_porcentaje: it.iva_porcentaje || 0,
  }));

  const t = calcularTotales(fiscales, Number(percepciones || 0));

  return {
    sub: round2(t.neto * signo),
    iva: round2(t.iva * signo),
    total: round2(t.total * signo),
  };
}
