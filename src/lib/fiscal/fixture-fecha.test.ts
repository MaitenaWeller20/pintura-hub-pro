import { describe, expect, it } from "vitest";

import {
  construirFechasFixtureArgentina,
  sumarDiasFechaIso,
} from "../../../e2e/fixtures/fecha-argentina";

describe("fechas dinámicas del fixture fiscal", () => {
  it("usa el día calendario argentino incluso antes de medianoche UTC", () => {
    const fechas = construirFechasFixtureArgentina(new Date("2026-08-23T01:30:00.000Z"));
    expect(fechas.hoy).toBe("2026-08-22");
    expect(fechas.visible).toBe("22/08/2026");
    expect(fechas.instante("12:30")).toBe("2026-08-22T15:30:00.000Z");
  });

  it("suma días calendario sin correrse al cambiar mes o año", () => {
    expect(sumarDiasFechaIso("2026-08-23", 10)).toBe("2026-09-02");
    expect(sumarDiasFechaIso("2026-12-31", 1)).toBe("2027-01-01");
  });
});
