import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { condicionIvaReceptorId, determinarLetra } from "./codigos";
import {
  calcularHashSnapshotFiscal,
  crearSnapshotFiscal,
  crearSnapshotFiscalV2,
  crearSnapshotFiscalV3,
  identidadReservaCoincide,
  resolverReceptorFiscalLegacy,
  serializarSnapshotFiscal,
  sha256HexUtf8,
  validarSnapshotFiscalPersistido,
  validarSnapshotFiscalV2,
  validarSnapshotFiscalV3,
} from "./snapshot";

it("congela CUIT e información del emisor correcto", () => {
  const entrada = {
    emisor: {
      razon_social: "GRUPO CASA FORMA S.A.S.",
      nombre_fantasia: "CasaForma",
      cuit: "30717322467",
      domicilio_fiscal: "BERNARDO O'HIGGINS 5450",
      condicion_iva: "RESPONSABLE_INSCRIPTO" as const,
      ingresos_brutos: "286447821",
      inicio_actividades: "2025-09-01",
      telefono: "3512146766",
    },
    receptor: {
      razon_social: "Consumidor Final",
      cuit_dni: null,
      doc_tipo: 99,
      doc_nro: 0,
      condicion_iva: "CONSUMIDOR_FINAL" as const,
      domicilio: null,
    },
    fecha: "2026-08-19T15:00:00.000Z",
    totales: { neto: 100, iva: 21, tributos: 0, total: 121, alicuotas: [] },
    condicion_venta: "CONTADO",
    lineas: [
      {
        codigo: "P-1",
        descripcion: "Pintura",
        cantidad: 1,
        precio_unitario_sin_iva: 100,
        descuento_porcentaje: 0,
        iva_porcentaje: 21,
        subtotal_con_iva: 121,
      },
    ],
  };

  const snapshot = crearSnapshotFiscal(entrada);
  entrada.emisor.cuit = "30714199664";
  entrada.lineas[0].descripcion = "CAMBIADA";

  expect(snapshot.emisor.cuit).toBe("30717322467");
  expect(snapshot.emisor.telefono).toBe("3512146766");
  expect(snapshot.lineas[0].descripcion).toBe("Pintura");
  expect(snapshot.version).toBe(1);
});

it("considera el CUIT parte de la identidad de una reserva", () => {
  const actual = {
    cuit: "30714199664",
    punto_venta: 5,
    cbte_tipo: 6,
    ambiente: "PRODUCCION" as const,
  };

  expect(identidadReservaCoincide(actual, actual)).toBe(true);
  expect(identidadReservaCoincide({ ...actual, cuit: "30717322467" }, actual)).toBe(false);
});

const receptorVivoRi = {
  razon_social: "ACME SA actualizada",
  cuit_dni: "30-71234567-1",
  doc_tipo: 80,
  doc_nro: 30712345671,
  condicion_iva: "RESPONSABLE_INSCRIPTO" as const,
  domicilio: "Domicilio vivo 999",
};

const snapshotFacturaBHistorica = {
  emisor: {
    razon_social: "GRUPO CASA FORMA S.A.S.",
    nombre_fantasia: "CasaForma",
    cuit: "30717322467",
    domicilio_fiscal: "BERNARDO O'HIGGINS 5450",
    condicion_iva: "RESPONSABLE_INSCRIPTO" as const,
    ingresos_brutos: "286447821",
    inicio_actividades: "2025-09-01",
    telefono: "3512146766",
  },
  receptor: {
    razon_social: "ACME SA al emitir",
    cuit_dni: "30-71234567-1",
    doc_tipo: 80,
    doc_nro: 30712345671,
    condicion_iva: "CONSUMIDOR_FINAL" as const,
    domicilio: "Domicilio original 123",
  },
  condicion_venta: "CONTADO",
  totales: { neto: 100, iva: 21, tributos: 0, total: 121, alicuotas: [] },
  fecha: "2026-08-19T15:00:00.000Z",
  lineas: [
    {
      codigo: "P-1",
      descripcion: "Pintura",
      cantidad: 1,
      precio_unitario_sin_iva: 100,
      descuento_porcentaje: 0,
      iva_porcentaje: 21,
      subtotal_con_iva: 121,
    },
  ],
  version: 1 as const,
};

it("una NC B hereda del snapshot v1 la condición 5 y el receptor completo original", () => {
  const receptor = resolverReceptorFiscalLegacy({
    tipoComprobante: "NOTA_CREDITO",
    letra: "B",
    receptorVivo: receptorVivoRi,
    snapshotOriginal: snapshotFacturaBHistorica,
  });

  expect(receptor).toEqual({
    razon_social: "ACME SA al emitir",
    cuit_dni: "30-71234567-1",
    doc_tipo: 80,
    doc_nro: 30712345671,
    condicion_iva: "CONSUMIDOR_FINAL",
    domicilio: "Domicilio original 123",
  });
  expect(condicionIvaReceptorId(receptor.condicion_iva)).toBe(5);
});

it("sin snapshot conserva sólo en notas B el fallback histórico RI a consumidor final", () => {
  expect(
    resolverReceptorFiscalLegacy({
      tipoComprobante: "NOTA_DEBITO",
      letra: "B",
      receptorVivo: receptorVivoRi,
      snapshotOriginal: null,
    }),
  ).toEqual({
    ...receptorVivoRi,
    condicion_iva: "CONSUMIDOR_FINAL",
  });
});

