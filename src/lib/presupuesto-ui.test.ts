import { describe, expect, it } from "vitest";
import { destinoColaFiscalVentaConvertida } from "./presupuesto-ui";

describe("destino fiscal de un presupuesto convertido", () => {
  it.each([
    {
      caso: "admin con v2 apagado",
      acceso: { isAdmin: true, facturacionV2Habilitada: false, puedeFacturar: true },
    },
    {
      caso: "empleado sin capacidad fiscal",
      acceso: { isAdmin: false, facturacionV2Habilitada: true, puedeFacturar: false },
    },
  ])("oculta el enlace para $caso", ({ acceso }) => {
    expect(destinoColaFiscalVentaConvertida("venta 1", acceso)).toBeNull();
  });

  it.each([
    {
      caso: "admin",
      acceso: { isAdmin: true, facturacionV2Habilitada: true, puedeFacturar: false },
    },
    {
      caso: "empleado con capacidad fiscal",
      acceso: { isAdmin: false, facturacionV2Habilitada: true, puedeFacturar: true },
    },
  ])("enlaza la venta para $caso", ({ acceso }) => {
    expect(destinoColaFiscalVentaConvertida("venta 1", acceso)).toBe(
      "/facturacion/cola?venta=venta%201",
    );
  });
});
