import { round2 } from "./fiscal/iva";

/** Espejo de ROUND por ítem en crear_presupuesto y editar_presupuesto. */
export function calcularLineaPresupuesto(
  precioBase: number,
  descuento: number,
  cantidad: number,
  ivaPorcentaje: number,
) {
  const precioNeto = round2(precioBase * (1 - descuento / 100));
  const subtotalSinIva = round2(precioNeto * cantidad);
  const iva = round2((subtotalSinIva * ivaPorcentaje) / 100);
  return { precioNeto, subtotalSinIva, iva, total: round2(subtotalSinIva + iva) };
}
