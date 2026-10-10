import { describe, expect, it } from "vitest";
import {
  calcularCierreEfectivo,
  construirCierreCajaRpc,
  efectivoRetiradoRegistrado,
} from "./cierre-caja";

describe("cierre de caja", () => {
  it("calcula el saldo que queda después de retirar efectivo", () => {
    expect(calcularCierreEfectivo(477_154.96, 430_000)).toEqual({
      efectivoDejado: 47_154.96,
      valido: true,
      error: null,
    });
  });

  it("impide retirar más de lo contado", () => {
    expect(calcularCierreEfectivo(100, 101).valido).toBe(false);
  });

  it("envía al servidor el saldo, no el retiro", () => {
    expect(construirCierreCajaRpc({
      sesionId: "caja-1",
      efectivoContado: 477_154.96,
      efectivoRetirado: 430_000,
      notas: "",
    })).toEqual({
      p_sesion_id: "caja-1",
      p_contado: { EFECTIVO: 477_154.96 },
      p_efectivo_dejado: 47_154.96,
      p_notas: undefined,
    });
  });

  it("recupera el importe retirado de cierres históricos", () => {
    expect(efectivoRetiradoRegistrado(477_154.96, 47_154.96)).toBe(430_000);
  });
});
