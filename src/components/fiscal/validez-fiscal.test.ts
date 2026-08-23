import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
});
