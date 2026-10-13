import { describe, expect, it } from "vitest";
import {
  autorizarAdministradorFiscal,
  autorizarContextoVentas,
  autorizarContextoColaFiscal,
  autorizarLecturaVenta,
  evaluarPermisoFiscal,
} from "./permiso.server";

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

  it("admin activo puede operar otra sucursal, pero conciliación/liberación y venta vieja no empleado", () => {
    expect(
      evaluarPermisoFiscal({
        ...base,
        esAdmin: true,
        perfil: { activo: true, puedeFacturar: false, sucursalId: null },
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
        perfil: { activo: true, puedeFacturar: false, sucursalId: null },
        accion: "EMITIR",
        confirmaVentaAntigua: false,
      }),
    ).toThrow(/confirmar expresamente/i);

    expect(
      evaluarPermisoFiscal({
        ...base,
        venta: { ...base.venta, diasAntiguedad: 6 },
        esAdmin: true,
        perfil: { activo: true, puedeFacturar: false, sucursalId: null },
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

  it.each([
    [null, /perfil fiscal/i],
    [{ activo: false, puedeFacturar: true, sucursalId: null }, /inactivo/i],
  ])("rechaza también al admin si su perfil no está activo", (perfil, mensaje) => {
    expect(() =>
      evaluarPermisoFiscal({
        ...base,
        esAdmin: true,
        perfil,
        accion: "CONCILIAR",
        confirmaVentaAntigua: false,
      }),
    ).toThrow(mensaje);
  });
});

describe("lectura user-bound del detalle de Ventas", () => {
  it("deja leer al empleado con sección Ventas aunque no tenga capacidad fiscal", async () => {
    await expect(
      autorizarLecturaVenta({
        userId: "empleado",
        ventaId: "venta-visible",
        lecturas: {
          cargarVentaVisible: async () => ({ id: "venta-visible", sucursalId: "sucursal-a" }),
          consultarEsAdmin: async () => false,
          cargarPerfil: async () => ({
            activo: true,
            sucursalId: "sucursal-a",
            secciones: ["ventas"],
          }),
        },
      }),
    ).resolves.toEqual({ ventaId: "venta-visible", sucursalId: "sucursal-a", esAdmin: false });
  });

  it("falla antes de cualquier lectura privilegiada cuando RLS no muestra la venta", async () => {
    const orden: string[] = [];
    await expect(
      autorizarLecturaVenta({
        userId: "empleado",
        ventaId: "venta-ajena",
        lecturas: {
          cargarVentaVisible: async () => {
            orden.push("venta-user-bound");
            return null;
          },
          consultarEsAdmin: async () => {
            orden.push("rol");
            return false;
          },
          cargarPerfil: async () => {
            orden.push("perfil");
            return { activo: true, sucursalId: "sucursal-a", secciones: ["ventas"] };
          },
        },
      }),
    ).rejects.toThrow("Venta no encontrada o no visible para el operador.");
    expect(orden).toEqual(["venta-user-bound"]);
  });

  it.each([
    [{ activo: true, sucursalId: "sucursal-b", secciones: ["ventas"] }, /sucursal activa/i],
    [{ activo: true, sucursalId: "sucursal-a", secciones: ["stock"] }, /sección Ventas/i],
    [{ activo: false, sucursalId: "sucursal-a", secciones: ["ventas"] }, /inactivo/i],
  ])("rechaza un perfil fuera del ámbito de lectura", async (perfil, mensaje) => {
    await expect(
      autorizarLecturaVenta({
        userId: "empleado",
        ventaId: "venta-visible",
        lecturas: {
          cargarVentaVisible: async () => ({ id: "venta-visible", sucursalId: "sucursal-a" }),
          consultarEsAdmin: async () => false,
          cargarPerfil: async () => perfil,
        },
      }),
    ).rejects.toThrow(mensaje);
  });

  it("mantiene al admin activo autorizado sin filtros de sección o sucursal", async () => {
    await expect(
      autorizarLecturaVenta({
        userId: "admin",
        ventaId: "venta-otra-sucursal",
        lecturas: {
          cargarVentaVisible: async () => ({
            id: "venta-otra-sucursal",
            sucursalId: "sucursal-b",
          }),
          consultarEsAdmin: async () => true,
          cargarPerfil: async () => ({ activo: true, sucursalId: null, secciones: [] }),
        },
      }),
    ).resolves.toEqual({
      ventaId: "venta-otra-sucursal",
      sucursalId: "sucursal-b",
      esAdmin: true,
    });
  });

  it("no convierte la lectura en permiso para previsualizar ni emitir", () => {
    const perfilSinCapacidad = { activo: true, puedeFacturar: false, sucursalId: "sucursal-a" };
    for (const accion of ["PREVISUALIZAR", "EMITIR"] as const) {
      expect(() =>
        evaluarPermisoFiscal({
          ...base,
          perfil: perfilSinCapacidad,
          accion,
          confirmaVentaAntigua: false,
        }),
      ).toThrow(/capacidad fiscal/i);
    }
  });
});

describe("contexto user-bound de listados de Ventas", () => {
  const lecturas = (
    overrides: Partial<{
      esAdmin: boolean;
      perfil: {
        activo: boolean;
        puedeFacturar: boolean;
        sucursalId: string | null;
        secciones: string[] | null;
      } | null;
    }> = {},
  ) => ({
    consultarEsAdmin: async () => overrides.esAdmin ?? false,
    cargarPerfil: async () =>
      overrides.perfil ?? {
        activo: true,
        puedeFacturar: false,
        sucursalId: "sucursal-a",
        secciones: ["ventas"],
      },
  });

  it("permite listar ventas al operador de la sección aunque no pueda facturar", async () => {
    await expect(
      autorizarContextoVentas({
        userId: "empleado",
        exigirCapacidadFiscal: false,
        lecturas: lecturas(),
      }),
    ).resolves.toEqual({ userId: "empleado", esAdmin: false, sucursalId: "sucursal-a" });
  });

  it("exige capacidad fiscal para seleccionar el original de una NC", async () => {
    await expect(
      autorizarContextoVentas({
        userId: "empleado",
        exigirCapacidadFiscal: true,
        lecturas: lecturas(),
      }),
    ).rejects.toThrow(/capacidad fiscal/i);
  });

  it.each([
    [
      { activo: true, puedeFacturar: true, sucursalId: "sucursal-a", secciones: ["stock"] },
      /sección Ventas/i,
    ],
    [
      { activo: false, puedeFacturar: true, sucursalId: "sucursal-a", secciones: ["ventas"] },
      /inactivo/i,
    ],
    [
      { activo: true, puedeFacturar: true, sucursalId: null, secciones: ["ventas"] },
      /sucursal activa/i,
    ],
  ])("rechaza un empleado fuera del ámbito comercial", async (perfil, mensaje) => {
    await expect(
      autorizarContextoVentas({
        userId: "empleado",
        exigirCapacidadFiscal: false,
        lecturas: lecturas({ perfil }),
      }),
    ).rejects.toThrow(mensaje);
  });

  it("mantiene al admin activo sin forzar sucursal ni capacidad fiscal", async () => {
    await expect(
      autorizarContextoVentas({
        userId: "admin",
        exigirCapacidadFiscal: true,
        lecturas: lecturas({
          esAdmin: true,
          perfil: { activo: true, puedeFacturar: false, sucursalId: null, secciones: [] },
        }),
      }),
    ).resolves.toEqual({ userId: "admin", esAdmin: true, sucursalId: null });
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

  it("rechaza sucursal deshabilitada y deja al admin activo sin filtro forzado", async () => {
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
          cargarPerfil: async () => ({
            activo: true,
            puedeFacturar: false,
            sucursalId: null,
          }),
          cargarSucursal: async () => null,
        },
      }),
    ).resolves.toEqual({ userId: "admin", esAdmin: true, sucursalId: null });
  });

  it.each([
    [null, /perfil/i],
    [{ activo: false, puedeFacturar: false, sucursalId: null }, /inactivo/i],
  ])("no permite que un admin sin perfil activo lea la cola", async (perfil, mensaje) => {
    await expect(
      autorizarContextoColaFiscal({
        userId: "admin",
        lecturas: {
          consultarEsAdmin: async () => true,
          cargarPerfil: async () => perfil,
          cargarSucursal: async () => null,
        },
      }),
    ).rejects.toThrow(mensaje);
  });
});

describe("administrador fiscal activo", () => {
  it("autoriza únicamente al admin que conserva un perfil activo", async () => {
    await expect(
      autorizarAdministradorFiscal({
        userId: "admin",
        lecturas: {
          consultarEsAdmin: async () => true,
          cargarPerfil: async () => ({ activo: true }),
        },
      }),
    ).resolves.toEqual({ userId: "admin", esAdmin: true });
  });

  it.each([
    [true, null, /perfil/i],
    [true, { activo: false }, /inactivo/i],
    [false, { activo: true }, /administrador/i],
  ])("rechaza rol=%s perfil=%o", async (esAdmin, perfil, mensaje) => {
    await expect(
      autorizarAdministradorFiscal({
        userId: "actor",
        lecturas: {
          consultarEsAdmin: async () => esAdmin,
          cargarPerfil: async () => perfil,
        },
      }),
    ).rejects.toThrow(mensaje);
  });
});
