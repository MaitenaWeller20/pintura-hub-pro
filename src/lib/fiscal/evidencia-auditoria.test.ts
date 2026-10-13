import { describe, expect, it } from "vitest";
import {
  COLUMNAS_EVIDENCIA_AUTORIZACION_SEGURA,
  COLUMNAS_VENTA_EVIDENCIA_AUTORIZACION_SEGURA,
  cargarEvidenciaAutorizacionFiscal,
} from "./evidencia-auditoria";

const VENTA_ID = "71000000-0000-4000-8000-000000000001";

describe("proyección cerrada de evidencia de autorización", () => {
  it("deriva autorización directa sin devolver respuesta, payload, errores ni hash", async () => {
    let columnas = "";
    const orden: string[] = [];
    const resultado = await cargarEvidenciaAutorizacionFiscal(VENTA_ID, {
      cargarVenta: async (input) => {
        orden.push("venta-user-bound");
        expect(input).toEqual({
          ventaId: VENTA_ID,
          columnas: COLUMNAS_VENTA_EVIDENCIA_AUTORIZACION_SEGURA,
        });
        return { data: { afip_emitido_at: "2026-08-20T13:02:00.000Z" }, error: null };
      },
      cargarIntento: async (input) => {
        orden.push("intento-admin");
        columnas = input.columnas;
        return {
          data: {
            resultado: "APROBADO",
            emision_tipo: "EMISION",
            emision_resultado: "A",
            emision_fuente: "FECAESolicitar",
            emision_emitido_at: "2026-08-20T13:02:00.000Z",
            recuperacion_tipo: null,
            recuperacion_resultado: null,
            recuperacion_fuente: null,
            recuperacion_coincidencia: null,
          },
          error: null,
        };
      },
    });

    expect(resultado).toEqual({
      origen: "EMISION",
      confirmadoAt: "2026-08-20T13:02:00.000Z",
    });
    expect(orden).toEqual(["venta-user-bound", "intento-admin"]);
    expect(columnas).toBe(COLUMNAS_EVIDENCIA_AUTORIZACION_SEGURA);
    expect(columnas).not.toMatch(
      /updated_at|payload_hash|error_clase|error_codigo|observaciones|cae/i,
    );
    expect(JSON.stringify(resultado)).not.toMatch(/respuesta|payload|error|hash/i);
  });

  it("deriva recuperación cerrada usando afip_emitido_at de la venta y no el reloj del intento", async () => {
    const resultado = await cargarEvidenciaAutorizacionFiscal(VENTA_ID, {
      cargarVenta: async () => ({
        data: { afip_emitido_at: "2026-08-20T13:04:00.123456Z" },
        error: null,
      }),
      cargarIntento: async () => ({
        data: {
          resultado: "RECUPERADO_CAE",
          emision_tipo: null,
          emision_resultado: null,
          emision_fuente: null,
          emision_emitido_at: null,
          recuperacion_tipo: "CONSULTA_ARCA",
          recuperacion_resultado: "COINCIDE",
          recuperacion_fuente: "FECompConsultar",
          recuperacion_coincidencia: "true",
        },
        error: null,
      }),
    });

    expect(resultado).toEqual({
      origen: "RECUPERACION",
      confirmadoAt: "2026-08-20T13:04:00.123456Z",
    });
  });

  it("falla cerrado ante evidencia malformada o error técnico de lectura", async () => {
    await expect(
      cargarEvidenciaAutorizacionFiscal(VENTA_ID, {
        cargarVenta: async () => ({
          data: { afip_emitido_at: "2026-08-20T13:02:00.000Z" },
          error: null,
        }),
        cargarIntento: async () => ({
          data: {
            resultado: "APROBADO",
            emision_tipo: "RESPUESTA_RARA",
            emision_resultado: "A",
            emision_fuente: "FECAESolicitar",
            emision_emitido_at: "2026-08-20T13:02:00.000Z",
            recuperacion_tipo: null,
            recuperacion_resultado: null,
            recuperacion_fuente: null,
            recuperacion_coincidencia: null,
          },
          error: null,
        }),
      }),
    ).rejects.toThrow("No se pudo validar la evidencia de autorización fiscal.");

    await expect(
      cargarEvidenciaAutorizacionFiscal(VENTA_ID, {
        cargarVenta: async () => ({
          data: { afip_emitido_at: "2026-08-20T13:02:00.000Z" },
          error: null,
        }),
        cargarIntento: async () => ({
          data: null,
          error: { message: "SQL secreto intent hash" },
        }),
      }),
    ).rejects.toThrow("No se pudo leer la evidencia de autorización fiscal.");
  });

  it("falla cerrado si la venta autorizada no conserva afip_emitido_at", async () => {
    let intentoLeido = false;
    await expect(
      cargarEvidenciaAutorizacionFiscal(VENTA_ID, {
        cargarVenta: async () => ({ data: { afip_emitido_at: null }, error: null }),
        cargarIntento: async () => {
          intentoLeido = true;
          return { data: null, error: null };
        },
      }),
    ).rejects.toThrow("No se pudo validar la emisión fiscal autorizada.");
    expect(intentoLeido).toBe(false);
  });
});
