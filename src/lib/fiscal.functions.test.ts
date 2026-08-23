import { describe, expect, it } from "vitest";
import {
  emitirInputSchema,
  ejecutarFachadaEmisionPostBorrador,
  postBorradorInputSchema,
  proyectarIncidenteFiscal,
} from "./fiscal.functions";

const INPUT = {
  venta_id: "71000000-0000-4000-8000-000000000001",
  receptor: { origen: "CLIENTE_COMERCIAL" as const },
  confirma_venta_antigua: false,
  huella_confirmacion_provisional:
    "9df51a2cdbd04aaa392561b214a01a6b8c200ba1762608f23c7fadb111848979",
};

describe("fachada post-borrador", () => {
  it("exige una huella canónica en toda emisión v2 regular", () => {
    const v2 = {
      venta_id: INPUT.venta_id,
      receptor: INPUT.receptor,
      confirma_venta_antigua: false,
      huella_confirmacion: INPUT.huella_confirmacion_provisional,
    };
    expect(emitirInputSchema.parse(v2)).toEqual(v2);
    expect(() => emitirInputSchema.parse({ ...v2, huella_confirmacion: undefined })).toThrow();
    expect(() => emitirInputSchema.parse({ ...v2, huella_confirmacion: "a" })).toThrow();
  });

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

describe("detalle readonly de un incidente fiscal", () => {
  it("conserva diferencias únicas del último intento sin exponer el resumen crudo", () => {
    expect(
      proyectarIncidenteFiscal(
        {
          id: INPUT.venta_id,
          afip_estado: "BLOQUEADO",
          afip_fase: "REQUEST_INICIADO",
          afip_error: "La respuesta no coincide con la reserva.",
          afip_error_clase: "INTEGRIDAD",
          afip_error_codigo: "RESPUESTA_DIVERGENTE",
          afip_error_fase: "RESPUESTA_RECIBIDA",
          afip_ultimo_error_at: "2026-08-23T15:00:00.000Z",
        },
        {
          resultado: "BLOQUEADO",
          respuesta_resumen: {
            diagnostico: {
              diferencias: { campos: ["importeTotal", "receptor.docNroArca", "importeTotal"] },
            },
            soap_crudo: "NO DEBE SALIR",
          },
        },
      ),
    ).toEqual({
      venta_id: INPUT.venta_id,
      estado: "BLOQUEADO",
      fase: "REQUEST_INICIADO",
      mensaje: "La respuesta no coincide con la reserva.",
      clase: "INTEGRIDAD",
      codigo: "RESPUESTA_DIVERGENTE",
      fase_error: "RESPUESTA_RECIBIDA",
      fecha: "2026-08-23T15:00:00.000Z",
      diferencias: ["importeTotal", "receptor.docNroArca"],
      legacy: false,
    });
  });

  it("marca un incidente legacy sin inventar diferencias", () => {
    expect(
      proyectarIncidenteFiscal(
        {
          id: INPUT.venta_id,
          afip_estado: "ERROR",
          afip_fase: null,
          afip_error: "Error heredado",
          afip_error_clase: null,
          afip_error_codigo: null,
          afip_error_fase: null,
          afip_ultimo_error_at: null,
        },
        null,
      ),
    ).toMatchObject({ legacy: true, diferencias: [] });
  });
});
