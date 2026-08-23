import { describe, expect, it } from "vitest";
import { ejecutarFachadaEmisionPostBorrador, postBorradorInputSchema } from "./fiscal.functions";

const INPUT = {
  venta_id: "71000000-0000-4000-8000-000000000001",
  receptor: { origen: "CLIENTE_COMERCIAL" as const },
  confirma_venta_antigua: false,
  huella_confirmacion_provisional:
    "9df51a2cdbd04aaa392561b214a01a6b8c200ba1762608f23c7fadb111848979",
};

describe("fachada post-borrador", () => {
  it("rechaza claves desconocidas y huellas no canónicas antes del handler", () => {
    expect(postBorradorInputSchema).toBeDefined();
    expect(postBorradorInputSchema.parse(INPUT)).toEqual(INPUT);
    expect(() => postBorradorInputSchema.parse({ ...INPUT, extra: "no" })).toThrow();
    expect(() =>
      postBorradorInputSchema.parse({ ...INPUT, huella_confirmacion_provisional: "ABC" }),
    ).toThrow();
  });

  it("fencea por autenticación y permiso antes de flags/preview/engine", async () => {
    const orden: string[] = [];

    await expect(
      ejecutarFachadaEmisionPostBorrador(INPUT, {
        asegurarAutenticacion: async () => {
          orden.push("auth");
          throw new Error("sin sesión");
        },
        autorizar: async () => orden.push("permiso"),
        cargarFlags: async () => {
          orden.push("flags");
          return {
            facturacion_receptor_v2_enabled: true,
            facturacion_legacy_writer_enabled: false,
          };
        },
        ejecutar: async () => {
          orden.push("engine");
          throw new Error("no debe llegar");
        },
      }),
    ).rejects.toThrow(/sesión/i);
    expect(orden).toEqual(["auth"]);

    orden.length = 0;
    await expect(
      ejecutarFachadaEmisionPostBorrador(INPUT, {
        asegurarAutenticacion: async () => orden.push("auth"),
        autorizar: async () => {
          orden.push("permiso");
          throw new Error("sin capacidad");
        },
        cargarFlags: async () => {
          orden.push("flags");
          return {
            facturacion_receptor_v2_enabled: true,
            facturacion_legacy_writer_enabled: false,
          };
        },
        ejecutar: async () => {
          orden.push("engine");
          throw new Error("no debe llegar");
        },
      }),
    ).rejects.toThrow(/capacidad/i);
    expect(orden).toEqual(["auth", "permiso"]);
  });

  it("respeta maintenance/legacy fencing y sólo ejecuta con el cuadrante v2", async () => {
    let ejecuciones = 0;
    const base = {
      asegurarAutenticacion: async () => undefined,
      autorizar: async () => undefined,
      ejecutar: async () => {
        ejecuciones += 1;
        return { estado: "APROBADO" as const };
      },
    };

    await expect(
      ejecutarFachadaEmisionPostBorrador(INPUT, {
        ...base,
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: true,
        }),
      }),
    ).rejects.toThrow(/v2.*habilitado|receptor v2/i);
    expect(ejecuciones).toBe(0);

    await expect(
      ejecutarFachadaEmisionPostBorrador(INPUT, {
        ...base,
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: false,
        }),
      }),
    ).resolves.toMatchObject({ estado: "MANTENIMIENTO" });
    expect(ejecuciones).toBe(0);

    await expect(
      ejecutarFachadaEmisionPostBorrador(INPUT, {
        ...base,
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
        }),
      }),
    ).resolves.toEqual({ estado: "APROBADO" });
    expect(ejecuciones).toBe(1);
  });
});
