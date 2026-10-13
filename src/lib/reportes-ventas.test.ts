import { describe, expect, it } from "vitest";
import { clasificarFacturacion, resumirCobros, resumirVentas } from "./reportes-ventas";

describe("facturación en reportes", () => {
  it("solo considera facturada una factura con CAE real", () => {
    expect(
      clasificarFacturacion({
        tipo_comprobante: "FACTURA_B",
        cae: "123456789",
        afip_estado: "APROBADO",
        afip_modo: "PRODUCCION",
        afip_simulado: false,
      }),
    ).toBe("FACTURADO");
    expect(
      clasificarFacturacion({
        tipo_comprobante: "FACTURA_B",
        cae: "123456789",
        afip_estado: "PENDIENTE",
        afip_modo: "PRODUCCION",
        afip_simulado: false,
      }),
    ).toBe("SIN_CAE");
    expect(
      clasificarFacturacion({
        tipo_comprobante: "FACTURA_B",
        cae: null,
        afip_estado: "PENDIENTE",
        afip_modo: null,
        afip_simulado: false,
      }),
    ).toBe("SIN_CAE");
    expect(
      clasificarFacturacion({
        tipo_comprobante: "FACTURA_B",
        cae: "SIMULADO",
        afip_estado: "APROBADO",
        afip_modo: "PRODUCCION",
        afip_simulado: true,
      }),
    ).toBe("SIN_CAE");
    expect(
      clasificarFacturacion({
        tipo_comprobante: "FACTURA_B",
        cae: "123456789",
        afip_estado: "APROBADO",
        afip_modo: "HOMOLOGACION",
        afip_simulado: false,
      }),
    ).toBe("SIN_CAE");
    expect(
      clasificarFacturacion({
        tipo_comprobante: "NOTA_CREDITO",
        afip_cbte_asoc_id: null,
        cae: null,
        afip_estado: "NO_APLICA",
        afip_modo: null,
        afip_simulado: false,
      }),
    ).toBe("SIN_FACTURAR");
    expect(
      clasificarFacturacion({
        tipo_comprobante: "REMITO",
        cae: null,
        afip_estado: "NO_APLICA",
        afip_modo: null,
        afip_simulado: false,
      }),
    ).toBe("SIN_FACTURAR");
  });

  it("incluye las ventas VENTA autorizadas por ARCA en el IVA y los cobros facturados", () => {
    const venta = {
      tipo_comprobante: "VENTA",
      cae: "74123456789012",
      afip_estado: "APROBADO",
      afip_modo: "PRODUCCION",
      afip_validez: "PRODUCCION",
      afip_simulado: false,
    };

    expect(clasificarFacturacion(venta)).toBe("FACTURADO");
    expect(resumirVentas([{ ...venta, estado: "ACTIVA", total: 121, iva_total: 21 }]).ivaConCae).toBe(21);
    expect(resumirCobros([{ monto: 121, forma_pago: "EFECTIVO", venta }], []).facturado).toBe(121);
  });

  it("separa una emisión VENTA fallida de una venta todavía sin facturar", () => {
    const venta = {
      tipo_comprobante: "VENTA",
      cae: null,
      afip_modo: null,
      afip_simulado: false,
    };

    expect(clasificarFacturacion({ ...venta, afip_estado: "ERROR_CORREGIBLE" })).toBe("SIN_CAE");
    expect(clasificarFacturacion({ ...venta, afip_estado: "SIN_FACTURAR" })).toBe("SIN_FACTURAR");
  });

  it("cuenta una nota de crédito de período con CAE real aunque no tenga factura asociada", () => {
    expect(clasificarFacturacion({
      tipo_comprobante: "NOTA_CREDITO",
      afip_cbte_asoc_id: null,
      cae: "74123456789012",
      afip_estado: "APROBADO",
      afip_modo: "PRODUCCION",
      afip_simulado: false,
    })).toBe("FACTURADO");
  });

  it("no cuenta como real un CAE marcado como simulado aunque el modo diga producción", () => {
    expect(clasificarFacturacion({
      tipo_comprobante: "VENTA",
      cae: "74123456789012",
      afip_estado: "APROBADO",
      afip_modo: "PRODUCCION",
      afip_validez: "SIMULADA",
      afip_simulado: false,
    })).toBe("SIN_CAE");
  });

  it("separa los pagos directos por estado fiscal y deja las cobranzas de cuenta corriente aparte", () => {
    const cobros = resumirCobros(
      [
        {
          monto: 121,
          forma_pago: "EFECTIVO",
          venta: {
            tipo_comprobante: "FACTURA_B",
            cae: "123",
            afip_estado: "APROBADO",
            afip_modo: "PRODUCCION",
            afip_simulado: false,
          },
        },
        {
          monto: 80,
          forma_pago: "TRANSFERENCIA",
          venta: {
            tipo_comprobante: "FACTURA_B",
            cae: null,
            afip_estado: "PENDIENTE",
            afip_modo: null,
            afip_simulado: false,
          },
        },
        {
          monto: 50,
          forma_pago: "EFECTIVO",
          venta: {
            tipo_comprobante: "REMITO",
            cae: null,
            afip_estado: "NO_APLICA",
            afip_modo: null,
            afip_simulado: false,
          },
        },
      ],
      [{ monto: 30, forma_pago: "EFECTIVO" }],
    );

    expect(cobros).toEqual({
      facturado: 121,
      sinCae: 80,
      sinFacturar: 50,
      cuentaCorriente: 30,
      total: 281,
      porPago: { EFECTIVO: 201, TRANSFERENCIA: 80 },
    });
  });

  it("calcula el IVA con CAE incluyendo el signo de una nota de crédito autorizada", () => {
    const ventas = [
      {
        tipo_comprobante: "FACTURA_B",
        estado: "ANULADA",
        total: 121,
        iva_total: 21,
        cae: "111",
        afip_estado: "APROBADO",
        afip_modo: "PRODUCCION",
        afip_simulado: false,
      },
      {
        tipo_comprobante: "REMITO",
        estado: "ACTIVA",
        total: 121,
        iva_total: 21,
        cae: null,
        afip_estado: "NO_APLICA",
        afip_modo: null,
        afip_simulado: false,
      },
      {
        tipo_comprobante: "FACTURA_B",
        estado: "ACTIVA",
        total: 121,
        iva_total: 21,
        cae: null,
        afip_estado: "PENDIENTE",
        afip_modo: null,
        afip_simulado: false,
      },
      {
        tipo_comprobante: "NOTA_CREDITO",
        estado: "ACTIVA",
        afip_cbte_asoc_id: "venta-1",
        total: -121,
        iva_total: -21,
        cae: "222",
        afip_estado: "APROBADO",
        afip_modo: "PRODUCCION",
        afip_simulado: false,
      },
    ];

    expect(resumirVentas(ventas)).toEqual({
      vendido: 242,
      ivaConCae: 0,
      notasCredito: 121,
      cantidad: 2,
      ticket: 121,
    });
  });

  it("suma el IVA en centavos sin residuos de coma flotante", () => {
    const fiscal = {
      tipo_comprobante: "FACTURA_B",
      estado: "ACTIVA",
      total: 1,
      cae: "123",
      afip_estado: "APROBADO",
      afip_modo: "PRODUCCION",
      afip_simulado: false,
    };
    expect(
      resumirVentas([
        { ...fiscal, iva_total: 0.1 },
        { ...fiscal, iva_total: 0.2 },
      ]).ivaConCae,
    ).toBe(0.3);
  });
});
