import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { encryptString } from "./crypto";

const resultGetFixture = {
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

const sdk = vi.hoisted(() => ({
  genericCall: vi.fn(),
  getLastVoucher: vi.fn(async () => ({ cbteNro: 42 })),
  contexts: [] as Array<{ ticketPath?: string; ticketStorage?: unknown }>,
}));

vi.mock("@arcasdk/core", () => ({
  Arca: class {
    genericService = { call: sdk.genericCall };
    electronicBillingService = {
      getLastVoucher: sdk.getLastVoucher,
    };

    constructor(context: { ticketPath?: string; ticketStorage?: unknown }) {
      // @arcasdk/core 2.0.0 evalúa __dirname al ser empaquetado como ESM si
      // ticketPath llega vacío, aun cuando recibe un ticketStorage propio.
      if (!context.ticketPath) throw new ReferenceError("__dirname is not defined");
      sdk.contexts.push(context);
    }
  },
}));

describe("cliente ARCA en el runtime ESM de Vercel", () => {
  const encryptionKeyAnterior = process.env.ARCA_ENCRYPTION_KEY;
  const mockModeAnterior = process.env.INVOICING_MOCK_MODE;

  beforeEach(() => {
    process.env.ARCA_ENCRYPTION_KEY = "clave-de-prueba-para-arca-de-32-caracteres";
    delete process.env.INVOICING_MOCK_MODE;
    vi.resetModules();
    sdk.genericCall.mockReset();
    sdk.getLastVoucher.mockClear();
    sdk.contexts.length = 0;
  });

  afterEach(() => {
    if (encryptionKeyAnterior === undefined) delete process.env.ARCA_ENCRYPTION_KEY;
    else process.env.ARCA_ENCRYPTION_KEY = encryptionKeyAnterior;

    if (mockModeAnterior === undefined) delete process.env.INVOICING_MOCK_MODE;
    else process.env.INVOICING_MOCK_MODE = mockModeAnterior;
  });

  it("inicializa el SDK sin depender de __dirname", async () => {
    const { ultimoAutorizado } = await import("./arca");

    const ultimo = await ultimoAutorizado(
      {
        cuit: "30-71419966-4",
        arca_key_enc: encryptString("PRIVATE KEY"),
        arca_cert_enc: encryptString("CERTIFICATE"),
      },
      { numero: 5, modo: "PRODUCCION" },
      6,
      {},
    );

    expect(ultimo).toBe(42);
    expect(sdk.contexts[0]?.ticketPath).toBe("/tmp/quimex-arca-tickets");
    expect(sdk.contexts[0]?.ticketStorage).toBeDefined();
  });

  it("mantiene @arcasdk/core fijado exactamente en 2.0.0", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies["@arcasdk/core"]).toBe("2.0.0");
  });

  it("consulta FECompConsultar por el servicio SOAP genérico público", async () => {
    sdk.genericCall.mockResolvedValue({ FECompConsultarResult: { ResultGet: resultGetFixture } });
    const { consultarComprobanteCompleto } = await import("./arca");

    const comprobante = await consultarComprobanteCompleto(
      {
        cuit: "30-71419966-4",
        arca_key_enc: encryptString("PRIVATE KEY"),
        arca_cert_enc: encryptString("CERTIFICATE"),
      },
      { numero: 5, modo: "PRODUCCION" },
      3,
      42,
      {},
    );

    expect(comprobante?.cae).toBe("74123456789012");
    expect(sdk.genericCall).toHaveBeenCalledWith("wsfe", "FECompConsultar", {
      FeCompConsReq: { CbteNro: 42, PtoVta: 5, CbteTipo: 3 },
    });
  });

  it("preserva el contrato legado de vencimiento como Date", async () => {
    sdk.genericCall.mockResolvedValue({ FECompConsultarResult: { ResultGet: resultGetFixture } });
    const { consultarComprobante } = await import("./arca");

    await expect(
      consultarComprobante(
        {
          cuit: "30-71419966-4",
          arca_key_enc: encryptString("PRIVATE KEY"),
          arca_cert_enc: encryptString("CERTIFICATE"),
        },
        { numero: 5, modo: "PRODUCCION" },
        3,
        42,
        {},
      ),
    ).resolves.toEqual({
      cae: "74123456789012",
      vencimiento: new Date("2026-09-01T12:00:00.000Z"),
    });
  });

  it("devuelve null sólo para ausencia estructurada con código 602", async () => {
    sdk.genericCall.mockResolvedValue({
      FECompConsultarResult: { Errors: { Err: { Code: 602, Msg: "sin datos" } } },
    });
    const { consultarComprobanteCompleto } = await import("./arca");
    const args = [
      {
        cuit: "30-71419966-4",
        arca_key_enc: encryptString("PRIVATE KEY"),
        arca_cert_enc: encryptString("CERTIFICATE"),
      },
      { numero: 5, modo: "PRODUCCION" } as const,
      3,
      42,
      {},
    ] as const;

    await expect(consultarComprobanteCompleto(...args)).resolves.toBeNull();

    sdk.genericCall.mockResolvedValue({
      FECompConsultarResult: { Errors: { Err: [{ Code: 602 }, { Code: 500 }] } },
    });
    await expect(consultarComprobanteCompleto(...args)).rejects.toThrow();

    sdk.genericCall.mockRejectedValue(
      Object.assign(new Error("error estructurado"), { code: 602 }),
    );
    await expect(consultarComprobanteCompleto(...args)).resolves.toBeNull();

    sdk.genericCall.mockRejectedValue(new Error("602 no existen datos / not found"));
    await expect(consultarComprobanteCompleto(...args)).rejects.toThrow(/602/);
  });

  it("mantiene timeout como incierto y un rechazo estructurado como definitivo", async () => {
    vi.useFakeTimers();
    try {
      sdk.genericCall.mockReturnValue(new Promise(() => undefined));
      const { consultarComprobanteCompleto, esErrorTransitorio } = await import("./arca");
      const consulta = consultarComprobanteCompleto(
        {
          cuit: "30-71419966-4",
          arca_key_enc: encryptString("PRIVATE KEY"),
          arca_cert_enc: encryptString("CERTIFICATE"),
        },
        { numero: 5, modo: "PRODUCCION" },
        3,
        42,
        {},
      );
      const capturada = consulta.catch((error) => error);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(esErrorTransitorio(await capturada)).toBe(true);

      sdk.genericCall.mockResolvedValue({
        FECompConsultarResult: {
          ResultGet: { ...resultGetFixture, Resultado: "R", CodAutorizacion: "" },
        },
      });
      const rechazo = await consultarComprobanteCompleto(
        {
          cuit: "30-71419966-4",
          arca_key_enc: encryptString("PRIVATE KEY"),
          arca_cert_enc: encryptString("CERTIFICATE"),
        },
        { numero: 5, modo: "PRODUCCION" },
        3,
        42,
        {},
      ).catch((error) => error);
      expect(esErrorTransitorio(rechazo)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aplica también 25 segundos al sondeo de secuencia", async () => {
    vi.useFakeTimers();
    try {
      sdk.getLastVoucher.mockReturnValueOnce(new Promise(() => undefined));
      const { ultimoAutorizado, esErrorTransitorio } = await import("./arca");
      const consulta = ultimoAutorizado(
        {
          cuit: "30-71419966-4",
          arca_key_enc: encryptString("PRIVATE KEY"),
          arca_cert_enc: encryptString("CERTIFICATE"),
        },
        { numero: 5, modo: "PRODUCCION" },
        3,
        {},
      );
      const capturada = consulta.catch((error) => error);
      await vi.advanceTimersByTimeAsync(24_999);
      let resuelta = false;
      void capturada.then(() => {
        resuelta = true;
      });
      await Promise.resolve();
      expect(resuelta).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(esErrorTransitorio(await capturada)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
