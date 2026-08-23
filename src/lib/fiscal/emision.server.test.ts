import { describe, expect, it } from "vitest";
import {
  construirPreviewBorradorFiscalProvisional,
  construirSnapshotFiscalDesdeLectura,
} from "./emision.server";
import { validarSnapshotFiscalV2 } from "./snapshot";

function preparacion(percepciones = "0.00") {
  return {
    lectura: {
      venta: {
        id: "71000000-0000-4000-8000-000000000001",
        sucursalId: "71000000-0000-4000-8000-000000000301",
        clienteId: null,
        fechaComercial: "2026-08-22T15:00:00.000Z",
        numeroComercial: "V-1",
        tipoComprobante: "VENTA",
        condicionVenta: "CONTADO",
        estado: "ACTIVA",
        subtotalSinIva: "0.15",
        ivaTotal: "0.03",
        percepciones,
        total: percepciones === "0.00" ? "0.18" : "0.20",
        totalPagado: "0.00",
        saldo: percepciones === "0.00" ? "0.18" : "0.20",
        afipEstado: "SIN_FACTURAR",
        afipFase: null,
        afipClaimToken: null,
        afipNumero: null,
        afipVersion: 0,
        afipEmisorCuit: null,
        afipPuntoVenta: null,
        afipCbteTipo: null,
        afipModo: null,
        afipSimulado: false,
        afipValidez: null,
        afipFechaComprobante: null,
        afipImpTotal: null,
        afipSnapshot: null,
        afipSnapshotHash: null,
        afipCbteAsocId: null,
        cae: null,
        caeVencimiento: null,
      },
      items: [
        {
          id: "71000000-0000-4000-8000-000000000011",
          productoId: null,
          codigo: "BORDE",
          descripcion: "Deriva binaria",
          cantidad: "7.25",
          precioUnitarioSinIva: "0.02",
          descuentoPorcentaje: "0.00",
          ivaPorcentaje: "21.00",
          subtotalNeto: "0.15",
          importeIva: "0.03",
          subtotalTotal: "0.18",
        },
      ],
    },
    contexto: {
      emisor: {
        cuit: "30714199664",
        condicion_iva: "RESPONSABLE_INSCRIPTO",
        arca_key_enc: "key",
        arca_cert_enc: "cert",
      },
      emisorImpreso: {
        razon_social: "EMISOR",
        nombre_fantasia: null,
        cuit: "30714199664",
        domicilio_fiscal: "Domicilio",
        condicion_iva: "RESPONSABLE_INSCRIPTO",
        ingresos_brutos: null,
        inicio_actividades: "2020-01-01",
        telefono: null,
      },
      pv: { numero: 5, modo: "HOMOLOGACION" },
      sucursal: {
        id: "71000000-0000-4000-8000-000000000301",
        nombre: "Sucursal",
        telefono: null,
        emisor_id: "71000000-0000-4000-8000-000000000201",
      },
      facturaA: { modalidad: "ESTANDAR_CONFIRMADA", revalidar_at: "2027-01-01" },
    },
    direccionSucursal: "Domicilio sucursal",
    receptor: {
      razonSocial: "Consumidor Final",
      domicilio: null,
      tipoDocumento: "SIN_IDENTIFICAR",
      numeroDocumento: null,
      docTipoArca: 99,
      docNroArca: "0",
      condicionIva: "CONSUMIDOR_FINAL",
      origen: "CLIENTE_COMERCIAL",
      origenId: null,
      verificadoArcaAt: null,
    },
    letra: "B",
    original: null,
  } as const;
}