it("una factura nueva RI conserva el receptor real y deriva A sin downgrade", () => {
  const receptor = resolverReceptorFiscalLegacy({
    tipoComprobante: "VENTA",
    letra: "B",
    receptorVivo: receptorVivoRi,
    snapshotOriginal: null,
  });

  expect(receptor).toEqual(receptorVivoRi);
  expect(determinarLetra("RESPONSABLE_INSCRIPTO", receptor.condicion_iva)).toBe("A");
});

it("un snapshot original desconocido bloquea la nota en vez de releer datos vivos", () => {
  expect(() =>
    resolverReceptorFiscalLegacy({
      tipoComprobante: "NOTA_CREDITO",
      letra: "B",
      receptorVivo: receptorVivoRi,
      snapshotOriginal: { ...snapshotFacturaBHistorica, version: 2 },
    }),
  ).toThrow(/snapshot v1/i);
});

it("bloquea un CUIT visible que no coincide con el DocNro declarado", () => {
  expect(() =>
    resolverReceptorFiscalLegacy({
      tipoComprobante: "NOTA_CREDITO",
      letra: "B",
      receptorVivo: receptorVivoRi,
      snapshotOriginal: {
        ...snapshotFacturaBHistorica,
        receptor: {
          ...snapshotFacturaBHistorica.receptor,
          doc_nro: 30712345672,
        },
      },
    }),
  ).toThrow(/documento lógico.*DocNro/i);
});

it("bloquea un CUIT informado como anónimo 99/0 y responsable inscripto", () => {
  expect(() =>
    resolverReceptorFiscalLegacy({
      tipoComprobante: "NOTA_CREDITO",
      letra: "B",
      receptorVivo: receptorVivoRi,
      snapshotOriginal: {
        ...snapshotFacturaBHistorica,
        receptor: {
          ...snapshotFacturaBHistorica.receptor,
          doc_tipo: 99,
          doc_nro: 0,
          condicion_iva: "RESPONSABLE_INSCRIPTO",
        },
      },
    }),
  ).toThrow(/receptor anónimo/i);
});

it("rechaza letras o ruido al normalizar el documento lógico", () => {
  expect(() =>
    resolverReceptorFiscalLegacy({
      tipoComprobante: "NOTA_CREDITO",
      letra: "B",
      receptorVivo: receptorVivoRi,
      snapshotOriginal: {
        ...snapshotFacturaBHistorica,
        receptor: {
          ...snapshotFacturaBHistorica.receptor,
          cuit_dni: "30-71234567-1XYZ",
        },
      },
    }),
  ).toThrow(/formato del documento lógico/i);
});

it("bloquea DocTipo 80 aunque número lógico y DocNro coincidan si el CUIT es inválido", () => {
  expect(() =>
    resolverReceptorFiscalLegacy({
      tipoComprobante: "NOTA_CREDITO",
      letra: "B",
      receptorVivo: receptorVivoRi,
      snapshotOriginal: {
        ...snapshotFacturaBHistorica,
        receptor: {
          ...snapshotFacturaBHistorica.receptor,
          cuit_dni: "30-71234567-2",
          doc_nro: 30712345672,
        },
      },
    }),
  ).toThrow(/CUIT válido/i);
});

it.each([
  ["A", "CONSUMIDOR_FINAL"],
  ["B", "RESPONSABLE_INSCRIPTO"],
] as const)("bloquea letra %s con condición incompatible %s", (letra, condicionIva) => {
  expect(() =>
    resolverReceptorFiscalLegacy({
      tipoComprobante: "NOTA_CREDITO",
      letra,
      receptorVivo: receptorVivoRi,
      snapshotOriginal: {
        ...snapshotFacturaBHistorica,
        receptor: {
          ...snapshotFacturaBHistorica.receptor,
          condicion_iva: condicionIva,
        },
      },
    }),
  ).toThrow(new RegExp(`letra ${letra}.*condición`, "i"));
});

it("acepta separadores permitidos y conserva una copia exacta sin mutar el snapshot", () => {
  const snapshot = {
    ...snapshotFacturaBHistorica,
    receptor: {
      ...snapshotFacturaBHistorica.receptor,
      cuit_dni: "30 . 71234567 - 1",
    },
  };

  const receptor = resolverReceptorFiscalLegacy({
    tipoComprobante: "NOTA_CREDITO",
    letra: "B",
    receptorVivo: receptorVivoRi,
    snapshotOriginal: snapshot,
  });
  receptor.razon_social = "Mutada afuera";

  expect(receptor.cuit_dni).toBe("30 . 71234567 - 1");
  expect(snapshot.receptor.razon_social).toBe("ACME SA al emitir");
});

it("tolera condición null sólo para el consumidor final anónimo del snapshot v1", () => {
  expect(
    resolverReceptorFiscalLegacy({
      tipoComprobante: "NOTA_DEBITO",
      letra: "B",
      receptorVivo: receptorVivoRi,
      snapshotOriginal: {
        ...snapshotFacturaBHistorica,
        receptor: {
          razon_social: "Consumidor Final",
          cuit_dni: null,
          doc_tipo: 99,
          doc_nro: 0,
          condicion_iva: null,
          domicilio: null,
        },
      },
    }),
  ).toEqual({
    razon_social: "Consumidor Final",
    cuit_dni: null,
    doc_tipo: 99,
    doc_nro: 0,
    condicion_iva: "CONSUMIDOR_FINAL",
    domicilio: null,
  });
});

