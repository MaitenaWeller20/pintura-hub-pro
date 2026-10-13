import { describe, expect, it } from "vitest";
import {
  confirmarReceptorManual,
  documentoFiscalArca,
  validarReceptorFiscalConfirmado,
  type ReceptorFiscalConfirmado,
  type SelectorReceptorFiscal,
} from "./receptor";

const selectorManual = (
  cambios: Partial<Extract<SelectorReceptorFiscal, { origen: "MANUAL" }>> = {},
) =>
  ({
    origen: "MANUAL",
    tipo_documento: "CUIT",
    numero_documento: "30-71234567-1",
    razon_social: "ACME SA",
    condicion_iva: "RESPONSABLE_INSCRIPTO",
    domicilio: "Av. Siempre Viva 123",
    guardar_para_proximas: false,
    confirma_datos_manuales: true,
    ...cambios,
  }) as Extract<SelectorReceptorFiscal, { origen: "MANUAL" }>;

describe("documento fiscal explícito del receptor", () => {
  it.each([
    ["CUIT", "30-71234567-1", "30712345671", 80],
    ["CUIL", "20-12345678-9", "20123456789", 86],
    ["CDI", "50-12345678-9", "50123456789", 87],
    ["DNI", "12.345.678", "12345678", 96],
    ["SIN_IDENTIFICAR", null, null, 99],
  ] as const)("mapea %s al código ARCA correspondiente", (tipo, numero, normalizado, docTipo) => {
    expect(documentoFiscalArca(tipo, numero)).toEqual({
      tipoDocumento: tipo,
      numeroDocumento: normalizado,
      docTipoArca: docTipo,
      docNroArca: normalizado ?? "0",
    });
  });

  it("no infiere CUIT, CUIL ni CDI a partir de once dígitos", () => {
    expect(documentoFiscalArca("CUIL", "30712345671").docTipoArca).toBe(86);
    expect(documentoFiscalArca("CDI", "30712345671").docTipoArca).toBe(87);
    expect(documentoFiscalArca("CUIT", "30712345671").docTipoArca).toBe(80);
  });

  it("valida CUIT con el dígito verificador canónico", () => {
    expect(() => documentoFiscalArca("CUIT", "30-71234567-8")).toThrow(/CUIT.*válido/i);
  });

  it("rechaza el CUIT trivial 00000000000 aunque cierre el módulo 11", () => {
    expect(() => documentoFiscalArca("CUIT", "00000000000")).toThrow(/CUIT.*válido/i);
  });

  it("exige exactamente once dígitos para CUIL y CDI, y siete u ocho para DNI", () => {
    expect(() => documentoFiscalArca("CUIL", "2012345678")).toThrow(/CUIL.*11/i);
    expect(() => documentoFiscalArca("CDI", "501234567890")).toThrow(/CDI.*11/i);
    expect(() => documentoFiscalArca("DNI", "123456")).toThrow(/DNI.*7.*8/i);
    expect(() => documentoFiscalArca("DNI", "123456789")).toThrow(/DNI.*7.*8/i);
  });
});

describe("selector manual", () => {
  it("confirma y normaliza un receptor manual sin inferir el tipo documental", () => {
    expect(confirmarReceptorManual(selectorManual(), 1_000)).toEqual({
      razonSocial: "ACME SA",
      domicilio: "Av. Siempre Viva 123",
      tipoDocumento: "CUIT",
      numeroDocumento: "30712345671",
      docTipoArca: 80,
      docNroArca: "30712345671",
      condicionIva: "RESPONSABLE_INSCRIPTO",
      origen: "MANUAL",
      origenId: null,
      verificadoArcaAt: null,
    });
  });

  it("requiere confirmación manual literal true", () => {
    const sinConfirmar = selectorManual({ confirma_datos_manuales: false as true });
    expect(() => confirmarReceptorManual(sinConfirmar, 1_000)).toThrow(/confirmar.*manual/i);
  });

  it("requiere razón social y una condición de IVA conocida", () => {
    expect(() => confirmarReceptorManual(selectorManual({ razon_social: "   " }), 1_000)).toThrow(
      /razón social/i,
    );
    expect(() =>
      confirmarReceptorManual(
        selectorManual({ condicion_iva: "DESCONOCIDA" as "CONSUMIDOR_FINAL" }),
        1_000,
      ),
    ).toThrow(/condición.*IVA/i);
  });

  it("sólo permite SIN_IDENTIFICAR para consumidor final", () => {
    expect(() =>
      confirmarReceptorManual(
        selectorManual({
          tipo_documento: "SIN_IDENTIFICAR",
          numero_documento: null,
          condicion_iva: "EXENTO",
        }),
        1_000,
      ),
    ).toThrow(/sin identificar.*consumidor final/i);
  });

  it("no permite guardar SIN_IDENTIFICAR como favorito", () => {
    expect(() =>
      confirmarReceptorManual(
        selectorManual({
          tipo_documento: "SIN_IDENTIFICAR",
          numero_documento: null,
          condicion_iva: "CONSUMIDOR_FINAL",
          guardar_para_proximas: true,
        }),
        1_000,
      ),
    ).toThrow(/favorito/i);
  });

  it("acepta consumidor final anónimo debajo de $10.000.000", () => {
    const receptor = confirmarReceptorManual(
      selectorManual({
        tipo_documento: "SIN_IDENTIFICAR",
        numero_documento: null,
        razon_social: "Consumidor Final",
        condicion_iva: "CONSUMIDOR_FINAL",
      }),
      9_999_999.99,
    );
    expect(receptor.docTipoArca).toBe(99);
    expect(receptor.docNroArca).toBe("0");
  });

  it.each([10_000_000, 10_000_000.01])("rechaza consumidor final anónimo desde $%s", (importe) => {
    expect(() =>
      confirmarReceptorManual(
        selectorManual({
          tipo_documento: "SIN_IDENTIFICAR",
          numero_documento: null,
          razon_social: "Consumidor Final",
          condicion_iva: "CONSUMIDOR_FINAL",
        }),
        importe,
      ),
    ).toThrow(/10\.000\.000.*identificar/i);
  });
});

