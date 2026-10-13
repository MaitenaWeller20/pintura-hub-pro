import { describe, expect, it } from "vitest";
import { camposEvidenciaFiscalLegacy } from "./legacy-compat";

describe("evidencia del writer fiscal legacy", () => {
  it.each([
    ["PRODUCCION", false, "PRODUCCION"],
    ["HOMOLOGACION", false, "HOMOLOGACION"],
    ["HOMOLOGACION", true, "SIMULADA"],
  ] as const)("marca %s simulado=%s como %s", (modo, simulado, validez) => {
    expect(
      camposEvidenciaFiscalLegacy({
        modo,
        simulado,
        fecha: "2026-08-24T01:30:00.000Z",
      }),
    ).toEqual({
      afip_version: 0,
      afip_legacy_incompleto: true,
      afip_validez: validez,
      afip_fecha_comprobante: "2026-08-23",
    });
  });

  it("rechaza una fecha no canónica en vez de guardar evidencia ambigua", () => {
    expect(() =>
      camposEvidenciaFiscalLegacy({
        modo: "PRODUCCION",
        simulado: false,
        fecha: "fecha inválida",
      }),
    ).toThrow(/fecha/i);
  });
});
