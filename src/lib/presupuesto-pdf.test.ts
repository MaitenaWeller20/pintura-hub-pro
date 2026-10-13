import { describe, expect, it } from "vitest";
import { tablaDeItemsPresupuesto } from "./presupuesto-pdf";

describe("tabla de productos del PDF de presupuesto", () => {
  it("muestra por separado el precio de lista y el precio final con descuento", () => {
    const tabla = tablaDeItemsPresupuesto([
      {
        codigo: "113.01.037",
        descripcion: "Base 10 L (Código 1234)",
        cantidad: 2,
        precio_lista_sin_iva: 200,
        descuento_porcentaje: 30,
        precio_sin_iva: 140,
        iva_porcentaje: 21,
        subtotal_con_iva: 338.8,
      },
    ]);

    expect(tabla.head).toEqual([
      ["Código", "Producto", "Cant.", "Precio de lista", "Desc.", "Precio final", "Subtotal"],
    ]);
    expect(tabla.body).toEqual([
      ["113.01.037", "Base 10 L (Código 1234)", "2", "$ 242,00", "30%", "$ 169,40", "$ 338,80"],
    ]);
  });

  it("indica con un guion cuando el producto no tiene descuento", () => {
    const tabla = tablaDeItemsPresupuesto([
      {
        codigo: "P-1",
        descripcion: "Producto sin descuento",
        cantidad: 1,
        precio_lista_sin_iva: 100,
        descuento_porcentaje: 0,
        precio_sin_iva: 100,
        iva_porcentaje: 21,
        subtotal_con_iva: 121,
      },
    ]);

    expect(tabla.body[0]?.[4]).toBe("—");
  });
});
