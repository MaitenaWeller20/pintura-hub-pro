import { describe, expect, it } from "vitest";

import {
  exigirCeroResiduosFixture,
  exigirSesionesCajaPropiasSinReferencias,
} from "../../../e2e/fixtures/limpieza-caja";

const sinReferencias = {
  ventas: 0,
  venta_pagos: 0,
  caja_movimientos: 0,
  cobranzas_cta_cte: 0,
  compras: 0,
  proveedor_pagos: 0,
};

describe("cleanup de cajas del fixture fiscal", () => {
  it("permite borrar una caja abierta por un usuario creado cuando ya no tiene referencias", () => {
    expect(
      exigirSesionesCajaPropiasSinReferencias(
        [{ id: "caja-propia", abierta_por: "usuario-e2e", cerrada_por: null }],
        new Set(["usuario-e2e"]),
        { "caja-propia": sinReferencias },
      ),
    ).toEqual(["caja-propia"]);
  });

  it("rechaza una caja ajena que el usuario E2E sólo haya cerrado", () => {
    expect(() =>
      exigirSesionesCajaPropiasSinReferencias(
        [{ id: "caja-ajena", abierta_por: "usuario-real", cerrada_por: "usuario-e2e" }],
        new Set(["usuario-e2e"]),
        { "caja-ajena": sinReferencias },
      ),
    ).toThrow(/caja ajena/i);
  });

  it("rechaza borrar una caja propia mientras conserve referencias comerciales", () => {
    expect(() =>
      exigirSesionesCajaPropiasSinReferencias(
        [{ id: "caja-con-venta", abierta_por: "usuario-e2e", cerrada_por: null }],
        new Set(["usuario-e2e"]),
        { "caja-con-venta": { ...sinReferencias, ventas: 1 } },
      ),
    ).toThrow(/ventas=1/i);
  });
});

describe("auditoría final del fixture fiscal", () => {
  it("acepta sólo ausencia total y enumera cada residuo", () => {
    expect(() => exigirCeroResiduosFixture({ ventas: 0, auth: 0, perfiles: 0 })).not.toThrow();
    expect(() => exigirCeroResiduosFixture({ ventas: 2, auth: 1, perfiles: 0 })).toThrow(
      /ventas=2.*auth=1/i,
    );
  });
});
