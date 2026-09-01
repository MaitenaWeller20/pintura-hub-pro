import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VentaItemsDetalle } from "./venta-items-detalle";

const itemConDescuento = {
  codigo: "116.01.095",
  descripcion: "SIKA MONOTOP 107 X8KG",
  cantidad: 2,
  precio_unitario_sin_iva: 1000,
  descuento_porcentaje: 30,
  iva_porcentaje: 21,
  subtotal_con_iva: 1694,
};

const renderDetalle = (tipoComprobante: string) =>
  renderToStaticMarkup(
    createElement(VentaItemsDetalle, {
      tipoComprobante,
      items: [itemConDescuento],
    }),
  );

describe("detalle de ítems de una venta", () => {
  it.each(["REMITO", "REMITO_OBRA", "FACTURA_B"])(
    "muestra precio de lista y precio final sin desglosar IVA en %s",
    (tipoComprobante) => {
      const html = renderDetalle(tipoComprobante);

      expect(html).toContain("Precio de lista");
      expect(html).toContain("Desc.");
      expect(html).toContain("Precio final");
      expect(html).toContain("Subtotal");
      expect(html).not.toContain("IVA");
      expect(html).toContain("30,00%");
      expect(html).toContain("1.210,00");
      expect(html).toContain("847,00");
      expect(html).toContain("1.694,00");
      expect(html.indexOf("Precio de lista")).toBeLessThan(html.indexOf("Desc."));
      expect(html.indexOf("Desc.")).toBeLessThan(html.indexOf("Precio final"));
      expect(html.indexOf("Precio final")).toBeLessThan(html.indexOf("Subtotal"));
    },
  );

  it("redondea el descuento antes del impuesto para cerrar con el importe de la línea", () => {
    const html = renderToStaticMarkup(
      createElement(VentaItemsDetalle, {
        tipoComprobante: "REMITO",
        items: [
          {
            codigo: "113.01.123",
            descripcion: "CASASECA MEMBRANA POLIURETANICA X20 KG",
            cantidad: 1,
            precio_unitario_sin_iva: 165989.88,
            descuento_porcentaje: 30,
            iva_porcentaje: 21,
            subtotal_con_iva: 140593.43,
          },
        ],
      }),
    );

    expect(html).toContain("200.847,75");
    expect(html).toContain("140.593,43");
    expect(html).not.toContain("140.593,42");
  });
});
