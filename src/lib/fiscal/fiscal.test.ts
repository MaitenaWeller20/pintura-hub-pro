import { describe, it, expect } from "vitest";
import {
  determinarLetra,
  cbteTipoAfip,
  ivaIdAfip,
  alicuotaValida,
  docTipoAfip,
  docNroAfip,
  condicionIvaReceptorId,
  esComprobanteFiscal,
  esNotaInterna,
  letraDeFactura,
  letraDeCbteTipo,
  tituloDeCbteTipo,
  TIPOS_C,
} from "./codigos";
import { calcularTotales, conIva, round2 } from "./iva";
import {
  fmtFechaAfip,
  fmtFechaIsoAr,
  parseFechaAfip,
  diasDesdeHoyAr,
  diasRestantesVentanaAfip,
  fechaFiscalHoyAr,
  fueraDeVentanaAfip,
  requiereConfirmacionVentaDemorada,
  validarCorrelatividadFechaFiscal,
} from "./fecha";
import { urlQrAfip } from "./qr";
import { detalleRechazoAfip } from "./arca";

describe("tipo de comprobante (rollout A/B para emisor RI)", () => {
  it("responsable inscripto a responsable inscripto = A", () => {
    expect(determinarLetra("RESPONSABLE_INSCRIPTO", "RESPONSABLE_INSCRIPTO")).toBe("A");
  });

  it("responsable inscripto a monotributista = A, sin downgrade manual", () => {
    expect(determinarLetra("RESPONSABLE_INSCRIPTO", "MONOTRIBUTO")).toBe("A");
  });

  it("responsable inscripto a exento o consumidor final = B", () => {
    expect(determinarLetra("RESPONSABLE_INSCRIPTO", "EXENTO")).toBe("B");
    expect(determinarLetra("RESPONSABLE_INSCRIPTO", "CONSUMIDOR_FINAL")).toBe("B");
  });

  it("no habilita emisión C nueva ni adivina la condición del receptor", () => {
    expect(() => determinarLetra("MONOTRIBUTO", "CONSUMIDOR_FINAL")).toThrow(/rollout.*RI/i);
    expect(() => determinarLetra("RESPONSABLE_INSCRIPTO", null)).toThrow(/condición.*receptor/i);
    expect(() => determinarLetra("RESPONSABLE_INSCRIPTO", undefined)).toThrow(
      /condición.*receptor/i,
    );
  });
});

describe("códigos de comprobante de AFIP", () => {
  it("facturas", () => {
    expect(cbteTipoAfip("FACTURA_A", "A")).toBe(1);
    expect(cbteTipoAfip("FACTURA_B", "B")).toBe(6);
    expect(cbteTipoAfip("FACTURA_C", "C")).toBe(11);
  });

  it("la venta neutral deriva 1/6 sólo después de confirmar A/B", () => {
    expect(cbteTipoAfip("VENTA", "A")).toBe(1);
    expect(cbteTipoAfip("VENTA", "B")).toBe(6);
    expect(() => cbteTipoAfip("VENTA", "C")).toThrow(/VENTA.*A o B/i);
  });

  it("notas de crédito heredan la letra del comprobante que rectifican", () => {
    expect(cbteTipoAfip("NOTA_CREDITO", "A")).toBe(3);
    expect(cbteTipoAfip("NOTA_CREDITO", "B")).toBe(8);
    expect(cbteTipoAfip("NOTA_CREDITO", "C")).toBe(13);
  });

  it("una nota sin letra original confirmada se bloquea", () => {
    expect(() => cbteTipoAfip("NOTA_CREDITO", null as unknown as "A")).toThrow(
      /letra.*confirmada/i,
    );
  });

  it("notas de débito", () => {
    expect(cbteTipoAfip("NOTA_DEBITO", "A")).toBe(2);
    expect(cbteTipoAfip("NOTA_DEBITO", "B")).toBe(7);
    expect(cbteTipoAfip("NOTA_DEBITO", "C")).toBe(12);
  });

  it("los documentos internos NO tienen código de AFIP: tiene que explotar", () => {
    expect(() => cbteTipoAfip("REMITO", "B")).toThrow(/sin equivalente en AFIP/);
    expect(() => cbteTipoAfip("REMITO_OBRA", "B")).toThrow();
    expect(() => cbteTipoAfip("FAC_INTERNA_CTA_CTE", "B")).toThrow();
  });

  it("los tipos clase C están marcados (no discriminan IVA)", () => {
    expect(TIPOS_C.has(11)).toBe(true); // Factura C
    expect(TIPOS_C.has(12)).toBe(true); // Nota de Débito C
    expect(TIPOS_C.has(13)).toBe(true); // Nota de Crédito C
    expect(TIPOS_C.has(6)).toBe(false); // Factura B sí discrimina
  });

  it("la letra de una NC se deriva de la factura original", () => {
    expect(letraDeFactura("FACTURA_A")).toBe("A");
    expect(letraDeFactura("FACTURA_B")).toBe("B");
    expect(letraDeFactura("FACTURA_C")).toBe("C");
  });

  it("la venta neutral no obtiene una B por default desde letraDeFactura", () => {
    expect(() => letraDeFactura("VENTA")).toThrow(/no tiene letra/i);
    expect(() => letraDeFactura("DESCONOCIDO")).toThrow(/no tiene letra/i);
  });
});

