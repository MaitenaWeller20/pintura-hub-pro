import { describe, expect, it, vi } from "vitest";
import {
  confirmarCierreFiscalInmediato,
  crearControlCreacionVenta,
  opcionesCierreVenta,
  registrarVentaSinFactura,
  resultadoColaDespuesDeEmision,
  resumirCierreVenta,
} from "./ventas-ui";

const FLAGS_V2 = {
  facturacionV2Habilitada: true,
  facturacionLegacyHabilitada: false,
} as const;

const FLAGS_LEGACY = {
  facturacionV2Habilitada: false,
  facturacionLegacyHabilitada: true,
} as const;

const FLAGS_MANTENIMIENTO = {
  facturacionV2Habilitada: false,
  facturacionLegacyHabilitada: false,
} as const;

describe("decisión de cierre de venta", () => {
  it("ofrece los dos cierres únicamente para la venta neutral con capacidad fiscal", () => {
    expect(
      opcionesCierreVenta({
        ...FLAGS_V2,
        puedeFacturar: true,
        tipoComprobante: "VENTA",
      }),
    ).toEqual({
      tipoPersistido: "VENTA",
      bloqueado: false,
      explicacion: null,
      acciones: [
        { id: "REGISTRAR_Y_FACTURAR", etiqueta: "Registrar venta y facturar" },
        { id: "REGISTRAR_SIN_FACTURAR", etiqueta: "Registrar sin facturar" },
      ],
    });

    for (const tipoComprobante of [
      "REMITO",
      "REMITO_OBRA",
      "FAC_INTERNA_CTA_CTE",
      "NOTA_CREDITO",
      "NOTA_DEBITO",
    ] as const) {
      expect(
        opcionesCierreVenta({
          ...FLAGS_V2,
          puedeFacturar: true,
          tipoComprobante,
        }).acciones,
      ).toEqual([{ id: "REGISTRAR_UNICO", etiqueta: "Guardar" }]);
    }
  });

  it("una persona sin capacidad sólo registra y entiende por qué no puede emitir", () => {
    expect(
      opcionesCierreVenta({
        ...FLAGS_V2,
        puedeFacturar: false,
        tipoComprobante: "VENTA",
      }),
    ).toEqual({
      tipoPersistido: "VENTA",
      bloqueado: false,
      explicacion:
        "La venta quedará en la cola. Necesitás el permiso Puede facturar para emitirla.",
      acciones: [{ id: "REGISTRAR_SIN_FACTURAR", etiqueta: "Registrar sin facturar" }],
    });
  });

  it("mantiene el escritor y selector A/B legacy mientras sólo ese rollout está activo", () => {
    expect(
      opcionesCierreVenta({
        ...FLAGS_LEGACY,
        puedeFacturar: true,
        tipoComprobante: "FACTURA_A",
      }),
    ).toEqual({
      tipoPersistido: "FACTURA_A",
      bloqueado: false,
      explicacion: null,
      acciones: [{ id: "REGISTRAR_LEGACY", etiqueta: "Guardar" }],
    });
    expect(
      opcionesCierreVenta({
        ...FLAGS_LEGACY,
        puedeFacturar: true,
        tipoComprobante: "FACTURA_B",
      }).tipoPersistido,
    ).toBe("FACTURA_B");
  });

  it("frena una venta positiva antes de mutarla durante mantenimiento y deja operar internos/notas", () => {
    expect(
      opcionesCierreVenta({
        ...FLAGS_MANTENIMIENTO,
        puedeFacturar: true,
        tipoComprobante: "VENTA",
      }),
    ).toEqual({
      tipoPersistido: "VENTA",
      bloqueado: true,
      explicacion: "La facturación está en mantenimiento. No se registró la venta ni el cobro.",
      acciones: [],
    });
    expect(
      opcionesCierreVenta({
        ...FLAGS_MANTENIMIENTO,
        puedeFacturar: true,
        tipoComprobante: "REMITO",
      }).acciones,
    ).toEqual([{ id: "REGISTRAR_UNICO", etiqueta: "Guardar" }]);
  });

  it("rechaza el cuadrante inválido con ambos escritores activos", () => {
    expect(() =>
      opcionesCierreVenta({
        facturacionV2Habilitada: true,
        facturacionLegacyHabilitada: true,
        puedeFacturar: true,
        tipoComprobante: "VENTA",
      }),
    ).toThrow(/ambos escritores/i);
  });
});

describe("resumen y resultado fiscal", () => {
  it("factura el total comercial aunque ahora se cobre sólo una parte o quede en cuenta corriente", () => {
    expect(resumirCierreVenta({ total: 1_210, pagadoAhora: 210, esCtaCte: false })).toEqual({
      total: 1_210,
      pagadoAhora: 210,
      saldo: 1_000,
      esCtaCte: false,
      totalFiscal: 1_210,
    });
    expect(resumirCierreVenta({ total: 1_210, pagadoAhora: 0, esCtaCte: true })).toEqual({
      total: 1_210,
      pagadoAhora: 0,
      saldo: 1_210,
      esCtaCte: true,
      totalFiscal: 1_210,
    });
  });

  it.each([
    ["APROBADO", "factura_aprobada"],
    ["ERROR_CORREGIBLE", "venta_creada_factura_pendiente"],
    ["MANTENIMIENTO", "venta_creada_factura_pendiente"],
    ["RECONCILIAR", "venta_creada_requiere_revision"],
    ["BLOQUEADO", "venta_creada_requiere_revision"],
    ["EN_CURSO", "venta_creada_requiere_revision"],
    ["TRANSPORTE_INCIERTO", "venta_creada_requiere_revision"],
  ] as const)("mapea %s al resultado de cola exacto", (estado, resultado) => {
    expect(resultadoColaDespuesDeEmision(estado)).toBe(resultado);
  });
});

