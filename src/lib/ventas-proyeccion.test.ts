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
});
