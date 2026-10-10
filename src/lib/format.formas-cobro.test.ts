import { describe, expect, it } from "vitest";
import { formaPagoLabel, formasCobro } from "./format";

describe("formas de cobro", () => {
  it("ofrece QR y canje como cobros independientes", () => {
    expect(formasCobro).toContain("QR");
    expect(formasCobro).toContain("CANJE");
    expect(formasCobro).not.toContain("MERCADO_PAGO");
    expect(formaPagoLabel.QR).toBe("QR");
    expect(formaPagoLabel.CANJE).toBe("Canje");
  });
});
