import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codigoErrorFiscalUsuario } from "./error-usuario";

const sdk = vi.hoisted(() => ({
  crearClienteArca: vi.fn(),
  conTimeoutArca: vi.fn(<T>(promise: Promise<T>) => promise),
}));

vi.mock("./arca", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./arca")>();
  return {
    ...actual,
    crearClienteArca: sdk.crearClienteArca,
    conTimeoutArca: sdk.conTimeoutArca,
  };
});

import { consultarPadronArcaDesdeContexto } from "./padron-arca.server";

const emisor = {
  cuit: "30-71419966-4",
  arca_key_enc: "clave-cifrada",
  arca_cert_enc: "certificado-cifrado",
};

const entornoOriginal = {
  NODE_ENV: process.env.NODE_ENV,
  VITEST: process.env.VITEST,
  INVOICING_MOCK_TEST_RUNNER: process.env.INVOICING_MOCK_TEST_RUNNER,
  INVOICING_MOCK_MODE: process.env.INVOICING_MOCK_MODE,
  INVOICING_MOCK_SCENARIO: process.env.INVOICING_MOCK_SCENARIO,
};

function restaurarEntorno(nombre: keyof typeof entornoOriginal): void {
  const valor = entornoOriginal[nombre];
  if (valor === undefined) delete process.env[nombre];
  else process.env[nombre] = valor;
}

function respuestaJuridica(): unknown {
  return {
    idPersona: 30714199664,
    tipoPersona: "JURIDICA",
    estadoClave: "ACTIVO",
    datosGenerales: {
      razonSocial: "APLICACIONES Y SERVICIOS S.R.L.",
      domicilioFiscal: { direccion: "Sarmiento 1398" },
    },
    datosRegimenGeneral: {
      impuesto: [{ idImpuesto: 30, estadoImpuesto: "AC" }],
    },
  };
}

function errorRemoto(nombre: string, propiedades: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`SENSITIVE-SOAP-FAULT ${nombre}`), propiedades);
}

function clienteQueResponde(respuesta: unknown) {
  const getTaxpayerDetails = vi.fn(async () => respuesta);
  sdk.crearClienteArca.mockResolvedValue({
    registerInscriptionProofService: { getTaxpayerDetails },
  });
  return getTaxpayerDetails;
}

async function errorDeConsulta(cause: unknown) {
  clienteQueResponde(Promise.reject(cause));
  const error = await consultarPadronArcaDesdeContexto({
    cuit: "30-71419966-4",
    emisor,
    ambiente: "HOMOLOGACION",
    admin: {},
  }).catch((capturado) => capturado);
  return error as Error;
}

