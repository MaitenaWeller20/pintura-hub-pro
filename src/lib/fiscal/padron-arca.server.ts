import { types as tiposNode } from "node:util";
import { conTimeoutArca, crearClienteArca, type EmisorFiscal } from "./arca";
import { crearErrorFiscalUsuario } from "./error-usuario";
import {
  codigoErrorPadronArcaInterno,
  consultarPadronArcaInterno,
  esCodigoErrorPadronArca,
  type CodigoErrorPadronArca,
  type ReceptorPadronArca,
} from "./padron-arca";
import { entornoHabilitaMockFiscal, entornoMockFiscalDelProceso } from "./mock-scenario.server";

const SERVICIO_PADRON = "ws_sr_constancia_inscripcion" as const;
const INSTANTE_PADRON_MOCK = "2026-08-29T12:00:00.000Z";

type AmbienteArca = "HOMOLOGACION" | "PRODUCCION";

type EventoPadronArca = {
  resultado: "OK" | "ERROR";
  codigo?: CodigoErrorPadronArca;
  etapa: "CONSULTA";
  servicio: typeof SERVICIO_PADRON;
  ambiente: AmbienteArca;
  duracion_ms: number;
};

type EntradaConsultaPadronArca = {
  cuit: string;
  emisor: EmisorFiscal;
  ambiente: AmbienteArca;
  admin: unknown;
  registrarEvento?: (evento: EventoPadronArca) => void;
  ahoraMs?: () => number;
};

function contribuyenteMockLocal(cuit: string): unknown {
  const monotributo = cuit === "30621146315";
  return {
    idPersona: Number(cuit),
    tipoPersona: "JURIDICA",
    estadoClave: "ACTIVO",
    datosGenerales: {
      razonSocial: monotributo
        ? "T13-E2E OTRO RECEPTOR PADRÓN MOCK"
        : "T13-E2E RECEPTOR PADRÓN MOCK",
      domicilioFiscal: { direccion: "Domicilio fiscal mock local" },
    },
    ...(monotributo
      ? { datosMonotributo: { impuesto: [{ idImpuesto: 20, estadoImpuesto: "AC" }] } }
      : { datosRegimenGeneral: { impuesto: [{ idImpuesto: 30, estadoImpuesto: "AC" }] } }),
  };
}

