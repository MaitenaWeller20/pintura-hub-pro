import { describe, expect, it, vi } from "vitest";
import { ejecutarConversionPresupuestoSegunFlags, ventaInputSchema } from "./ventas.functions";

const VENTA_BASE = {
  sucursal_id: "71000000-0000-4000-8000-000000000001",
  cliente_id: "72000000-0000-4000-8000-000000000001",
  tipo_comprobante: "VENTA",
  condicion_venta: "CONTADO",
  items: [
    {
      producto_id: "73000000-0000-4000-8000-000000000001",
      cantidad: 1,
      descuento_porcentaje: 0,
    },
  ],
  pagos: [{ forma_pago: "EFECTIVO", monto: 121, detalle: {} }],
  idempotency_key: "74000000-0000-4000-8000-000000000001",
} as const;

describe("entrada de venta neutral", () => {
  it("acepta VENTA de forma explícita sin abrir la enum a valores desconocidos", () => {
    expect(ventaInputSchema.parse(VENTA_BASE).tipo_comprobante).toBe("VENTA");
    expect(() =>
      ventaInputSchema.parse({ ...VENTA_BASE, tipo_comprobante: "FACTURA_LIBRE" }),
    ).toThrow();
  });
});

describe("fence del conversor de presupuesto", () => {
  const inputV2 = {
    entrada: "V2" as const,
    presupuesto_id: "75000000-0000-4000-8000-000000000001",
    cliente_id: "72000000-0000-4000-8000-000000000001",
    condicion_venta: "CONTADO" as const,
    pagos: [{ forma_pago: "TRANSFERENCIA" as const, monto: 121, detalle: {} }],
    idempotency_key: "76000000-0000-4000-8000-000000000001",
  };
  const inputLegacy = {
    entrada: "LEGACY" as const,
    presupuesto_id: "75000000-0000-4000-8000-000000000001",
    cliente_id: "72000000-0000-4000-8000-000000000001",
    tipo_comprobante: "FACTURA_B" as const,
    condicion_venta: "CONTADO" as const,
    pagos: [{ forma_pago: "EFECTIVO" as const, monto: 121, detalle: {} }],
    idempotency_key: "76000000-0000-4000-8000-000000000001",
  };

  it("v2 llama sólo al conversor neutral y conserva el ID devuelto", async () => {
    const convertirNeutral = vi.fn(async () => ({
      id: "77000000-0000-4000-8000-000000000001",
      numero: "VTA-00000001",
      cta_cte: false,
    }));
    const convertirLegacy = vi.fn();

    await expect(
      ejecutarConversionPresupuestoSegunFlags(inputV2, {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
        }),
        convertirNeutral,
        convertirLegacy,
      }),
    ).resolves.toEqual({
      id: "77000000-0000-4000-8000-000000000001",
      numero: "VTA-00000001",
      cta_cte: false,
    });
    expect(convertirNeutral).toHaveBeenCalledTimes(1);
    expect(convertirLegacy).not.toHaveBeenCalled();
  });

  it("legacy llama sólo a la firma legacy con su A/B explícita", async () => {
    const convertirNeutral = vi.fn();
    const convertirLegacy = vi.fn(async () => ({
      id: "77000000-0000-4000-8000-000000000002",
      numero: "FB-00000001",
      cta_cte: false,
    }));

    await ejecutarConversionPresupuestoSegunFlags(inputLegacy, {
      cargarFlags: async () => ({
        facturacion_receptor_v2_enabled: false,
        facturacion_legacy_writer_enabled: true,
      }),
      convertirNeutral,
      convertirLegacy,
    });
    expect(convertirLegacy).toHaveBeenCalledTimes(1);
    expect(convertirNeutral).not.toHaveBeenCalled();
  });

  it("mantenimiento devuelve antes de cualquier mutación comercial", async () => {
    const convertirNeutral = vi.fn();
    const convertirLegacy = vi.fn();

    await expect(
      ejecutarConversionPresupuestoSegunFlags(inputV2, {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: false,
        }),
        convertirNeutral,
        convertirLegacy,
      }),
    ).resolves.toEqual({
      estado: "MANTENIMIENTO",
      mensaje:
        "La facturación está temporalmente en mantenimiento. No se convirtió el presupuesto.",
    });
    expect(convertirNeutral).not.toHaveBeenCalled();
    expect(convertirLegacy).not.toHaveBeenCalled();
  });

  it("un cliente de rollout equivocado no cruza al otro escritor", async () => {
    const deps = {
      cargarFlags: async () => ({
        facturacion_receptor_v2_enabled: true,
        facturacion_legacy_writer_enabled: false,
      }),
      convertirNeutral: vi.fn(),
      convertirLegacy: vi.fn(),
    };

    await expect(ejecutarConversionPresupuestoSegunFlags(inputLegacy, deps)).rejects.toThrow(
      /legacy.*drain|fuera del drain/i,
    );
    expect(deps.convertirNeutral).not.toHaveBeenCalled();
    expect(deps.convertirLegacy).not.toHaveBeenCalled();
  });
});
