import { conTimeoutArca, crearClienteArca, esErrorTransitorio, type EmisorFiscal } from "./arca";
import { codigoErrorFiscalUsuario, crearErrorFiscalUsuario } from "./error-usuario";
import {
  consultarPadronArca,
  esCodigoErrorPadronArca,
  type CodigoErrorPadronArca,
  type ReceptorPadronArca,
} from "./padron-arca";

const SERVICIO_PADRON = "ws_sr_constancia_inscripcion" as const;

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

function valorPropio(value: unknown, campo: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
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

function codigoMarcadoSeguro(cause: unknown) {
  try {
    return codigoErrorFiscalUsuario(cause);
  } catch {
    return null;
  }
}

function clasificarErrorPadronArca(cause: unknown): CodigoErrorPadronArca {
  try {
    if (esErrorTransitorio(cause)) return "PADRON_ARCA_CAIDO";
  } catch {
    // Un error remoto no confiable no puede impedir su traducción a un código cerrado.
  }
  if ([502, 503, 504].includes(estadoHttp(cause) ?? 0)) return "PADRON_ARCA_CAIDO";

  const detalle = textoError(cause);
  if (
    /not.?authori[sz]ed|unauthori[sz]ed|forbidden|access denied|certificad[oa].*(?:no.*autoriz|not.*authoriz)|ws_sr_constancia_inscripcion.*(?:no|not).*authoriz/i.test(
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
    const arca = await crearClienteArca(emisor, ambiente, admin);
    const resultado = await consultarPadronArca(cuit, {
      obtenerContribuyente: (id) =>
        conTimeoutArca(
          arca.registerInscriptionProofService.getTaxpayerDetails(id),
          "consultar el padrón",
        ),
      ahora: () => new Date(),
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
    const marcado = codigoMarcadoSeguro(cause);
    const codigo =
      marcado && esCodigoErrorPadronArca(marcado) ? marcado : clasificarErrorPadronArca(cause);
    registrarSinFiltrar(registrarEvento, {
      resultado: "ERROR",
      codigo,
      etapa: "CONSULTA",
      servicio: SERVICIO_PADRON,
      ambiente,
      duracion_ms: duracionMs(inicio, ahoraMs),
    });
    if (marcado && esCodigoErrorPadronArca(marcado)) throw cause;
    throw crearErrorFiscalUsuario(codigo);
  }
}
