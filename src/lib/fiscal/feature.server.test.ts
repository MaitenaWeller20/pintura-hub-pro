import { describe, expect, it, vi } from "vitest";
import {
  cargarFlagsFacturacionDesdeSupabase,
  decidirEscritorFiscal,
  leerFlagsFacturacion,
  permiteLectorLegacySinMarca,
} from "./feature.server";

describe("feature flags del escritor fiscal", () => {
  it.each([
    [
      {
        facturacion_receptor_v2_enabled: false,
        facturacion_legacy_writer_enabled: true,
        nota_credito_periodo_enabled: false,
      },
      "LEGACY",
      "LEGACY",
    ],
    [
      {
        facturacion_receptor_v2_enabled: true,
        facturacion_legacy_writer_enabled: false,
        nota_credito_periodo_enabled: false,
      },
      "V2",
      "V2",
    ],
    [
      {
        facturacion_receptor_v2_enabled: false,
        facturacion_legacy_writer_enabled: false,
        nota_credito_periodo_enabled: false,
      },
      "LEGACY",
      "MANTENIMIENTO",
    ],
    [
      {
        facturacion_receptor_v2_enabled: false,
        facturacion_legacy_writer_enabled: false,
        nota_credito_periodo_enabled: false,
      },
      "V2",
      "MANTENIMIENTO",
    ],
  ] as const)("enruta %o + %s a %s", (flags, entrada, esperado) => {
    expect(decidirEscritorFiscal(flags, entrada)).toBe(esperado);
  });

  it("falla cerrado para ambos escritores activos y para cruce de inputs", () => {
    expect(() =>
      decidirEscritorFiscal(
        {
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: true,
          nota_credito_periodo_enabled: false,
        },
        "V2",
      ),
    ).toThrow(/inválida/i);
    expect(() =>
      decidirEscritorFiscal(
        {
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: false,
        },
        "LEGACY",
      ),
    ).toThrow(/cliente legacy/i);
    expect(() =>
      decidirEscritorFiscal(
        {
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: true,
          nota_credito_periodo_enabled: false,
        },
        "V2",
      ),
    ).toThrow(/cliente receptor v2/i);
  });

  it("abre el lector sin marca sólo durante la ventana legacy exclusiva", () => {
    expect(
      permiteLectorLegacySinMarca({
        facturacion_receptor_v2_enabled: false,
        facturacion_legacy_writer_enabled: true,
        nota_credito_periodo_enabled: false,
      }),
    ).toBe(true);
    expect(
      permiteLectorLegacySinMarca({
        facturacion_receptor_v2_enabled: true,
        facturacion_legacy_writer_enabled: false,
        nota_credito_periodo_enabled: true,
      }),
    ).toBe(false);
    expect(
      permiteLectorLegacySinMarca({
        facturacion_receptor_v2_enabled: false,
        facturacion_legacy_writer_enabled: false,
        nota_credito_periodo_enabled: false,
      }),
    ).toBe(false);
    expect(() =>
      permiteLectorLegacySinMarca({
        facturacion_receptor_v2_enabled: true,
        facturacion_legacy_writer_enabled: true,
        nota_credito_periodo_enabled: true,
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
          nota_credito_periodo_enabled: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: true,
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: true,
        },
      ]);
    expect(await leerFlagsFacturacion(consultar)).toEqual({
      facturacion_receptor_v2_enabled: false,
      facturacion_legacy_writer_enabled: true,
      nota_credito_periodo_enabled: false,
    });
    expect(await leerFlagsFacturacion(consultar)).toEqual({
      facturacion_receptor_v2_enabled: false,
      facturacion_legacy_writer_enabled: false,
      nota_credito_periodo_enabled: true,
    });
    expect(consultar).toHaveBeenCalledTimes(2);

    await expect(leerFlagsFacturacion(async () => [])).rejects.toThrow(/exactamente una/i);
    await expect(
      leerFlagsFacturacion(async () => [
        {
          id: true,
          facturacion_receptor_v2_enabled: "false",
          facturacion_legacy_writer_enabled: true,
          nota_credito_periodo_enabled: false,
        },
      ]),
    ).rejects.toThrow(/booleanos/i);
    await expect(
      leerFlagsFacturacion(async () => [
        {
          id: true,
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
        },
      ]),
    ).rejects.toThrow(/booleanos/i);
    await expect(
      leerFlagsFacturacion(async () => [
        {
          id: true,
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: "true",
        },
      ]),
    ).rejects.toThrow(/booleanos/i);
    await expect(
      leerFlagsFacturacion(async () => [
        {
          id: true,
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: true,
        },
        {
          id: true,
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: true,
        },
      ]),
    ).rejects.toThrow(/exactamente una/i);
  });

  it("selecciona exactamente los tres flags sin cachear entre escrituras", async () => {
    const columnas: string[] = [];
    const eq = vi.fn(async () => ({
      data: [
        {
          id: true,
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: true,
        },
      ],
      error: null,
    }));
    const supabase = {
      from: vi.fn(() => ({
        select: (seleccion: string) => {
          columnas.push(seleccion);
          return { eq };
        },
      })),
    };

    await cargarFlagsFacturacionDesdeSupabase(supabase);
    await cargarFlagsFacturacionDesdeSupabase(supabase);

    expect(columnas).toEqual([
      "id,facturacion_receptor_v2_enabled,facturacion_legacy_writer_enabled,nota_credito_periodo_enabled",
      "id,facturacion_receptor_v2_enabled,facturacion_legacy_writer_enabled,nota_credito_periodo_enabled",
    ]);
    expect(supabase.from).toHaveBeenCalledTimes(2);
    expect(eq).toHaveBeenCalledTimes(2);
  });
});
