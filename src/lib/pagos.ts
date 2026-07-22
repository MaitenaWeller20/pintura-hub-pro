// Normalización y agregados de "cobros" (plata que entró), unificando dos fuentes:
//  - venta_pagos: pagos hechos en la venta (contado/parcial). Las notas de crédito
//    guardan monto NEGATIVO (devoluciones).
//  - cobranzas_cta_cte: cobros contra cuenta corriente.
// forma_pago es enum en venta_pagos pero text en cobranzas: nunca se castea; se
// muestra con formaPagoLabel[x] ?? x.
import { fmtDate } from "./format";

export type Cobro = {
  fecha: string;
  origen: "VENTA" | "CTA_CTE";
  cliente?: string;
  sucursalId: string;
  formaPago: string;
  monto: number; // firmado: negativo = devolución (NC)
  tipo: "COBRO" | "DEVOLUCION";
  comprobante?: string;
};

export type VentaRow = {
  fecha: string;
  numero_comprobante: string;
  sucursal_id: string;
  cliente?: { razon_social?: string | null } | null;
  pagos: Array<{ forma_pago: string; monto: number | string }>;
};

export type CobranzaRow = {
  fecha: string;
  sucursal_id: string;
  forma_pago: string;
  monto: number | string;
  cliente?: { razon_social?: string | null } | null;
};

const ELECTRONICO = new Set([
  "TRANSFERENCIA",
  "TARJETA_CREDITO",
  "TARJETA_DEBITO",
  "MERCADO_PAGO",
  "CHEQUE",
]);

function toNum(v: number | string): number {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return isNaN(n) ? 0 : n;
}

export function normalizarCobros(ventas: VentaRow[], cobranzas: CobranzaRow[]): Cobro[] {
  const cobros: Cobro[] = [];

  for (const v of ventas) {
    for (const p of v.pagos ?? []) {
      const monto = toNum(p.monto);
      cobros.push({
        fecha: v.fecha,
        origen: "VENTA",
        cliente: v.cliente?.razon_social ?? undefined,
        sucursalId: v.sucursal_id,
        formaPago: p.forma_pago,
        monto,
        tipo: monto >= 0 ? "COBRO" : "DEVOLUCION",
        comprobante: v.numero_comprobante,
      });
    }
  }

  for (const c of cobranzas) {
    const monto = toNum(c.monto);
    cobros.push({
      fecha: c.fecha,
      origen: "CTA_CTE",
      cliente: c.cliente?.razon_social ?? undefined,
      sucursalId: c.sucursal_id,
      formaPago: c.forma_pago,
      monto,
      tipo: monto >= 0 ? "COBRO" : "DEVOLUCION",
    });
  }

  // Orden descendente por fecha (más reciente primero).
  cobros.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
  return cobros;
}

export function totalesPorMedio(cobros: Cobro[]): Array<{ formaPago: string; total: number }> {
  const map = new Map<string, number>();
  for (const c of cobros) {
    map.set(c.formaPago, (map.get(c.formaPago) ?? 0) + c.monto);
  }
  return [...map.entries()]
    .map(([formaPago, total]) => ({ formaPago, total }))
    .filter((x) => Math.abs(x.total) > 0.005)
    .sort((a, b) => b.total - a.total);
}

export function resumenPagos(cobros: Cobro[]): {
  totalNeto: number;
  efectivo: number;
  electronico: number;
  // R10: montos BRUTOS (sólo cobros positivos) y devoluciones segregadas, para
  // no mostrar una devolución como un pago negativo embebido en un medio.
  cobradoBruto: number;
  efectivoBruto: number;
  electronicoBruto: number;
  devoluciones: number;
  ticketPromedio: number;
  cantidad: number;
} {
  let totalNeto = 0;
  let efectivo = 0;
  let electronico = 0;
  let cobradoBruto = 0;
  let efectivoBruto = 0;
  let electronicoBruto = 0;
  let devoluciones = 0;
  let sumPositivos = 0;
  let cantPositivos = 0;

  for (const c of cobros) {
    totalNeto += c.monto;
    if (c.formaPago === "EFECTIVO") efectivo += c.monto;
    else if (ELECTRONICO.has(c.formaPago)) electronico += c.monto;
    if (c.monto > 0) {
      sumPositivos += c.monto;
      cantPositivos += 1;
      cobradoBruto += c.monto;
      if (c.formaPago === "EFECTIVO") efectivoBruto += c.monto;
      else if (ELECTRONICO.has(c.formaPago)) electronicoBruto += c.monto;
    } else if (c.monto < 0) {
      devoluciones += -c.monto; // valor absoluto
    }
  }

  return {
    totalNeto,
    efectivo,
    electronico,
    cobradoBruto,
    efectivoBruto,
    electronicoBruto,
    devoluciones,
    ticketPromedio: cantPositivos > 0 ? sumPositivos / cantPositivos : 0,
    cantidad: cantPositivos,
  };
}

export function serieDiaria(cobros: Cobro[]): Array<{ fecha: string; total: number }> {
  const map = new Map<string, number>();
  for (const c of cobros) {
    const dia = fmtDate(c.fecha); // agrupa por día local AR
    map.set(dia, (map.get(dia) ?? 0) + c.monto);
  }
  // Orden ascendente por la fecha real (no por el label formateado).
  const byDay = [...map.entries()].map(([fecha, total]) => ({ fecha, total }));
  // Reordenar usando la primera aparición cronológica: reconstruimos desde cobros ordenados asc.
  const orden = [...new Set([...cobros].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)).map((c) => fmtDate(c.fecha)))];
  byDay.sort((a, b) => orden.indexOf(a.fecha) - orden.indexOf(b.fecha));
  return byDay;
}
