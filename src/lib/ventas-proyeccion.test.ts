import { describe, expect, it } from "vitest";
import { COLUMNAS_VENTA_SEGURAS } from "./ventas-proyeccion";

describe("proyección de ventas para operadores", () => {
  it("no solicita el diagnóstico técnico fiscal ni comodines", () => {
    const columnas = COLUMNAS_VENTA_SEGURAS.split(",").map((columna) => columna.trim());

    expect(columnas).not.toContain("*");
    expect(columnas).not.toContain("afip_error");
    expect(columnas).toContain("afip_estado");
    expect(columnas).toContain("afip_error_clase");
  });

  it("incluye sólo los campos inmutables necesarios para auditar una NC por período", () => {
    const columnas = COLUMNAS_VENTA_SEGURAS.split(",").map((columna) => columna.trim());

    expect(columnas).toEqual(
      expect.arrayContaining([
        "created_at",
        "usuario_id",
        "periodo_asoc_desde",
        "periodo_asoc_hasta",
        "nc_periodo_modalidad",
        "motivo_nota_credito",
        "nc_resolucion",
        "nc_efectos_aplicados_at",
        "afip_emitido_at",
      ]),
    );
    expect(columnas).not.toEqual(
      expect.arrayContaining([
        "afip_error",
        "afip_claim_token",
        "nc_periodo_payload_hash",
        "idempotency_payload_hash",
      ]),
    );
  });
});
