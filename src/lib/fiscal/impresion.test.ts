import { readFileSync } from "node:fs";
import QRCode from "qrcode";
import { describe, expect, it, vi } from "vitest";
import {
  ErrorImpresionFiscal,
  prepararDatosFiscalesImpresos,
  prepararDatosFiscalesLegacyMarcados,
} from "./impresion";
import { qrAfipDataUrlObligatorio, urlQrAfip } from "./qr";
import { crearSnapshotFiscalV2, type SnapshotFiscalV2 } from "./snapshot";
import { resolverDatosFiscalesComprobanteDesdeFila } from "../fiscal.functions";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/fiscal-snapshot-parity-v2.json", import.meta.url),
    "utf8",
  ),
) as { input: SnapshotFiscalV2 };

function crearSnapshot(
  mutar?: (input: Omit<SnapshotFiscalV2, "hash" | "version">) => void,
): SnapshotFiscalV2 {
  const { hash: _hash, version: _version, ...body } = structuredClone(fixture.input);
  mutar?.(body);
  return crearSnapshotFiscalV2(body);
}

function filaAprobada(snapshot = crearSnapshot()) {
  return {
    id: snapshot.venta.id,
    afip_estado: "APROBADO",
    afip_fase: "PERSISTIDO",
    afip_version: 2,
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
  };
}

const QR_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAklEQVR4AewaftIAAAMaSURBVOXBW6qlWBQAwUxx/lPOrgUtbET7eB9FfxghED9QMVQ+qXhKZVR8ovJdGy+38XI7i4qnVFYVQ+VQcUVlVHyHyqhYVTylMjZebueCyp2KKypnKquKlcqh4orKV6ncqVhtvNzOL6k4UxkVT6msKv6mjZfb+WUqd1TuqIyKlcqo+Bs2Xm7j5XYuVHyVyqg4qAyVVcVQOVQMlZ+qeGrj5XYWKn9DxVB5qmKonKmMipXKV2283F7xGyq+quKg8l9U7lR818bL7SqHiqEyKu6orCruqIyKoTIqPqk4U7miMirOVEbFUBkbLycQJxVD5aziisqouKMyKu6ojIqVyqFipbKquKOy2ni5jZfbeaDioPKUyqpiqPyEylMqq4qhMjZebq84qKwqhsqh4orKJyqjYqgcKobKJxVDZVQMlaFyVrGqGBsvt/NFKquKOxVPqTylMiqGyqriE5Wx8XI7F1RGxVnFSmWl8n+p+ERltfFyu8pZxScqo2KlcqgYKqNiqIyKg8qoGCqj4qziuyqGyth4uY2XE4hvqBgqq4qDypWKoXKoGCqjYqjcqRgqq4qnNl5u54GKg8pQGRVD5axiqDxVcaXioHKl4imVsfFy9gc3VO5UfKIyKobKJxVDZVQMlbOKobKqOFO5svFyAvFBxZnKqmKoHCquqIyKg8qqYqVyqBgqo+KOyqhYqYyNl7M/+EDlrOKnVA4VV1Q+qRgqo+KpjZfbeDmBOKkYKr+pYqjcqbii8hMVQ2VUjI2Xsz/4BSqfVAyVUXFQWVUMlVFxUBkVV1TuVAyVsfFyu8pPVKwqzlSGyqi4UzFUnlIZFWcV/2Xj5XYWFU+prCqGylnFSmVUnKmMiqEyVO5UPKUyKsbGy+1cULlT8VTFSuVOxZWKoXKm8onKqLiy8XIbL7fzF6mMilFxR2VUrFRGxUFlVTFU7qiMiqEyNl5u55eojIqDylC5UvEdFVcqhsqhYqWy2ng5gfhXxVMqo2KlcqgYKqPijsqq4o7KqFip3Km4svFyOwuV71IZFXdU7lQMlZXKHZVVxVA5VFxRGRsv9w+XWOO73oYUWAAAAABJRU5ErkJggg==";