describe("documentos internos vs fiscales", () => {
  it("remitos y factura interna NO van a AFIP", () => {
    expect(esComprobanteFiscal("REMITO")).toBe(false);
    expect(esComprobanteFiscal("REMITO_OBRA")).toBe(false);
    expect(esComprobanteFiscal("FAC_INTERNA_CTA_CTE")).toBe(false);
  });

  it("las facturas y notas sí", () => {
    expect(esComprobanteFiscal("VENTA")).toBe(true);
    expect(esComprobanteFiscal("FACTURA_A")).toBe(true);
    expect(esComprobanteFiscal("FACTURA_B")).toBe(true);
    expect(esComprobanteFiscal("FACTURA_C")).toBe(true);
    expect(esComprobanteFiscal("NOTA_CREDITO")).toBe(true);
    expect(esComprobanteFiscal("NOTA_DEBITO")).toBe(true);
  });

  it("un valor desconocido no se vuelve fiscal por descarte", () => {
    expect(esComprobanteFiscal("FACTURA_X")).toBe(false);
    expect(esComprobanteFiscal("")).toBe(false);
  });
});

describe("notas internas (reversión de algo que nunca se declaró)", () => {
  it("una nota SIN comprobante asociado es interna: no se emite", () => {
    expect(esNotaInterna("NOTA_CREDITO", null)).toBe(true);
    expect(esNotaInterna("NOTA_CREDITO", undefined)).toBe(true);
    expect(esNotaInterna("NOTA_CREDITO", "")).toBe(true);
    expect(esNotaInterna("NOTA_DEBITO", null)).toBe(true);
  });

  it("una nota CON comprobante asociado sí es fiscal", () => {
    expect(esNotaInterna("NOTA_CREDITO", "b3f1c2d4-0000-4000-8000-000000000001")).toBe(false);
  });

  // Una factura nunca lleva asociado y no por eso deja de ser fiscal.
  it("no aplica a las facturas", () => {
    expect(esNotaInterna("FACTURA_A", null)).toBe(false);
    expect(esNotaInterna("FACTURA_B", null)).toBe(false);
    expect(esNotaInterna("FACTURA_C", null)).toBe(false);
  });
});

