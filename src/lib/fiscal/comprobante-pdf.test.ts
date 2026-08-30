import { describe, it, expect } from "vitest";
import { generarComprobantePdf, numeroFiscal } from "./comprobante-pdf";
import { porcentajeDeIvaId, requiereLeyendaTransparencia, tituloDeCbteTipo } from "./codigos";
import {
  ErrorImpresionFiscal,
  LEYENDA_CREDITO_FISCAL_MONOTRIBUTO,
  type DatosFiscalesImpresos,
} from "./impresion";
import { esPngDataUrlFiscal } from "./qr";
import { prepararDatosFiscalesImpresos } from "./impresion";
import { crearSnapshotFiscalV3Fixture } from "./snapshot-v3.test-fixture";

/**
 * El PDF es el papel que ve el cliente y que mira el contador. Lo que se
 * verifica acá es que los datos OBLIGATORIOS estén realmente impresos, no que
 * quede lindo: el bug anterior fue justamente que faltaban campos.
 *
 * Para leerlo, se saca el texto crudo del PDF: jsPDF no comprime por defecto, así
 * que los literales quedan visibles entre paréntesis dentro de los streams.
 */
function textoDelPdf(doc: ReturnType<typeof generarComprobantePdf>["doc"]): string {
  const raw = doc.output("arraybuffer");
  const bytes = new Uint8Array(raw);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  // Los strings de un PDF van como (texto) Tj / TJ. Con esto alcanza para
  // comprobar presencia de campos.
  const decoded = s
    .replace(/\\(\d{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\([()\\])/g, "$1")
    .replace(/\u00a0/g, " ")
    .replace(/\x97/g, "—");
  const textos = [...decoded.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((match) =>
    match[1].replace(/\\([()\\])/g, "$1"),
  );
  // Se conserva el stream para las coordenadas Td y se agrega una lectura
  // corrida: jsPDF parte las leyendas largas en varios Tj aunque visualmente
  // sean una sola oración.
  return `${decoded}\n${textos.join(" ")}`;
}

function textosPorPagina(doc: ReturnType<typeof generarComprobantePdf>["doc"]): string[] {
  const paginas = (doc.internal as unknown as { pages: string[][] }).pages;
  return paginas.slice(1).map((operadores) =>
    operadores
      .join("\n")
      .replace(/\\(\d{3})/g, (_m, octal) => String.fromCharCode(parseInt(octal, 8)))
      .replace(/\\([()\\])/g, "$1")
      .replace(/\u00a0/g, " ")
      .replace(/\x97/g, "—"),
  );
}

const venta = {
  numero_comprobante: "OHI-FVTA-0042",
  tipo_comprobante: "FACTURA_B",
  fecha: "2026-08-10T15:00:00Z",
  condicion_venta: "CONTADO",
  subtotal_sin_iva: 1000,
  iva_total: 210,
  percepciones: 0,
  total: 1210,
  cliente: { razon_social: "Pinturerías del Sur SRL", cuit_dni: "30712345678" },
  sucursal: { nombre: "O'Higgins" },
};

const items = [
  {
    codigo: "LX-001",
    descripcion: "Látex interior 20L",
    cantidad: 2,
    precio_unitario_sin_iva: 500,
    descuento_porcentaje: 0,
    iva_porcentaje: 21,
    subtotal_con_iva: 1210,
  },
];

const QR_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAklEQVR4AewaftIAAAMaSURBVOXBW6qlWBQAwUxx/lPOrgUtbET7eB9FfxghED9QMVQ+qXhKZVR8ovJdGy+38XI7i4qnVFYVQ+VQcUVlVHyHyqhYVTylMjZebueCyp2KKypnKquKlcqh4orKV6ncqVhtvNzOL6k4UxkVT6msKv6mjZfb+WUqd1TuqIyKlcqo+Bs2Xm7j5XYuVHyVyqg4qAyVVcVQOVQMlZ+qeGrj5XYWKn9DxVB5qmKonKmMipXKV2283F7xGyq+quKg8l9U7lR818bL7SqHiqEyKu6orCruqIyKoTIqPqk4U7miMirOVEbFUBkbLycQJxVD5aziisqouKMyKu6ojIqVyqFipbKquKOy2ni5jZfbeaDioPKUyqpiqPyEylMqq4qhMjZebq84qKwqhsqh4orKJyqjYqgcKobKJxVDZVQMlaFyVrGqGBsvt/NFKquKOxVPqTylMiqGyqriE5Wx8XI7F1RGxVnFSmWl8n+p+ERltfFyu8pZxScqo2KlcqgYKqNiqIyKg8qoGCqj4qziuyqGyth4uY2XE4hvqBgqq4qDypWKoXKoGCqjYqjcqRgqq4qnNl5u54GKg8pQGRVD5axiqDxVcaXioHKl4imVsfFy9gc3VO5UfKIyKobKJxVDZVQMlbOKobKqOFO5svFyAvFBxZnKqmKoHCquqIyKg8qqYqVyqBgqo+KOyqhYqYyNl7M/+EDlrOKnVA4VV1Q+qRgqo+KpjZfbeDmBOKkYKr+pYqjcqbii8hMVQ2VUjI2Xsz/4BSqfVAyVUXFQWVUMlVFxUBkVV1TuVAyVsfFyu8pPVKwqzlSGyqi4UzFUnlIZFWcV/2Xj5XYWFU+prCqGylnFSmVUnKmMiqEyVO5UPKUyKsbGy+1cULlT8VTFSuVOxZWKoXKm8onKqLiy8XIbL7fzF6mMilFxR2VUrFRGxUFlVTFU7qiMiqEyNl5u55eojIqDylC5UvEdFVcqhsqhYqWy2ng5gfhXxVMqo2KlcqgYKqPijsqq4o7KqFip3Km4svFyOwuV71IZFXdU7lQMlZXKHZVVxVA5VFxRGRsv9w+XWOO73oYUWAAAAABJRU5ErkJggg==";

const fiscalBase: DatosFiscalesImpresos = {
  origen: "SNAPSHOT_V2",
  advertencia: null,
  emisor: {
    razon_social: "CasaForma SRL",
    nombre_fantasia: "CasaForma",
    cuit: "30712345678",
    domicilio_fiscal: "O'Higgins 1234",
    condicion_iva: "RESPONSABLE_INSCRIPTO",
    ingresos_brutos: "901-123456-7",
    inicio_actividades: "2019-03-15",
    telefono: null,
  },
  receptor: {
    razon_social: "Juan Pérez",
    cuit_dni: "20123456789",
    doc_tipo: 80,
    condicion_iva: "CONSUMIDOR_FINAL",
    domicilio: "Belgrano 500",
  },
  condicion_venta: "CONTADO",
  lineas: items,
  totales: {
    neto: 1000,
    exento: 0,
    no_gravado: 0,
    iva: 210,
    tributos: 0,
    total: 1210,
    alicuotas: [{ Id: 5, BaseImp: 1000, Importe: 210 }],
  },
  cae: "75123456789012",
  cae_vencimiento: "2026-08-20",
  fecha: "2026-08-22",
  punto_venta: 1,
  numero: 42,
  cbte_tipo: 6,
  modo: "PRODUCCION",
  simulado: false,
  validez: "PRODUCCION",
  iva_contenido: "210.00",
  otros_impuestos_nacionales_indirectos: "0.00",
  qrInput: {
    fecha: "2026-08-22",
    cuit: "30712345678",
    ptoVta: 1,
    tipoCmp: 6,
    nroCmp: 42,
    importe: "1210.00",
    moneda: "PES",
    ctz: "1.000000",
    tipoDocRec: 80,
    nroDocRec: "20123456789",
    codAut: "75123456789012",
  },
  qr: QR_PNG,
};

const fiscalConTotalesCompletos: DatosFiscalesImpresos = {
  ...fiscalBase,
  lineas: [
    items[0],
    { ...items[0], codigo: "EX-001", descripcion: "Operación exenta", subtotal_con_iva: 100 },
    { ...items[0], codigo: "NG-001", descripcion: "Operación no gravada", subtotal_con_iva: 50 },
  ],
  totales: {
    neto: 1000,
    exento: 100,
    no_gravado: 50,
    iva: 210,
    tributos: 20,
    total: 1380,
    alicuotas: [{ Id: 5, BaseImp: 1000, Importe: 210 }],
  },
};

describe("numeración fiscal impresa", () => {
  it("usa el formato PPPPP-NNNNNNNN", () => {
    expect(numeroFiscal(1, 42)).toBe("00001-00000042");
    expect(numeroFiscal(12345, 12345678)).toBe("12345-12345678");
  });
});

describe("comprobante impreso — los campos obligatorios", () => {
  const { doc, nombre } = generarComprobantePdf(venta, items, fiscalBase);
  const texto = textoDelPdf(doc);

  it("el archivo se nombra con el número fiscal, no con el interno", () => {
    expect(nombre).toBe("00001-00000042.pdf");
  });

  it("imprime los datos del emisor, incluidos Ingresos Brutos e inicio de actividades", () => {
    expect(texto).toContain("CasaForma SRL");
    expect(texto).toContain("CUIT: 30712345678");
    expect(texto).toContain("Ingresos Brutos: 901-123456-7");
    expect(texto).toContain("Inicio de actividades: 15/03/2019");
  });

  // RG 5616: sin esto el comprobante está incompleto.
  it("imprime la condición de IVA del receptor y su domicilio", () => {
    expect(texto).toContain("Condición IVA: Consumidor Final");
    expect(texto).toContain("Domicilio: Belgrano 500");
  });

  it("imprime la condición de venta", () => {
    expect(texto).toContain("Condición de venta: Contado");
  });

  it("imprime el recuadro de la letra con el código de AFIP", () => {
    expect(texto).toContain("COD. 06");
  });

  it("discrimina el IVA por alícuota, no en una sola línea genérica", () => {
    expect(texto).toContain("IVA 21,00%");
  });

  it("imprime el CAE y su vencimiento sin correrse un día", () => {
    expect(texto).toContain("CAE N°: 75123456789012");
    expect(texto).toContain("Vto. CAE: 20/08/2026");
  });

  it("imprime la fecha fiscal congelada y no la fecha comercial vieja", () => {
    expect(texto).toContain("Fecha de emisión: 22/08/2026");
    expect(texto).not.toContain("10/08/2026");
  });

  it("el bloque fiscal usa al receptor congelado y nunca al comprador comercial", () => {
    expect(texto).toContain("Juan Pérez");
    expect(texto).not.toContain("Pinturerías del Sur SRL");
  });

  it("imprime tipo y número del CDI congelado en el receptor fiscal", () => {
    const { doc } = generarComprobantePdf(venta, items, {
      ...fiscalBase,
      receptor: {
        ...fiscalBase.receptor,
        razon_social: "Receptor con CDI",
        cuit_dni: "50123456789",
        doc_tipo: 87,
      },
      qrInput: {
        ...fiscalBase.qrInput,
        tipoDocRec: 87,
        nroDocRec: "50123456789",
      },
    });

    const textoCdi = textoDelPdf(doc);
    expect(textoCdi).toContain("Receptor con CDI");
    expect(textoCdi).toContain("CDI: 50-12345678-9");
  });

  // Ley 27.743 / RG 5614: obligatoria en B y C a consumidor final.
  it("incluye la leyenda de Transparencia Fiscal en una B a consumidor final", () => {
    expect(texto).toContain("Régimen de Transparencia Fiscal al Consumidor (Ley N° 27.743)");
    expect(texto).toContain("IVA Contenido: $ 210,00");
    expect(texto).toContain("Otros Impuestos Nacionales Indirectos: $ 0,00");
  });
});

describe("leyenda de crédito fiscal Ley 27.618", () => {
  it.each([1, 2, 3])("la imprime completa para CbteTipo A %s a monotributo", (cbteTipo) => {
    const { doc } = generarComprobantePdf(venta, items, {
      ...fiscalBase,
      cbte_tipo: cbteTipo,
      receptor: {
        ...fiscalBase.receptor,
        razon_social: "Receptor monotributista",
        condicion_iva: "MONOTRIBUTO",
      },
    });

    expect(textoDelPdf(doc)).toContain(LEYENDA_CREDITO_FISCAL_MONOTRIBUTO);
  });
});

describe("totales fiscales completos", () => {
  it("imprime neto, exento, no gravado, IVA y tributos en renglones separados", () => {
    const { doc } = generarComprobantePdf(
      { ...venta, total: 999999 },
      items,
      fiscalConTotalesCompletos,
    );
    const texto = textoDelPdf(doc);

    expect(texto).toContain("Neto gravado");
    expect(texto).toContain("$ 1.000,00");
    expect(texto).toContain("Exento");
    expect(texto).toContain("$ 100,00");
    expect(texto).toContain("No gravado");
    expect(texto).toContain("$ 50,00");
    expect(texto).toContain("IVA 21,00%");
    expect(texto).toContain("$ 210,00");
    expect(texto).toContain("Percepciones y otros tributos");
    expect(texto).toContain("$ 20,00");
    expect(texto).toContain("Otros Impuestos Nacionales Indirectos: $ 0,00");
    expect(texto).toContain("$ 1.380,00");
    expect(texto).not.toContain("$ 999.999,00");
  });

  it("usa el IVA congelado aunque el snapshot no tenga alícuotas", () => {
    const fiscalPuroExentoNoGravado: DatosFiscalesImpresos = {
      ...fiscalBase,
      lineas: [
        { ...items[0], codigo: "EX-001", descripcion: "Operación exenta", subtotal_con_iva: 100 },
        {
          ...items[0],
          codigo: "NG-001",
          descripcion: "Operación no gravada",
          subtotal_con_iva: 50,
        },
      ],
      totales: {
        neto: 0,
        exento: 100,
        no_gravado: 50,
        iva: 0,
        tributos: 0,
        total: 150,
        alicuotas: [],
      },
    };

    const { doc } = generarComprobantePdf(
      { ...venta, subtotal_sin_iva: 999, iva_total: 999, total: 999 },
      items,
      fiscalPuroExentoNoGravado,
    );
    const texto = textoDelPdf(doc);

    expect(texto).toContain("Neto gravado $ 0,00 Exento $ 100,00 No gravado $ 50,00 IVA $ 0,00");
    expect(texto).toContain("TOTAL $ 150,00");
    expect(texto).not.toContain("$ 999,00");
  });
});

describe("nota de crédito", () => {
  // Internamente una NC guarda todo en negativo; el papel va en positivo.
  const ncVenta = {
    ...venta,
    tipo_comprobante: "NOTA_CREDITO",
    numero_comprobante: "OHI-NCIV-0007",
    subtotal_sin_iva: -1000,
    iva_total: -210,
    total: -1210,
  };
  const ncItems = [{ ...items[0], subtotal_con_iva: -1210 }];
  const ncFiscal: DatosFiscalesImpresos = { ...fiscalBase, cbte_tipo: 8, numero: 7 };

  const { doc } = generarComprobantePdf(ncVenta, ncItems, ncFiscal);
  const texto = textoDelPdf(doc);

  it("se titula NOTA DE CRÉDITO", () => {
    expect(texto).toContain("NOTA DE");
  });

  it("no imprime importes en negativo", () => {
    // Primero: que efectivamente haya importes impresos, si no el chequeo de
    // abajo pasaría en vacío.
    expect(texto).toMatch(/\$\s?1\.210,00/);
    expect(texto).not.toMatch(/-\s?\$/);
    expect(texto).toContain("COD. 08");
  });
});

describe("nota de crédito por período desde snapshot v3", () => {
  const snapshot = crearSnapshotFiscalV3Fixture();
  const fiscal = {
    ...prepararDatosFiscalesImpresos({
      id: snapshot.venta.id,
      afip_estado: "APROBADO",
      afip_fase: "PERSISTIDO",
      afip_version: 7,
      afip_legacy_incompleto: false,
      afip_snapshot: snapshot,
      afip_snapshot_hash: snapshot.hash,
      afip_emisor_cuit: snapshot.identidad.emisorCuit,
      afip_punto_venta: snapshot.identidad.puntoVenta,
      afip_cbte_tipo: snapshot.identidad.cbteTipo,
      afip_numero: snapshot.identidad.numero,
      afip_modo: snapshot.identidad.modo,
      afip_simulado: snapshot.identidad.simulado,
      afip_validez: snapshot.identidad.validez,
      afip_fecha_comprobante: snapshot.fechaComprobante,
      afip_imp_total: snapshot.importeTotal,
      cae: "75123456789012",
      cae_vencimiento: "2026-08-30",
      periodo_asoc_desde: "1999-01-01",
      nc_periodo_modalidad: "BONIFICACION_AJUSTE",
      motivo_nota_credito: "dato vivo que no debe imprimirse",
    }),
    qr: QR_PNG,
  };
  const { doc } = generarComprobantePdf(
    {
      ...venta,
      tipo_comprobante: "NOTA_CREDITO",
      cliente: { razon_social: "Comprador comercial", cuit_dni: "20333444559" },
    },
    [{ ...items[0], descripcion: "línea viva que no debe imprimirse" }],
    fiscal,
  );
  const texto = textoDelPdf(doc);

  it("imprime asociación, modo y motivo congelados junto con receptor, importes y CAE", () => {
    expect(texto).toContain("Período asociado: 01/08/2026 a 15/08/2026");
    expect(texto).toContain("Modalidad: Devolución de productos");
    expect(texto).toContain("Motivo: Devolución de productos del período");
    expect(texto).toContain(snapshot.receptor.razonSocial);
    expect(texto).toContain(snapshot.items[0].descripcion);
    expect(texto).toContain("Neto gravado");
    expect(texto).toContain("IVA");
    expect(texto).toContain("TOTAL");
    expect(texto).toContain("CAE N°: 75123456789012");
  });

  it("no usa receptor, líneas ni metadata fiscal viva", () => {
    expect(texto).not.toContain("Comprador comercial");
    expect(texto).not.toContain("OHI-FVTA-0042");
    expect(texto).not.toContain("línea viva que no debe imprimirse");
    expect(texto).not.toContain("01/01/1999");
    expect(texto).not.toContain("dato vivo que no debe imprimirse");
  });
});

describe("factura C (emisor monotributista)", () => {
  const cFiscal: DatosFiscalesImpresos = {
    ...fiscalBase,
    cbte_tipo: 11,
    emisor: { ...fiscalBase.emisor!, condicion_iva: "MONOTRIBUTO" },
    totales: {
      neto: 1210,
      exento: 0,
      no_gravado: 0,
      iva: 0,
      tributos: 0,
      total: 1210,
      alicuotas: [],
    },
  };
  const { doc } = generarComprobantePdf(
    { ...venta, tipo_comprobante: "FACTURA_C" },
    items,
    cFiscal,
  );
  const texto = textoDelPdf(doc);

  // AFIP no admite IVA discriminado en clase C: el papel tampoco puede mostrarlo.
  it("no discrimina IVA", () => {
    expect(texto).not.toContain("Neto gravado");
    expect(texto).not.toMatch(/IVA \d/);
    expect(texto).toContain("COD. 11");
  });
});

describe("comprobante sin CAE (documento interno)", () => {
  const { doc, nombre } = generarComprobantePdf(
    { ...venta, tipo_comprobante: "REMITO", numero_comprobante: "OHI-REM-0003" },
    items,
    null,
  );
  const texto = textoDelPdf(doc);

  it("cae a la numeración interna", () => {
    expect(nombre).toBe("OHI-REM-0003.pdf");
  });

  it("avisa que no es un comprobante fiscal y no inventa un CAE", () => {
    expect(texto).toContain("Documento interno");
    expect(texto).not.toContain("Comprobante Autorizado");
  });
});

describe("comprobantes largos", () => {
  // Una obra se lleva 40 renglones sin despeinarse. autoTable pagina la tabla,
  // pero los bloques que van DESPUÉS se dibujan en coordenadas calculadas: antes
  // se escribían fuera de la hoja y el comprobante salía sin el bloque de CAE.
  const muchos = Array.from({ length: 45 }, (_, n) => ({
    ...items[0],
    codigo: `IT-${String(n).padStart(3, "0")}`,
    descripcion: `Producto de prueba número ${n}`,
  }));
  const { doc } = generarComprobantePdf(venta, muchos, { ...fiscalBase, lineas: muchos });
  const texto = textoDelPdf(doc);

  it("pasa a más de una página", () => {
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
  });

  it("el bloque de CAE y las leyendas siguen estando", () => {
    expect(texto).toContain("Comprobante Autorizado");
    expect(texto).toContain("CAE N°: 75123456789012");
    expect(texto).toContain("TOTAL");
    expect(texto).toContain("Transparencia Fiscal");
  });

  // Estar en el archivo no alcanza: hay que estar DENTRO de la hoja. jsPDF escribe
  // cada texto como "<x> <y> Td" en puntos, con el origen abajo a la izquierda; si
  // un bloque se pasó del pie, su y sale negativa y en el papel no se ve nada.
  //
  // Se barren muchos tamaños a propósito: el caso peligroso no es "muchos ítems"
  // sino la cantidad EXACTA que deja la tabla terminando al pie de una hoja. Con
  // un solo tamaño el test pasa aunque la protección esté rota.
  it("no dibuja nada fuera de la hoja, para cualquier cantidad de ítems", () => {
    const ALTO_A4_PT = 841.89;
    for (let n = 1; n <= 60; n++) {
      const lista = Array.from({ length: n }, (_, k) => ({ ...items[0], codigo: `IT-${k}` }));
      const { doc: d } = generarComprobantePdf(venta, lista, { ...fiscalBase, lineas: lista });
      const ys = [...textoDelPdf(d).matchAll(/([\d.-]+) ([\d.-]+) Td/g)].map((m) => Number(m[2]));
      expect(ys.length, `con ${n} ítems no se dibujó nada`).toBeGreaterThan(20);
      expect(Math.min(...ys), `con ${n} ítems algo quedó por debajo del pie`).toBeGreaterThan(0);
      expect(Math.max(...ys), `con ${n} ítems algo quedó por arriba del borde`).toBeLessThan(
        ALTO_A4_PT,
      );
    }
  });

  it("reserva la altura dinámica de neto, exento, no gravado, IVA y tributos", () => {
    const ALTO_A4_PT = 841.89;
    for (let n = 1; n <= 60; n++) {
      const lista = Array.from({ length: n }, (_, k) => ({
        ...items[0],
        codigo: `TOTAL-${k}`,
      }));
      const { doc: d } = generarComprobantePdf(venta, lista, {
        ...fiscalConTotalesCompletos,
        lineas: lista,
      });
      const texto = textoDelPdf(d);
      const ys = [...texto.matchAll(/([\d.-]+) ([\d.-]+) Td/g)].map((match) => Number(match[2]));

      expect(texto, `con ${n} ítems faltó el exento`).toContain("Exento");
      expect(texto, `con ${n} ítems faltó el no gravado`).toContain("No gravado");
      expect(Math.min(...ys), `con ${n} ítems el total salió debajo del pie`).toBeGreaterThan(0);
      expect(Math.max(...ys), `con ${n} ítems el total salió arriba del borde`).toBeLessThan(
        ALTO_A4_PT,
      );
    }
  });

  it.each([1, 20, 60])("con %s ítems conserva todas las páginas en A4", (cantidad) => {
    const lista = Array.from({ length: cantidad }, (_, k) => ({
      ...items[0],
      codigo: `A4-${k}`,
    }));
    const { doc: d } = generarComprobantePdf(venta, lista, { ...fiscalBase, lineas: lista });

    for (let pagina = 1; pagina <= d.getNumberOfPages(); pagina += 1) {
      d.setPage(pagina);
      expect(d.internal.pageSize.getWidth()).toBeCloseTo(210, 1);
      expect(d.internal.pageSize.getHeight()).toBeCloseTo(297, 1);
    }
    const contenido = textoDelPdf(d);
    expect(contenido).toContain("CAE N°: 75123456789012");
    expect(contenido).toContain("Otros Impuestos Nacionales Indirectos: $ 0,00");
    if (cantidad === 60) expect(d.getNumberOfPages()).toBeGreaterThan(1);
  });

  it("no deja líneas de transparencia huérfanas del bloque CAE con 20 ítems", () => {
    const lista = Array.from({ length: 20 }, (_, k) => ({
      ...items[0],
      codigo: `PAG-${k}`,
    }));
    const { doc: d } = generarComprobantePdf(venta, lista, { ...fiscalBase, lineas: lista });
    const paginaTransparencia = textosPorPagina(d).find((pagina) =>
      pagina.includes("IVA Contenido"),
    );

    expect(paginaTransparencia).toBeDefined();
    expect(paginaTransparencia).toContain("CAE N°: 75123456789012");
  });
});

describe("líneas congeladas al emitir", () => {
  // Una reimpresión tiene que salir igual al original entregado, aunque la venta
  // en la base haya cambiado.
  const otrasLineas = [
    {
      codigo: "CONGELADO-1",
      descripcion: "Lo que se declaró a AFIP",
      cantidad: 1,
      precio_unitario_sin_iva: 1000,
      descuento_porcentaje: 0,
      iva_porcentaje: 21,
      subtotal_con_iva: 1210,
    },
  ];
  const { doc } = generarComprobantePdf(venta, items, { ...fiscalBase, lineas: otrasLineas });
  const texto = textoDelPdf(doc);

  it("el snapshot le gana a venta_items", () => {
    expect(texto).toContain("CONGELADO-1");
    expect(texto).not.toContain("LX-001");
  });
});

describe("comprobante simulado", () => {
  const { doc } = generarComprobantePdf(venta, items, {
    ...fiscalBase,
    simulado: true,
    validez: "SIMULADA",
  });
  const texto = textoDelPdf(doc);

  // Que nadie confunda un CAE de mock con uno real, ni en pantalla ni en papel.
  it("lo dice en la cara", () => {
    expect(texto).toContain("SIN VALIDEZ FISCAL — COMPROBANTE SIMULADO");
  });
});

describe("comprobante de homologación", () => {
  it("queda marcado inequívocamente como no legal", () => {
    const { doc } = generarComprobantePdf(venta, items, {
      ...fiscalBase,
      modo: "HOMOLOGACION",
      validez: "HOMOLOGACION",
    });

    expect(textoDelPdf(doc)).toContain("SIN VALIDEZ FISCAL — HOMOLOGACIÓN");
  });
});

describe("defensas del renderer fiscal", () => {
  it("un CAE sin QR falla cerrado y nunca imprime como autorizado", () => {
    expect(() =>
      generarComprobantePdf(venta, items, { ...fiscalBase, qr: undefined }),
    ).toThrowError(
      expect.objectContaining({
        name: "ErrorImpresionFiscal",
        codigo: "QR_FISCAL_OBLIGATORIO",
      }),
    );
    expect(ErrorImpresionFiscal).toBeDefined();
  });

  it("v2 nunca cae al nombre vivo de la sucursal si el emisor congelado está corrupto", () => {
    expect(() =>
      generarComprobantePdf({ ...venta, sucursal: { nombre: "SUCURSAL VIVA PROHIBIDA" } }, items, {
        ...fiscalBase,
        emisor: { ...fiscalBase.emisor, razon_social: null },
      }),
    ).toThrowError(expect.objectContaining({ codigo: "SNAPSHOT_FISCAL_INVALIDO" }));
  });

  it("la rama legacy muestra su advertencia imborrable", () => {
    const { doc } = generarComprobantePdf(venta, items, {
      ...fiscalBase,
      origen: "LEGACY_INCOMPLETO",
      advertencia: "HISTÓRICO LEGACY — DATOS FISCALES INCOMPLETOS",
    });

    const texto = textoDelPdf(doc);
    expect(texto).toContain("HISTÓRICO LEGACY — DATOS FISCALES INCOMPLETOS");
    expect(texto).toContain("IVA Contenido: no disponible en histórico legacy");
    expect(texto).toContain(
      "Otros Impuestos Nacionales Indirectos: no disponible en histórico legacy",
    );
    expect(texto).not.toContain("IVA Contenido: $ 0,00");
    expect(texto).not.toContain("Otros Impuestos Nacionales Indirectos: $ 0,00");
  });

  it.each([
    ["base64 basura", "data:image/png;base64,not-a-png"],
    [
      "firma incorrecta",
      `data:image/png;base64,${Buffer.from("contenido que no es png").toString("base64")}`,
    ],
  ])("rechaza QR con %s antes de invocar el renderer PNG", (_caso, qr) => {
    expect(() => generarComprobantePdf(venta, items, { ...fiscalBase, qr })).toThrowError(
      expect.objectContaining({ codigo: "QR_FISCAL_OBLIGATORIO" }),
    );
  });

  it("envuelve como error fiscal tipado un PNG estructural que addImage no puede leer", () => {
    const pngConIhdrInvalido =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAAAAAAAAAAAAAAAAAAAAAAAAElFTkQAAAAA";

    expect(esPngDataUrlFiscal(pngConIhdrInvalido)).toBe(true);
    expect(() =>
      generarComprobantePdf(venta, items, { ...fiscalBase, qr: pngConIhdrInvalido }),
    ).toThrowError(expect.objectContaining({ codigo: "QR_FISCAL_OBLIGATORIO" }));
  });
});

describe("helpers de impresión fiscal", () => {
  it("del Id de AFIP al porcentaje (para el desglose por alícuota)", () => {
    expect(porcentajeDeIvaId(3)).toBe(0);
    expect(porcentajeDeIvaId(4)).toBe(10.5);
    expect(porcentajeDeIvaId(5)).toBe(21);
    expect(porcentajeDeIvaId(6)).toBe(27);
    expect(() => porcentajeDeIvaId(99)).toThrow(/desconocido/);
  });

  it("el título sale del CbteTipo emitido", () => {
    expect(tituloDeCbteTipo(1)).toBe("FACTURA");
    expect(tituloDeCbteTipo(6)).toBe("FACTURA");
    expect(tituloDeCbteTipo(3)).toBe("NOTA DE CRÉDITO");
    expect(tituloDeCbteTipo(8)).toBe("NOTA DE CRÉDITO");
    expect(tituloDeCbteTipo(2)).toBe("NOTA DE DÉBITO");
    expect(tituloDeCbteTipo(12)).toBe("NOTA DE DÉBITO");
  });

  it("la leyenda de transparencia va en B y C a consumidor final, no en A", () => {
    expect(requiereLeyendaTransparencia(6, "CONSUMIDOR_FINAL")).toBe(true);
    expect(requiereLeyendaTransparencia(11, "CONSUMIDOR_FINAL")).toBe(true);
    expect(requiereLeyendaTransparencia(1, "RESPONSABLE_INSCRIPTO")).toBe(false);
    expect(requiereLeyendaTransparencia(6, "RESPONSABLE_INSCRIPTO")).toBe(false);
    expect(requiereLeyendaTransparencia(6, null)).toBe(false);
  });
});