describe("preparación fiscal v2 para impresión", () => {
  it("usa sólo el receptor y la fecha fiscal congelados, no el comprador ni la fecha comercial", () => {
    const snapshot = crearSnapshot((input) => {
      input.venta.fechaComercial = "2024-01-02T15:00:00.000Z";
      input.receptor.razonSocial = "ACME S.A.";
      input.receptor.domicilio = "Fiscal 123";
    });

    const preparado = prepararDatosFiscalesImpresos(filaAprobada(snapshot));

    expect(preparado.origen).toBe("SNAPSHOT_V2");
    expect(preparado.advertencia).toBeNull();
    expect(preparado.receptor).toMatchObject({
      razon_social: "ACME S.A.",
      domicilio: "Fiscal 123",
    });
    expect(preparado.fecha).toBe("2026-08-22");
    expect(JSON.stringify(preparado)).not.toContain("2024-01-02");
  });

  it("deriva el QR y todos los importes impresos de la evidencia autorizada", () => {
    const preparado = prepararDatosFiscalesImpresos(filaAprobada());

    expect(preparado.qrInput).toEqual({
      fecha: "2026-08-22",
      cuit: "30714199664",
      ptoVta: 5,
      tipoCmp: 6,
      nroCmp: 1,
      importe: "1380.00",
      moneda: "PES",
      ctz: "1.000000",
      tipoDocRec: 96,
      nroDocRec: "30123456",
      codAut: "75123456789012",
    });
    expect(preparado.totales).toEqual({
      neto: "1000.00",
      exento: "100.00",
      no_gravado: "50.00",
      iva: "210.00",
      tributos: "20.00",
      total: "1380.00",
      alicuotas: [{ Id: 5, BaseImp: "1000.00", Importe: "210.00" }],
    });
    expect(preparado.iva_contenido).toBe("210.00");
    expect(preparado.otros_impuestos_nacionales_indirectos).toBe("20.00");

    const payload = JSON.parse(
      Buffer.from(urlQrAfip(preparado.qrInput).split("?p=")[1], "base64").toString("utf8"),
    );
    expect(payload).toMatchObject({
      fecha: "2026-08-22",
      cuit: 30714199664,
      ptoVta: 5,
      tipoCmp: 6,
      nroCmp: 1,
      importe: 1380,
      tipoDocRec: 96,
      nroDocRec: 30123456,
      codAut: 75123456789012,
    });
  });

  it.each([
    ["snapshot ausente", { afip_snapshot: null }, "SNAPSHOT_FISCAL_INVALIDO"],
    ["hash externo distinto", { afip_snapshot_hash: "f".repeat(64) }, "SNAPSHOT_FISCAL_DIVERGENTE"],
    ["número distinto", { afip_numero: 999 }, "SNAPSHOT_FISCAL_DIVERGENTE"],
    [
      "fecha fiscal distinta",
      { afip_fecha_comprobante: "2026-08-21" },
      "SNAPSHOT_FISCAL_DIVERGENTE",
    ],
    ["total fiscal distinto", { afip_imp_total: "1380.01" }, "SNAPSHOT_FISCAL_DIVERGENTE"],
  ])("bloquea un APROBADO nuevo con %s", (_caso, cambio, codigo) => {
    try {
      prepararDatosFiscalesImpresos({ ...filaAprobada(), ...cambio });
      throw new Error("debió fallar");
    } catch (error) {
      expect(error).toBeInstanceOf(ErrorImpresionFiscal);
      expect((error as ErrorImpresionFiscal).codigo).toBe(codigo);
    }
  });

  it("bloquea estado/fase/CAE inconsistentes antes de producir un modelo fiscal", () => {
    for (const cambio of [
      { afip_estado: "SIN_FACTURAR" },
      { afip_fase: "RESPUESTA_RECIBIDA" },
      { cae: null },
      { cae: "CAE-invalido" },
    ]) {
      expect(() => prepararDatosFiscalesImpresos({ ...filaAprobada(), ...cambio })).toThrowError(
        expect.objectContaining({ codigo: "COMPROBANTE_FISCAL_INCONSISTENTE" }),
      );
    }
  });
});