describe("alícuotas de IVA", () => {
  it("mapea los porcentajes a los ids de AFIP", () => {
    expect(ivaIdAfip(0)).toBe(3);
    expect(ivaIdAfip(10.5)).toBe(4);
    expect(ivaIdAfip(21)).toBe(5);
    expect(ivaIdAfip(27)).toBe(6);
  });

  it("normaliza: 21.0 y '21' son la misma alícuota que 21", () => {
    expect(ivaIdAfip(21.0)).toBe(5);
    expect(ivaIdAfip(Number("21.00"))).toBe(5);
  });

  it("una alícuota que AFIP no soporta explota, no adivina", () => {
    expect(() => ivaIdAfip(13)).toThrow(/no soportada/);
  });

  // Este es el bug que ya ocurrió en lubricentro y está documentado.
  it("un 0% legítimo NO colapsa a 21% (0 es falsy: `Number(x) || 21` lo rompe)", () => {
    expect(alicuotaValida(0, 21)).toBe(0);
    expect(alicuotaValida("0", 21)).toBe(0);
  });

  it("un campo ausente cae al fallback y NO a 0% (Number(null) === 0)", () => {
    expect(alicuotaValida(null, 21)).toBe(21);
    expect(alicuotaValida(undefined, 21)).toBe(21);
    expect(alicuotaValida("", 21)).toBe(21);
  });

  it("valores inválidos caen al fallback", () => {
    expect(alicuotaValida(999, 21)).toBe(21);
    expect(alicuotaValida(-5, 21)).toBe(21);
    expect(alicuotaValida("abc", 10.5)).toBe(10.5);
    expect(alicuotaValida(NaN, 21)).toBe(21);
  });
});

describe("receptor legacy", () => {
  it("11 dígitos = CUIT (80)", () => {
    expect(docTipoAfip("30712345678")).toBe(80);
    expect(docTipoAfip("30-71234567-8")).toBe(80);
  });

  it("7-8 dígitos = DNI (96)", () => {
    expect(docTipoAfip("12345678")).toBe(96);
  });

  it("sin documento = consumidor final (99) con número 0", () => {
    expect(docTipoAfip(null)).toBe(99);
    expect(docTipoAfip("")).toBe(99);
    expect(docNroAfip(null)).toBe(0);
    expect(docNroAfip("")).toBe(0);
  });

  it("limpia guiones y puntos del número", () => {
    expect(docNroAfip("30-71234567-8")).toBe(30712345678);
  });

  it("CondicionIVAReceptorId (RG 5616, obligatorio desde 2025)", () => {
    expect(condicionIvaReceptorId("RESPONSABLE_INSCRIPTO")).toBe(1);
    expect(condicionIvaReceptorId("EXENTO")).toBe(4);
    expect(condicionIvaReceptorId("CONSUMIDOR_FINAL")).toBe(5);
    expect(condicionIvaReceptorId("MONOTRIBUTO")).toBe(6);
    expect(condicionIvaReceptorId(null)).toBe(5); // default: consumidor final
  });
});