it("no impone la matriz nueva A/B a una nota C histórica coherente", () => {
  expect(
    resolverReceptorFiscalLegacy({
      tipoComprobante: "NOTA_CREDITO",
      letra: "C",
      receptorVivo: receptorVivoRi,
      snapshotOriginal: {
        ...snapshotFacturaBHistorica,
        receptor: {
          ...snapshotFacturaBHistorica.receptor,
          condicion_iva: "RESPONSABLE_INSCRIPTO",
        },
      },
    }),
  ).toEqual({
    ...snapshotFacturaBHistorica.receptor,
    condicion_iva: "RESPONSABLE_INSCRIPTO",
  });
});

const parityFixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/fiscal-snapshot-parity-v2.json", import.meta.url),
    "utf8",
  ),
) as {
  input: Record<string, unknown>;
  canonical: string;
  sha256: string;
};

function inputV2() {
  const {
    hash: _hash,
    version: _version,
    ...input
  } = structuredClone(parityFixture.input) as Record<string, unknown>;
  return input;
}

function bodyV2() {
  const { hash: _hash, ...body } = structuredClone(parityFixture.input) as Record<string, unknown>;
  return body;
}

function notaInputV2() {
  const input = inputV2() as any;
  input.venta.tipoComprobante = "NOTA_CREDITO";
  input.identidad.cbteTipo = 8;
  input.origen = "COMPROBANTE_ORIGINAL";
  input.comprobanteOriginalId = "71000000-0000-4000-8000-000000000401";
  input.cbtesAsoc = [
    {
      tipo: 6,
      puntoVenta: input.identidad.puntoVenta,
      numero: 1,
      cuit: input.emisor.cuit,
      fecha: "2026-08-20",
    },
  ];
  return input;
}

function prepararReceptorArcaParaVerificacion(input: { receptor: Record<string, unknown> }) {
  input.receptor = {
    ...input.receptor,
    tipoDocumento: "CUIT",
    numeroDocumento: "30714199664",
    docTipoArca: 80,
    docNroArca: "30714199664",
    origen: "ARCA",
  };
}

function inputV2ConReceptorRi() {
  const input = inputV2() as any;
  input.receptor = {
    razonSocial: "CLIENTE RI",
    domicilio: "Domicilio fiscal 123",
    tipoDocumento: "CUIT",
    numeroDocumento: "30714199664",
    docTipoArca: 80,
    docNroArca: "30714199664",
    condicionIva: "RESPONSABLE_INSCRIPTO",
    origen: "MANUAL",
    origenId: null,
    verificadoArcaAt: null,
    condicionIvaReceptorId: 1,
  };
  input.letra = "A";
  input.identidad.cbteTipo = 1;
  input.ivaContenido = "0.00";
  return input;
}

function inputV2SinTributos() {
  const input = inputV2() as any;
  input.items = input.items.map((item: any) => ({
    ...item,
    productoId: item.productoId ?? "71000000-0000-4000-8000-000000000102",
  }));
  input.importeTributos = "0.00";
  input.importeTotal = "1360.00";
  input.tributos = [];
  input.otrosImpuestosNacionalesIndirectos = "0.00";
  return input;
}

function inputV3() {
  const input = structuredClone(crearSnapshotFiscalV2(inputV2SinTributos())) as any;
  delete input.version;
  delete input.hash;
  delete input.origen;
  delete input.comprobanteOriginalId;
  delete input.cbtesAsoc;
  input.venta.tipoComprobante = "NOTA_CREDITO";
  input.identidad.cbteTipo = 8;
  input.periodoAsoc = { desde: "2026-08-01", hasta: "2026-08-20" };
  input.notaCredito = {
    modalidad: "DEVOLUCION_PRODUCTOS",
    motivo: "Devolución de productos del período",
  };
  return input;
}

