import { describe, expect, it } from "vitest";
import {
  perfilHabilitaSesion,
  resolverAccesoFiscalUsuario,
  resolverEstadoFiscalUsuario,
  resolverRolEfectivo,
} from "./use-current-user";
import { puedeAbrirRuta } from "@/lib/secciones";

describe("estado fiscal del usuario", () => {
  it("cierra el layout ante perfil ausente, inactivo o lectura rechazada", () => {
    expect(perfilHabilitaSesion({ activo: true }, null)).toBe(true);
    expect(perfilHabilitaSesion({ activo: false }, null)).toBe(false);
    expect(perfilHabilitaSesion(null, null)).toBe(false);
    expect(perfilHabilitaSesion({ activo: true }, new Error("REST 403"))).toBe(false);
  });

  it.each([
    [[{ role: "empleado" }, { role: "admin" }], "admin"],
    [[{ role: "admin" }, { role: "empleado" }], "admin"],
  ] as const)("resuelve admin sin depender del orden de %o", (roles, esperado) => {
    const role = resolverRolEfectivo(roles);
    expect(role).toBe(esperado);
    expect(
      resolverEstadoFiscalUsuario({
        isAdmin: role === "admin",
        puedeFacturarPerfil: false,
        settings: [
          {
            id: true,
            facturacion_receptor_v2_enabled: true,
            facturacion_legacy_writer_enabled: false,
          },
        ],
      }),
    ).toMatchObject({ puedeFacturar: true, facturacionV2Habilitada: true });
  });

  it.each([
    [[{ role: "empleado" }, { role: "admin" }]],
    [[{ role: "admin" }, { role: "empleado" }]],
  ])("mantiene loader, menú y guard administrativos con roles %o", (roles) => {
    const acceso = resolverAccesoFiscalUsuario({
      roles,
      perfilActivo: true,
      puedeFacturarPerfil: false,
      settings: [
        {
          id: true,
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
        },
      ],
    });
    expect(acceso).toMatchObject({ role: "admin", isAdmin: true, puedeFacturar: true });
    expect(puedeAbrirRuta("/facturacion/configuracion", acceso)).toBe(true);
  });

  it("falla cerrado ante roles desconocidos y prioriza empleado sólo si no existe admin", () => {
    expect(resolverRolEfectivo([{ role: "dueño" }])).toBeNull();
    expect(resolverRolEfectivo([{ role: "empleado" }, { role: "basura" }])).toBe("empleado");
  });

  it("ignora roles y capacidad de un perfil ausente o inactivo", () => {
    for (const perfilActivo of [false, null] as const) {
      expect(
        resolverAccesoFiscalUsuario({
          roles: [{ role: "admin" }],
          perfilActivo,
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
        role: null,
        isAdmin: false,
        puedeFacturar: false,
        facturacionV2Habilitada: false,
        facturacionLegacyHabilitada: false,
      });
    }
  });

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
