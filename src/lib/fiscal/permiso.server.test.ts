import { describe, expect, it } from "vitest";
import { evaluarPermisoFiscal } from "./permiso.server";

const base = {
  venta: { id: "venta", sucursalId: "sucursal-a", diasAntiguedad: 0 },
  perfil: { activo: true, puedeFacturar: true, sucursalId: "sucursal-a" },
  esAdmin: false,
} as const;

describe("permiso fiscal server", () => {
  it("autoriza al empleado activo, capaz y de la misma sucursal", () => {
    expect(
      evaluarPermisoFiscal({ ...base, accion: "EMITIR", confirmaVentaAntigua: false }),
    ).toEqual({
      ventaId: "venta",
      sucursalId: "sucursal-a",
      esAdmin: false,
    });
  });

  it.each([
    [{ ...base.perfil, activo: false }, /inactivo/i],
    [{ ...base.perfil, puedeFacturar: false }, /capacidad/i],
    [{ ...base.perfil, sucursalId: "sucursal-b" }, /sucursal/i],
  ])("rechaza empleado sin condición requerida", (perfil, mensaje) => {
    expect(() =>
      evaluarPermisoFiscal({ ...base, perfil, accion: "EMITIR", confirmaVentaAntigua: false }),
    ).toThrow(mensaje);
  });

  it("admin puede operar otra sucursal, pero conciliación/liberación y venta vieja no empleado", () => {
    expect(
      evaluarPermisoFiscal({
        ...base,
        esAdmin: true,
        perfil: null,
        venta: { ...base.venta, sucursalId: "otra" },
        accion: "CONCILIAR",
        confirmaVentaAntigua: false,
      }),
    ).toMatchObject({ esAdmin: true, sucursalId: "otra" });

    for (const accion of ["CONCILIAR", "LIBERAR"] as const) {
      expect(() => evaluarPermisoFiscal({ ...base, accion, confirmaVentaAntigua: false })).toThrow(
        /administrador/i,
      );
    }
    expect(() =>
      evaluarPermisoFiscal({
        ...base,
        venta: { ...base.venta, diasAntiguedad: 6 },
        accion: "EMITIR",
        confirmaVentaAntigua: true,
      }),
    ).toThrow(/administrador/i);

    expect(() =>
      evaluarPermisoFiscal({
        ...base,
        venta: { ...base.venta, diasAntiguedad: 6 },
        esAdmin: true,
        perfil: null,
        accion: "EMITIR",
        confirmaVentaAntigua: false,
      }),
    ).toThrow(/confirmar expresamente/i);

    expect(
      evaluarPermisoFiscal({
        ...base,
        venta: { ...base.venta, diasAntiguedad: 6 },
        esAdmin: true,
        perfil: null,
        accion: "EMITIR",
        confirmaVentaAntigua: true,
      }),
    ).toMatchObject({ esAdmin: true });

    expect(
      evaluarPermisoFiscal({
        ...base,
        venta: { ...base.venta, diasAntiguedad: 6 },
        accion: "PREVISUALIZAR",
        confirmaVentaAntigua: false,
      }),
    ).toMatchObject({ esAdmin: false });
  });
});
