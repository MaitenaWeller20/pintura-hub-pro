import { describe, expect, it } from "vitest";
import type { SnapshotFiscalV2 } from "./snapshot";
import { crearPayloadCaeDesdeSnapshot, normalizarComprobanteArca } from "./arca";

export const snapshotFiscalFixture = {
  version: 2,
  hash: "a".repeat(64),
  venta: {
    id: "71000000-0000-4000-8000-000000000001",
    numeroComercial: "0005-00000042",
    tipoComprobante: "NOTA_CREDITO",
    condicionVenta: "CONTADO",
    fechaComercial: "2026-08-21",
  },
  items: [],
  emisor: {
    id: "71000000-0000-4000-8000-000000000002",
    razonSocial: "EMISOR SA",
    nombreFantasia: null,
    cuit: "30714199664",
    domicilioFiscal: "Domicilio 1",
    condicionIva: "RESPONSABLE_INSCRIPTO",
    ingresosBrutos: null,
    inicioActividades: "2020-01-01",
    telefono: null,
  },
  sucursal: {
    id: "71000000-0000-4000-8000-000000000003",
    nombre: "Casa central",
    direccion: "Domicilio 1",
    telefono: null,
  },
  receptor: {
    razonSocial: "CLIENTE SA",
    domicilio: "Domicilio 2",
    tipoDocumento: "CUIT",
    numeroDocumento: "30712345671",
    docTipoArca: 80,
    docNroArca: "30712345671",
    condicionIva: "RESPONSABLE_INSCRIPTO",
    origen: "MANUAL",
    origenId: null,
    verificadoArcaAt: null,
    condicionIvaReceptorId: 1,
  },
  identidad: {
    numero: 42,
    emisorCuit: "30714199664",
    puntoVenta: 5,
    cbteTipo: 3,
    modo: "PRODUCCION",
    simulado: false,
    validez: "PRODUCCION",
  },
  letra: "A",
  concepto: 1,
  fechaComprobante: "2026-08-21",
  importeNeto: "100.00",
  importeExento: "5.00",
  importeNoGravado: "7.00",
  importeIva: "21.00",
  importeTributos: "3.00",
  importeTotal: "136.00",
  alicuotasIva: [{ id: 5, baseImponible: "100.00", importe: "21.00" }],
  tributos: [
    {
      id: 99,
      descripcion: "Percepción",
      baseImponible: "100.00",
      alicuota: "3.00",
      importe: "3.00",
    },
  ],
  moneda: "PES",
  cotizacion: "1.000000",
  ivaContenido: "0.00",
  otrosImpuestosNacionalesIndirectos: "3.00",
  origen: "COMPROBANTE_ORIGINAL",
  comprobanteOriginalId: "71000000-0000-4000-8000-000000000004",
  cbtesAsoc: [{ tipo: 1, puntoVenta: 5, numero: 40, cuit: "30714199664", fecha: "2026-08-20" }],
} satisfies SnapshotFiscalV2;

export const resultGetFixture = {
  PtoVta: 5,
  CbteTipo: 3,
  CbteDesde: 42,
  CbteHasta: 42,
  CodAutorizacion: "74123456789012",
  FchVto: "20260901",
  Resultado: "A",
  Concepto: 1,
  DocTipo: 80,
  DocNro: "30712345671",
  CondicionIVAReceptorId: 1,
  CbteFch: "20260821",
  ImpTotal: 136,
  ImpTotConc: 7,
  ImpNeto: 100,
  ImpOpEx: 5,
  ImpIVA: 21,
  ImpTrib: 3,
  MonId: "PES",
  MonCotiz: 1,
  Iva: { AlicIva: [{ Id: 5, BaseImp: 100, Importe: 21 }] },
  Tributos: { Tributo: [{ Id: 99, BaseImp: 100, Alic: 3, Importe: 3 }] },
  CbtesAsoc: {
    CbteAsoc: [{ Tipo: 1, PtoVta: 5, Nro: 40, Cuit: "30714199664", CbteFch: "20260820" }],
  },
};

describe("adaptador fiscal ARCA", () => {
  it("crea el payload de emisión solamente desde el snapshot v2 completo", () => {
    expect(crearPayloadCaeDesdeSnapshot(snapshotFiscalFixture)).toEqual({
      CantReg: 1,
      PtoVta: 5,
      CbteTipo: 3,
      Concepto: 1,
      DocTipo: 80,
      DocNro: 30712345671,
      CbteDesde: 42,
      CbteHasta: 42,
      CbteFch: "20260821",
      ImpTotal: 136,
      ImpTotConc: 7,
      ImpNeto: 100,
      ImpOpEx: 5,
      ImpIVA: 21,
      ImpTrib: 3,
      MonId: "PES",
      MonCotiz: 1,
      CondicionIVAReceptorId: 1,
      Iva: [{ Id: 5, BaseImp: 100, Importe: 21 }],
      Tributos: [{ Id: 99, Desc: "Percepción", BaseImp: 100, Alic: 3, Importe: 3 }],
      CbtesAsoc: [{ Tipo: 1, PtoVta: 5, Nro: 40, Cuit: "30714199664", CbteFch: "20260820" }],
    });
  });

  it("normaliza colecciones SOAP singleton y array de forma idéntica", () => {
    const arrays = normalizarComprobanteArca(resultGetFixture);
    const singleton = normalizarComprobanteArca({
      ...resultGetFixture,
      Iva: { AlicIva: resultGetFixture.Iva.AlicIva[0] },
      Tributos: { Tributo: resultGetFixture.Tributos.Tributo[0] },
      CbtesAsoc: { CbteAsoc: resultGetFixture.CbtesAsoc.CbteAsoc[0] },
    });

    expect(singleton).toEqual(arrays);
    expect(arrays).toEqual({
      puntoVenta: 5,
      cbteTipo: 3,
      numero: 42,
      cae: "74123456789012",
      caeVencimiento: "2026-09-01",
      concepto: 1,
      docTipo: 80,
      docNro: "30712345671",
      condicionIvaReceptorId: 1,
      fecha: "2026-08-21",
      total: "136.00",
      neto: "100.00",
      exento: "5.00",
      noGravado: "7.00",
      iva: "21.00",
      tributosTotal: "3.00",
      moneda: "PES",
      cotizacion: "1.000000",
      alicuotas: [{ id: 5, base: "100.00", importe: "21.00" }],
      tributos: [{ id: 99, base: "100.00", alicuota: "3.00", importe: "3.00" }],
      asociados: [{ tipo: 1, puntoVenta: 5, numero: 40, cuit: "30714199664", fecha: "2026-08-20" }],
    });
  });

  it.each([
    "PtoVta",
    "CbteTipo",
    "CbteDesde",
    "CbteHasta",
    "Concepto",
    "DocTipo",
    "DocNro",
    "CondicionIVAReceptorId",
    "CbteFch",
    "ImpTotal",
    "ImpTotConc",
    "ImpNeto",
    "ImpOpEx",
    "ImpIVA",
    "ImpTrib",
    "MonId",
    "MonCotiz",
  ])("rechaza el resultado remoto si falta el campo comparable %s", (campo) => {
    const incompleto = { ...resultGetFixture } as Record<string, unknown>;
    delete incompleto[campo];
    expect(() => normalizarComprobanteArca(incompleto)).toThrow(new RegExp(campo, "i"));
  });

  it("rechaza rangos remotos que no identifican un único comprobante", () => {
    expect(() => normalizarComprobanteArca({ ...resultGetFixture, CbteHasta: 43 })).toThrow(
      /CbteDesde.*CbteHasta/i,
    );
  });
});
