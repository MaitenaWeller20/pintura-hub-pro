import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GuiaEstadoCorregible } from "./guia-estado-corregible";

describe("guía del estado corregible", () => {
  it("explica el estado y da pasos concretos desde el detalle de la venta", () => {
    const html = renderToStaticMarkup(createElement(GuiaEstadoCorregible, { ventaId: "venta-1" }));

    expect(html).toContain("todavía no tiene una factura autorizada por ARCA");
    expect(html).toContain("A revisar");
    expect(html).toContain("Corregir/reintentar");
    expect(html).toContain("No hagas otra venta ni vuelvas a cobrar");
    expect(html).toContain("Aprobado");
    expect(html).toContain("CAE");
    expect(html).toContain("avisá al encargado");
    expect(html).toContain("/facturacion/cola?venta=venta-1");
  });
});