describe("cálculo de totales — los invariantes que AFIP valida", () => {
  it("neto + IVA === total, exacto", () => {
    const t = calcularTotales([
      { cantidad: 3, precio_unitario_sin_iva: 45000, iva_porcentaje: 21, descuento_porcentaje: 0 },
      { cantidad: 1, precio_unitario_sin_iva: 2200, iva_porcentaje: 21, descuento_porcentaje: 0 },
    ]);
    expect(round2(t.neto + t.iva)).toBe(t.total);
  });

  it("la suma de las bases por alícuota === neto, y la de los importes === IVA", () => {
    const t = calcularTotales([
      { cantidad: 2, precio_unitario_sin_iva: 1000, iva_porcentaje: 21 },
      { cantidad: 1, precio_unitario_sin_iva: 500, iva_porcentaje: 10.5 },
      { cantidad: 4, precio_unitario_sin_iva: 250, iva_porcentaje: 21 },
    ]);
    const sumaBases = round2(t.alicuotas.reduce((a, x) => a + x.BaseImp, 0));
    const sumaImportes = round2(t.alicuotas.reduce((a, x) => a + x.Importe, 0));
    expect(sumaBases).toBe(t.neto);
    expect(sumaImportes).toBe(t.iva);
  });

  it("agrupa por alícuota (dos ítems al 21% son UNA sola entrada)", () => {
    const t = calcularTotales([
      { cantidad: 1, precio_unitario_sin_iva: 100, iva_porcentaje: 21 },
      { cantidad: 1, precio_unitario_sin_iva: 200, iva_porcentaje: 21 },
      { cantidad: 1, precio_unitario_sin_iva: 300, iva_porcentaje: 10.5 },
    ]);
    expect(t.alicuotas).toHaveLength(2);
    const al21 = t.alicuotas.find((a) => a.Id === 5)!;
    expect(al21.BaseImp).toBe(300);
    expect(al21.Importe).toBe(63);
  });

  it("aguanta precios que dan centavos partidos sin desbalancearse", () => {
    // 3 x 33.33 al 21% -> el redondeo por ítem tiene que cerrar igual.
    const t = calcularTotales([
      { cantidad: 3, precio_unitario_sin_iva: 33.33, iva_porcentaje: 21 },
      { cantidad: 7, precio_unitario_sin_iva: 12.47, iva_porcentaje: 10.5 },
      { cantidad: 1, precio_unitario_sin_iva: 0.01, iva_porcentaje: 21 },
    ]);
    expect(round2(t.neto + t.iva)).toBe(t.total);
    expect(round2(t.alicuotas.reduce((a, x) => a + x.BaseImp, 0))).toBe(t.neto);
    expect(round2(t.alicuotas.reduce((a, x) => a + x.Importe, 0))).toBe(t.iva);
  });

  it("aplica el descuento por ítem antes de calcular el IVA", () => {
    const t = calcularTotales([
      { cantidad: 1, precio_unitario_sin_iva: 1000, iva_porcentaje: 21, descuento_porcentaje: 10 },
    ]);
    expect(t.neto).toBe(900);
    expect(t.iva).toBe(189);
    expect(t.total).toBe(1089);
  });

  it("un ítem exento (0%) no aporta IVA pero sí neto", () => {
    const t = calcularTotales([
      { cantidad: 1, precio_unitario_sin_iva: 1000, iva_porcentaje: 0 },
      { cantidad: 1, precio_unitario_sin_iva: 1000, iva_porcentaje: 21 },
    ]);
    expect(t.neto).toBe(2000);
    expect(t.iva).toBe(210);
    const exento = t.alicuotas.find((a) => a.Id === 3)!;
    expect(exento.BaseImp).toBe(1000);
    expect(exento.Importe).toBe(0);
  });

  it("las percepciones van a tributos y al total, no al neto ni al IVA", () => {
    const t = calcularTotales(
      [{ cantidad: 1, precio_unitario_sin_iva: 1000, iva_porcentaje: 21 }],
      50,
    );
    expect(t.neto).toBe(1000);
    expect(t.iva).toBe(210);
    expect(t.tributos).toBe(50);
    expect(t.total).toBe(1260);
    // El invariante que AFIP valida: ImpTotal == ImpNeto + ImpIVA + ImpTrib.
    expect(round2(t.neto + t.iva + t.tributos)).toBe(t.total);
  });

  it("sin percepciones, tributos es 0", () => {
    const t = calcularTotales([{ cantidad: 1, precio_unitario_sin_iva: 100, iva_porcentaje: 21 }]);
    expect(t.tributos).toBe(0);
  });
});

