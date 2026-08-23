import { describe, expect, it } from "vitest";
import { resolverEstadoFiscalUsuario } from "./use-current-user";

describe("estado fiscal del usuario", () => {
  it("acepta una única configuración válida y deriva la capacidad por rol o perfil", () => {
    expect(
      resolverEstadoFiscalUsuario({
        isAdmin: false,
        puedeFacturarPerfil: true,
        settings: [
          {
            id: true,
            facturacion_receptor_v2_enabled: true,
            facturacion_legacy_writer_enabled: false,
          },
        ],
      }),
    ).toEqual({
      puedeFacturar: true,
      facturacionV2Habilitada: true,
      facturacionLegacyHabilitada: false,
    });
    expect(
      resolverEstadoFiscalUsuario({
        isAdmin: true,
        puedeFacturarPerfil: false,
        settings: [
          {
            id: true,
            facturacion_receptor_v2_enabled: false,
            facturacion_legacy_writer_enabled: true,
          },
        ],
      }).puedeFacturar,
    ).toBe(true);
  });

  it("falla cerrado ante ambos escritores, filas ausentes o flags inválidos", () => {
    const casos: unknown[] = [
      [],
      [
        {
          id: true,
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: true,
        },
      ],
      [
        {
          id: true,
          facturacion_receptor_v2_enabled: "true",
          facturacion_legacy_writer_enabled: false,
        },
      ],
    ];
    for (const settings of casos) {
      expect(
        resolverEstadoFiscalUsuario({
          isAdmin: false,
          puedeFacturarPerfil: true,
          settings,
        }),
      ).toEqual({
        puedeFacturar: true,
        facturacionV2Habilitada: false,
        facturacionLegacyHabilitada: false,
      });
    }
  });
});
