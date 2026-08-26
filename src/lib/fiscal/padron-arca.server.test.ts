import { beforeEach, describe, expect, it, vi } from "vitest";
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
    sdk.crearClienteArca.mockReset();
    sdk.conTimeoutArca.mockClear();
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
    const causa = new Error();
    Object.defineProperty(causa, "message", {
      get() {
        throw new Error("SENSITIVE-SOAP-FAULT getter");
      },
    });

    const error = await errorDeConsulta(causa);

    expect(codigoErrorFiscalUsuario(error)).toBe("RESPUESTA_PADRON_INVALIDA");
    expect(error.message).not.toContain("SENSITIVE-SOAP-FAULT");
  });
});
