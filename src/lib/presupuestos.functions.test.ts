import { describe, expect, it, vi } from "vitest";
import {
  crearPresupuestoInputSchema,
  editarPresupuestoInputSchema,
  ejecutarCreacionPresupuestoCerrada,
  ejecutarEdicionPresupuestoCerrada,
  ejecutarPreflightConversionPresupuesto,
} from "./presupuestos.functions";

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

const ALTA_BASE = {
  p_sucursal_id: sucursalId,
  p_items: [
    {
      producto_id: "84000000-0000-4000-8000-000000000001",
      cantidad: 1,
      descuento_porcentaje: 0,
    },
  ],
};

function textoProfundo(value: unknown, vistos = new Set<unknown>()): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || vistos.has(value)) return "";
  vistos.add(value);
  return Reflect.ownKeys(value)
    .flatMap((key) => [String(key), textoProfundo(Reflect.get(value, key), vistos)])
    .join(" ");
}

describe("writers server-side cerrados de presupuesto", () => {
  it("valida entradas estrictas, permite omitir fallback y rechaza custom de 161", () => {
    expect(crearPresupuestoInputSchema.parse(ALTA_BASE).p_items[0]).not.toHaveProperty(
      "descripcion",
    );
    expect(() =>
      crearPresupuestoInputSchema.parse({
        ...ALTA_BASE,
        p_items: [{ ...ALTA_BASE.p_items[0], descripcion: "😀".repeat(161) }],
      }),
    ).toThrow(/160/);
    expect(() => crearPresupuestoInputSchema.parse({ ...ALTA_BASE, inesperado: true })).toThrow();
    const { p_sucursal_id: _sucursal, ...itemsYCabecera } = ALTA_BASE;
    expect(
      editarPresupuestoInputSchema.parse({
        ...itemsYCabecera,
        p_presupuesto_id: presupuestoId,
        p_repreciar: false,
      }),
    ).toMatchObject({ p_presupuesto_id: presupuestoId, p_repreciar: false });
  });

  it.each([
    ["crear", ejecutarCreacionPresupuestoCerrada, ALTA_BASE],
    [
      "editar",
      ejecutarEdicionPresupuestoCerrada,
      {
        p_items: ALTA_BASE.p_items,
        p_presupuesto_id: presupuestoId,
        p_repreciar: false,
      },
    ],
  ] as const)("%s no expone el rechazo Supabase real", async (_caso, ejecutar, input) => {
    const causa = {
      message: 'duplicate key violates constraint "presupuesto_items_pkey"',
      code: "23505",
      details: "public.presupuesto_items",
      hint: "function editar_presupuesto",
      cause: new Error("secreto"),
    };
    const registrar = vi.fn();
    const resultado = await ejecutar(input as never, {
      ejecutarRpc: async () => ({ data: null, error: causa }),
      registrar,
    });

    expect(registrar).toHaveBeenCalledWith(expect.stringContaining("PRESUPUESTO"), causa);
    expect(resultado).toMatchObject({ ok: false, error: { codigo: "ERROR_INTERNO" } });
    const salida = textoProfundo(resultado).toLowerCase();
    for (const token of [
      "constraint",
      "presupuesto_items",
      "editar_presupuesto",
      "23505",
      "cause",
      "secreto",
    ]) {
      expect(salida).not.toContain(token);
    }
  });

  it("rechaza una salida RPC abierta o no numérica sin devolver su contenido", async () => {
    const resultados = await Promise.all([
      ejecutarCreacionPresupuestoCerrada(ALTA_BASE, {
        ejecutarRpc: async () => ({
          data: [{ presupuesto_id: presupuestoId, numero: "P-1", tabla_interna: "secreto" }],
          error: null,
        }),
        registrar: vi.fn(),
      }),
      ejecutarEdicionPresupuestoCerrada(
        { p_items: ALTA_BASE.p_items, p_presupuesto_id: presupuestoId, p_repreciar: false },
        {
          ejecutarRpc: async () => ({
            data: [{ presupuesto_id: presupuestoId, numero: "P-1", total: "no-numérico" }],
            error: null,
          }),
          registrar: vi.fn(),
        },
      ),
    ]);

    for (const resultado of resultados) {
      expect(resultado).toMatchObject({ ok: false, error: { codigo: "ERROR_INTERNO" } });
      expect(textoProfundo(resultado).toLowerCase()).not.toMatch(
        /tabla_interna|secreto|no-numérico/,
      );
    }
  });
});
