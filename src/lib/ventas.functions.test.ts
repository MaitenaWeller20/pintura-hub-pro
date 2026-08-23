import { describe, expect, it, vi } from "vitest";
import {
  anulacionVentaInputSchema,
  ejecutarCreacionNotaSegunFlags,
  ejecutarConversionPresupuestoSegunFlags,
  ventaInputSchema,
} from "./ventas.functions";

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

describe("anulación idempotente", () => {
  const ventaId = "75000000-0000-4000-8000-000000000001";
  const clave = "75000000-0000-4000-8000-000000000002";

  it("exige una clave UUID estable además de la venta", () => {
    expect(anulacionVentaInputSchema.parse({ venta_id: ventaId, idempotency_key: clave })).toEqual({
      venta_id: ventaId,
      idempotency_key: clave,
    });
    expect(() => anulacionVentaInputSchema.parse({ venta_id: ventaId })).toThrow();
    expect(() =>
      anulacionVentaInputSchema.parse({ venta_id: ventaId, idempotency_key: "otra" }),
    ).toThrow();
  });
});

describe("cerco comercial de NC/ND", () => {
  const nota = (tipo: "NOTA_CREDITO" | "NOTA_DEBITO") =>
    ventaInputSchema.parse({
      ...VENTA_BASE,
      tipo_comprobante: tipo,
      cbte_asoc_id: "78000000-0000-4000-8000-000000000001",
    }) as ReturnType<typeof ventaInputSchema.parse> & {
      tipo_comprobante: "NOTA_CREDITO" | "NOTA_DEBITO";
    };

  it("en v2 una NC usa sólo la reversión total del original", async () => {
    const crearRegular = vi.fn();
    const crearNotaCreditoTotal = vi.fn(async () => ({
      id: "79000000-0000-4000-8000-000000000001",
      numero: "NCV-00000001",
      cta_cte: false,
    }));

    await expect(
      ejecutarCreacionNotaSegunFlags(nota("NOTA_CREDITO"), {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
        }),
        crearRegular,
        crearNotaCreditoTotal,
      }),
    ).resolves.toMatchObject({ id: "79000000-0000-4000-8000-000000000001" });
    expect(crearNotaCreditoTotal).toHaveBeenCalledWith(
      "78000000-0000-4000-8000-000000000001",
      VENTA_BASE.idempotency_key,
    );
    expect(crearRegular).not.toHaveBeenCalled();
  });

  it("en v2 rechaza una NC sin clave estable antes de todo escritor", async () => {
    const crearRegular = vi.fn();
    const crearNotaCreditoTotal = vi.fn();
    const input = {
      ...nota("NOTA_CREDITO"),
      idempotency_key: undefined,
    };

    await expect(
      ejecutarCreacionNotaSegunFlags(input, {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
        }),
        crearRegular,
        crearNotaCreditoTotal,
      }),
    ).rejects.toThrow("Falta la clave de idempotencia de la nota de crédito.");

    expect(crearNotaCreditoTotal).not.toHaveBeenCalled();
    expect(crearRegular).not.toHaveBeenCalled();
  });

  it("en v2 rechaza ND antes de todo escritor comercial", async () => {
    const cargarFlags = vi.fn(async () => ({
      facturacion_receptor_v2_enabled: true,
      facturacion_legacy_writer_enabled: false,
    }));
    const crearRegular = vi.fn();
    const crearNotaCreditoTotal = vi.fn();

    await expect(
      ejecutarCreacionNotaSegunFlags(nota("NOTA_DEBITO"), {
        cargarFlags,
        crearRegular,
        crearNotaCreditoTotal,
      }),
    ).rejects.toThrow(/nota de débito.*fuera de alcance/i);
    expect(crearRegular).not.toHaveBeenCalled();
    expect(crearNotaCreditoTotal).not.toHaveBeenCalled();
  });

  it("preserva la escritura de notas sólo en legacy y bloquea mantenimiento", async () => {
    const crearRegular = vi.fn(async () => ({ id: "legacy", numero: "NC-1", cta_cte: false }));
    const crearNotaCreditoTotal = vi.fn();
    const input = nota("NOTA_CREDITO");

    await ejecutarCreacionNotaSegunFlags(input, {
      cargarFlags: async () => ({
        facturacion_receptor_v2_enabled: false,
        facturacion_legacy_writer_enabled: true,
      }),
      crearRegular,
      crearNotaCreditoTotal,
    });
    expect(crearRegular).toHaveBeenCalledWith(input);

    await expect(
      ejecutarCreacionNotaSegunFlags(input, {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: false,
        }),
        crearRegular,
        crearNotaCreditoTotal,
      }),
    ).rejects.toThrow(/mantenimiento/i);
    expect(crearRegular).toHaveBeenCalledTimes(1);
    expect(crearNotaCreditoTotal).not.toHaveBeenCalled();
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
