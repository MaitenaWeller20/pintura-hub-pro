import { describe, expect, it } from "vitest";
import {
  FORMAS_PAGO_CORREGIBLES,
  leerCorreccionFormaPagoCaja,
  mensajeErrorCorreccionFormaPago,
  validarCorreccionFormaPago,
} from "./correccion-forma-pago";

describe("corrección de forma de pago", () => {
  it("ofrece todos los medios cobrables y nunca cuenta corriente", () => {
    expect(FORMAS_PAGO_CORREGIBLES).toEqual([
      "EFECTIVO",
      "TRANSFERENCIA",
      "TARJETA_DEBITO",
      "TARJETA_CREDITO",
      "MERCADO_PAGO",
      "CHEQUE",
    ]);
    expect(FORMAS_PAGO_CORREGIBLES).not.toContain("CTA_CTE");
  });

  it("exige un cambio real y un motivo concreto de hasta 1000 caracteres", () => {
    expect(
      validarCorreccionFormaPago({
        formaActual: "EFECTIVO",
        formaNueva: "EFECTIVO",
        motivo: "Se informó mal el medio",
      }),
    ).toContain("distinta");
    expect(
      validarCorreccionFormaPago({
        formaActual: "EFECTIVO",
        formaNueva: "TRANSFERENCIA",
        motivo: "mal",
      }),
    ).toContain("motivo");
    expect(
      validarCorreccionFormaPago({
        formaActual: "EFECTIVO",
        formaNueva: "TRANSFERENCIA",
        motivo: "x".repeat(1001),
      }),
    ).toContain("1000");
    expect(
      validarCorreccionFormaPago({
        formaActual: "EFECTIVO",
        formaNueva: "TRANSFERENCIA",
        motivo: "Se informó efectivo en vez de transferencia",
      }),
    ).toBeNull();
  });

  it("preserva errores operativos conocidos y oculta detalles técnicos", () => {
    expect(
      mensajeErrorCorreccionFormaPago(
        new Error(
          "Otra persona corrigió este pago. Cerrá esta ventana, revisá los cambios y volvé a intentarlo.",
        ),
      ),
    ).toContain("Otra persona corrigió");
    expect(
      mensajeErrorCorreccionFormaPago(
        new Error('PGRST204: column "correccion_version" does not exist'),
      ),
    ).toBe(
      "No pudimos corregir la forma de pago. No se guardó ningún cambio; actualizá la venta y volvé a intentar.",
    );
  });

  it("reconoce únicamente auditorías de caja originadas por un pago", () => {
    expect(
      leerCorreccionFormaPagoCaja({
        campos_modificados: ["forma_pago_venta"],
        valores_anteriores: {
          pago: {
            id: "pago-1",
            venta_id: "venta-1",
            forma_pago: "EFECTIVO",
            monto: 299386.55,
          },
        },
        valores_nuevos: {
          pago: {
            id: "pago-1",
            venta_id: "venta-1",
            forma_pago: "TRANSFERENCIA",
            monto: 299386.55,
          },
        },
      }),
    ).toEqual({
      pagoId: "pago-1",
      ventaId: "venta-1",
      formaAnterior: "EFECTIVO",
      formaNueva: "TRANSFERENCIA",
      monto: 299386.55,
    });

    expect(
      leerCorreccionFormaPagoCaja({
        campos_modificados: ["efectivo_contado"],
        valores_anteriores: {},
        valores_nuevos: {},
      }),
    ).toBeNull();
  });
});
