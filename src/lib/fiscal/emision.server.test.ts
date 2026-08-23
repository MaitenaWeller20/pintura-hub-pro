import { describe, expect, it } from "vitest";
import {
  cargarContextoArcaCongelado,
  construirPreviewBorradorFiscalProvisional,
  construirSnapshotFiscalDesdeLectura,
  crearHuellaConfirmacionFiscal,
  emitirPostBorradorConHuella,
  type ConfirmacionFiscalPostBorrador,
} from "./emision.server";
import type { ReservaFiscalPersistida } from "./emision";
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

function reservaCongelada(): ReservaFiscalPersistida {
  const frozen = construirSnapshotFiscalDesdeLectura({
    preparacion: preparacion() as never,
    numero: 42,
    fechaComprobante: "2026-08-22",
  });
  return {
    ventaId: frozen.venta.id,
    claimToken: "81000000-0000-4000-8000-000000000001",
    afipVersion: 4,
    numero: frozen.identidad.numero,
    snapshot: frozen,
    payloadHash: frozen.hash,
    emisorCuit: frozen.identidad.emisorCuit,
    puntoVenta: frozen.identidad.puntoVenta,
    cbteTipo: frozen.identidad.cbteTipo,
    modo: frozen.identidad.modo,
  };
}

describe("credencial ARCA congelada después de reservar", () => {
  it("ignora la asignación viva editada y carga por snapshot.emisor.id + modo congelado", async () => {
    const reserva = reservaCongelada();
    const lecturas: string[] = [];

    const contexto = await cargarContextoArcaCongelado(reserva, {
      cargarEmisor: async (id) => {
        lecturas.push(`emisor:${id}`);
        return { id, cuit: "30714199664" };
      },
      cargarCredencial: async (emisorId, modo) => {
        lecturas.push(`credencial:${emisorId}:${modo}`);
        return {
          emisorId,
          ambiente: modo,
          arcaKeyEnc: "key-congelada",
          arcaCertEnc: "cert-congelado",
        };
      },
    });

    expect(lecturas).toEqual([
      "emisor:71000000-0000-4000-8000-000000000201",
      "credencial:71000000-0000-4000-8000-000000000201:HOMOLOGACION",
    ]);
    expect(contexto).toEqual({
      emisor: {
        cuit: "30714199664",
        arca_key_enc: "key-congelada",
        arca_cert_enc: "cert-congelado",
      },
      pv: { numero: 5, modo: "HOMOLOGACION" },
      cbteTipo: 6,
      numero: 42,
    });
  });

  it.each([
    ["emisor faltante", async () => null, async () => null],
    [
      "CUIT del emisor distinto",
      async (id: string) => ({ id, cuit: "30717322467" }),
      async () => null,
    ],
    ["credencial faltante", async (id: string) => ({ id, cuit: "30714199664" }), async () => null],
    [
      "credencial de otro ambiente",
      async (id: string) => ({ id, cuit: "30714199664" }),
      async (emisorId: string) => ({
        emisorId,
        ambiente: "PRODUCCION" as const,
        arcaKeyEnc: "key",
        arcaCertEnc: "cert",
      }),
    ],
  ])("falla cerrado ante %s", async (_caso, cargarEmisor, cargarCredencial) => {
    await expect(
      cargarContextoArcaCongelado(reservaCongelada(), {
        cargarEmisor,
        cargarCredencial,
      } as never),
    ).rejects.toThrow(/emisor|CUIT|credencial|ambiente/i);
  });

  it("rechaza una reserva cuya PV/tipo/número no coincide con el snapshot", async () => {
    const reserva = reservaCongelada();
    reserva.puntoVenta = 99;

    await expect(
      cargarContextoArcaCongelado(reserva, {
        cargarEmisor: async (id) => ({ id, cuit: "30714199664" }),
        cargarCredencial: async (emisorId, ambiente) => ({
          emisorId,
          ambiente,
          arcaKeyEnc: "key",
          arcaCertEnc: "cert",
        }),
      }),
    ).rejects.toThrow(/identidad.*congelada|reserva/i);
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

const CONFIRMACION_BASE: ConfirmacionFiscalPostBorrador = {
  version: 1,
  importe: "0.20",
  emisorCuit: "30714199664",
  puntoVenta: 5,
  modo: "HOMOLOGACION",
  letra: "B",
  cbteTipo: 6,
  fechaFiscal: "2026-08-22",
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
};

function confirmacionesDistintas(): Array<[string, ConfirmacionFiscalPostBorrador]> {
  const cambiar = (
    nombre: string,
    mutar: (confirmacion: ConfirmacionFiscalPostBorrador) => void,
  ): [string, ConfirmacionFiscalPostBorrador] => {
    const confirmacion = structuredClone(CONFIRMACION_BASE);
    mutar(confirmacion);
    return [nombre, confirmacion];
  };
  return [
    cambiar("importe", (c) => (c.importe = "0.21")),
    cambiar("emisor CUIT", (c) => (c.emisorCuit = "30717322467")),
    cambiar("punto de venta", (c) => (c.puntoVenta = 6)),
    cambiar("modo", (c) => (c.modo = "PRODUCCION")),
    cambiar("letra", (c) => (c.letra = "A")),
    cambiar("CbteTipo", (c) => (c.cbteTipo = 1)),
    cambiar("fecha fiscal", (c) => (c.fechaFiscal = "2026-08-23")),
    cambiar("receptor.razonSocial", (c) => (c.receptor.razonSocial = "Otro receptor")),
    cambiar("receptor.domicilio", (c) => (c.receptor.domicilio = "Otra calle")),
    cambiar("receptor.tipoDocumento", (c) => (c.receptor.tipoDocumento = "DNI")),
    cambiar("receptor.numeroDocumento", (c) => (c.receptor.numeroDocumento = "30111222")),
    cambiar("receptor.docTipoArca", (c) => (c.receptor.docTipoArca = 96)),
    cambiar("receptor.docNroArca", (c) => (c.receptor.docNroArca = "30111222")),
    cambiar("receptor.condicionIva", (c) => (c.receptor.condicionIva = "EXENTO")),
    cambiar("receptor.origen", (c) => (c.receptor.origen = "MANUAL")),
    cambiar("receptor.origenId", (c) => (c.receptor.origenId = "receptor-1")),
    cambiar("receptor.verificadoArcaAt", (c) => (c.receptor.verificadoArcaAt = "2026-08-22")),
  ];
}

describe("handshake post-creación del borrador", () => {
  it("produce SHA-256 canónico de la tupla completa", () => {
    expect(crearHuellaConfirmacionFiscal(CONFIRMACION_BASE)).toBe(
      "9df51a2cdbd04aaa392561b214a01a6b8c200ba1762608f23c7fadb111848979",
    );
  });

  it.each(confirmacionesDistintas())("cambia la huella si cambia %s", (_campo, confirmacion) => {
    expect(crearHuellaConfirmacionFiscal(confirmacion)).not.toBe(
      crearHuellaConfirmacionFiscal(CONFIRMACION_BASE),
    );
  });

  it("emite por el motor normal sólo cuando la preview autoritativa coincide exactamente", async () => {
    let emisiones = 0;
    const resultado = await emitirPostBorradorConHuella(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: { origen: "CLIENTE_COMERCIAL" },
        confirmaVentaAntigua: false,
        huellaProvisional: crearHuellaConfirmacionFiscal(CONFIRMACION_BASE),
      },
      {
        previsualizarVenta: async () => ({
          huella_confirmacion: crearHuellaConfirmacionFiscal(CONFIRMACION_BASE),
          confirmacion_autoritativa: CONFIRMACION_BASE,
        }),
        emitir: async () => {
          emisiones += 1;
          return {
            estado: "APROBADO" as const,
            cae: "74123456789012",
            numero: 1,
            recuperado: false,
            advertencias: [],
          };
        },
      },
    );

    expect(resultado.estado).toBe("APROBADO");
    expect(emisiones).toBe(1);
  });

  it.each(confirmacionesDistintas())(
    "exige reconfirmación y deja cero claims/red si la venta persistida cambia %s",
    async (_campo, autoritativa) => {
      let claims = 0;
      let red = 0;
      const resultado = await emitirPostBorradorConHuella(
        {
          ventaId: "71000000-0000-4000-8000-000000000001",
          receptor: { origen: "CLIENTE_COMERCIAL" },
          confirmaVentaAntigua: false,
          huellaProvisional: crearHuellaConfirmacionFiscal(CONFIRMACION_BASE),
        },
        {
          previsualizarVenta: async () => ({
            huella_confirmacion: crearHuellaConfirmacionFiscal(autoritativa),
            confirmacion_autoritativa: autoritativa,
          }),
          emitir: async () => {
            claims += 1;
            red += 1;
            throw new Error("no debe emitir");
          },
        },
      );

      expect(resultado).toMatchObject({
        estado: "RECONFIRMACION_REQUERIDA",
        huella_confirmacion: crearHuellaConfirmacionFiscal(autoritativa),
      });
      expect(claims).toBe(0);
      expect(red).toBe(0);
    },
  );
});
