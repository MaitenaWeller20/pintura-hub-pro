import { describe, it, expect } from "vitest";
import { generarComprobantePdf, numeroFiscal, type DatosFiscalesImpresos } from "./comprobante-pdf";
import { porcentajeDeIvaId, requiereLeyendaTransparencia, tituloDeCbteTipo } from "./codigos";

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
  return s.replace(/\\(\d{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));
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

const fiscalBase: DatosFiscalesImpresos = {
  emisor: {
    razon_social: "CasaForma SRL",
    nombre_fantasia: "CasaForma",
    cuit: "30712345678",
    domicilio_fiscal: "O'Higgins 1234",
    condicion_iva: "RESPONSABLE_INSCRIPTO",
    ingresos_brutos: "901-123456-7",
    inicio_actividades: "2019-03-15",
  },
  receptor: {
    razon_social: "Juan Pérez",
    cuit_dni: "20123456789",
    doc_tipo: 80,
    condicion_iva: "CONSUMIDOR_FINAL",
    domicilio: "Belgrano 500",
  },
  condicion_venta: "CONTADO",
  totales: {
    neto: 1000,
    iva: 210,
    tributos: 0,
    total: 1210,
    alicuotas: [{ Id: 5, BaseImp: 1000, Importe: 210 }],
  },
  cae: "75123456789012",
  cae_vencimiento: "2026-08-20",
  punto_venta: 1,
  numero: 42,
  cbte_tipo: 6,
  modo: "PRODUCCION",
  qr: null,
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

  // Ley 27.743 / RG 5614: obligatoria en B y C a consumidor final.
  it("incluye la leyenda de Transparencia Fiscal en una B a consumidor final", () => {
    expect(texto).toContain("Transparencia Fiscal");
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

describe("factura C (emisor monotributista)", () => {
  const cFiscal: DatosFiscalesImpresos = {
    ...fiscalBase,
    cbte_tipo: 11,
    emisor: { ...fiscalBase.emisor!, condicion_iva: "MONOTRIBUTO" },
    totales: { neto: 1210, iva: 0, tributos: 0, total: 1210, alicuotas: [] },
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
  const { doc } = generarComprobantePdf(venta, muchos, fiscalBase);
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
      const { doc: d } = generarComprobantePdf(venta, lista, fiscalBase);
      const ys = [...textoDelPdf(d).matchAll(/([\d.-]+) ([\d.-]+) Td/g)].map((m) => Number(m[2]));
      expect(ys.length, `con ${n} ítems no se dibujó nada`).toBeGreaterThan(20);
      expect(Math.min(...ys), `con ${n} ítems algo quedó por debajo del pie`).toBeGreaterThan(0);
      expect(Math.max(...ys), `con ${n} ítems algo quedó por arriba del borde`).toBeLessThan(
        ALTO_A4_PT,
      );
    }
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
  const { doc } = generarComprobantePdf(venta, items, { ...fiscalBase, simulado: true });
  const texto = textoDelPdf(doc);

  // Que nadie confunda un CAE de mock con uno real, ni en pantalla ni en papel.
  it("lo dice en la cara", () => {
    expect(texto).toContain("SIMULADO");
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