describe("fechas fiscales en hora de Argentina", () => {
  // El bug que tienen lubricentro Y MesaYa: con toISOString() (UTC), esta venta
  // se factura como 1 de agosto y cae en el período de IVA equivocado.
  it("una venta a las 21:30 del 31/07 (hora AR) se factura el 31, no el 1/08", () => {
    const nocheDelUltimoDia = new Date("2026-08-01T00:30:00Z"); // 21:30 del 31/07 en AR
    expect(fmtFechaAfip(nocheDelUltimoDia)).toBe("20260731");
    expect(fmtFechaIsoAr(nocheDelUltimoDia)).toBe("2026-07-31");
  });

  it("una venta al mediodía se formatea normal", () => {
    const mediodia = new Date("2026-07-13T15:00:00Z"); // 12:00 en AR
    expect(fmtFechaAfip(mediodia)).toBe("20260713");
  });

  it("parsea el YYYYMMDD que devuelve AFIP", () => {
    const d = parseFechaAfip("20260723")!;
    expect(fmtFechaIsoAr(d)).toBe("2026-07-23");
  });

  it("rechaza un formato que no sea de 8 dígitos", () => {
    expect(parseFechaAfip("2026-07-23")).toBeNull();
    expect(parseFechaAfip("")).toBeNull();
    expect(parseFechaAfip(null)).toBeNull();
  });

  it.each(["20260230", "00000101", "20261301", "20260010"])(
    "rechaza la fecha calendario AFIP inválida %s sin hacer rollover",
    (fecha) => {
      expect(parseFechaAfip(fecha)).toBeNull();
    },
  );
});

describe("ventana de ±5 días de AFIP (Concepto=1, productos)", () => {
  // 09:00 del 10/08 en hora de Argentina.
  const hoy = new Date("2026-08-10T12:00:00Z");
  const enAr = (iso: string) => new Date(iso);

  it("una venta del día se puede emitir", () => {
    expect(diasDesdeHoyAr(enAr("2026-08-10T13:00:00Z"), hoy)).toBe(0);
    expect(fueraDeVentanaAfip(enAr("2026-08-10T13:00:00Z"), hoy)).toBe(false);
  });

  it("el día 5 todavía entra; el 6 ya no", () => {
    expect(fueraDeVentanaAfip(enAr("2026-08-05T12:00:00Z"), hoy)).toBe(false);
    expect(diasDesdeHoyAr(enAr("2026-08-05T12:00:00Z"), hoy)).toBe(5);
    expect(fueraDeVentanaAfip(enAr("2026-08-04T12:00:00Z"), hoy)).toBe(true);
    expect(diasDesdeHoyAr(enAr("2026-08-04T12:00:00Z"), hoy)).toBe(6);
  });

  it("una fecha a futuro también se sale de la ventana", () => {
    expect(fueraDeVentanaAfip(enAr("2026-08-15T12:00:00Z"), hoy)).toBe(false);
    expect(fueraDeVentanaAfip(enAr("2026-08-16T12:00:00Z"), hoy)).toBe(true);
    expect(diasDesdeHoyAr(enAr("2026-08-16T12:00:00Z"), hoy)).toBe(-6);
  });

  // El mismo motivo por el que existe fecha.ts: contar en UTC corre el día.
  it("cuenta días calendario de Argentina, no de UTC", () => {
    // 23:00 del 09/08 en AR (que en UTC ya es el 10/08). Es de AYER, no de hoy.
    const anocheEnAr = enAr("2026-08-10T02:00:00Z");
    expect(diasDesdeHoyAr(anocheEnAr, hoy)).toBe(1);
  });

  it("los días restantes bajan hasta el último día y después se van a negativo", () => {
    expect(diasRestantesVentanaAfip(enAr("2026-08-10T12:00:00Z"), hoy)).toBe(5);
    expect(diasRestantesVentanaAfip(enAr("2026-08-05T12:00:00Z"), hoy)).toBe(0);
    expect(diasRestantesVentanaAfip(enAr("2026-08-04T12:00:00Z"), hoy)).toBe(-1);
  });
});

