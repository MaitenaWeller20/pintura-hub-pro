import { describe, expect, it } from "vitest";
import type { ComprobanteArcaConsultado } from "./arca";
import type { SnapshotFiscalV2 } from "./snapshot";
import { compararSnapshotConArca, decidirConciliacion } from "./reconciliacion";

const snapshotFiscalFixture = {
  hash: "a".repeat(64),
  identidad: { puntoVenta: 5, cbteTipo: 3, numero: 42 },
  concepto: 1,
  receptor: { docTipoArca: 80, docNroArca: "30712345671", condicionIvaReceptorId: 1 },
  fechaComprobante: "2026-08-21",
  importeTotal: "136.00",
  importeNeto: "100.00",
  importeExento: "5.00",
  importeNoGravado: "7.00",
  importeIva: "21.00",
  importeTributos: "3.00",
  moneda: "PES",
  cotizacion: "1.000000",
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
  cbtesAsoc: [{ tipo: 1, puntoVenta: 5, numero: 40, cuit: "30714199664", fecha: "2026-08-20" }],
} as SnapshotFiscalV2;

const remotoFixture: ComprobanteArcaConsultado = {
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
};

describe("comparación exacta del snapshot contra ARCA", () => {
  it("no informa diferencias para una coincidencia exacta", () => {
    expect(compararSnapshotConArca(snapshotFiscalFixture, remotoFixture)).toEqual([]);
  });

  it.each([
    ["identidad.puntoVenta", { puntoVenta: 6 }],
    ["identidad.cbteTipo", { cbteTipo: 8 }],
    ["identidad.numero", { numero: 43 }],
    ["concepto", { concepto: 2 }],
    ["receptor.docTipoArca", { docTipo: 96 }],
    ["receptor.docNroArca", { docNro: "12345678" }],
    ["receptor.condicionIvaReceptorId", { condicionIvaReceptorId: 5 }],
    ["fechaComprobante", { fecha: "2026-08-22" }],
    ["importeTotal", { total: "136.01" }],
    ["importeNeto", { neto: "100.01" }],
    ["importeExento", { exento: "5.01" }],
    ["importeNoGravado", { noGravado: "7.01" }],
    ["importeIva", { iva: "21.01" }],
    ["importeTributos", { tributosTotal: "3.01" }],
    ["moneda", { moneda: "USD" }],
    ["cotizacion", { cotizacion: "2.000000" }],
  ] as const)("expone sólo la ruta enmascarada %s", (ruta, cambio) => {
    expect(compararSnapshotConArca(snapshotFiscalFixture, { ...remotoFixture, ...cambio })).toEqual(
      [ruta],
    );
  });

  it.each([
    ["alicuotasIva[0].id", "alicuotas", { id: 4 }],
    ["alicuotasIva[0].baseImponible", "alicuotas", { base: "99.00" }],
    ["alicuotasIva[0].importe", "alicuotas", { importe: "20.00" }],
    ["tributos[0].id", "tributos", { id: 98 }],
    ["tributos[0].descripcion", "tributos", { descripcion: "Otra percepción" }],
    ["tributos[0].baseImponible", "tributos", { base: "99.00" }],
    ["tributos[0].alicuota", "tributos", { alicuota: "2.00" }],
    ["tributos[0].importe", "tributos", { importe: "2.00" }],
    ["cbtesAsoc[0].tipo", "asociados", { tipo: 6 }],
    ["cbtesAsoc[0].puntoVenta", "asociados", { puntoVenta: 6 }],
    ["cbtesAsoc[0].numero", "asociados", { numero: 39 }],
    ["cbtesAsoc[0].cuit", "asociados", { cuit: "30712345671" }],
    ["cbtesAsoc[0].fecha", "asociados", { fecha: null }],
  ] as const)("compara el campo anidado %s sin revelar valores", (ruta, coleccion, cambio) => {
    const original = remotoFixture[coleccion] as Array<Record<string, unknown>>;
    const remoto = {
      ...remotoFixture,
      [coleccion]: [{ ...original[0], ...cambio }],
    } as ComprobanteArcaConsultado;
    expect(compararSnapshotConArca(snapshotFiscalFixture, remoto)).toEqual([ruta]);
  });

  it("ignora solamente el orden de las colecciones", () => {
    const snapshot = {
      ...snapshotFiscalFixture,
      alicuotasIva: [
        { id: 4, baseImponible: "10.00", importe: "1.05" },
        ...snapshotFiscalFixture.alicuotasIva,
      ],
      tributos: [
        { id: 2, descripcion: "Tasa", baseImponible: "10.00", alicuota: "2.00", importe: "0.20" },
        ...snapshotFiscalFixture.tributos,
      ],
      cbtesAsoc: [
        { tipo: 6, puntoVenta: 1, numero: 2, cuit: "30714199664", fecha: "2026-08-19" },
        ...snapshotFiscalFixture.cbtesAsoc,
      ],
    };
    const remoto = {
      ...remotoFixture,
      alicuotas: [...remotoFixture.alicuotas, { id: 4, base: "10.00", importe: "1.05" }],
      tributos: [
        ...remotoFixture.tributos,
        { id: 2, descripcion: "Tasa", base: "10.00", alicuota: "2.00", importe: "0.20" },
      ],
      asociados: [
        ...remotoFixture.asociados,
        { tipo: 6, puntoVenta: 1, numero: 2, cuit: "30714199664", fecha: "2026-08-19" },
      ],
    };
    expect(compararSnapshotConArca(snapshot, remoto)).toEqual([]);
  });

  it("bloquea si ARCA omite la descripción de un tributo", () => {
    const remoto = {
      ...remotoFixture,
      tributos: [{ id: 99, base: "100.00", alicuota: "3.00", importe: "3.00" }],
    } as ComprobanteArcaConsultado;
    expect(compararSnapshotConArca(snapshotFiscalFixture, remoto)).toEqual([
      "tributos[0].descripcion",
    ]);
  });
});

