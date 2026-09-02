import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { encryptString } from "./crypto";
import { codigoErrorFiscalUsuario } from "./error-usuario";
import type { SnapshotFiscalPersistido } from "./snapshot";

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
  Tributos: {
    Tributo: [{ Id: 99, Desc: "Percepción", BaseImp: 100, Alic: 3, Importe: 3 }],
  },
  CbtesAsoc: {
    CbteAsoc: [{ Tipo: 1, PtoVta: 5, Nro: 40, Cuit: "30714199664", CbteFch: "20260820" }],
  },
};

const sdk = vi.hoisted(() => ({
  genericCall: vi.fn(),
  createVoucher: vi.fn(),
  getLastVoucher: vi.fn(async () => ({ cbteNro: 42 })),
  contexts: [] as Array<{ ticketPath?: string; ticketStorage?: unknown }>,
}));

vi.mock("@arcasdk/core", () => ({
  Arca: class {
    genericService = { call: sdk.genericCall };
    electronicBillingService = {
      getLastVoucher: sdk.getLastVoucher,
      createVoucher: sdk.createVoucher,
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
    sdk.createVoucher.mockReset();
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

  it("clasifica certificado ausente como configuración sin filtrar detalles técnicos", async () => {
    const { ultimoAutorizado } = await import("./arca");

    const promise = ultimoAutorizado(
      { cuit: "30-71419966-4", arca_key_enc: null, arca_cert_enc: null },
      { numero: 5, modo: "PRODUCCION" },
      6,
      {},
    );

    await expect(promise).rejects.toSatisfy(
      (error: unknown) => codigoErrorFiscalUsuario(error) === "CERTIFICADO_ARCA_INVALIDO",
    );
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

    sdk.genericCall.mockRejectedValue(Object.assign(new Error("código textual"), { code: "602" }));
    await expect(consultarComprobanteCompleto(...args)).rejects.toThrow(/textual/);
  });

  it("no acepta Code textual 602 ni propiedades heredadas como ausencia", async () => {
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

    sdk.genericCall.mockResolvedValue({
      FECompConsultarResult: { Errors: { Err: { Code: "602" } } },
    });
    await expect(consultarComprobanteCompleto(...args)).rejects.toThrow();

    const errorsHeredados = Object.create({ Err: { Code: 602 } });
    sdk.genericCall.mockResolvedValue({
      FECompConsultarResult: { Errors: errorsHeredados },
    });
    await expect(consultarComprobanteCompleto(...args)).rejects.toThrow();
  });

  it.each([null, false, 0, ""])("ResultGet presente pero %j falla cerrado", async (ResultGet) => {
    sdk.genericCall.mockResolvedValue({
      FECompConsultarResult: { ResultGet, Errors: { Err: { Code: 602 } } },
    });
    const { consultarComprobanteCompleto } = await import("./arca");
    await expect(
      consultarComprobanteCompleto(
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
    ).rejects.toThrow();
  });

  it("rechaza accessors del envelope sin ejecutarlos", async () => {
    let ejecutado = false;
    const raw = {};
    Object.defineProperty(raw, "FECompConsultarResult", {
      enumerable: true,
      get() {
        ejecutado = true;
        return { Errors: { Err: { Code: 602 } } };
      },
    });
    sdk.genericCall.mockResolvedValue(raw);
    const { consultarComprobanteCompleto } = await import("./arca");
    await expect(
      consultarComprobanteCompleto(
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
    ).rejects.toThrow(/accessor|datos/i);
    expect(ejecutado).toBe(false);
  });

  it("un getter de parsing que arroja code numérico 602 no se reclasifica como ausencia", async () => {
    const resultGet = { ...resultGetFixture };
    Object.defineProperty(resultGet, "PtoVta", {
      enumerable: true,
      get() {
        throw Object.assign(new Error("getter de parsing"), { code: 602 });
      },
    });
    sdk.genericCall.mockResolvedValue({ FECompConsultarResult: { ResultGet: resultGet } });
    const { consultarComprobanteCompleto } = await import("./arca");
    await expect(
      consultarComprobanteCompleto(
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
    ).rejects.toThrow();
  });

  it.each([
    ["R con CAE", { ResultGet: { ...resultGetFixture, Resultado: "R" } }],
    ["Resultado ausente", { ResultGet: { ...resultGetFixture, Resultado: undefined } }],
    ["Resultado desconocido", { ResultGet: { ...resultGetFixture, Resultado: "P" } }],
    [
      "A con error estructurado",
      { ResultGet: resultGetFixture, Errors: { Err: { Code: 10016, Msg: "rechazo" } } },
    ],
    [
      "R vacío mezclado con error",
      {
        ResultGet: { ...resultGetFixture, Resultado: "R", CodAutorizacion: "" },
        Errors: { Err: { Code: 10016, Msg: "rechazo" } },
      },
    ],
  ])("trata como incierta la contradicción de aprobación: %s", async (_caso, response) => {
    sdk.genericCall.mockResolvedValue({ FECompConsultarResult: response });
    const { consultarComprobanteCompleto, esErrorTransitorio } = await import("./arca");
    const error = await consultarComprobanteCompleto(
      {
        cuit: "30-71419966-4",
        arca_key_enc: encryptString("PRIVATE KEY"),
        arca_cert_enc: encryptString("CERTIFICATE"),
      },
      { numero: 5, modo: "PRODUCCION" },
      3,
      42,
      {},
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(esErrorTransitorio(error)).toBe(true);
  });

  it("acepta A exacto con CAE válido y Errors.Err vacío", async () => {
    sdk.genericCall.mockResolvedValue({
      FECompConsultarResult: { ResultGet: resultGetFixture, Errors: { Err: [] } },
    });
    const { consultarComprobanteCompleto } = await import("./arca");
    await expect(
      consultarComprobanteCompleto(
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
    ).resolves.toMatchObject({ cae: "74123456789012" });
  });

  describe("clasificación estricta de FECAESolicitar", () => {
    const emisor = () => ({
      cuit: "30-71419966-4",
      arca_key_enc: encryptString("PRIVATE KEY"),
      arca_cert_enc: encryptString("CERTIFICATE"),
    });
    const detalle = {
      Concepto: 1,
      DocTipo: 80,
      DocNro: 30714199664,
      CbteDesde: 42,
      CbteHasta: 42,
      CbteFch: "20260822",
      Resultado: "A",
      CAE: "74123456789012",
      CAEFchVto: "20260901",
      Observaciones: { Obs: [] },
    };
    const cabecera = {
      Cuit: 30714199664,
      PtoVta: 5,
      CbteTipo: 1,
      FchProceso: "20260822150000",
      CantReg: 1,
      Resultado: "A",
      Reproceso: "N",
    };
    const respuestaA = () => ({
      response: {
        FeCabResp: { ...cabecera },
        FeDetResp: { FECAEDetResponse: [{ ...detalle }] },
        Errors: { Err: [] as Array<{ Code: number; Msg?: string }> },
      },
      cae: "74123456789012",
      caeFchVto: "20260901",
    });
    const payloadExacto = {
      CbteTipo: 1,
      Concepto: 1,
      DocTipo: 80,
      DocNro: 30714199664,
      CbteFch: "20260822",
    };
    const solicitar = async (payload: Record<string, unknown> = payloadExacto) => {
      const { solicitarCaeConPayload } = await import("./arca");
      return solicitarCaeConPayload(emisor(), { numero: 5, modo: "PRODUCCION" }, payload, 42, {});
    };

    it("aprueba sólo A coherente, un detalle exacto, CAE canónico y fecha calendario", async () => {
      sdk.createVoucher.mockResolvedValue(respuestaA());

      await expect(solicitar()).resolves.toEqual({
        cae: "74123456789012",
        vencimiento: new Date("2026-09-01T12:00:00.000Z"),
        modo: "PRODUCCION",
      });
    });

    it("preserva PeriodoAsoc anidado al cruzar el límite real del SDK", async () => {
      sdk.createVoucher.mockResolvedValue(respuestaA());
      const payloadPeriodo = {
        ...payloadExacto,
        PeriodoAsoc: { FchDesde: "20260801", FchHasta: "20260815" },
      };

      await solicitar(payloadPeriodo);

      expect(sdk.createVoucher).toHaveBeenCalledTimes(1);
      expect(sdk.createVoucher.mock.calls[0]?.[0]).toEqual(payloadPeriodo);
      const argumentoSdk = sdk.createVoucher.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(argumentoSdk.PeriodoAsoc).toEqual({
        FchDesde: "20260801",
        FchHasta: "20260815",
      });
    });

    it("un snapshot v3 inválido falla antes de invocar el SDK", async () => {
      const { crearPayloadCaeDesdeSnapshot } = await import("./arca");
      const emitir = async () => {
        const payload = crearPayloadCaeDesdeSnapshot({ version: 3 } as SnapshotFiscalPersistido);
        return solicitar(payload);
      };

      await expect(emitir()).rejects.toThrow(/snapshot|clave|faltante/i);
      expect(sdk.createVoucher).not.toHaveBeenCalled();
    });

    it("clasifica un timeout posterior al envío como incierto y no reintenta", async () => {
      vi.useFakeTimers();
      try {
        sdk.createVoucher.mockReturnValue(new Promise(() => undefined));
        const solicitud = solicitar({
          ...payloadExacto,
          PeriodoAsoc: { FchDesde: "20260801", FchHasta: "20260815" },
        });
        const capturada = solicitud.catch((error) => error);

        await vi.advanceTimersByTimeAsync(25_000);

        const { esErrorTransitorio } = await import("./arca");
        expect(esErrorTransitorio(await capturada)).toBe(true);
        expect(sdk.createVoucher).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      [
        "A con Errors",
        (r: ReturnType<typeof respuestaA>) =>
          (r.response.Errors.Err = [{ Code: 10013, Msg: "rechazo" }]),
      ],
      [
        "R con CAE",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeCabResp.Resultado = "R";
          r.response.FeDetResp.FECAEDetResponse[0].Resultado = "R";
        },
      ],
      [
        "Resultado ausente",
        (r: ReturnType<typeof respuestaA>) => {
          (r.response.FeDetResp.FECAEDetResponse[0] as { Resultado?: string }).Resultado =
            undefined;
        },
      ],
      [
        "Resultado desconocido",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeCabResp.Resultado = "P";
          r.response.FeDetResp.FECAEDetResponse[0].Resultado = "P";
        },
      ],
      [
        "CAE ausente sin R",
        (r: ReturnType<typeof respuestaA>) => {
          (r.response.FeDetResp.FECAEDetResponse[0] as { CAE?: string }).CAE = undefined;
          r.cae = "";
        },
      ],
      [
        "CAE malformado",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse[0].CAE = "7412";
          r.cae = "7412";
        },
      ],
      [
        "dos detalles",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse.push({ ...detalle });
        },
      ],
      [
        "PV distinto",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeCabResp.PtoVta = 6;
        },
      ],
      [
        "tipo distinto",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeCabResp.CbteTipo = 6;
        },
      ],
      [
        "número distinto",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse[0].CbteDesde = 43;
          r.response.FeDetResp.FECAEDetResponse[0].CbteHasta = 43;
        },
      ],
      [
        "fecha imposible",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse[0].CAEFchVto = "20260230";
          r.caeFchVto = "20260230";
        },
      ],
      [
        "año cero",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse[0].CAEFchVto = "00000101";
          r.caeFchVto = "00000101";
        },
      ],
    ])(
      "clasifica como incierta la respuesta contradictoria o malformada: %s",
      async (_caso, mutar) => {
        const raw = respuestaA();
        mutar(raw);
        sdk.createVoucher.mockResolvedValue(raw);
        const { esErrorTransitorio } = await import("./arca");

        const error = await solicitar().catch((caught) => caught);

        expect(error).toBeInstanceOf(Error);
        expect(esErrorTransitorio(error)).toBe(true);
      },
    );

    it.each([
      [
        "Concepto distinto",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse[0].Concepto = 2;
        },
      ],
      [
        "DocTipo distinto",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse[0].DocTipo = 96;
        },
      ],
      [
        "DocNro distinto",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse[0].DocNro = 30714199665;
        },
      ],
      [
        "CbteFch distinto",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse[0].CbteFch = "20260823";
        },
      ],
      [
        "Concepto ausente",
        (r: ReturnType<typeof respuestaA>) => {
          delete (r.response.FeDetResp.FECAEDetResponse[0] as { Concepto?: number }).Concepto;
        },
      ],
      [
        "DocTipo ausente",
        (r: ReturnType<typeof respuestaA>) => {
          delete (r.response.FeDetResp.FECAEDetResponse[0] as { DocTipo?: number }).DocTipo;
        },
      ],
      [
        "DocNro ausente",
        (r: ReturnType<typeof respuestaA>) => {
          delete (r.response.FeDetResp.FECAEDetResponse[0] as { DocNro?: number }).DocNro;
        },
      ],
      [
        "CbteFch ausente",
        (r: ReturnType<typeof respuestaA>) => {
          delete (r.response.FeDetResp.FECAEDetResponse[0] as { CbteFch?: string }).CbteFch;
        },
      ],
      [
        "Concepto inválido",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse[0].Concepto = -1;
        },
      ],
      [
        "DocTipo inválido",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse[0].DocTipo = 80.5;
        },
      ],
      [
        "DocNro inválido",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse[0].DocNro = "30-71419966-4" as never;
        },
      ],
      [
        "CbteFch inválido",
        (r: ReturnType<typeof respuestaA>) => {
          r.response.FeDetResp.FECAEDetResponse[0].CbteFch = "20260230";
        },
      ],
    ])("clasifica como incierta una identidad de detalle no exacta: %s", async (_caso, mutar) => {
      const raw = respuestaA();
      mutar(raw);
      sdk.createVoucher.mockResolvedValue(raw);
      const { ArcaRechazoDefinitivo, esErrorTransitorio } = await import("./arca");

      const error = await solicitar().catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: "ArcaRespuestaIncierta" });
      expect(error).not.toBeInstanceOf(ArcaRechazoDefinitivo);
      expect(esErrorTransitorio(error)).toBe(true);
    });

    it("sólo R coherente con CAE vacío es rechazo definitivo y conserva códigos seguros", async () => {
      const raw = respuestaA();
      raw.response.FeCabResp.Resultado = "R";
      raw.response.FeDetResp.FECAEDetResponse[0] = {
        ...detalle,
        Resultado: "R",
        CAE: "",
        CAEFchVto: "",
        Observaciones: {
          Obs: { Code: 10016, Msg: "CUIT 30-71419966-4 monto $999 secreto=abc" } as never,
        },
      };
      raw.cae = "";
      raw.caeFchVto = "";
      sdk.createVoucher.mockResolvedValue(raw);
      const { ArcaRechazoDefinitivo } = await import("./arca");

      const error = await solicitar().catch((caught) => caught);

      expect(error).toBeInstanceOf(ArcaRechazoDefinitivo);
      expect(error.codigo).toBe("10016");
      expect(error.message).toMatch(/rechazo fiscal.*10016/i);
      expect(error.message).not.toMatch(/30-71419966-4|999|secreto|abc/i);
    });

    it("acepta la forma singleton del detalle que expone SOAP además de arrays", async () => {
      const raw = respuestaA();
      raw.response.FeDetResp.FECAEDetResponse = raw.response.FeDetResp.FECAEDetResponse[0] as never;
      sdk.createVoucher.mockResolvedValue(raw);

      await expect(solicitar()).resolves.toMatchObject({ cae: "74123456789012" });
    });
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