describe("fecha fiscal nueva y correlatividad", () => {
  // 23:30 del 22/08 en Córdoba; UTC ya está en el día siguiente.
  const reloj = () => new Date("2026-08-23T02:30:00.000Z");

  it("toma hoy en America/Argentina/Cordoba y no retrodata a la venta", () => {
    expect(fechaFiscalHoyAr(reloj)).toBe("2026-08-22");
    expect(() => validarCorrelatividadFechaFiscal("2026-08-16", null, reloj)).toThrow(
      /fecha fiscal.*hoy/i,
    );
  });

  it("no permite una fecha nueva anterior a la última autorizada", () => {
    expect(() => validarCorrelatividadFechaFiscal("2026-08-21", "2026-08-22", reloj)).toThrow(
      /anterior.*última autorizada/i,
    );
  });

  it("bloquea si la última fecha autorizada está en el futuro", () => {
    expect(() => validarCorrelatividadFechaFiscal("2026-08-22", "2026-08-23", reloj)).toThrow(
      /última autorizada.*futuro/i,
    );
  });

  it("acepta hoy cuando conserva la correlatividad", () => {
    expect(() => validarCorrelatividadFechaFiscal("2026-08-22", "2026-08-21", reloj)).not.toThrow();
  });

  it("una venta comercial de más de cinco días sólo requiere confirmación admin", () => {
    expect(requiereConfirmacionVentaDemorada(new Date("2026-08-16T15:00:00.000Z"), reloj)).toBe(
      true,
    );
    expect(requiereConfirmacionVentaDemorada(new Date("2026-08-17T15:00:00.000Z"), reloj)).toBe(
      false,
    );
    expect(fechaFiscalHoyAr(reloj)).toBe("2026-08-22");
  });
});

describe("QR de AFIP (RG 4892)", () => {
  const base = {
    fecha: new Date("2026-07-13T15:00:00Z"),
    cuit: 30712345678,
    ptoVta: 1,
    tipoCmp: 6,
    nroCmp: 42,
    importe: 1234.56,
    tipoDocRec: 99,
    nroDocRec: 0,
    codAut: "75123456789012",
  };

  it("arma la URL oficial con el payload en base64", () => {
    const url = urlQrAfip(base);
    expect(url.startsWith("https://www.afip.gob.ar/fe/qr/?p=")).toBe(true);
  });

  it("el payload respeta la especificación", () => {
    const url = urlQrAfip(base);
    const p = url.split("?p=")[1];
    const data = JSON.parse(Buffer.from(p, "base64").toString("utf8"));

    expect(data.ver).toBe(1);
    expect(data.fecha).toBe("2026-07-13");
    expect(data.moneda).toBe("PES");
    expect(data.ctz).toBe(1);
    expect(data.tipoCodAut).toBe("E"); // E = CAE (A sería CAEA)

    // Estos van como NÚMEROS, no como strings. Es parte de la especificación.
    expect(typeof data.cuit).toBe("number");
    expect(typeof data.nroCmp).toBe("number");
    expect(typeof data.importe).toBe("number");
    expect(typeof data.nroDocRec).toBe("number");
    expect(typeof data.codAut).toBe("number");
    expect(data.codAut).toBe(75123456789012);
  });

  it("el orden de las claves es el que fija la especificación", () => {
    const url = urlQrAfip(base);
    const p = url.split("?p=")[1];
    const json = Buffer.from(p, "base64").toString("utf8");
    expect(Object.keys(JSON.parse(json))).toEqual([
      "ver",
      "fecha",
      "cuit",
      "ptoVta",
      "tipoCmp",
      "nroCmp",
      "importe",
      "moneda",
      "ctz",
      "tipoDocRec",
      "nroDocRec",
      "tipoCodAut",
      "codAut",
    ]);
  });
});

