import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EstadoFiscalPill } from "./estado-fiscal-pill";
import { ValidezFiscal } from "./validez-fiscal";

describe("presentación de validez fiscal", () => {
  it.each([
    ["PRODUCCION", "Producción · validez legal"],
    ["HOMOLOGACION", "Homologación · sin validez legal"],
    ["SIMULADA", "Simulada · sin validez legal"],
  ] as const)("hace explícita la validez %s", (validez, texto) => {
    expect(renderToStaticMarkup(createElement(ValidezFiscal, { validez }))).toContain(texto);
  });

  it("no inventa validez mientras está pendiente", () => {
    const html = renderToStaticMarkup(createElement(ValidezFiscal, { validez: null }));
    expect(html).toContain("Validez pendiente");
    expect(html).not.toContain("validez legal");
  });

  it("presenta una venta no fiscal como estado neutral y no como validez pendiente", () => {
    const estado = renderToStaticMarkup(createElement(EstadoFiscalPill, { estado: "NO_APLICA" }));
    const validez = renderToStaticMarkup(
      createElement(ValidezFiscal, { validez: null, estado: "NO_APLICA" }),
    );

    expect(estado).toContain("No fiscal/No aplica");
    expect(estado).toContain("text-muted-foreground");
    expect(validez).toBe("");
    expect(`${estado}${validez}`).not.toContain("Validez pendiente");
  });
});
