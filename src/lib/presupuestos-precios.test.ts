import { describe, expect, it } from "vitest";
import { calcularLineaPresupuesto } from "./presupuestos-precios";

describe("previsualización del precio presupuestado", () => {
  it("redondea IVA por línea y evita el centavo de multiplicar el unitario mostrado", () => {
    expect(calcularLineaPresupuesto(125, 10, 3, 21)).toEqual({
      precioNeto: 112.5,
      subtotalSinIva: 337.5,
      iva: 70.88,
      total: 408.38,
    });
  });
});
