import { describe, expect, it } from "vitest";
import { autorizarContextoColaFiscal, evaluarPermisoFiscal } from "./permiso.server";

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

describe("contexto user-bound de cola y favoritos", () => {
  it("fuerza al empleado activo y capaz a su sucursal activa habilitada", async () => {
    const contexto = await autorizarContextoColaFiscal({
      userId: "user",
      lecturas: {
        consultarEsAdmin: async () => false,
        cargarPerfil: async () => ({
          activo: true,
          puedeFacturar: true,
          sucursalId: "sucursal-a",
        }),
        cargarSucursal: async () => ({ activa: true, asignada: true }),
      },
    });
    expect(contexto).toEqual({ userId: "user", esAdmin: false, sucursalId: "sucursal-a" });
  });

  it.each([
    [null, /perfil/i],
    [{ activo: false, puedeFacturar: true, sucursalId: "sucursal-a" }, /inactivo/i],
    [{ activo: true, puedeFacturar: false, sucursalId: "sucursal-a" }, /capacidad/i],
    [{ activo: true, puedeFacturar: true, sucursalId: null }, /sucursal activa/i],
  ])("rechaza un empleado sin contexto fiscal completo", async (perfil, mensaje) => {
    await expect(
      autorizarContextoColaFiscal({
        userId: "user",
        lecturas: {
          consultarEsAdmin: async () => false,
          cargarPerfil: async () => perfil,
          cargarSucursal: async () => ({ activa: true, asignada: true }),
        },
      }),
    ).rejects.toThrow(mensaje);
  });

  it("rechaza sucursal deshabilitada y deja al admin sin filtro forzado", async () => {
    await expect(
      autorizarContextoColaFiscal({
        userId: "user",
        lecturas: {
          consultarEsAdmin: async () => false,
          cargarPerfil: async () => ({
            activo: true,
            puedeFacturar: true,
            sucursalId: "sucursal-a",
          }),
          cargarSucursal: async () => ({ activa: false, asignada: true }),
        },
      }),
    ).rejects.toThrow(/sucursal.*inactiva/i);

    await expect(
      autorizarContextoColaFiscal({
        userId: "user",
        lecturas: {
          consultarEsAdmin: async () => false,
          cargarPerfil: async () => ({
            activo: true,
            puedeFacturar: true,
            sucursalId: "sucursal-a",
          }),
          cargarSucursal: async () => ({ activa: true, asignada: false }),
        },
      }),
    ).rejects.toThrow(/sucursal.*asignada/i);

    await expect(
      autorizarContextoColaFiscal({
        userId: "admin",
        lecturas: {
          consultarEsAdmin: async () => true,
          cargarPerfil: async () => null,
          cargarSucursal: async () => null,
        },
      }),
    ).resolves.toEqual({ userId: "admin", esAdmin: true, sucursalId: null });
  });
});
