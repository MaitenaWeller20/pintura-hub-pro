import { describe, expect, it, vi } from "vitest";
import {
  decidirEscritorFiscal,
  leerFlagsFacturacion,
  permiteLectorLegacySinMarca,
} from "./feature.server";

describe("feature flags del escritor fiscal", () => {
  it.each([
    [
      { facturacion_receptor_v2_enabled: false, facturacion_legacy_writer_enabled: true },
      "LEGACY",
      "LEGACY",
    ],
    [
      { facturacion_receptor_v2_enabled: true, facturacion_legacy_writer_enabled: false },
      "V2",
      "V2",
    ],
    [
      { facturacion_receptor_v2_enabled: false, facturacion_legacy_writer_enabled: false },
      "LEGACY",
      "MANTENIMIENTO",
    ],
    [
      { facturacion_receptor_v2_enabled: false, facturacion_legacy_writer_enabled: false },
      "V2",
      "MANTENIMIENTO",
    ],
  ] as const)("enruta %o + %s a %s", (flags, entrada, esperado) => {
    expect(decidirEscritorFiscal(flags, entrada)).toBe(esperado);
  });

  it("falla cerrado para ambos escritores activos y para cruce de inputs", () => {
    expect(() =>
      decidirEscritorFiscal(
        { facturacion_receptor_v2_enabled: true, facturacion_legacy_writer_enabled: true },
        "V2",
      ),
    ).toThrow(/inválida/i);
    expect(() =>
      decidirEscritorFiscal(
        { facturacion_receptor_v2_enabled: true, facturacion_legacy_writer_enabled: false },
        "LEGACY",
      ),
    ).toThrow(/cliente legacy/i);
    expect(() =>
      decidirEscritorFiscal(
        { facturacion_receptor_v2_enabled: false, facturacion_legacy_writer_enabled: true },
        "V2",
      ),
    ).toThrow(/cliente receptor v2/i);
  });

  it("abre el lector sin marca sólo durante la ventana legacy exclusiva", () => {
    expect(
      permiteLectorLegacySinMarca({
        facturacion_receptor_v2_enabled: false,
        facturacion_legacy_writer_enabled: true,
      }),
    ).toBe(true);
    expect(
      permiteLectorLegacySinMarca({
        facturacion_receptor_v2_enabled: true,
        facturacion_legacy_writer_enabled: false,
      }),
    ).toBe(false);
    expect(
      permiteLectorLegacySinMarca({
        facturacion_receptor_v2_enabled: false,
        facturacion_legacy_writer_enabled: false,
      }),
    ).toBe(false);
    expect(() =>
      permiteLectorLegacySinMarca({
        facturacion_receptor_v2_enabled: true,
        facturacion_legacy_writer_enabled: true,
      }),
    ).toThrow(/ambos escritores/i);
  });

  it("relee la fila única id=true en cada invocación y valida tipos", async () => {
    const consultar = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: true,
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: true,
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: false,
        },
      ]);
    expect(await leerFlagsFacturacion(consultar)).toEqual({
      facturacion_receptor_v2_enabled: false,
      facturacion_legacy_writer_enabled: true,
    });
    expect(await leerFlagsFacturacion(consultar)).toEqual({
      facturacion_receptor_v2_enabled: false,
      facturacion_legacy_writer_enabled: false,
    });
    expect(consultar).toHaveBeenCalledTimes(2);

    await expect(leerFlagsFacturacion(async () => [])).rejects.toThrow(/exactamente una/i);
    await expect(
      leerFlagsFacturacion(async () => [
        {
          id: true,
          facturacion_receptor_v2_enabled: "false",
          facturacion_legacy_writer_enabled: true,
        },
      ]),
    ).rejects.toThrow(/booleanos/i);
  });
});