describe("snapshot fiscal v3 por período", () => {
  it("congela exactamente el contrato fiscal por período sin resolución comercial", () => {
    const v2 = crearSnapshotFiscalV2(inputV2SinTributos());
    const snapshot = crearSnapshotFiscalV3(inputV3());

    expect(Object.keys(snapshot)).toEqual([
      "version",
      "hash",
      "venta",
      "items",
      "emisor",
      "sucursal",
      "receptor",
      "identidad",
      "letra",
      "concepto",
      "fechaComprobante",
      "importeNeto",
      "importeExento",
      "importeNoGravado",
      "importeIva",
      "importeTributos",
      "importeTotal",
      "alicuotasIva",
      "tributos",
      "moneda",
      "cotizacion",
      "ivaContenido",
      "otrosImpuestosNacionalesIndirectos",
      "origen",
      "comprobanteOriginalId",
      "cbtesAsoc",
      "periodoAsoc",
      "notaCredito",
    ]);
    expect(snapshot).toMatchObject({
      version: 3,
      origen: "PERIODO_ASOCIADO",
      comprobanteOriginalId: null,
      cbtesAsoc: [],
      periodoAsoc: { desde: "2026-08-01", hasta: "2026-08-20" },
      notaCredito: {
        modalidad: "DEVOLUCION_PRODUCTOS",
        motivo: "Devolución de productos del período",
      },
    });
    expect(snapshot).not.toHaveProperty("resolucion");
    expect(snapshot.notaCredito).not.toHaveProperty("resolucion");
    expect(snapshot.importeTotal).toBe(v2.importeTotal);
    expect(Number(snapshot.importeTotal)).toBeGreaterThan(0);
    expect(snapshot.importeNeto).toBe(v2.importeNeto);
    expect(snapshot.importeIva).toBe(v2.importeIva);
    expect(snapshot.items).toEqual(v2.items);
    expect(snapshot.receptor).toEqual(v2.receptor);
    expect(snapshot.identidad).toEqual({ ...v2.identidad, cbteTipo: 8 });
    expect(validarSnapshotFiscalV3(snapshot)).toEqual(snapshot);
  });

  it.each([
    ["fecha inicial inexistente", (value: any) => (value.periodoAsoc.desde = "2026-02-30")],
    ["fecha final inexistente", (value: any) => (value.periodoAsoc.hasta = "2026-02-30")],
    ["período invertido", (value: any) => (value.periodoAsoc.desde = "2026-08-21")],
    ["período posterior a la emisión", (value: any) => (value.periodoAsoc.hasta = "2026-08-23")],
    ["motivo corto", (value: any) => (value.notaCredito.motivo = " abc ")],
    ["modalidad desconocida", (value: any) => (value.notaCredito.modalidad = "OTRA")],
    ["comprobante que no es NC", (value: any) => (value.venta.tipoComprobante = "VENTA")],
    ["CbteTipo no estándar", (value: any) => (value.identidad.cbteTipo = 7)],
  ])("rechaza %s", (_caso, mutar) => {
    const input = inputV3();
    mutar(input);
    expect(() => crearSnapshotFiscalV3(input)).toThrow();
  });

  it("falla cerrado ante claves faltantes/desconocidas, orden no canónico y tampering", () => {
    const snapshot = crearSnapshotFiscalV3(inputV3()) as any;

    expect(() => validarSnapshotFiscalV3({ ...snapshot, resolucion: "REINTEGRO" })).toThrow(
      /clave|desconocida|faltante/i,
    );

    const sinPeriodo = structuredClone(snapshot);
    delete sinPeriodo.periodoAsoc;
    expect(() => validarSnapshotFiscalV3(sinPeriodo)).toThrow(/clave|desconocida|faltante/i);

    const desordenado = structuredClone(snapshot);
    desordenado.items.reverse();
    expect(() => validarSnapshotFiscalV3(desordenado)).toThrow(/orden canónico/i);

    const adulterado = structuredClone(snapshot);
    adulterado.notaCredito.motivo = adulterado.notaCredito.motivo.replace("p", "P");
    expect(() => validarSnapshotFiscalV3(adulterado)).toThrow(/hash/i);
  });

  it("serializa dos veces el mismo input con exactamente los mismos bytes y hash", () => {
    const primero = crearSnapshotFiscalV3(inputV3());
    const segundo = crearSnapshotFiscalV3(inputV3());
    const { hash: _hashPrimero, ...cuerpoPrimero } = primero;
    const { hash: _hashSegundo, ...cuerpoSegundo } = segundo;

    expect(serializarSnapshotFiscal(cuerpoPrimero)).toBe(serializarSnapshotFiscal(cuerpoSegundo));
    expect(JSON.stringify(primero)).toBe(JSON.stringify(segundo));
    expect(primero.hash).toBe(segundo.hash);
  });

  it("despacha snapshots persistidos v2/v3 sin ampliar el validador v2", () => {
    const v2 = crearSnapshotFiscalV2(inputV2() as never);
    const v3 = crearSnapshotFiscalV3(inputV3());

    expect(validarSnapshotFiscalPersistido(v2)).toEqual(v2);
    expect(validarSnapshotFiscalPersistido(v3)).toEqual(v3);
    expect(() => validarSnapshotFiscalV2(v3)).toThrow(/versión 2/i);
    expect(() => validarSnapshotFiscalPersistido(snapshotFacturaBHistorica)).toThrow(/versión/i);
    expect(() => validarSnapshotFiscalPersistido({ ...v3, version: 4 })).toThrow(/versión/i);
  });
});