describe("adaptador server-only del padrón ARCA", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.VITEST = "true";
    delete process.env.INVOICING_MOCK_MODE;
    sdk.crearClienteArca.mockReset();
    sdk.conTimeoutArca.mockClear();
  });

  afterEach(() => {
    restaurarEntorno("NODE_ENV");
    restaurarEntorno("VITEST");
    restaurarEntorno("INVOICING_MOCK_TEST_RUNNER");
    restaurarEntorno("INVOICING_MOCK_MODE");
    restaurarEntorno("INVOICING_MOCK_SCENARIO");
    vi.restoreAllMocks();
  });

  it("en mock Playwright valida el CUIT con una respuesta local y no abre SDK ni red", async () => {
    process.env.INVOICING_MOCK_TEST_RUNNER = "playwright";
    process.env.INVOICING_MOCK_MODE = "true";
    process.env.INVOICING_MOCK_SCENARIO = "OK";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      consultarPadronArcaDesdeContexto({
        cuit: "30-71419966-4",
        emisor: { cuit: "30714199664", arca_key_enc: null, arca_cert_enc: null },
        ambiente: "HOMOLOGACION",
        admin: {},
      }),
    ).resolves.toMatchObject({
      cuit: "30714199664",
      razonSocial: "T13-E2E RECEPTOR PADRÓN MOCK",
      condicionIvaConfirmada: "RESPONSABLE_INSCRIPTO",
      domicilioFiscal: "Domicilio fiscal mock local",
    });

    expect(sdk.crearClienteArca).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("en mock Playwright conserva la misma verificación entre preview y confirmación", async () => {
    process.env.INVOICING_MOCK_TEST_RUNNER = "playwright";
    process.env.INVOICING_MOCK_MODE = "true";
    process.env.INVOICING_MOCK_SCENARIO = "OK";
    const entrada = {
      cuit: "30-71419966-4",
      emisor: { cuit: "30714199664", arca_key_enc: null, arca_cert_enc: null },
      ambiente: "HOMOLOGACION" as const,
      admin: {},
    };

    const primera = await consultarPadronArcaDesdeContexto(entrada);
    const segunda = await consultarPadronArcaDesdeContexto(entrada);

    expect(primera.verificadoArcaAt).toBe("2026-08-29T12:00:00.000Z");
    expect(segunda).toEqual(primera);
  });

  it("consulta getPersona_v2 mediante getTaxpayerDetails y registra el éxito sin datos fiscales", async () => {
    const getTaxpayerDetails = clienteQueResponde(respuestaJuridica());
    const registrarEvento = vi.fn();
    const ahoraMs = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125);

    await expect(
      consultarPadronArcaDesdeContexto({
        cuit: "30-71419966-4",
        emisor,
        ambiente: "HOMOLOGACION",
        admin: {},
        registrarEvento,
        ahoraMs,
      }),
    ).resolves.toMatchObject({
      cuit: "30714199664",
      condicionIvaConfirmada: "RESPONSABLE_INSCRIPTO",
    });

    expect(getTaxpayerDetails).toHaveBeenCalledWith(30714199664);
    expect(registrarEvento).toHaveBeenCalledWith({
      resultado: "OK",
      etapa: "CONSULTA",
      servicio: "ws_sr_constancia_inscripcion",
      ambiente: "HOMOLOGACION",
      duracion_ms: 25,
    });
  });

  it.each([
    ["ETIMEDOUT", errorRemoto("ETIMEDOUT", { code: "ETIMEDOUT" }), "PADRON_ARCA_CAIDO"],
    ["ECONNRESET", errorRemoto("ECONNRESET", { code: "ECONNRESET" }), "PADRON_ARCA_CAIDO"],
    ["HTTP 502", errorRemoto("502", { status: 502 }), "PADRON_ARCA_CAIDO"],
    [
      "HTTP 502 como código",
      errorRemoto("estado numerico sin status en el texto", { code: 502 }),
      "PADRON_ARCA_CAIDO",
    ],
    ["HTTP 503", errorRemoto("503", { status: 503 }), "PADRON_ARCA_CAIDO"],
    ["HTTP 504", errorRemoto("504", { status: 504 }), "PADRON_ARCA_CAIDO"],
    [
      "AfipTimeout",
      Object.assign(errorRemoto("timeout"), { name: "AfipTimeout" }),
      "PADRON_ARCA_CAIDO",
    ],
    [
      "falla de autorización",
      errorRemoto("unauthorized certificate for ws_sr_constancia_inscripcion"),
      "PADRON_NO_AUTORIZADO",
    ],
    [
      "HTTP 401",
      errorRemoto("estado sin texto de autorización", { status: 401 }),
      "PADRON_NO_AUTORIZADO",
    ],
    [
      "HTTP 403 anidado",
      errorRemoto("estado anidado sin texto de autorización", { response: { status: 403 } }),
      "PADRON_NO_AUTORIZADO",
    ],
    [
      "falla de autorización en español",
      errorRemoto("No autorizado para consultar"),
      "PADRON_NO_AUTORIZADO",
    ],
    ["falla PEM", errorRemoto("PEM routines private key"), "PADRON_CONFIG_INVALIDA"],
    ["falla de descifrado", errorRemoto("failed to decrypt certificate"), "PADRON_CONFIG_INVALIDA"],
    [
      "configuración de cifrado ausente",
      errorRemoto("ARCA_ENCRYPTION_KEY no configurada"),
      "PADRON_CONFIG_INVALIDA",
    ],
    ["falla remota desconocida", errorRemoto("unexpected payload"), "RESPUESTA_PADRON_INVALIDA"],
  ])("clasifica %s sin filtrar la causa remota", async (_caso, cause, codigo) => {
    const error = await errorDeConsulta(cause);

    expect(codigoErrorFiscalUsuario(error)).toBe(codigo);
    expect(error.message).not.toContain("SENSITIVE-SOAP-FAULT");
  });

  it("registra únicamente el evento cerrado cuando la consulta falla", async () => {
    const registrarEvento = vi.fn();
    const ahoraMs = vi.fn().mockReturnValueOnce(500).mockReturnValueOnce(550);
    clienteQueResponde(Promise.reject(errorRemoto("unexpected payload")));

    await expect(
      consultarPadronArcaDesdeContexto({
        cuit: "30-71419966-4",
        emisor,
        ambiente: "PRODUCCION",
        admin: {},
        registrarEvento,
        ahoraMs,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => codigoErrorFiscalUsuario(error) === "RESPUESTA_PADRON_INVALIDA",
    );

    const evento = registrarEvento.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(evento).toEqual({
      resultado: "ERROR",
      codigo: "RESPUESTA_PADRON_INVALIDA",
      etapa: "CONSULTA",
      servicio: "ws_sr_constancia_inscripcion",
      ambiente: "PRODUCCION",
      duracion_ms: 50,
    });
    expect(Object.keys(evento).sort()).toEqual(
      ["resultado", "codigo", "etapa", "servicio", "ambiente", "duracion_ms"].sort(),
    );
  });

  it("mantiene un error remoto malformado detrás del código público", async () => {
    let getterEjecutado = false;
    const causa = new Error();
    Object.defineProperty(causa, "message", {
      get() {
        getterEjecutado = true;
        throw new Error("SENSITIVE-SOAP-FAULT getter");
      },
    });

    const error = await errorDeConsulta(causa);

    expect(codigoErrorFiscalUsuario(error)).toBe("RESPUESTA_PADRON_INVALIDA");
    expect(getterEjecutado).toBe(false);
    expect(error.message).not.toContain("SENSITIVE-SOAP-FAULT");
  });

  it("no confía en un marcador fiscal enviado por un rechazo del SDK", async () => {
    const atacante = Object.assign(new Error("SENSITIVE-RAW-SOAP-MARKER"), {
      codigoFiscalUsuario: "PADRON_ARCA_CAIDO",
    });
    const registrarEvento = vi.fn();
    clienteQueResponde(Promise.reject(atacante));

    const error = await consultarPadronArcaDesdeContexto({
      cuit: "30-71419966-4",
      emisor,
      ambiente: "HOMOLOGACION",
      admin: {},
      registrarEvento,
    }).catch((cause) => cause);

    expect(codigoErrorFiscalUsuario(error)).toBe("RESPUESTA_PADRON_INVALIDA");
    expect(error).not.toBe(atacante);
    expect(error.message).not.toContain("SENSITIVE-RAW-SOAP-MARKER");
    expect(JSON.stringify(registrarEvento.mock.calls)).not.toContain("SENSITIVE-RAW-SOAP-MARKER");
  });

  it("encierra un proxy revocado en la raíz de la respuesta", async () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    clienteQueResponde(revocable.proxy);

    const error = await consultarPadronArcaDesdeContexto({
      cuit: "30-71419966-4",
      emisor,
      ambiente: "PRODUCCION",
      admin: {},
      registrarEvento: vi.fn(),
    }).catch((cause) => cause);

    expect(codigoErrorFiscalUsuario(error)).toBe("RESPUESTA_PADRON_INVALIDA");
    expect(error.message).not.toContain("revoked");
  });

  it("encierra un proxy fiscal anidado que arroja un marcador falsificado", async () => {
    const atacante = Object.assign(new Error("SENSITIVE-NESTED-DESCRIPTOR-PROXY"), {
      codigoFiscalUsuario: "CUIT_INACTIVO",
    });
    const respuesta = respuestaJuridica() as Record<string, unknown>;
    respuesta.datosRegimenGeneral = new Proxy(
      { impuesto: [{ idImpuesto: 30, estadoImpuesto: "AC" }] },
      {
        ownKeys() {
          throw atacante;
        },
      },
    );
    clienteQueResponde(respuesta);

    const error = await consultarPadronArcaDesdeContexto({
      cuit: "30-71419966-4",
      emisor,
      ambiente: "HOMOLOGACION",
      admin: {},
      registrarEvento: vi.fn(),
    }).catch((cause) => cause);

    expect(codigoErrorFiscalUsuario(error)).toBe("RESPUESTA_PADRON_INVALIDA");
    expect(error).not.toBe(atacante);
    expect(error.message).not.toContain("SENSITIVE-NESTED-DESCRIPTOR-PROXY");
  });

  it("rechaza un proxy de descriptores que cambia de estado entre snapshots", async () => {
    const atacante = Object.assign(new Error("SENSITIVE-STATEFUL-DESCRIPTOR-PROXY"), {
      codigoFiscalUsuario: "PADRON_NO_AUTORIZADO",
    });
    const respuesta = respuestaJuridica() as Record<string, unknown>;
    let lecturasClaves = 0;
    respuesta.datosRegimenGeneral = new Proxy(
      { impuesto: [{ idImpuesto: 30, estadoImpuesto: "AC" }] },
      {
        ownKeys(target) {
          lecturasClaves += 1;
          if (lecturasClaves > 1) throw atacante;
          return Reflect.ownKeys(target);
        },
      },
    );
    clienteQueResponde(respuesta);

    const error = await consultarPadronArcaDesdeContexto({
      cuit: "30-71419966-4",
      emisor,
      ambiente: "HOMOLOGACION",
      admin: {},
      registrarEvento: vi.fn(),
    }).catch((cause) => cause);

    expect(codigoErrorFiscalUsuario(error)).toBe("RESPUESTA_PADRON_INVALIDA");
    expect(error).not.toBe(atacante);
    expect(error.message).not.toContain("SENSITIVE-STATEFUL-DESCRIPTOR-PROXY");
  });
});