describe("Snapshot desde lectura PostgreSQL exacta", () => {
  it("conserva el redondeo fixed-point 0.02 × 7.25 = 0.15 sin iva.ts", () => {
    const snapshot = construirSnapshotFiscalDesdeLectura({
      preparacion: preparacion() as never,
      numero: 1,
      fechaComprobante: "2026-08-22",
    });
    expect(snapshot.items[0].subtotalNeto).toBe("0.15");
    expect(snapshot.importeTotal).toBe("0.18");
    expect(validarSnapshotFiscalV2(snapshot)).toEqual(snapshot);
  });

  it("mapea percepciones con descripción obligatoria y strings canónicos", () => {
    const snapshot = construirSnapshotFiscalDesdeLectura({
      preparacion: preparacion("0.02") as never,
      numero: 1,
      fechaComprobante: "2026-08-22",
    });
    expect(snapshot.tributos).toEqual([
      {
        id: 99,
        descripcion: "Percepciones",
        baseImponible: "0.15",
        alicuota: "0.00",
        importe: "0.02",
      },
    ]);
    expect(snapshot.otrosImpuestosNacionalesIndirectos).toBe("0.02");
  });
});

describe("preview provisional de borrador", () => {
  it("resuelve catálogo/receptor/contexto y devuelve todos los campos sin escribir", async () => {
    const resultado = await construirPreviewBorradorFiscalProvisional(
      {
        sucursalId: "71000000-0000-4000-8000-000000000301",
        clienteId: "71000000-0000-4000-8000-000000000401",
        fechaComercial: "2026-08-10T15:00:00.000Z",
        items: [
          {
            producto_id: "71000000-0000-4000-8000-000000000501",
            cantidad: 7.25,
            descuento_porcentaje: 0,
            precio_unitario_sin_iva: 0.02,
          },
        ],
        pagos: [{ forma_pago: "EFECTIVO", monto: 0.1, detalle: {} }],
        percepciones: 0.02,
        receptor: { origen: "CLIENTE_COMERCIAL" },
      },
      {
        cargarContexto: async () => preparacion().contexto as never,
        cargarCliente: async () => ({
          id: "71000000-0000-4000-8000-000000000401",
          razonSocial: "Consumidor Final",
          cuitDni: null,
          tipo: "CONSUMIDOR_FINAL",
          direccion: null,
        }),
        cargarProductos: async () => [
          {
            id: "71000000-0000-4000-8000-000000000501",
            activo: true,
            precioSinIva: 999,
            ivaPorcentaje: 21,
          },
        ],
        cargarFavorito: async () => null,
        ahora: () => new Date("2026-08-22T15:00:00.000Z"),
      },
    );

    expect(resultado).toMatchObject({
      autoritativo: false,
      requiere_reconfirmacion_post_creacion: true,
      comprador: "71000000-0000-4000-8000-000000000401",
      letra: "B",
      emisor_cuit: "30714199664",
      punto_venta: 5,
      modo: "HOMOLOGACION",
      fecha_comercial: "2026-08-10T15:00:00.000Z",
      fecha_fiscal: "2026-08-22",
      demora_dias: 12,
      total: "0.20",
      pagado: "0.10",
      saldo: "0.10",
    });
    expect(resultado.receptor.tipoDocumento).toBe("SIN_IDENTIFICAR");
    expect(resultado.confirmacion_provisional).toMatchObject({
      importe: "0.20",
      emisor_cuit: "30714199664",
      punto_venta: 5,
      letra: "B",
    });
  });

  it("falla cerrado si el catálogo no resuelve exactamente todos los productos", async () => {
    await expect(
      construirPreviewBorradorFiscalProvisional(
        {
          sucursalId: "71000000-0000-4000-8000-000000000301",
          clienteId: "71000000-0000-4000-8000-000000000401",
          fechaComercial: "2026-08-22T15:00:00.000Z",
          items: [
            {
              producto_id: "71000000-0000-4000-8000-000000000501",
              cantidad: 1,
              descuento_porcentaje: 0,
            },
          ],
          pagos: [],
          percepciones: 0,
          receptor: { origen: "CLIENTE_COMERCIAL" },
        },
        {
          cargarContexto: async () => preparacion().contexto as never,
          cargarCliente: async () => ({
            id: "71000000-0000-4000-8000-000000000401",
            razonSocial: "Consumidor Final",
            cuitDni: null,
            tipo: "CONSUMIDOR_FINAL",
            direccion: null,
          }),
          cargarProductos: async () => [],
          cargarFavorito: async () => null,
          ahora: () => new Date("2026-08-22T15:00:00.000Z"),
        },
      ),
    ).rejects.toThrow(/producto.*activo/i);
  });
});
