import { describe, expect, it } from "vitest";
import {
  calcularTotalesNotaCreditoPeriodo,
  determinarLetraNcPeriodo,
  notaCreditoPeriodoInputSchema,
  validarAsociacionFiscal,
  validarLiquidacionNotaCreditoPeriodo,
  validarPeriodoAsociado,
} from "./nota-credito-periodo";

const IDS = {
  idempotency: "00000000-0000-4000-8000-000000000001",
  sucursal: "00000000-0000-4000-8000-000000000002",
  cliente: "00000000-0000-4000-8000-000000000003",
  producto: "00000000-0000-4000-8000-000000000004",
} as const;

const devolucionValida = {
  idempotency_key: IDS.idempotency,
  sucursal_id: IDS.sucursal,
  cliente_id: IDS.cliente,
  periodo_desde: "2026-07-01",
  periodo_hasta: "2026-07-31",
  motivo: "Producto dañado",
  resolucion: "REINTEGRO",
  pagos: [{ forma_pago: "TRANSFERENCIA", monto_centavos: 12100 }],
  modalidad: "DEVOLUCION_PRODUCTOS",
  items: [
    {
      producto_id: IDS.producto,
      cantidad: 1,
      precio_unitario_sin_iva: 100,
      iva_porcentaje: 21,
    },
  ],
} as const;

