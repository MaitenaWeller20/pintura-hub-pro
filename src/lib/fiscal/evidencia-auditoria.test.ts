import { describe, expect, it } from "vitest";
import {
  COLUMNAS_EVIDENCIA_AUTORIZACION_SEGURA,
  cargarEvidenciaAutorizacionFiscal,
} from "./evidencia-auditoria";

const VENTA_ID = "71000000-0000-4000-8000-000000000001";

describe("proyección cerrada de evidencia de autorización", () => {
  it("deriva autorización directa sin devolver respuesta, payload, errores ni hash", async () => {
    let columnas = "";
    const resultado = await cargarEvidenciaAutorizacionFiscal(VENTA_ID, {
      cargar: async (input) => {
        columnas = input.columnas;
        return {
          data: {
            resultado: "APROBADO",
            updated_at: "2026-08-20T13:02:01.000Z",
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
    expect(columnas).toBe(COLUMNAS_EVIDENCIA_AUTORIZACION_SEGURA);
    expect(columnas).not.toMatch(/payload_hash|error_clase|error_codigo|observaciones|cae/i);
    expect(JSON.stringify(resultado)).not.toMatch(/respuesta|payload|error|hash/i);
  });

  it("deriva recuperación desde coincidencia cerrada y timestamp del intento", async () => {
    const resultado = await cargarEvidenciaAutorizacionFiscal(VENTA_ID, {
      cargar: async () => ({
        data: {
          resultado: "RECUPERADO_CAE",
          updated_at: "2026-08-20T13:04:00.000Z",
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
      confirmadoAt: "2026-08-20T13:04:00.000Z",
    });
  });

  it("falla cerrado ante evidencia malformada o error técnico de lectura", async () => {
    await expect(
      cargarEvidenciaAutorizacionFiscal(VENTA_ID, {
        cargar: async () => ({
          data: {
            resultado: "APROBADO",
            updated_at: "2026-08-20T13:02:01.000Z",
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
        cargar: async () => ({ data: null, error: { message: "SQL secreto intent hash" } }),
      }),
    ).rejects.toThrow("No se pudo leer la evidencia de autorización fiscal.");
  });
});