describe("snapshot fiscal v2", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["á🚀", "48f2689b4d2b0b4341df4a7f142e93c1fb45f2adc48f4c1eddf65848dbaa9eb9"],
  ])("implementa el vector SHA-256 UTF-8 de %j", (texto, esperado) => {
    expect(sha256HexUtf8(texto)).toBe(esperado);
  });

  it("produce los mismos bytes y SHA-256 que el fixture compartido con PostgreSQL", () => {
    const snapshot = crearSnapshotFiscalV2(inputV2() as never);

    expect(serializarSnapshotFiscal(bodyV2())).toBe(parityFixture.canonical);
    expect(calcularHashSnapshotFiscal(bodyV2())).toBe(parityFixture.sha256);
    expect(snapshot.hash).toBe(parityFixture.sha256);
    expect(snapshot).toEqual(parityFixture.input);
    expect(validarSnapshotFiscalV2(snapshot)).toEqual(snapshot);
  });

  it("normaliza el orden de items, alícuotas, tributos y asociaciones con claves de dominio", () => {
    const base = inputV2() as any;
    base.items[1] = {
      ...base.items[1],
      ivaPorcentaje: "10.50",
      importeIva: "10.50",
      subtotalTotal: "110.50",
    };
    base.items.reverse();
    base.alicuotasIva = [
      { id: 4, baseImponible: "100.00", importe: "10.50" },
      ...base.alicuotasIva,
    ];
    base.tributos = [
      {
        id: 2,
        descripcion: "Tasa nacional",
        baseImponible: "100.00",
        alicuota: "5.00",
        importe: "5.00",
      },
      ...base.tributos,
    ];
    base.importeNeto = "1100.00";
    base.importeExento = "0.00";
    base.importeIva = "220.50";
    base.importeTributos = "25.00";
    base.importeTotal = "1395.50";
    base.ivaContenido = "220.50";
    base.otrosImpuestosNacionalesIndirectos = "25.00";

    const snapshot = crearSnapshotFiscalV2(base);

    expect(snapshot.items.map((item) => item.id)).toEqual([
      "71000000-0000-4000-8000-000000000011",
      "71000000-0000-4000-8000-000000000012",
      "71000000-0000-4000-8000-000000000013",
    ]);
    expect(snapshot.alicuotasIva.map((row) => row.id)).toEqual([4, 5]);
    expect(snapshot.tributos.map((row) => row.id)).toEqual([1, 2]);
  });

  it("recalcula cada línea y no acepta subtotales coherentes sólo a nivel agregado", () => {
    const input = inputV2() as any;
    input.items[0].cantidad = "3.00";

    expect(() => crearSnapshotFiscalV2(input)).toThrow(/cálculo|subtotal|item/i);
  });

  it("redondea una vez por ítem y agrupa los importes ya redondeados", () => {
    const input = inputV2() as any;
    input.items = [
      {
        ...input.items[0],
        id: "71000000-0000-4000-8000-000000000011",
        productoId: null,
        cantidad: "1.00",
        precioUnitarioSinIva: "0.05",
        descuentoPorcentaje: "10.00",
        ivaPorcentaje: "10.50",
        subtotalNeto: "0.05",
        importeIva: "0.01",
        subtotalTotal: "0.06",
      },
      {
        ...input.items[0],
        id: "71000000-0000-4000-8000-000000000012",
        productoId: null,
        cantidad: "1.00",
        precioUnitarioSinIva: "0.05",
        descuentoPorcentaje: "10.00",
        ivaPorcentaje: "10.50",
        subtotalNeto: "0.05",
        importeIva: "0.01",
        subtotalTotal: "0.06",
      },
    ];
    input.importeNeto = "0.10";
    input.importeExento = "0.00";
    input.importeNoGravado = "0.00";
    input.importeIva = "0.02";
    input.importeTributos = "0.00";
    input.importeTotal = "0.12";
    input.alicuotasIva = [{ id: 4, baseImponible: "0.10", importe: "0.02" }];
    input.tributos = [];
    input.ivaContenido = "0.02";
    input.otrosImpuestosNacionalesIndirectos = "0.00";

    expect(crearSnapshotFiscalV2(input).alicuotasIva).toEqual([
      { id: 4, baseImponible: "0.10", importe: "0.02" },
    ]);
  });

  it("exige el ID ARCA y los importes exactos de cada grupo de IVA", () => {
    const idIncorrecto = inputV2() as any;
    idIncorrecto.alicuotasIva[0].id = 4;
    expect(() => crearSnapshotFiscalV2(idIncorrecto)).toThrow(/alícuota|IVA|ID/i);

    const grupoIncorrecto = inputV2() as any;
    grupoIncorrecto.alicuotasIva = [
      { id: 3, baseImponible: "100.00", importe: "0.00" },
      { id: 5, baseImponible: "900.00", importe: "210.00" },
    ];
    expect(() => crearSnapshotFiscalV2(grupoIncorrecto)).toThrow(/alícuota|IVA|grupo/i);
  });

  it("representa el neto gravado a tasa cero únicamente con ID 3", () => {
    const input = inputV2() as any;
    input.items = [
      {
        ...input.items[1],
        ivaPorcentaje: "0.00",
        subtotalNeto: "100.00",
        importeIva: "0.00",
        subtotalTotal: "100.00",
      },
    ];
    input.importeNeto = "100.00";
    input.importeExento = "0.00";
    input.importeNoGravado = "0.00";
    input.importeIva = "0.00";
    input.importeTributos = "0.00";
    input.importeTotal = "100.00";
    input.alicuotasIva = [{ id: 3, baseImponible: "100.00", importe: "0.00" }];
    input.tributos = [];
    input.ivaContenido = "0.00";
    input.otrosImpuestosNacionalesIndirectos = "0.00";

    expect(crearSnapshotFiscalV2(input).alicuotasIva).toEqual([
      { id: 3, baseImponible: "100.00", importe: "0.00" },
    ]);
  });

  it("hace el hash sensible a receptor, condición, fecha, número, total y asociación", () => {
    const base = bodyV2() as any;
    const hash = calcularHashSnapshotFiscal(base);
    const variantes = [
      { ...base, receptor: { ...base.receptor, razonSocial: "OTRO" } },
      { ...base, receptor: { ...base.receptor, condicionIva: "EXENTO" } },
      { ...base, fechaComprobante: "2026-08-23" },
      { ...base, identidad: { ...base.identidad, numero: 2 } },
      { ...base, importeTotal: "1380.01" },
      {
        ...base,
        cbtesAsoc: [
          {
            tipo: 6,
            puntoVenta: 5,
            numero: 99,
            cuit: "30714199664",
            fecha: "2026-08-21",
          },
        ],
      },
    ];

    for (const variante of variantes) {
      expect(calcularHashSnapshotFiscal(variante)).not.toBe(hash);
    }
  });

  it("congela copias y no retiene referencias mutables", () => {
    const entrada = inputV2() as any;
    const snapshot = crearSnapshotFiscalV2(entrada);
    entrada.items[0].descripcion = "mutada";
    entrada.receptor.razonSocial = "mutado";

    expect(snapshot.items[0].descripcion).toBe("Pintura interior");
    expect(snapshot.receptor.razonSocial).toBe("CLIENTE FINAL");
  });

  it("el constructor controla version=2 y no la acepta desde el caller", () => {
    expect(crearSnapshotFiscalV2(inputV2() as never).version).toBe(2);
    expect(() => crearSnapshotFiscalV2({ ...inputV2(), version: 1 } as never)).toThrow(
      /desconocida|faltante/i,
    );
  });

  it("bloquea emisores no RI y comprobantes C nuevos", () => {
    const input = inputV2() as any;
    input.emisor.condicionIva = "MONOTRIBUTO";
    input.letra = "C";
    input.identidad.cbteTipo = 11;

    expect(() => crearSnapshotFiscalV2(input)).toThrow(/emisor.*RI|responsable inscripto/i);
  });

  it("acepta alícuotas vacías sólo para un comprobante puramente exento", () => {
    const input = inputV2() as any;
    input.items = [
      {
        ...input.items[1],
        subtotalNeto: "100.00",
        importeIva: "0.00",
        subtotalTotal: "100.00",
      },
    ];
    input.importeNeto = "0.00";
    input.importeExento = "100.00";
    input.importeNoGravado = "0.00";
    input.importeIva = "0.00";
    input.importeTributos = "0.00";
    input.importeTotal = "100.00";
    input.alicuotasIva = [];
    input.tributos = [];
    input.ivaContenido = "0.00";
    input.otrosImpuestosNacionalesIndirectos = "0.00";

    expect(crearSnapshotFiscalV2(input).alicuotasIva).toEqual([]);
  });

  it("acepta instantes canónicos con segundos y con exactamente tres milisegundos", () => {
    const input = inputV2() as any;
    prepararReceptorArcaParaVerificacion(input);
    input.venta.fechaComercial = "2026-08-20T15:00:00Z";
    input.receptor.verificadoArcaAt = "2026-08-21T14:59:58.123Z";

    const snapshot = crearSnapshotFiscalV2(input);
    expect(snapshot.venta.fechaComercial).toBe("2026-08-20T15:00:00Z");
    expect(snapshot.receptor.verificadoArcaAt).toBe("2026-08-21T14:59:58.123Z");
  });

  it.each([
    ["fecha comercial normalizada", "2026-02-30T15:00:00Z", false],
    ["fecha comercial 24:00", "2026-08-22T24:00:00Z", false],
    ["verificación normalizada", "2026-02-30T15:00:00.000Z", true],
    ["verificación 24:00", "2026-08-22T24:00:00.000Z", true],
  ])("rechaza %s", (_caso, instante, esVerificacion) => {
    const input = inputV2() as any;
    if (esVerificacion) {
      prepararReceptorArcaParaVerificacion(input);
      input.receptor.verificadoArcaAt = instante;
    } else {
      input.venta.fechaComercial = instante;
    }

    expect(() => crearSnapshotFiscalV2(input)).toThrow(/instante|fecha|verificación/i);
  });

  it.each([
    ["venta.fechaComercial", (input: any) => (input.venta.fechaComercial = "0000-01-01T00:00:00Z")],
    [
      "receptor.verificadoArcaAt",
      (input: any) => (input.receptor.verificadoArcaAt = "0000-01-01T00:00:00.000Z"),
    ],
    ["fechaComprobante", (input: any) => (input.fechaComprobante = "0000-01-01")],
    ["emisor.inicioActividades", (input: any) => (input.emisor.inicioActividades = "0000-01-01")],
    ["cbtesAsoc.fecha", (input: any) => (input.cbtesAsoc[0].fecha = "0000-01-01")],
  ])("rechaza el año 0000 en %s", (_campo, mutar) => {
    const input = notaInputV2();
    if (_campo === "receptor.verificadoArcaAt") prepararReceptorArcaParaVerificacion(input);
    mutar(input);
    expect(() => crearSnapshotFiscalV2(input)).toThrow(/fecha|instante|año/i);
  });

  it.each([
    ["venta.fechaComercial", (input: any) => (input.venta.fechaComercial = "2100-02-29T00:00:00Z")],
    [
      "receptor.verificadoArcaAt",
      (input: any) => (input.receptor.verificadoArcaAt = "2100-02-29T00:00:00.000Z"),
    ],
    ["fechaComprobante", (input: any) => (input.fechaComprobante = "2100-02-29")],
    ["emisor.inicioActividades", (input: any) => (input.emisor.inicioActividades = "2100-02-29")],
    ["cbtesAsoc.fecha", (input: any) => (input.cbtesAsoc[0].fecha = "2100-02-29")],
  ])("rechaza 2100-02-29 en %s", (_campo, mutar) => {
    const input = notaInputV2();
    if (_campo === "receptor.verificadoArcaAt") prepararReceptorArcaParaVerificacion(input);
    mutar(input);
    expect(() => crearSnapshotFiscalV2(input)).toThrow(/fecha|instante/i);
  });

  it.each([
    ["0001-01-01", "0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000Z"],
    ["2024-02-29", "2024-02-29T00:00:00Z", "2024-02-29T00:00:00.000Z"],
  ])(
    "acepta la fecha gregoriana válida %s en los cinco campos",
    (dia, instanteVenta, instanteArca) => {
      const input = notaInputV2();
      prepararReceptorArcaParaVerificacion(input);
      input.venta.fechaComercial = instanteVenta;
      input.receptor.verificadoArcaAt = instanteArca;
      input.fechaComprobante = dia;
      input.emisor.inicioActividades = dia;
      input.cbtesAsoc[0].fecha = dia;

      const snapshot = crearSnapshotFiscalV2(input);
      expect(snapshot.fechaComprobante).toBe(dia);
      expect(snapshot.cbtesAsoc[0].fecha).toBe(dia);
    },
  );

  it.each(["00000000000", "30-71419966-4"])(
    "rechaza CUIT de emisor no canónico o inválido: %s",
    (cuit) => {
      const input = inputV2() as any;
      input.emisor.cuit = cuit;
      input.identidad.emisorCuit = cuit;
      expect(() => crearSnapshotFiscalV2(input)).toThrow(/CUIT/i);
    },
  );

  it.each(["00000000000", "30-71419966-4"])(
    "rechaza CUIT de identidad no canónico o inválido: %s",
    (cuit) => {
      const input = inputV2() as any;
      input.identidad.emisorCuit = cuit;
      expect(() => crearSnapshotFiscalV2(input)).toThrow(/CUIT/i);
    },
  );

  it.each(["00000000000", "30-71419966-4"])(
    "rechaza CUIT de receptor no canónico o inválido: %s",
    (cuit) => {
      const input = inputV2ConReceptorRi();
      input.receptor.numeroDocumento = cuit;
      input.receptor.docNroArca = cuit.replace(/\D/g, "");
      expect(() => crearSnapshotFiscalV2(input)).toThrow(/CUIT|documento/i);
    },
  );

  it.each(["00000000000", "30-71419966-4"])(
    "rechaza CUIT de CbtesAsoc no canónico o inválido: %s",
    (cuit) => {
      const input = notaInputV2();
      input.cbtesAsoc[0].cuit = cuit;
      expect(() => crearSnapshotFiscalV2(input)).toThrow(/CUIT|asociación/i);
    },
  );

  it("acepta CUIT canónico válido en emisor, identidad, receptor y asociación", () => {
    const facturaA = inputV2ConReceptorRi();
    expect(crearSnapshotFiscalV2(facturaA).receptor.numeroDocumento).toBe("30714199664");

    const nota = notaInputV2();
    expect(crearSnapshotFiscalV2(nota).cbtesAsoc[0].cuit).toBe("30714199664");
  });

  it("no confunde otros impuestos nacionales indirectos con el total de tributos", () => {
    const input = inputV2() as any;
    input.otrosImpuestosNacionalesIndirectos = "25.00";

    expect(crearSnapshotFiscalV2(input).otrosImpuestosNacionalesIndirectos).toBe("25.00");
  });

  it("valida una NC completa con CUIT en CbtesAsoc y rechaza ND nueva", () => {
    const nc = inputV2() as any;
    nc.venta.tipoComprobante = "NOTA_CREDITO";
    nc.identidad.cbteTipo = 8;
    nc.origen = "COMPROBANTE_ORIGINAL";
    nc.comprobanteOriginalId = "71000000-0000-4000-8000-000000000901";
    nc.cbtesAsoc = [
      {
        tipo: 6,
        puntoVenta: 5,
        numero: 42,
        cuit: "30714199664",
        fecha: "2026-08-21",
      },
    ];

    expect(crearSnapshotFiscalV2(nc).cbtesAsoc[0].cuit).toBe("30714199664");
    expect(() =>
      crearSnapshotFiscalV2({
        ...nc,
        venta: { ...nc.venta, tipoComprobante: "NOTA_DEBITO" },
        identidad: { ...nc.identidad, cbteTipo: 7 },
      }),
    ).toThrow(/débito.*fuera de alcance/i);
  });

  it.each([
    ["decimal numérico", (value: any) => (value.importeTotal = 1380)],
    ["total incoherente", (value: any) => (value.importeTotal = "1380.01")],
    ["documento ARCA distinto", (value: any) => (value.receptor.docNroArca = "30123457")],
    ["condición ARCA distinta", (value: any) => (value.receptor.condicionIvaReceptorId = 4)],
    ["CUIT emisor distinto", (value: any) => (value.identidad.emisorCuit = "30717322467")],
    ["letra/tipo distinto", (value: any) => (value.identidad.cbteTipo = 1)],
    ["validez incoherente", (value: any) => (value.identidad.validez = "SIMULADA")],
    ["fecha imposible", (value: any) => (value.fechaComprobante = "2026-02-30")],
    ["clave desconocida", (value: any) => (value.secreto = "no")],
    ["item duplicado", (value: any) => value.items.push(structuredClone(value.items[0]))],
    [
      "alícuota duplicada",
      (value: any) => value.alicuotasIva.push(structuredClone(value.alicuotasIva[0])),
    ],
    [
      "alícuota vacía",
      (value: any) => (value.alicuotasIva[0] = { id: 5, baseImponible: "0.00", importe: "0.00" }),
    ],
    [
      "tributo vacío",
      (value: any) =>
        (value.tributos[0] = {
          ...value.tributos[0],
          baseImponible: "0.00",
          alicuota: "0.00",
          importe: "0.00",
        }),
    ],
    ["tributo duplicado", (value: any) => value.tributos.push(structuredClone(value.tributos[0]))],
    ["clave anidada desconocida", (value: any) => (value.receptor.secreto = "no")],
    ["clave anidada faltante", (value: any) => delete value.emisor.cuit],
  ])("falla cerrado ante %s", (_caso, mutar) => {
    const value = inputV2() as any;
    mutar(value);
    expect(() => crearSnapshotFiscalV2(value)).toThrow();
  });

  it("rechaza asociaciones duplicadas aunque el resto de la nota sea coherente", () => {
    const nc = inputV2() as any;
    nc.venta.tipoComprobante = "NOTA_CREDITO";
    nc.identidad.cbteTipo = 8;
    nc.origen = "COMPROBANTE_ORIGINAL";
    nc.comprobanteOriginalId = "71000000-0000-4000-8000-000000000901";
    const asociacion = {
      tipo: 6,
      puntoVenta: 5,
      numero: 42,
      cuit: "30714199664",
      fecha: "2026-08-21",
    };
    nc.cbtesAsoc = [asociacion, { ...asociacion }];

    expect(() => crearSnapshotFiscalV2(nc)).toThrow(/asociaci/i);
  });

  it("rechaza v1, hashes alterados y arrays desordenados al leer lo persistido", () => {
    expect(() => validarSnapshotFiscalV2(snapshotFacturaBHistorica)).toThrow(/versión 2/i);

    const valido = crearSnapshotFiscalV2(inputV2() as never) as any;
    expect(() => validarSnapshotFiscalV2({ ...valido, hash: "f".repeat(64) })).toThrow(/hash/i);

    const desordenado = structuredClone(valido);
    desordenado.items.reverse();
    expect(() => validarSnapshotFiscalV2(desordenado)).toThrow(/orden canónico/i);
  });

  it.each([
    ["NaN", { value: Number.NaN }],
    ["infinito", { value: Number.POSITIVE_INFINITY }],
    ["menos cero", { value: -0 }],
    ["unsafe integer", { value: Number.MAX_SAFE_INTEGER + 1 }],
    ["undefined", { value: undefined }],
    ["función", { value: () => null }],
    ["símbolo", { value: Symbol("x") }],
    ["bigint", { value: 1n }],
    ["Date", { value: new Date("2026-08-22T00:00:00Z") }],
    ["surrogate", { value: "\ud800" }],
  ])("el serializador rechaza %s", (_caso, value) => {
    expect(() => serializarSnapshotFiscal(value)).toThrow();
  });

  it("rechaza ciclos, accessors y la propiedad hash en el valor a serializar", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => serializarSnapshotFiscal(cycle)).toThrow(/cíclico/i);

    const accessor = Object.defineProperty({}, "valor", {
      enumerable: true,
      get: () => 1,
    });
    expect(() => serializarSnapshotFiscal(accessor)).toThrow(/accessor/i);
    expect(() => serializarSnapshotFiscal({ version: 2, hash: "x" })).toThrow(/sin hash/i);
  });

  it("nunca ejecuta accessors de índices de arrays", () => {
    const ejecutar = (operacion: (array: unknown[], input: Record<string, unknown>) => unknown) => {
      const input = inputV2() as any;
      const items = structuredClone(input.items) as unknown[];
      const primero = items[0];
      let lecturas = 0;
      Object.defineProperty(items, "0", {
        configurable: true,
        enumerable: true,
        get() {
          lecturas += 1;
          return primero;
        },
      });
      input.items = items;

      expect(() => operacion(items, input)).toThrow(/accessor/i);
      expect(lecturas).toBe(0);
    };

    ejecutar((items) => serializarSnapshotFiscal({ items }));
    ejecutar((items) => calcularHashSnapshotFiscal({ items }));
    ejecutar((_items, input) => crearSnapshotFiscalV2(input as never));
    ejecutar((_items, input) => {
      const { hash: _hash, ...body } = structuredClone(parityFixture.input) as any;
      body.items = input.items;
      validarSnapshotFiscalV2({ ...body, hash: parityFixture.sha256 });
    });
  });

  it.each([
    [
      "setter",
      (array: unknown[]) =>
        Object.defineProperty(array, "0", {
          configurable: true,
          enumerable: true,
          set() {},
        }),
      /accessor/i,
    ],
    [
      "índice no enumerable",
      (array: unknown[]) =>
        Object.defineProperty(array, "0", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: array[0],
        }),
      /enumerable/i,
    ],
    ["hueco", (array: unknown[]) => delete array[0], /hueco/i],
    ["propiedad extra", (array: any) => (array.extra = true), /adicional/i],
    ["índice aparente fuera del largo", (array: any) => (array["4294967295"] = true), /adicional/i],
    ["Symbol", (array: any) => (array[Symbol("x")] = true), /adicional|Symbol/i],
    [
      "prototipo custom",
      (array: unknown[]) => Object.setPrototypeOf(array, Object.create(Array.prototype)),
      /prototipo/i,
    ],
  ])("rechaza arrays con %s", (_caso, mutar, mensaje) => {
    const array = [{ id: 1 }];
    mutar(array);
    expect(() => serializarSnapshotFiscal({ items: array })).toThrow(mensaje);
  });

  it("ordena claves por bytes UTF-8 y no por el orden de inserción", () => {
    expect(serializarSnapshotFiscal({ á: 1, a: 2 })).toBe('{"a":2,"á":1}');
  });
});
