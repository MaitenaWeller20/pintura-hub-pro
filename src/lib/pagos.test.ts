import { describe, it, expect } from "vitest";
import { normalizarCobros, totalesPorMedio, resumenPagos, serieDiaria } from "./pagos";

const ventas = [
  {
    fecha: "2026-07-10T15:00:00Z",
    numero_comprobante: "OHI-FVTA-0001",
    sucursal_id: "s1",
    cliente: { razon_social: "Cliente A" },
    pagos: [{ forma_pago: "EFECTIVO", monto: 1000 }],
  },
  {
    fecha: "2026-07-11T15:00:00Z",
    numero_comprobante: "OHI-NCIV-0001",
    sucursal_id: "s1",
    cliente: { razon_social: "Cliente A" },
    pagos: [{ forma_pago: "EFECTIVO", monto: -400 }], // NC (devolución)
  },
];
const cobranzas = [
  {
    fecha: "2026-07-10T16:00:00Z",
    sucursal_id: "s1",
    forma_pago: "TRANSFERENCIA",
    monto: 500,
    cliente: { razon_social: "Cliente B" },
  },
];

describe("normalizarCobros", () => {
  it("merges both sources, sets tipo by sign, sorts desc", () => {
    const c = normalizarCobros(ventas as any, cobranzas as any);
    expect(c).toHaveLength(3);
    expect(c[0].fecha >= c[1].fecha).toBe(true);
    const nc = c.find((x) => x.monto < 0)!;
    expect(nc.tipo).toBe("DEVOLUCION");
    expect(c.find((x) => x.origen === "CTA_CTE")?.formaPago).toBe("TRANSFERENCIA");
  });
});

describe("totalesPorMedio", () => {
  it("sums signed by medio", () => {
    const t = totalesPorMedio(normalizarCobros(ventas as any, cobranzas as any));
    expect(t.find((x) => x.formaPago === "EFECTIVO")?.total).toBe(600); // 1000 - 400
    expect(t.find((x) => x.formaPago === "TRANSFERENCIA")?.total).toBe(500);
  });
});

describe("resumenPagos", () => {
  it("net total, ticket excludes devoluciones", () => {
    const r = resumenPagos(normalizarCobros(ventas as any, cobranzas as any));
    expect(r.totalNeto).toBe(1100); // 1000 - 400 + 500
    expect(r.efectivo).toBe(600);
    expect(r.electronico).toBe(500);
    expect(r.cantidad).toBe(2); // dos cobros positivos
    expect(r.ticketPromedio).toBe(750); // (1000 + 500) / 2
  });
});

describe("serieDiaria", () => {
  it("groups by day ascending", () => {
    const s = serieDiaria(normalizarCobros(ventas as any, cobranzas as any));
    expect(s).toHaveLength(2); // 10/07 y 11/07
    expect(s[0].total).toBe(1500); // 10/07: 1000 + 500
    expect(s[1].total).toBe(-400); // 11/07: NC
  });
});
