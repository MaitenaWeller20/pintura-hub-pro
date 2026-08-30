import { describe, expect, it, vi } from "vitest";
import { ejecutarPreflightConversionPresupuesto } from "./presupuestos.functions";

const presupuestoId = "81000000-0000-4000-8000-000000000001";
const sucursalId = "82000000-0000-4000-8000-000000000001";
const cajaId = "83000000-0000-4000-8000-000000000001";

describe("preflight user-bound de conversión de presupuesto", () => {
  it("lee presupuesto y caja en orden y devuelve una proyección cerrada", async () => {
    const orden: string[] = [];
    const cargarPrivilegiado = vi.fn();
    const deps = {
      cargarPresupuestoUsuario: async (id: string) => {
        orden.push("usuario-presupuesto");
        expect(id).toBe(presupuestoId);
        return {
          id: presupuestoId,
          sucursal_id: sucursalId,
          sucursal: { nombre: "General Paz" },
          cliente_id: "dato-no-expuesto",
          usuario_id: "dato-no-expuesto",
        };
      },
      cargarCajasUsuario: async (id: string, limite: number) => {
        orden.push("usuario-caja");
        expect(id).toBe(sucursalId);
        expect(limite).toBe(2);
        return [
          {
            id: cajaId,
            abierta_en: "2026-08-30T12:00:00.000Z",
            fondo_inicial: 100_000,
            notas: "dato-no-expuesto",
          },
        ];
      },
      cargarPrivilegiado,
    };

    await expect(ejecutarPreflightConversionPresupuesto({ presupuestoId }, deps)).resolves.toEqual({
      presupuestoId,
      sucursalId,
      sucursalNombre: "General Paz",
      caja: { id: cajaId, abiertaDesde: "2026-08-30T12:00:00.000Z" },
    });
    expect(orden).toEqual(["usuario-presupuesto", "usuario-caja"]);
    expect(cargarPrivilegiado).not.toHaveBeenCalled();
  });

  it("cierra BOLA sin consultar caja ni abrir una lectura privilegiada", async () => {
    const cargarCajasUsuario = vi.fn();
    const cargarPrivilegiado = vi.fn();
    const deps = {
      cargarPresupuestoUsuario: vi.fn(async () => null),
      cargarCajasUsuario,
      cargarPrivilegiado,
    };

    await expect(ejecutarPreflightConversionPresupuesto({ presupuestoId }, deps)).rejects.toThrow(
      "No se pudo leer el presupuesto o no tenés acceso.",
    );
    expect(cargarCajasUsuario).not.toHaveBeenCalled();
    expect(cargarPrivilegiado).not.toHaveBeenCalled();
  });

  it("oculta errores internos del presupuesto y conserva la misma respuesta opaca", async () => {
    const cargarCajasUsuario = vi.fn();

    await expect(
      ejecutarPreflightConversionPresupuesto(
        { presupuestoId },
        {
          cargarPresupuestoUsuario: async () => {
            throw new Error("detalle SQL sensible");
          },
          cargarCajasUsuario,
        },
      ),
    ).rejects.toThrow("No se pudo leer el presupuesto o no tenés acceso.");
    expect(cargarCajasUsuario).not.toHaveBeenCalled();
  });

  it("representa sin caja como null sin exponer saldos o cierres", async () => {
    const resultado = await ejecutarPreflightConversionPresupuesto(
      { presupuestoId },
      {
        cargarPresupuestoUsuario: async () => ({
          id: presupuestoId,
          sucursal_id: sucursalId,
          sucursal: [{ nombre: "General Paz" }],
        }),
        cargarCajasUsuario: async () => [],
      },
    );

    expect(resultado).toEqual({
      presupuestoId,
      sucursalId,
      sucursalNombre: "General Paz",
      caja: null,
    });
  });

  it("consulta como máximo dos cajas y falla cerrado ante ambigüedad o error", async () => {
    const presupuesto = {
      id: presupuestoId,
      sucursal_id: sucursalId,
      sucursal: { nombre: "General Paz" },
    };
    const cajasAmbiguas = [
      { id: cajaId, abierta_en: "2026-08-30T12:00:00.000Z" },
      {
        id: "83000000-0000-4000-8000-000000000002",
        abierta_en: "2026-08-30T13:00:00.000Z",
      },
    ];
    const cargarCajasUsuario = vi.fn(async (_id: string, limite: number) => {
      expect(limite).toBe(2);
      return cajasAmbiguas;
    });

    await expect(
      ejecutarPreflightConversionPresupuesto(
        { presupuestoId },
        { cargarPresupuestoUsuario: async () => presupuesto, cargarCajasUsuario },
      ),
    ).rejects.toThrow("No se pudo confirmar la caja de la sucursal.");

    await expect(
      ejecutarPreflightConversionPresupuesto(
        { presupuestoId },
        {
          cargarPresupuestoUsuario: async () => presupuesto,
          cargarCajasUsuario: async () => {
            throw new Error("detalle SQL sensible");
          },
        },
      ),
    ).rejects.toThrow("No se pudo confirmar la caja de la sucursal.");
  });

  it("rechaza una sucursal ausente antes de consultar caja", async () => {
    const cargarCajasUsuario = vi.fn();

    await expect(
      ejecutarPreflightConversionPresupuesto(
        { presupuestoId },
        {
          cargarPresupuestoUsuario: async () => ({
            id: presupuestoId,
            sucursal_id: sucursalId,
            sucursal: null,
          }),
          cargarCajasUsuario,
        },
      ),
    ).rejects.toThrow("El presupuesto no tiene una sucursal válida.");
    expect(cargarCajasUsuario).not.toHaveBeenCalled();
  });
});