describe("receptor fiscal confirmado", () => {
  const receptorRi: ReceptorFiscalConfirmado = {
    razonSocial: "ACME SA",
    domicilio: null,
    tipoDocumento: "CUIT",
    numeroDocumento: "30712345671",
    docTipoArca: 80,
    docNroArca: "30712345671",
    condicionIva: "RESPONSABLE_INSCRIPTO",
    origen: "ARCA",
    origenId: null,
    verificadoArcaAt: "2026-08-22T12:00:00.000Z",
  };

  it("acepta A sólo con CUIT válido y DocTipo 80", () => {
    expect(validarReceptorFiscalConfirmado(receptorRi, 1_000)).toEqual(receptorRi);
    expect(() =>
      validarReceptorFiscalConfirmado({ ...receptorRi, docTipoArca: 86 }, 1_000),
    ).toThrow(/DocTipo 80/i);
    expect(() =>
      validarReceptorFiscalConfirmado(
        { ...receptorRi, numeroDocumento: "30712345678", docNroArca: "30712345678" },
        1_000,
      ),
    ).toThrow(/CUIT.*válido/i);
  });

  it("no acepta RI o monotributo con un tipo documental de once dígitos distinto de CUIT", () => {
    expect(() =>
      validarReceptorFiscalConfirmado(
        {
          ...receptorRi,
          tipoDocumento: "CUIL",
          numeroDocumento: "20123456789",
          docTipoArca: 86,
          docNroArca: "20123456789",
          condicionIva: "MONOTRIBUTO",
        },
        1_000,
      ),
    ).toThrow(/Factura A.*CUIT/i);
  });

  it("rechaza un documento lógico que no coincide exactamente con DocTipo/DocNro", () => {
    expect(() =>
      validarReceptorFiscalConfirmado({ ...receptorRi, docNroArca: "0" }, 1_000),
    ).toThrow(/documento.*ARCA/i);
  });

  it("rechaza SIN_IDENTIFICAR proveniente de un favorito", () => {
    expect(() =>
      validarReceptorFiscalConfirmado(
        {
          ...receptorRi,
          razonSocial: "Consumidor Final",
          tipoDocumento: "SIN_IDENTIFICAR",
          numeroDocumento: null,
          docTipoArca: 99,
          docNroArca: "0",
          condicionIva: "CONSUMIDOR_FINAL",
          origen: "FAVORITO",
          origenId: "b091f3db-dcef-4031-9fb2-9cbde4212266",
          verificadoArcaAt: null,
        },
        1_000,
      ),
    ).toThrow(/favorito/i);
  });

  it.each([
    [
      "un documento distinto de CUIT/80",
      {
        tipoDocumento: "DNI" as const,
        numeroDocumento: "12345678",
        docTipoArca: 96 as const,
        docNroArca: "12345678",
        condicionIva: "CONSUMIDOR_FINAL" as const,
      },
    ],
    ["una fecha de calendario imposible", { verificadoArcaAt: "2026-02-30T12:00:00.000Z" }],
    ["una fecha sin offset ISO válido", { verificadoArcaAt: "2026-08-22T12:00:00.000" }],
  ])("rechaza un receptor ARCA con %s", (_caso, cambios) => {
    expect(() => validarReceptorFiscalConfirmado({ ...receptorRi, ...cambios }, 1_000)).toThrow(
      /ARCA|CUIT|DocTipo/i,
    );
  });

  it("impide que un origen distinto de ARCA declare una verificación ARCA", () => {
    expect(() =>
      validarReceptorFiscalConfirmado(
        {
          ...receptorRi,
          origen: "MANUAL",
          verificadoArcaAt: "2026-08-22T12:00:00.000Z",
        },
        1_000,
      ),
    ).toThrow(/verificación ARCA/i);
  });
});
