import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  crearSnapshotFiscalV3,
  type SnapshotFiscalPersistido,
  type SnapshotFiscalV2,
  type SnapshotFiscalV3,
  type SnapshotFiscalV3Input,
} from "./snapshot";
import { conTimeoutArca, crearPayloadCaeDesdeSnapshot, normalizarComprobanteArca } from "./arca";

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
  Tributos: {
    Tributo: [{ Id: 99, Desc: "Percepción", BaseImp: 100, Alic: 3, Importe: 3 }],
  },
  CbtesAsoc: {
    CbteAsoc: [{ Tipo: 1, PtoVta: 5, Nro: 40, Cuit: "30714199664", CbteFch: "20260820" }],
  },
};

function crearSnapshotFiscalV3Fixture(): SnapshotFiscalV3 {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../test/fixtures/fiscal-snapshot-parity-v2.json", import.meta.url),
      "utf8",
    ),
  ) as { input: Record<string, unknown> };
  const input = structuredClone(fixture.input);
  delete input.version;
  delete input.hash;
  delete input.origen;
  delete input.comprobanteOriginalId;
  delete input.cbtesAsoc;
  const venta = input.venta as Record<string, unknown>;
  const items = input.items as Array<Record<string, unknown>>;
  const identidad = input.identidad as Record<string, unknown>;
  venta.tipoComprobante = "NOTA_CREDITO";
  input.items = items.map((item) => ({
    ...item,
    productoId: item.productoId ?? "71000000-0000-4000-8000-000000000199",
  }));
  identidad.cbteTipo = 8;
  input.importeTributos = "0.00";
  input.importeTotal = "1360.00";
  input.tributos = [];
  input.otrosImpuestosNacionalesIndirectos = "0.00";
  input.periodoAsoc = { desde: "2026-08-01", hasta: "2026-08-15" };
  input.notaCredito = {
    modalidad: "DEVOLUCION_PRODUCTOS",
    motivo: "Devolución de productos del período",
  };
  return crearSnapshotFiscalV3(input as SnapshotFiscalV3Input);
}