describe("creación comercial idempotente antes de emitir", () => {
  it("registrar sin factura crea una sola vez y devuelve la URL exacta sin pedir receptor ni ARCA", async () => {
    const control = crearControlCreacionVenta();
    const crearVenta = vi.fn(async (idempotencyKey: string) => {
      expect(idempotencyKey).toBe("71000000-0000-4000-8000-000000000001");
      return { id: "72000000-0000-4000-8000-000000000001" };
    });

    const [primera, dobleClick] = await Promise.all([
      registrarVentaSinFactura(control, "71000000-0000-4000-8000-000000000001", crearVenta),
      registrarVentaSinFactura(control, "71000000-0000-4000-8000-000000000001", crearVenta),
    ]);

    expect(crearVenta).toHaveBeenCalledTimes(1);
    expect(primera).toEqual({
      ventaId: "72000000-0000-4000-8000-000000000001",
      href: "/facturacion/cola?venta=72000000-0000-4000-8000-000000000001&resultado=venta_creada_factura_pendiente",
    });
    expect(dobleClick).toEqual(primera);
  });

  it("preview confirmada crea una vez, conserva el ID y la segunda confirmación sólo reenvía la nueva huella", async () => {
    const control = crearControlCreacionVenta();
    const crearVenta = vi.fn(async () => ({
      id: "72000000-0000-4000-8000-000000000002",
    }));
    const emitirPostBorrador = vi
      .fn()
      .mockResolvedValueOnce({
        estado: "RECONFIRMACION_REQUERIDA",
        huella_confirmacion: "b".repeat(64),
      })
      .mockResolvedValueOnce({ estado: "APROBADO", cae: "74111111111111" });

    const primera = await confirmarCierreFiscalInmediato(
      {
        control,
        idempotencyKey: "71000000-0000-4000-8000-000000000002",
        receptor: { origen: "CLIENTE_COMERCIAL" },
        confirmaVentaAntigua: false,
        huellaConfirmacion: "a".repeat(64),
      },
      { crearVenta, emitirPostBorrador },
    );
    const segunda = await confirmarCierreFiscalInmediato(
      {
        control,
        idempotencyKey: "71000000-0000-4000-8000-000000000002",
        receptor: { origen: "CLIENTE_COMERCIAL" },
        confirmaVentaAntigua: false,
        huellaConfirmacion: "b".repeat(64),
      },
      { crearVenta, emitirPostBorrador },
    );

    expect(primera).toMatchObject({ estado: "RECONFIRMACION_REQUERIDA" });
    expect(segunda).toMatchObject({ estado: "APROBADO" });
    expect(crearVenta).toHaveBeenCalledTimes(1);
    expect(emitirPostBorrador).toHaveBeenNthCalledWith(1, {
      ventaId: "72000000-0000-4000-8000-000000000002",
      receptor: { origen: "CLIENTE_COMERCIAL" },
      confirmaVentaAntigua: false,
      huellaConfirmacion: "a".repeat(64),
    });
    expect(emitirPostBorrador).toHaveBeenNthCalledWith(2, {
      ventaId: "72000000-0000-4000-8000-000000000002",
      receptor: { origen: "CLIENTE_COMERCIAL" },
      confirmaVentaAntigua: false,
      huellaConfirmacion: "b".repeat(64),
    });
  });

  it("si crear la venta falla no llama emisión y permite reintentar la misma clave", async () => {
    const control = crearControlCreacionVenta();
    const crearVenta = vi
      .fn()
      .mockRejectedValueOnce(new Error("venta no creada"))
      .mockResolvedValueOnce({ id: "72000000-0000-4000-8000-000000000003" });
    const emitirPostBorrador = vi.fn(async () => ({ estado: "APROBADO" }));
    const input = {
      control,
      idempotencyKey: "71000000-0000-4000-8000-000000000003",
      receptor: { origen: "CLIENTE_COMERCIAL" as const },
      confirmaVentaAntigua: false,
      huellaConfirmacion: "c".repeat(64),
    };

    await expect(
      confirmarCierreFiscalInmediato(input, { crearVenta, emitirPostBorrador }),
    ).rejects.toThrow("venta no creada");
    expect(emitirPostBorrador).not.toHaveBeenCalled();

    await confirmarCierreFiscalInmediato(input, { crearVenta, emitirPostBorrador });
    expect(crearVenta).toHaveBeenCalledTimes(2);
    expect(emitirPostBorrador).toHaveBeenCalledTimes(1);
  });
});