describe("fallback histórico marcado", () => {
  const datosHistoricos = {
    emisor: {
      razon_social: "CasaForma histórica",
      nombre_fantasia: "CasaForma",
      cuit: "30714199664",
      domicilio_fiscal: "Sarmiento 1398",
      condicion_iva: "RESPONSABLE_INSCRIPTO",
      ingresos_brutos: "280970280",
      inicio_actividades: "2013-10-01",
    },
    receptor: {
      razon_social: "Cliente histórico",
      cuit_dni: "30123456",
      doc_tipo: 96,
      doc_nro: 30123456,
      condicion_iva: "CONSUMIDOR_FINAL",
      domicilio: "Domicilio histórico",
    },
    condicion_venta: "CONTADO",
    totales: {
      neto: 1000,
      iva: 210,
      tributos: 0,
      total: 1210,
      alicuotas: [{ Id: 5, BaseImp: 1000, Importe: 210 }],
    },
    lineas: [],
    fecha: "2020-02-03",
    cae: "75123456789012",
    cae_vencimiento: "2020-02-13",
    punto_venta: 5,
    numero: 9,
    cbte_tipo: 6,
    modo: "PRODUCCION",
    simulado: false,
    qr: QR_PNG,
  };

  const filaLegacy = {
    id: "71000000-0000-4000-8000-000000000901",
    afip_estado: "APROBADO",
    afip_version: 1,
    afip_legacy_incompleto: true,
    afip_snapshot: null,
    afip_emisor_cuit: "30714199664",
    afip_punto_venta: 5,
    afip_cbte_tipo: 6,
    afip_numero: 9,
    afip_modo: "PRODUCCION",
    afip_simulado: false,
    afip_validez: "PRODUCCION",
    afip_fecha_comprobante: "2020-02-03",
    afip_imp_total: "1210.00",
    cae: "75123456789012",
    cae_vencimiento: "2020-02-13",
  };

  it("sólo habilita el lector histórico con el marcador explícito y deja una advertencia visible", () => {
    const preparado = prepararDatosFiscalesLegacyMarcados({
      fila: filaLegacy,
      datosHistoricos,
    });

    expect(preparado.origen).toBe("LEGACY_INCOMPLETO");
    expect(preparado.advertencia).toBe("HISTÓRICO LEGACY — DATOS FISCALES INCOMPLETOS");
    expect(preparado.receptor.razon_social).toBe("Cliente histórico");
    expect(preparado.qrInput.fecha).toBe("2020-02-03");
  });

  it("no deja confundir legacy sin marcar ni una aprobación v2 nueva con el fallback", () => {
    expect(() =>
      prepararDatosFiscalesLegacyMarcados({
        fila: { ...filaLegacy, afip_legacy_incompleto: false },
        datosHistoricos,
      }),
    ).toThrowError(expect.objectContaining({ codigo: "LEGACY_FISCAL_NO_MARCADO" }));

    const snapshot = crearSnapshot();
    expect(() =>
      prepararDatosFiscalesLegacyMarcados({
        fila: {
          ...filaLegacy,
          afip_version: 2,
          afip_snapshot: snapshot,
          afip_snapshot_hash: snapshot.hash,
        },
        datosHistoricos,
      }),
    ).toThrowError(expect.objectContaining({ codigo: "LEGACY_FISCAL_NO_MARCADO" }));
  });
});

describe("QR fiscal obligatorio", () => {
  it("rechaza un input incompleto en vez de devolver null", async () => {
    const input = prepararDatosFiscalesImpresos(filaAprobada()).qrInput;

    await expect(qrAfipDataUrlObligatorio({ ...input, codAut: "" })).rejects.toMatchObject({
      name: "ErrorImpresionFiscal",
      codigo: "QR_FISCAL_OBLIGATORIO",
    });
  });

  it("propaga como error fiscal tipado una falla real del generador de PNG", async () => {
    const input = prepararDatosFiscalesImpresos(filaAprobada()).qrInput;
    vi.spyOn(QRCode, "toDataURL").mockRejectedValueOnce(new Error("png roto"));

    await expect(qrAfipDataUrlObligatorio(input)).rejects.toMatchObject({
      name: "ErrorImpresionFiscal",
      codigo: "QR_FISCAL_OBLIGATORIO",
    });
  });
});

describe("fachada de lectura fiscal", () => {
  it("devuelve null únicamente para una venta realmente no aprobada y sin CAE", async () => {
    let efectos = 0;
    const resultado = await resolverDatosFiscalesComprobanteDesdeFila(
      { afip_estado: "SIN_FACTURAR", cae: null },
      {
        cargarLegacy: async () => {
          efectos += 1;
          return null;
        },
        generarQr: async () => {
          efectos += 1;
          return QR_PNG;
        },
      },
    );

    expect(resultado).toBeNull();
    expect(efectos).toBe(0);
  });

  it("para v2 prepara, exige QR y jamás consulta el lector vivo legacy", async () => {
    let lecturasLegacy = 0;
    const resultado = await resolverDatosFiscalesComprobanteDesdeFila(filaAprobada(), {
      cargarLegacy: async () => {
        lecturasLegacy += 1;
        throw new Error("no debe leerse");
      },
      generarQr: async () => QR_PNG,
    });

    expect(resultado).toMatchObject({ origen: "SNAPSHOT_V2", qr: QR_PNG });
    expect(lecturasLegacy).toBe(0);
  });

  it("una falla de QR en un CAE aprobado se propaga y no se convierte en null", async () => {
    await expect(
      resolverDatosFiscalesComprobanteDesdeFila(filaAprobada(), {
        cargarLegacy: async () => null,
        generarQr: async () => {
          throw new ErrorImpresionFiscal("QR_FISCAL_OBLIGATORIO", "QR roto");
        },
      }),
    ).rejects.toMatchObject({ codigo: "QR_FISCAL_OBLIGATORIO" });
  });

  it("un APROBADO sin CAE falla cerrado antes de lector legacy o QR", async () => {
    let efectos = 0;
    await expect(
      resolverDatosFiscalesComprobanteDesdeFila(
        { ...filaAprobada(), cae: null },
        {
          cargarLegacy: async () => {
            efectos += 1;
            return null;
          },
          generarQr: async () => {
            efectos += 1;
            return QR_PNG;
          },
        },
      ),
    ).rejects.toMatchObject({ codigo: "COMPROBANTE_FISCAL_INCONSISTENTE" });
    expect(efectos).toBe(0);
  });
});
