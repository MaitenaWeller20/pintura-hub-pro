import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HistorialCorreccionesPago } from "./historial-correcciones-pago";

describe("historial visible de correcciones de forma de pago", () => {
  it("muestra medio anterior, nuevo, importe inmutable, responsable y motivo", () => {
    const html = renderToStaticMarkup(
      createElement(HistorialCorreccionesPago, {
        correcciones: [
          {
            id: 1,
            corregidaEn: "2026-09-02T12:00:00.000Z",
            corregidaPor: "Administradora",
            motivo: "Se informó efectivo en vez de transferencia",
            formaAnterior: "EFECTIVO",
            formaNueva: "TRANSFERENCIA",
            monto: 299386.55,
            versionNueva: 1,
          },
        ],
      }),
    );

    expect(html).toContain("Historial de correcciones");
    expect(html).toContain("Efectivo");
    expect(html).toContain("Transferencia");
    expect(html).toContain("$ 299.386,55");
    expect(html).toContain("Administradora");
    expect(html).toContain("Se informó efectivo en vez de transferencia");
  });

  it("no inventa historial cuando el pago nunca fue corregido", () => {
    const html = renderToStaticMarkup(
      createElement(HistorialCorreccionesPago, { correcciones: [] }),
    );
    expect(html).toBe("");
  });
});