describe("motivo del rechazo de AFIP (detalleRechazoAfip)", () => {
  it("extrae sólo códigos validados y reemplaza Msg por una clasificación genérica", () => {
    // Forma real de FECAESolicitarResult cuando AFIP observa un comprobante.
    const response = {
      FeDetResp: {
        FECAEDetResponse: [
          {
            Observaciones: {
              Obs: [{ Code: 10016, Msg: "CUIT 30-71419966-4 monto $999 secret=abc" }],
            },
          },
        ],
      },
    };
    const detalle = detalleRechazoAfip(response);
    expect(detalle).toBe("ARCA informó un rechazo fiscal (códigos: 10016).");
    expect(detalle).not.toMatch(/30-71419966-4|999|secret|abc/i);
  });

  it("extrae los Errors de nivel request y junta varios motivos", () => {
    const response = {
      Errors: { Err: [{ Code: 10013, Msg: "DocTipo debe ser 80 (CUIT)" }] },
      FeDetResp: {
        FECAEDetResponse: [{ Observaciones: { Obs: [{ Code: 15, Msg: "Campo X inválido" }] } }],
      },
    };
    expect(detalleRechazoAfip(response)).toBe(
      "ARCA informó un rechazo fiscal (códigos: 15, 10013).",
    );
  });

  it("no rompe con respuestas vacías, nulas o sin observaciones", () => {
    expect(detalleRechazoAfip(null)).toBe("");
    expect(detalleRechazoAfip(undefined)).toBe("");
    expect(detalleRechazoAfip({})).toBe("");
    expect(
      detalleRechazoAfip({ FeDetResp: { FECAEDetResponse: [{ Observaciones: { Obs: [] } }] } }),
    ).toBe("");
  });
});

describe("letra y título desde el CbteTipo autorizado", () => {
  it("la letra de la NC sale del CbteTipo REALMENTE emitido, no del tipo tipeado", () => {
    expect(letraDeCbteTipo(6)).toBe("B"); // Factura B
    expect(letraDeCbteTipo(1)).toBe("A"); // Factura A
    expect(letraDeCbteTipo(11)).toBe("C"); // Factura C
    expect(letraDeCbteTipo(8)).toBe("B"); // NC B
    expect(letraDeCbteTipo(3)).toBe("A"); // NC A
    expect(letraDeCbteTipo(13)).toBe("C"); // NC C
  });

  it("código nulo o desconocido no obtiene letra A por default", () => {
    expect(() => letraDeCbteTipo(null)).toThrow(/CbteTipo.*desconocido/i);
    expect(() => letraDeCbteTipo(999)).toThrow(/CbteTipo.*desconocido/i);
  });

  it("código nulo o desconocido no obtiene título Factura por default", () => {
    expect(() => tituloDeCbteTipo(null as unknown as number)).toThrow(/CbteTipo.*desconocido/i);
    expect(() => tituloDeCbteTipo(999)).toThrow(/CbteTipo.*desconocido/i);
  });
});

describe("conIva (precio final para mostrar)", () => {
  it("le suma el IVA a un neto", () => {
    expect(conIva(100, 21)).toBe(121);
    expect(conIva(14861.87, 21)).toBe(17982.86);
  });

  it("reproduce el caso que reportó la clienta", () => {
    // La membrana: 173727.61 de lista, 25% de descuento, y se vende a 157.657,81.
    const neto = +(173727.61 * 0.75).toFixed(2); // 130295.71
    expect(neto).toBe(130295.71);
    expect(conIva(neto, 21)).toBe(157657.81);
  });

  it("acepta alícuotas que no son 21", () => {
    expect(conIva(1000, 10.5)).toBe(1105);
    expect(conIva(1000, 0)).toBe(1000);
  });

  it("redondea a dos decimales, como el resto del cálculo fiscal", () => {
    expect(conIva(0.01, 21)).toBe(0.01);
    expect(conIva(33.33, 21)).toBe(40.33);
  });

  it("tolera null, undefined y strings, que es como vienen de la base", () => {
    expect(conIva(null, 21)).toBe(0);
    expect(conIva(undefined, undefined)).toBe(0);
    expect(conIva("100", "21")).toBe(121);
  });
});