function valorPropio(value: unknown, campo: string): unknown {
  if (typeof value !== "object" || value === null || tiposNode.isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, campo);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function estadoHttp(cause: unknown): number | null {
  const directo =
    valorPropio(cause, "status") ?? valorPropio(cause, "statusCode") ?? valorPropio(cause, "code");
  if (typeof directo === "number" && Number.isSafeInteger(directo)) return directo;
  const respuesta = valorPropio(cause, "response");
  const anidado =
    valorPropio(respuesta, "status") ??
    valorPropio(respuesta, "statusCode") ??
    valorPropio(respuesta, "code");
  return typeof anidado === "number" && Number.isSafeInteger(anidado) ? anidado : null;
}

function textoError(cause: unknown): string {
  const mensaje = valorPropio(cause, "message");
  return typeof mensaje === "string" ? mensaje : "";
}

const CODIGO_ERROR_TRANSPORTE_PADRON = Symbol("codigoErrorTransportePadron");

type ErrorTransportePadron = Error & {
  [CODIGO_ERROR_TRANSPORTE_PADRON]: CodigoErrorPadronArca;
};

function crearErrorTransportePadron(cause: unknown): ErrorTransportePadron {
  let codigo: CodigoErrorPadronArca = "RESPUESTA_PADRON_INVALIDA";
  try {
    codigo = clasificarErrorPadronArca(cause);
  } catch {
    // Una causa hostil no puede escapar de la clasificación cerrada.
  }
  const error = new Error("PADRON_ARCA_TRANSPORTE_INTERNO") as ErrorTransportePadron;
  Object.defineProperty(error, CODIGO_ERROR_TRANSPORTE_PADRON, {
    value: codigo,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return error;
}

function codigoErrorTransportePadron(cause: unknown): CodigoErrorPadronArca | null {
  if (typeof cause !== "object" || cause === null || tiposNode.isProxy(cause)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, CODIGO_ERROR_TRANSPORTE_PADRON);
    return descriptor && "value" in descriptor && esCodigoErrorPadronArca(descriptor.value)
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function clasificarErrorPadronArca(cause: unknown): CodigoErrorPadronArca {
  if (typeof cause === "object" && cause !== null && tiposNode.isProxy(cause)) {
    return "RESPUESTA_PADRON_INVALIDA";
  }
  const status = estadoHttp(cause);
  if ([502, 503, 504].includes(status ?? 0)) return "PADRON_ARCA_CAIDO";
  if ([401, 403].includes(status ?? 0)) return "PADRON_NO_AUTORIZADO";

  const nombre = valorPropio(cause, "name");
  const codigo = valorPropio(cause, "code");
  const detalle = textoError(cause);
  if (
    nombre === "AfipTimeout" ||
    nombre === "ArcaRespuestaIncierta" ||
    (typeof codigo === "string" &&
      [
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "ECONNRESET",
        "ENETUNREACH",
        "EPIPE",
      ].includes(codigo)) ||
    /AfipTimeout|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|ENETUNREACH|socket hang up|network error|getaddrinfo|\b50[234]\b|Service Unavailable|Gateway Time-?out|Bad Gateway|ECONNABORTED/i.test(
      detalle,
    )
  ) {
    return "PADRON_ARCA_CAIDO";
  }
  if (
    /not.?authori[sz]ed|unauthori[sz]ed|forbidden|access denied|no(?:\s+está)?\s+autorizad[oa]|certificad[oa].*(?:no.*autoriz|not.*authoriz)|ws_sr_constancia_inscripcion.*(?:no|not).*authoriz/i.test(
      detalle,
    )
  ) {
    return "PADRON_NO_AUTORIZADO";
  }
  if (
    /\bPEM\b|private key|clave privada|decrypt|descifr|ARCA_ENCRYPTION_KEY|no hay certificado|certificate.*(?:invalid|malformed|parse|decode)|key.*(?:invalid|malformed|parse|decode)|passphrase/i.test(
      detalle,
    )
  ) {
    return "PADRON_CONFIG_INVALIDA";
  }
  return "RESPUESTA_PADRON_INVALIDA";
}

function registrarEventoPorDefecto(evento: EventoPadronArca): void {
  console.info(evento);
}

function registrarSinFiltrar(
  registrarEvento: (evento: EventoPadronArca) => void,
  evento: EventoPadronArca,
): void {
  try {
    registrarEvento(evento);
  } catch {
    // El logging no debe reemplazar un resultado fiscal cerrado.
  }
}

function duracionMs(inicio: number, ahoraMs: () => number): number {
  return Math.max(0, ahoraMs() - inicio);
}

export async function consultarPadronArcaDesdeContexto({
  cuit,
  emisor,
  ambiente,
  admin,
  registrarEvento = registrarEventoPorDefecto,
  ahoraMs = Date.now,
}: EntradaConsultaPadronArca): Promise<ReceptorPadronArca> {
  const inicio = ahoraMs();
  try {
    const mockLocal = entornoHabilitaMockFiscal(entornoMockFiscalDelProceso());
    const resultado = await consultarPadronArcaInterno(cuit, {
      obtenerContribuyente: async (id) => {
        if (mockLocal) return contribuyenteMockLocal(String(id));
        try {
          const arca = await crearClienteArca(emisor, ambiente, admin);
          return await conTimeoutArca(
            arca.registerInscriptionProofService.getTaxpayerDetails(id),
            "consultar el padrón",
          );
        } catch (cause) {
          throw crearErrorTransportePadron(cause);
        }
      },
      ahora: () => (mockLocal ? new Date(INSTANTE_PADRON_MOCK) : new Date()),
    });
    registrarSinFiltrar(registrarEvento, {
      resultado: "OK",
      etapa: "CONSULTA",
      servicio: SERVICIO_PADRON,
      ambiente,
      duracion_ms: duracionMs(inicio, ahoraMs),
    });
    return resultado;
  } catch (cause) {
    const codigo =
      codigoErrorTransportePadron(cause) ??
      codigoErrorPadronArcaInterno(cause) ??
      "RESPUESTA_PADRON_INVALIDA";
    registrarSinFiltrar(registrarEvento, {
      resultado: "ERROR",
      codigo,
      etapa: "CONSULTA",
      servicio: SERVICIO_PADRON,
      ambiente,
      duracion_ms: duracionMs(inicio, ahoraMs),
    });
    throw crearErrorFiscalUsuario(codigo);
  }
}
