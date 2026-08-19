import { conIva } from "@/lib/fiscal/iva";
import { fmtMoney } from "@/lib/format";

export interface ItemPresupuestoPdf {
  codigo: string;
  descripcion: string;
  cantidad: number | string;
  precio_lista_sin_iva: number | string;
  descuento_porcentaje: number | string;
  precio_sin_iva: number | string;
  iva_porcentaje: number | string;
  subtotal_con_iva: number | string;
}

export function tablaDeItemsPresupuesto(items: ItemPresupuestoPdf[]) {
  return {
    head: [["Código", "Producto", "Cant.", "Precio de lista", "Desc.", "Precio final", "Subtotal"]],
    body: items.map((item) => [
      item.codigo,
      item.descripcion,
      String(Number(item.cantidad)),
      fmtMoney(conIva(item.precio_lista_sin_iva, item.iva_porcentaje)),
      Number(item.descuento_porcentaje) > 0 ? `${Number(item.descuento_porcentaje)}%` : "—",
      fmtMoney(conIva(item.precio_sin_iva, item.iva_porcentaje)),
      fmtMoney(item.subtotal_con_iva),
    ]),
  };
}