describe("decisión de conciliación", () => {
  it("recupera el CAE únicamente ante coincidencia remota exacta", () => {
    expect(
      decidirConciliacion({
        snapshot: snapshotFiscalFixture,
        remoto: remotoFixture,
        ultimoRemoto: 42,
        numeroReservado: 42,
        payloadHash: snapshotFiscalFixture.hash,
      }),
    ).toEqual({
      accion: "RECUPERAR_CAE",
      cae: "74123456789012",
      vencimiento: "2026-09-01",
    });
  });

  it("bloquea ante cualquier diferencia remota", () => {
    expect(
      decidirConciliacion({
        snapshot: snapshotFiscalFixture,
        remoto: { ...remotoFixture, total: "1.00" },
        ultimoRemoto: 42,
        numeroReservado: 42,
        payloadHash: snapshotFiscalFixture.hash,
      }),
    ).toEqual({
      accion: "BLOQUEAR",
      diferencias: ["importeTotal"],
    });
  });

  it("reenvía el mismo número sólo ante ausencia, secuencia anterior exacta y mismo hash", () => {
    expect(
      decidirConciliacion({
        snapshot: snapshotFiscalFixture,
        remoto: null,
        ultimoRemoto: 41,
        numeroReservado: 42,
        payloadHash: snapshotFiscalFixture.hash,
      }),
    ).toEqual({ accion: "REENVIAR_MISMO_NUMERO" });
    expect(
      decidirConciliacion({
        snapshot: snapshotFiscalFixture,
        remoto: null,
        ultimoRemoto: 41,
        numeroReservado: 42,
        payloadHash: "b".repeat(64),
      }),
    ).toEqual({ accion: "BLOQUEAR", diferencias: ["hash"] });
  });

  it("bloquea cualquier salto de secuencia sin filtrar números", () => {
    expect(
      decidirConciliacion({
        snapshot: snapshotFiscalFixture,
        remoto: null,
        ultimoRemoto: 43,
        numeroReservado: 42,
        payloadHash: snapshotFiscalFixture.hash,
      }),
    ).toEqual({ accion: "BLOQUEAR", diferencias: ["secuencia"] });
  });

  it("bloquea si el número reservado no es el congelado en el snapshot", () => {
    expect(
      decidirConciliacion({
        snapshot: snapshotFiscalFixture,
        remoto: null,
        ultimoRemoto: 42,
        numeroReservado: 43,
        payloadHash: snapshotFiscalFixture.hash,
      }),
    ).toEqual({ accion: "BLOQUEAR", diferencias: ["identidad.numero"] });
  });

  it.each([
    ["hash", { numeroReservado: 42, payloadHash: "b".repeat(64) }],
    ["identidad.numero", { numeroReservado: 43, payloadHash: snapshotFiscalFixture.hash }],
  ] as const)("valida %s congelado antes de recuperar un remoto presente", (ruta, cambio) => {
    expect(
      decidirConciliacion({
        snapshot: snapshotFiscalFixture,
        remoto: remotoFixture,
        ultimoRemoto: 42,
        ...cambio,
      }),
    ).toEqual({ accion: "BLOQUEAR", diferencias: [ruta] });
  });

  it.each([
    ["cae", { cae: "7412345678901" }],
    ["cae", { cae: "7412345678901X" }],
    ["caeVencimiento", { caeVencimiento: "0000-01-01" }],
    ["caeVencimiento", { caeVencimiento: "2026-02-30" }],
  ] as const)("bloquea recuperación con %s remoto inválido", (ruta, cambio) => {
    expect(
      decidirConciliacion({
        snapshot: snapshotFiscalFixture,
        remoto: { ...remotoFixture, ...cambio },
        ultimoRemoto: 42,
        numeroReservado: 42,
        payloadHash: snapshotFiscalFixture.hash,
      }),
    ).toEqual({ accion: "BLOQUEAR", diferencias: [ruta] });
  });
});
