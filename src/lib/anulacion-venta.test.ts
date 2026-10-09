import { describe, expect, it } from "vitest";
import { sePuedeAnularVenta } from "./anulacion-venta";

describe("anulación de notas de crédito", () => {
  it("permite corregir una nota con factura asociada que todavía no tiene CAE", () => {
    expect(
      sePuedeAnularVenta({ id: "nota", tipo_comprobante: "NOTA_CREDITO", cae: null }, new Set()),
    ).toBe(true);
  });

  it("impide anular una nota ya autorizada por AFIP", () => {
    expect(
      sePuedeAnularVenta(
        { id: "nota", tipo_comprobante: "NOTA_CREDITO", cae: "12345678901234" },
        new Set(),
      ),
    ).toBe(false);
  });

  it("permite anular una nota con CAE simulado, sin validez fiscal", () => {
    expect(
      sePuedeAnularVenta(
        {
          id: "nota",
          tipo_comprobante: "NOTA_CREDITO",
          cae: "CAE-SIMULADO",
          afip_simulado: true,
        },
        new Set(),
      ),
    ).toBe(true);
  });

  it("impide revertir la nota que generó la anulación de otra venta", () => {
    expect(
      sePuedeAnularVenta(
        { id: "nota", tipo_comprobante: "NOTA_CREDITO", cae: null },
        new Set(["nota"]),
      ),
    ).toBe(false);
  });
});
