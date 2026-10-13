import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HistorialCorreccionesIngreso } from "./historial-correcciones-ingreso";

describe("historial visible de correcciones de ingresos", () => {
  it("muestra quién corrigió, cuándo, el motivo y el antes/nuevo/delta de cada línea", () => {
    const html = renderToStaticMarkup(
      createElement(HistorialCorreccionesIngreso, {
        correcciones: [
          {
            id: "correccion-1",
            corregidoPor: "Agustina Páez",
            corregidoEn: "2026-08-24T13:30:00.000Z",
            motivo: "El remito traía dos unidades, no cuatro.",
            cambios: [
              {
                itemId: "item-techos",
                descripcion: "Techos atérmicos x1 kg",
                cantidadAnterior: 4,
                cantidadNueva: 2,
                delta: -2,
              },
              {
                itemId: "item-cargado-por-error",
                descripcion: "Látex x20 lts",
                cantidadAnterior: 3,
                cantidadNueva: 0,
                delta: -3,
              },
            ],
          },
        ],
      }),
    );

    expect(html).toContain("Historial de correcciones");
    expect(html).toContain("Agustina Páez");
    expect(html).toContain("El remito traía dos unidades, no cuatro.");
    expect(html).toContain("Techos atérmicos x1 kg");
    expect(html).toContain("4");
    expect(html).toContain("2");
    expect(html).toMatch(/[−-]2/);
    expect(html).toContain("Látex x20 lts");
    expect(html).toContain("0");
    expect(html).toMatch(/[−-]3/);
    expect(html).toContain("2026");
  });

  it("no inventa historial cuando todavía no hubo correcciones", () => {
    const html = renderToStaticMarkup(
      createElement(HistorialCorreccionesIngreso, { correcciones: [] }),
    );

    expect(html).not.toContain("Historial de correcciones");
  });
});
