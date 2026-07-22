import { describe, it, expect } from "vitest";
import { calcTotalesComprobante } from "./ventas-totales";

// R3 — Bug del centavo. El front sumaba el IVA sin redondear por línea y daba
// $153.253,05; el server redondea el IVA POR LÍNEA (ROUND por ítem) y da
// $153.253,04. El pago electrónico se precargaba con el total del front (1
// centavo mayor) y la RPC lo rechazaba ("los pagos electrónicos superan el
// total"). calcTotalesComprobante debe calcular EXACTAMENTE igual que el server.
describe("calcTotalesComprobante", () => {
  it("redondea el IVA por línea igual que el server (caso exacto de la captura)", () => {
    const items = [
      { precio_unitario_sin_iva: 120490.35, precio_lista: 120490.35, cantidad: 1, descuento_porcentaje: 0, iva_porcentaje: 21 },
      { precio_unitario_sin_iva: 6165.06, precio_lista: 6165.06, cantidad: 1, descuento_porcentaje: 0, iva_porcentaje: 21 },
    ];
    const t = calcTotalesComprobante(items, 0, 1);
    expect(t.sub).toBe(126655.41);
    expect(t.iva).toBe(26597.63); // NO 26597.6361
    expect(t.total).toBe(153253.04); // NO 153253.05
  });

  it("aplica signo negativo en una nota de crédito", () => {
    const items = [
      { precio_unitario_sin_iva: 100, precio_lista: 100, cantidad: 1, descuento_porcentaje: 0, iva_porcentaje: 21 },
    ];
    const t = calcTotalesComprobante(items, 0, -1);
    expect(t.sub).toBe(-100);
    expect(t.iva).toBe(-21);
    expect(t.total).toBe(-121);
  });

  it("usa el precio de lista cuando el precio tipeado es null (no lo trata como 0)", () => {
    const items = [
      { precio_unitario_sin_iva: null, precio_lista: 200, cantidad: 2, descuento_porcentaje: 0, iva_porcentaje: 21 },
    ];
    const t = calcTotalesComprobante(items, 0, 1);
    expect(t.sub).toBe(400);
    expect(t.iva).toBe(84);
    expect(t.total).toBe(484);
  });

  it("suma las percepciones al total, con el mismo signo", () => {
    const items = [
      { precio_unitario_sin_iva: 100, precio_lista: 100, cantidad: 1, descuento_porcentaje: 0, iva_porcentaje: 21 },
    ];
    const t = calcTotalesComprobante(items, 50, 1);
    expect(t.total).toBe(171); // 100 + 21 + 50
  });

  it("respeta la alícuota exenta (IVA 0%) sin forzar 21", () => {
    const items = [
      { precio_unitario_sin_iva: 1000, precio_lista: 1000, cantidad: 1, descuento_porcentaje: 0, iva_porcentaje: 0 },
    ];
    const t = calcTotalesComprobante(items, 0, 1);
    expect(t.iva).toBe(0);
    expect(t.total).toBe(1000);
  });

  it("aplica el descuento por línea antes del IVA", () => {
    const items = [
      { precio_unitario_sin_iva: 1000, precio_lista: 1000, cantidad: 1, descuento_porcentaje: 10, iva_porcentaje: 21 },
    ];
    const t = calcTotalesComprobante(items, 0, 1);
    expect(t.sub).toBe(900);
    expect(t.iva).toBe(189);
    expect(t.total).toBe(1089);
  });

  // R5: la Nota de Débito manda UNA línea de recargo "con IVA". El front calcula el
  // neto como recargoConIVA/1.21; al pasar por la fórmula del server el total debe
  // reconstruir el recargo con IVA (± 1 centavo de redondeo). Ej: 10% de $74.052.
  it("reconstruye el recargo con IVA de una nota de débito (10% de 74052)", () => {
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const recargoConIVA = round2(74052 * 0.10); // 7405.2
    const recargoNeto = round2(recargoConIVA / 1.21); // 6119.17
    const t = calcTotalesComprobante(
      [{ precio_unitario_sin_iva: recargoNeto, precio_lista: recargoNeto, cantidad: 1, descuento_porcentaje: 0, iva_porcentaje: 21 }],
      0, 1,
    );
    expect(Math.abs(t.total - recargoConIVA)).toBeLessThanOrEqual(0.01);
  });
});