describe("adaptador fiscal ARCA", () => {
  it("expone el timeout compartido sin alterar una respuesta del SDK que llega a tiempo", async () => {
    await expect(conTimeoutArca(Promise.resolve("respuesta SDK"), "prueba")).resolves.toBe(
      "respuesta SDK",
    );
  });

  it("crea el payload de emisión solamente desde el snapshot v2 completo", () => {
    const detalle = crearPayloadCaeDesdeSnapshot(snapshotFiscalFixture);

    expect(detalle).toEqual({
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
    expect(detalle).not.toHaveProperty("PeriodoAsoc");
  });

  it("emite PeriodoAsoc exacto para v3 y nunca CbtesAsoc", () => {
    const detalle = crearPayloadCaeDesdeSnapshot(crearSnapshotFiscalV3Fixture());

    expect(detalle.PeriodoAsoc).toEqual({
      FchDesde: "20260801",
      FchHasta: "20260815",
    });
    expect(detalle).not.toHaveProperty("CbtesAsoc");
  });

  it("una factura v2 ordinaria no emite ninguna asociación", () => {
    const factura = {
      ...snapshotFiscalFixture,
      venta: { ...snapshotFiscalFixture.venta, tipoComprobante: "VENTA" },
      origen: "VENTA",
      comprobanteOriginalId: null,
      cbtesAsoc: [],
    } as SnapshotFiscalV2;
    const detalle = crearPayloadCaeDesdeSnapshot(factura);

    expect(detalle).not.toHaveProperty("CbtesAsoc");
    expect(detalle).not.toHaveProperty("PeriodoAsoc");
  });

  it("rechaza un snapshot v3 persistido adulterado antes de construir el request", () => {
    const adulterado = structuredClone(crearSnapshotFiscalV3Fixture());
    adulterado.periodoAsoc.hasta = "2026-02-30";

    expect(() => crearPayloadCaeDesdeSnapshot(adulterado as SnapshotFiscalPersistido)).toThrow(
      /per[ií]odo|fecha|hash/i,
    );
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
      periodoAsoc: null,
      alicuotas: [{ id: 5, base: "100.00", importe: "21.00" }],
      tributos: [
        {
          id: 99,
          descripcion: "Percepción",
          base: "100.00",
          alicuota: "3.00",
          importe: "3.00",
        },
      ],
      asociados: [{ tipo: 1, puntoVenta: 5, numero: 40, cuit: "30714199664", fecha: "2026-08-20" }],
    });
  });

  it("normaliza PeriodoAsoc de ResultGet a fechas ISO", () => {
    const { CbtesAsoc: _cbtesAsoc, ...sinComprobantesAsociados } = resultGetFixture;

    expect(
      normalizarComprobanteArca({
        ...sinComprobantesAsociados,
        PeriodoAsoc: { FchDesde: "20260801", FchHasta: "20260815" },
      }).periodoAsoc,
    ).toEqual({ desde: "2026-08-01", hasta: "2026-08-15" });
  });

  it.each([
    ["fecha inicial ausente", { FchHasta: "20260815" }],
    ["fecha final ausente", { FchDesde: "20260801" }],
    ["fecha inicial inválida", { FchDesde: "20260230", FchHasta: "20260815" }],
    ["fecha final inválida", { FchDesde: "20260801", FchHasta: "00000101" }],
  ])("rechaza PeriodoAsoc con %s", (_caso, PeriodoAsoc) => {
    const { CbtesAsoc: _cbtesAsoc, ...sinComprobantesAsociados } = resultGetFixture;

    expect(() => normalizarComprobanteArca({ ...sinComprobantesAsociados, PeriodoAsoc })).toThrow(
      /PeriodoAsoc|FchDesde|FchHasta/i,
    );
  });

  it("rechaza una respuesta remota que contiene ambas asociaciones", () => {
    expect(() =>
      normalizarComprobanteArca({
        ...resultGetFixture,
        PeriodoAsoc: { FchDesde: "20260801", FchHasta: "20260815" },
      }),
    ).toThrow(/PeriodoAsoc|CbtesAsoc|asociaciones/i);
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

  it("rechaza registros con prototipo personalizado o propiedades heredadas", () => {
    const heredado = Object.create(resultGetFixture) as Record<string, unknown>;
    expect(() => normalizarComprobanteArca(heredado)).toThrow(/ResultGet|registro|plano/i);
  });

  it("rechaza accessors sin ejecutarlos", () => {
    let ejecutado = false;
    const accessor = { ...resultGetFixture };
    Object.defineProperty(accessor, "PtoVta", {
      enumerable: true,
      get() {
        ejecutado = true;
        return 5;
      },
    });

    expect(() => normalizarComprobanteArca(accessor)).toThrow(/accessor|PtoVta|datos/i);
    expect(ejecutado).toBe(false);
  });

  it("rechaza arrays SOAP con prototipo personalizado", () => {
    const rows = [{ Id: 5, BaseImp: 100, Importe: 21 }];
    Object.setPrototypeOf(rows, { ...Array.prototype });
    expect(() =>
      normalizarComprobanteArca({ ...resultGetFixture, Iva: { AlicIva: rows } }),
    ).toThrow(/array|prototipo/i);
  });

  it.each([
    ["fracción monetaria no cero más allá de centavos", { ImpTotal: "136.004" }],
    ["booleano", { ImpTotal: true }],
    ["notación exponencial", { ImpTotal: "1e2" }],
    ["magnitud no segura", { ImpTotal: "90071992547409.92" }],
    ["cotización con séptimo decimal no cero", { MonCotiz: "1.0000001" }],
  ])("rechaza decimal no canónico: %s", (_caso, cambio) => {
    expect(() => normalizarComprobanteArca({ ...resultGetFixture, ...cambio })).toThrow(
      /decimal|precisión|ImpTotal|MonCotiz/i,
    );
  });

  it("acepta ceros decimales extra sólo cuando no pierden precisión", () => {
    expect(
      normalizarComprobanteArca({
        ...resultGetFixture,
        ImpTotal: "136.0000",
        MonCotiz: "1.00000000",
      }),
    ).toMatchObject({ total: "136.00", cotizacion: "1.000000" });
  });

  it.each(["7412345678901", "7412345678901X", " 74123456789012 "])(
    "rechaza CAE no canónico de catorce dígitos: %j",
    (cae) => {
      expect(() =>
        normalizarComprobanteArca({ ...resultGetFixture, CodAutorizacion: cae }),
      ).toThrow(/CAE|CodAutorizacion/i);
    },
  );

  it.each(["00000101", "20260230"])("rechaza vencimiento CAE inválido: %s", (FchVto) => {
    expect(() => normalizarComprobanteArca({ ...resultGetFixture, FchVto })).toThrow(/FchVto/i);
  });

  it("mantiene el vencimiento CAE nullable", () => {
    expect(
      normalizarComprobanteArca({ ...resultGetFixture, FchVto: undefined }).caeVencimiento,
    ).toBeNull();
  });

  it("requiere la descripción observable de cada tributo", () => {
    const tributo = { ...resultGetFixture.Tributos.Tributo[0] } as Record<string, unknown>;
    delete tributo.Desc;
    expect(() =>
      normalizarComprobanteArca({ ...resultGetFixture, Tributos: { Tributo: tributo } }),
    ).toThrow(/Tributos.*Desc|descripci/i);
  });

  it("ordena tributos incluyendo la descripción como parte estable del dominio", () => {
    const normalizado = normalizarComprobanteArca({
      ...resultGetFixture,
      ImpTrib: 6,
      Tributos: {
        Tributo: [
          { Id: 99, Desc: "Zeta", BaseImp: 100, Alic: 3, Importe: 3 },
          { Id: 99, Desc: "Alfa", BaseImp: 100, Alic: 3, Importe: 3 },
        ],
      },
    });
    expect(normalizado.tributos.map((row) => row.descripcion)).toEqual(["Alfa", "Zeta"]);
  });

  it.each([undefined, "R", "P"])(
    "normalización pública exige Resultado A exacto: %j",
    (Resultado) => {
      expect(() => normalizarComprobanteArca({ ...resultGetFixture, Resultado })).toThrow(
        /Resultado/i,
      );
    },
  );
});
