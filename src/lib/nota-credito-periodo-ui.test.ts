import { describe, expect, it } from "vitest";
import {
  camposVisiblesNcPeriodo,
  cambiarModalidadNcPeriodo,
  cambiarResolucionNcPeriodo,
  excluirPendientesFiscalesDeConsulta,
  esVentaVisibleEnListadoComercial,
  puedeIniciarNcPeriodo,
  resumenEfectosNcPeriodo,
  validarEnvioNcPeriodo,
} from "./nota-credito-periodo-ui";

describe("estado visible de la NC fiscal por período", () => {
  it("habilita el camino por período sólo con v2, flag y capacidad efectiva", () => {
    expect(puedeIniciarNcPeriodo({ v2: true, periodoHabilitado: true, puedeEmitir: true })).toBe(
      true,
    );
    expect(puedeIniciarNcPeriodo({ v2: true, periodoHabilitado: true, puedeEmitir: false })).toBe(
      false,
    );
    expect(puedeIniciarNcPeriodo({ v2: false, periodoHabilitado: true, puedeEmitir: true })).toBe(
      false,
    );
  });

  it("separa los campos de productos y concepto al cambiar de modalidad", () => {
    expect(camposVisiblesNcPeriodo("DEVOLUCION_PRODUCTOS")).toEqual({
      productos: true,
      concepto: false,
    });
    expect(
      cambiarModalidadNcPeriodo("DEVOLUCION_PRODUCTOS", {
        productos: [{ productoId: "p", descripcion: "Piso", cantidad: 1 }],
        concepto: "",
      }),
    ).toEqual({ productos: [], concepto: "" });
  });

  it("limpia el medio de reintegro incompatible al acreditar saldo a favor", () => {
    expect(
      cambiarResolucionNcPeriodo("SALDO_FAVOR", [{ formaPago: "EFECTIVO", montoCentavos: 100 }]),
    ).toEqual([]);
  });

  it("no precompleta las fechas del período", () => {
    expect(
      cambiarModalidadNcPeriodo("BONIFICACION_AJUSTE", { productos: [], concepto: "" }),
    ).not.toHaveProperty("periodoDesde");
  });
});

describe("resumen operacional", () => {
  it("informa que la devolución aumenta stock sólo tras CAE y lista cantidades", () => {
    expect(
      resumenEfectosNcPeriodo({
        modalidad: "DEVOLUCION_PRODUCTOS",
        resolucion: "REINTEGRO",
        items: [{ descripcion: "Piso porcelanato", cantidad: 2 }],
        pagos: [{ formaPago: "EFECTIVO", montoCentavos: 12100 }],
        totalCentavos: 12100,
        clienteComercial: "Casa Forma SA",
        receptorFiscal: "Casa Forma SA",
      }),
    ).toEqual({
      stock: "Después del CAE, aumenta stock: 2 × Piso porcelanato.",
      liquidacion: ["Reintegro exacto: $121,00 por efectivo."],
      advertenciaTitular: null,
    });
  });

  it("indica que un ajuste no modifica stock y conserva ambos titulares", () => {
    expect(
      resumenEfectosNcPeriodo({
        modalidad: "BONIFICACION_AJUSTE",
        resolucion: "SALDO_FAVOR",
        items: [{ descripcion: "Bonificación julio", cantidad: 1 }],
        pagos: [],
        totalCentavos: 5000,
        clienteComercial: "Cuenta comercial Obra Norte",
        receptorFiscal: "Constructora Sur SA",
      }),
    ).toEqual({
      stock: "No modifica stock.",
      liquidacion: ["Saldo a favor exacto: $50,00 en la cuenta comercial."],
      advertenciaTitular:
        "El crédito queda en Cuenta comercial Obra Norte; el receptor fiscal es Constructora Sur SA.",
    });
  });
});

describe("gating de envío y listado", () => {
  it("no permite seguir sin receptor confirmado, liquidación exacta y revisión", () => {
    expect(
      validarEnvioNcPeriodo({
        receptorConfirmado: false,
        liquidacionExacta: true,
        confirmaPeriodo: true,
      }),
    ).toEqual({ ok: false, mensaje: "Confirmá el receptor fiscal antes de emitir." });
    expect(
      validarEnvioNcPeriodo({
        receptorConfirmado: true,
        liquidacionExacta: false,
        confirmaPeriodo: true,
      }),
    ).toEqual({ ok: false, mensaje: "El reintegro debe coincidir exactamente con el total." });
    expect(
      validarEnvioNcPeriodo({
        receptorConfirmado: true,
        liquidacionExacta: true,
        confirmaPeriodo: false,
      }),
    ).toEqual({
      ok: false,
      mensaje: "Confirmá que el período corresponde a las operaciones ajustadas.",
    });
  });

  it("oculta pendientes fiscales del listado comercial y conserva activas", () => {
    expect(esVentaVisibleEnListadoComercial("PENDIENTE_FISCAL")).toBe(false);
    expect(esVentaVisibleEnListadoComercial("ACTIVA")).toBe(true);
  });

  it("excluye pendientes fiscales de la consulta antes de ordenar y limitar", () => {
    const calls: string[] = [];
    const query = {
      neq: (column: never, value: never) => {
        calls.push(`neq:${column}:${value}`);
        return query;
      },
      order: () => {
        calls.push("order");
        return query;
      },
      limit: () => {
        calls.push("limit");
        return query;
      },
    };

    excluirPendientesFiscalesDeConsulta(query).order().limit();
    expect(calls).toEqual(["neq:estado:PENDIENTE_FISCAL", "order", "limit"]);
  });
});