describe("nota de crédito fiscal por período: entrada estricta", () => {
  it("rechaza períodos ausentes, fechas no reales y claves de fecha fiscal del navegador", () => {
    for (const input of [
      { ...devolucionValida, periodo_desde: undefined },
      { ...devolucionValida, periodo_hasta: undefined },
      { ...devolucionValida, periodo_desde: "2026-02-30" },
      { ...devolucionValida, periodo_hasta: "31-07-2026" },
      { ...devolucionValida, fecha_emision: "2026-07-31" },
    ]) {
      expect(notaCreditoPeriodoInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("recorta el motivo y exige al menos cinco caracteres útiles", () => {
    const valido = notaCreditoPeriodoInputSchema.parse({
      ...devolucionValida,
      motivo: "  Motivo válido  ",
    });
    expect(valido.motivo).toBe("Motivo válido");
    expect(
      notaCreditoPeriodoInputSchema.safeParse({ ...devolucionValida, motivo: "  abc  " }).success,
    ).toBe(false);
  });

  it("acepta únicamente líneas de producto positivas para una devolución", () => {
    expect(notaCreditoPeriodoInputSchema.safeParse(devolucionValida).success).toBe(true);
    expect(
      notaCreditoPeriodoInputSchema.safeParse({ ...devolucionValida, items: [] }).success,
    ).toBe(false);
    expect(
      notaCreditoPeriodoInputSchema.safeParse({
        ...devolucionValida,
        items: [{ ...devolucionValida.items[0], producto_id: null, descripcion: "Concepto libre" }],
      }).success,
    ).toBe(false);
  });

  it("acepta una única bonificación libre con descripción, neto positivo e IVA permitido", () => {
    const ajuste = {
      ...devolucionValida,
      modalidad: "BONIFICACION_AJUSTE",
      pagos: [],
      resolucion: "SALDO_FAVOR",
      items: [
        {
          producto_id: null,
          descripcion: "Bonificación comercial",
          cantidad: 1,
          precio_unitario_sin_iva: 250.5,
          iva_porcentaje: 10.5,
        },
      ],
    };
    expect(notaCreditoPeriodoInputSchema.safeParse(ajuste).success).toBe(true);
    expect(
      notaCreditoPeriodoInputSchema.safeParse({
        ...ajuste,
        items: [...ajuste.items, ajuste.items[0]],
      }).success,
    ).toBe(false);
    expect(
      notaCreditoPeriodoInputSchema.safeParse({
        ...ajuste,
        items: [{ ...ajuste.items[0], descripcion: "   " }],
      }).success,
    ).toBe(false);
  });

  it("rechaza cantidad cero, precio negativo, IVA desconocido, líneas mezcladas y totales del navegador", () => {
    expect(
      notaCreditoPeriodoInputSchema.safeParse({
        ...devolucionValida,
        items: [{ ...devolucionValida.items[0], cantidad: 0 }],
      }).success,
    ).toBe(false);
    expect(
      notaCreditoPeriodoInputSchema.safeParse({
        ...devolucionValida,
        items: [{ ...devolucionValida.items[0], precio_unitario_sin_iva: -1 }],
      }).success,
    ).toBe(false);
    expect(
      notaCreditoPeriodoInputSchema.safeParse({
        ...devolucionValida,
        items: [{ ...devolucionValida.items[0], iva_porcentaje: 13 }],
      }).success,
    ).toBe(false);
    expect(
      notaCreditoPeriodoInputSchema.safeParse({
        ...devolucionValida,
        items: [{ ...devolucionValida.items[0], descripcion: "No corresponde" }],
      }).success,
    ).toBe(false);
    expect(
      notaCreditoPeriodoInputSchema.safeParse({ ...devolucionValida, total: 121 }).success,
    ).toBe(false);
    expect(
      notaCreditoPeriodoInputSchema.safeParse({ ...devolucionValida, percepciones: 10 }).success,
    ).toBe(false);
  });
});

describe("nota de crédito fiscal por período: fechas, importes y liquidación", () => {
  it("exige desde <= hasta <= fecha fiscal de emisión, sin aceptar rollovers", () => {
    expect(() =>
      validarPeriodoAsociado({
        desde: "2026-07-01",
        hasta: "2026-07-31",
        fechaEmision: "2026-07-31",
      }),
    ).not.toThrow();
    expect(() =>
      validarPeriodoAsociado({
        desde: "2026-07-31",
        hasta: "2026-07-01",
        fechaEmision: "2026-07-31",
      }),
    ).toThrow();
    expect(() =>
      validarPeriodoAsociado({
        desde: "2026-07-01",
        hasta: "2026-08-01",
        fechaEmision: "2026-07-31",
      }),
    ).toThrow();
    expect(() =>
      validarPeriodoAsociado({
        desde: "2026-02-30",
        hasta: "2026-03-01",
        fechaEmision: "2026-03-01",
      }),
    ).toThrow();
  });

  it("redondea cada línea y devuelve totales positivos en centavos", () => {
    expect(
      calcularTotalesNotaCreditoPeriodo([
        { cantidad: 3, precioUnitarioSinIva: 33.335, ivaPorcentaje: 21 },
        { cantidad: 1, precioUnitarioSinIva: 12.47, ivaPorcentaje: 10.5 },
      ]),
    ).toEqual({ netoCentavos: 11248, ivaCentavos: 2231, totalCentavos: 13479 });
  });

  it("exige reintegro completo al centavo y sin cuenta corriente", () => {
    expect(() =>
      validarLiquidacionNotaCreditoPeriodo({
        resolucion: "REINTEGRO",
        totalCentavos: 12100,
        clienteId: IDS.cliente,
        pagos: [{ formaPago: "TRANSFERENCIA", montoCentavos: 12100 }],
      }),
    ).not.toThrow();
    expect(() =>
      validarLiquidacionNotaCreditoPeriodo({
        resolucion: "REINTEGRO",
        totalCentavos: 12100,
        clienteId: IDS.cliente,
        pagos: [{ formaPago: "CTA_CTE" as never, montoCentavos: 12100 }],
      }),
    ).toThrow(/CTA_CTE/i);
    expect(() =>
      validarLiquidacionNotaCreditoPeriodo({
        resolucion: "REINTEGRO",
        totalCentavos: 12100,
        clienteId: IDS.cliente,
        pagos: [{ formaPago: "EFECTIVO", montoCentavos: 12099 }],
      }),
    ).toThrow(/centavo|total/i);
  });

  it("exige saldo a favor completo, sin pagos y con cliente comercial", () => {
    expect(() =>
      validarLiquidacionNotaCreditoPeriodo({
        resolucion: "SALDO_FAVOR",
        totalCentavos: 12100,
        clienteId: IDS.cliente,
        pagos: [],
      }),
    ).not.toThrow();
    expect(() =>
      validarLiquidacionNotaCreditoPeriodo({
        resolucion: "SALDO_FAVOR",
        totalCentavos: 12100,
        clienteId: "",
        pagos: [],
      }),
    ).toThrow(/cliente/i);
    expect(() =>
      validarLiquidacionNotaCreditoPeriodo({
        resolucion: "SALDO_FAVOR",
        totalCentavos: 12100,
        clienteId: IDS.cliente,
        pagos: [{ formaPago: "EFECTIVO", montoCentavos: 12100 }],
      }),
    ).toThrow(/pago/i);
  });

  it("rechaza liquidaciones parciales o mixtas", () => {
    expect(() =>
      validarLiquidacionNotaCreditoPeriodo({
        resolucion: "REINTEGRO",
        totalCentavos: 12100,
        clienteId: IDS.cliente,
        pagos: [
          { formaPago: "EFECTIVO", montoCentavos: 6000 },
          { formaPago: "TRANSFERENCIA", montoCentavos: 5000 },
        ],
      }),
    ).toThrow(/centavo|total/i);
  });
});

describe("nota de crédito fiscal por período: asociación y letra", () => {
  it("acepta factura ordinaria sin asociación, NC enlazada por recibo y NC por período", () => {
    expect(() => validarAsociacionFiscal("FACTURA_A", { tipo: "NINGUNA" })).not.toThrow();
    expect(() =>
      validarAsociacionFiscal("NOTA_CREDITO", {
        tipo: "COMPROBANTE",
        comprobanteOriginalId: IDS.producto,
      }),
    ).not.toThrow();
    expect(() =>
      validarAsociacionFiscal("NOTA_CREDITO", {
        tipo: "PERIODO",
        desde: "2026-07-01",
        hasta: "2026-07-31",
      }),
    ).not.toThrow();
  });

  it("rechaza una NC fiscal sin asociación o ambigua", () => {
    expect(() => validarAsociacionFiscal("NOTA_CREDITO", { tipo: "NINGUNA" }, true)).toThrow(
      /asociación/i,
    );
    expect(() =>
      validarAsociacionFiscal("NOTA_CREDITO", {
        tipo: "COMPROBANTE",
        comprobanteOriginalId: IDS.producto,
        desde: "2026-07-01",
        hasta: "2026-07-31",
      } as never),
    ).toThrow(/ambigua|asociación/i);
  });

  it("deriva A/B para RI y C para monotributo", () => {
    expect(determinarLetraNcPeriodo("RESPONSABLE_INSCRIPTO", "RESPONSABLE_INSCRIPTO")).toBe("A");
    expect(determinarLetraNcPeriodo("RESPONSABLE_INSCRIPTO", "MONOTRIBUTO")).toBe("A");
    expect(determinarLetraNcPeriodo("RESPONSABLE_INSCRIPTO", "EXENTO")).toBe("B");
    expect(determinarLetraNcPeriodo("RESPONSABLE_INSCRIPTO", "CONSUMIDOR_FINAL")).toBe("B");
    for (const receptor of [
      "RESPONSABLE_INSCRIPTO",
      "MONOTRIBUTO",
      "EXENTO",
      "CONSUMIDOR_FINAL",
    ] as const) {
      expect(determinarLetraNcPeriodo("MONOTRIBUTO", receptor)).toBe("C");
    }
  });
});
