import { decryptString } from "./crypto";
import { fmtFechaAfip, parseFechaAfip } from "./fecha";
import { TIPOS_C, CONCEPTO_PRODUCTOS } from "./codigos";
import { SupabaseTicketStorage } from "./ticket-storage";
import type { AlicuotaAfip } from "./iva";
import type { SnapshotFiscalV2 } from "./snapshot";
import {
  entornoHabilitaMockFiscal,
  entornoMockFiscalDelProceso,
  escenarioMockFiscalActual,
} from "./mock-scenario.server";

/**
 * Cliente de AFIP/ARCA (WSAA + WSFEv1) sobre @arcasdk/core.
 *
 * Sólo usamos tres llamadas, y a propósito NO usamos createNextVoucher (que
 * junta getLastVoucher + createVoucher): necesitamos meter la guarda
 * anti-duplicación EN EL MEDIO de las dos.
 */

// AFIP se cuelga. El timeout no cancela el SOAP de fondo —AFIP puede terminar
// autorizando igual—, pero evita que la función serverless muera esperando.
// Por eso existe consultarComprobante(): para recuperar el CAE de un comprobante
// que quedó en el limbo.
const TIMEOUT_MS = 25_000;

const entornoMockAlCargarArca = entornoMockFiscalDelProceso();
export const MOCK =
  typeof window === "undefined" && entornoHabilitaMockFiscal(entornoMockAlCargarArca);

export interface EmisorFiscal {
  cuit: string;
  arca_key_enc: string | null;
  arca_cert_enc: string | null;
}

export interface PuntoVenta {
  numero: number;
  modo: "HOMOLOGACION" | "PRODUCCION";
}

export interface DatosCae {
  cbteTipo: number;
  numero: number;
  fecha: Date;
  docTipo: number;
  docNro: number;
  neto: number;
  iva: number;
  /** Percepciones / otros tributos. Se declaran como ImpTrib. */
  tributos: number;
  total: number;
  condicionIvaReceptorId: number;
  alicuotas: AlicuotaAfip[];
  comprobantesAsociados?: Array<{ tipo: number; ptoVta: number; nro: number }>;
}

export interface RespuestaCae {
  cae: string;
  vencimiento: Date | null;
  modo: "HOMOLOGACION" | "PRODUCCION";
}

class AfipTimeout extends Error {
  override name = "AfipTimeout";
}

class ArcaRespuestaIncierta extends Error {
  override name = "ArcaRespuestaIncierta";
}

function aplicarEscenarioSolicitudMock(): void {
  const escenario = escenarioMockFiscalActual();
  if (escenario === "RECHAZO_DEFINITIVO") {
    throw new ArcaRechazoDefinitivo(
      "ARCA informó un rechazo fiscal definitivo en el escenario de prueba.",
      "MOCK_RECHAZO_DEFINITIVO",
    );
  }
  if (escenario === "TIMEOUT_POST_REQUEST") {
    throw new AfipTimeout(
      "El escenario de prueba simuló un timeout después de iniciar la solicitud fiscal.",
    );
  }
}

export class ArcaRechazoDefinitivo extends Error {
  override name = "ArcaRechazoDefinitivo";

  constructor(
    message: string,
    readonly codigo = "RECHAZO_ARCA",
  ) {
    super(message);
  }
}

type ClienteSupabaseTicketStorage = ConstructorParameters<typeof SupabaseTicketStorage>[0];

export type ClienteArcaSdk = InstanceType<(typeof import("@arcasdk/core"))["Arca"]>;

export function conTimeoutArca<T>(p: Promise<T>, etiqueta: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new AfipTimeout(`AFIP no respondió al ${etiqueta} (${TIMEOUT_MS / 1000}s).`)),
      TIMEOUT_MS,
    );
    p.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

/**
 * ¿El error es transitorio (AFIP caído / red) o de negocio (datos mal)?
 *
 * Los errores de certificado (vencido, no autorizado) NO son transitorios: por
 * más que reintentes no se arreglan solos, hay que renovar el certificado. Si los
 * metés acá, el sistema reintenta para siempre y nadie se entera de que el
 * certificado venció.
 */
export function esErrorTransitorio(e: unknown): boolean {
  const err = e as { name?: string; code?: string; message?: string };
  if (err?.name === "AfipTimeout" || err?.name === "ArcaRespuestaIncierta") return true;
  if (
    err?.code &&
    [
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNRESET",
      "ENETUNREACH",
      "EPIPE",
    ].includes(err.code)
  ) {
    return true;
  }
  return /AfipTimeout|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|ENETUNREACH|socket hang up|network error|getaddrinfo|\b50[234]\b|Service Unavailable|Gateway Time-?out|Bad Gateway|ECONNABORTED/i.test(
    String(err?.message ?? ""),
  );
}

export type ComprobanteArcaConsultado = {
  puntoVenta: number;
  cbteTipo: number;
  numero: number;
  cae: string;
  caeVencimiento: string | null;
  concepto: number;
  docTipo: number;
  docNro: string;
  condicionIvaReceptorId: number;
  fecha: string;
  total: string;
  neto: string;
  exento: string;
  noGravado: string;
  iva: string;
  tributosTotal: string;
  moneda: string;
  cotizacion: string;
  alicuotas: Array<{ id: number; base: string; importe: string }>;
  tributos: Array<{
    id: number;
    descripcion: string;
    base: string;
    alicuota: string;
    importe: string;
  }>;
  asociados: Array<{
    tipo: number;
    puntoVenta: number;
    numero: number;
    cuit: string;
    fecha: string | null;
  }>;
};

function fechaArca(value: unknown, campo: string, nullable = false): string | null {
  if (nullable && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string") throw new Error(`ARCA omitió o devolvió inválido ${campo}.`);
  const compacta = /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(compacta) || compacta.startsWith("0000-"))
    throw new Error(`ARCA devolvió inválido ${campo}.`);
  const parsed = new Date(`${compacta}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== compacta) {
    throw new Error(`ARCA devolvió inválido ${campo}.`);
  }
  return compacta;
}

function enteroArca(value: unknown, campo: string): number {
  if (value === "" || value === null || value === undefined)
    throw new Error(`ARCA omitió ${campo}.`);
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)) return value;
    throw new Error(`ARCA devolvió inválido ${campo}.`);
  }
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error(`ARCA devolvió inválido ${campo}.`);
  const exacto = BigInt(value);
  if (exacto > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`ARCA devolvió inválido ${campo}.`);
  return Number(exacto);
}

function decimalArca(value: unknown, campo: string, posiciones: 2 | 6): string {
  if (value === "" || value === null || value === undefined)
    throw new Error(`ARCA omitió ${campo}.`);
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error(`ARCA devolvió inválido ${campo}.`);
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0 || Object.is(value, -0)))
    throw new Error(`ARCA devolvió inválido ${campo}.`);
  const texto = String(value);
  const coincidencia = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(texto);
  if (!coincidencia) throw new Error(`ARCA devolvió inválido ${campo}.`);
  const enteros = coincidencia[1];
  const decimales = coincidencia[2] ?? "";
  const excedente = decimales.slice(posiciones);
  if (/[^0]/.test(excedente)) throw new Error(`ARCA devolvió inválido ${campo}.`);
  const fraccion = decimales.slice(0, posiciones).padEnd(posiciones, "0");
  const escalado = BigInt(`${enteros}${fraccion}`);
  if (escalado > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`ARCA devolvió inválido ${campo}.`);
  return `${enteros}.${fraccion}`;
}

function textoArca(value: unknown, campo: string, permiteVacio = false): string {
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error(`ARCA omitió ${campo}.`);
  const texto = String(value).trim();
  if (!permiteVacio && texto === "") throw new Error(`ARCA devolvió vacío ${campo}.`);
  return texto;
}

function comoArray(value: unknown, campo: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [value];
  if (Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error(`ARCA devolvió un array con prototipo inválido en ${campo}.`);
  const claves = Reflect.ownKeys(value);
  if (
    claves.some(
      (clave) => typeof clave !== "string" || (clave !== "length" && !/^(0|[1-9]\d*)$/.test(clave)),
    )
  )
    throw new Error(`ARCA devolvió un array inválido en ${campo}.`);
  const descriptorLongitud = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !descriptorLongitud ||
    !("value" in descriptorLongitud) ||
    !Number.isSafeInteger(descriptorLongitud.value) ||
    descriptorLongitud.value < 0 ||
    claves.length !== descriptorLongitud.value + 1
  )
    throw new Error(`ARCA devolvió un array inválido en ${campo}.`);
  for (let index = 0; index < descriptorLongitud.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set)
      throw new Error(`ARCA devolvió un array sin datos propios en ${campo}.`);
  }
  return value;
}

function registro(value: unknown, campo: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`ARCA devolvió inválido ${campo}.`);
  const prototipo = Object.getPrototypeOf(value);
  if (prototipo !== Object.prototype && prototipo !== null)
    throw new Error(`ARCA devolvió inválido ${campo}.`);
  for (const clave of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, clave);
    if (typeof clave !== "string" || !descriptor || !("value" in descriptor))
      throw new Error(`ARCA devolvió un registro sin datos propios en ${campo}.`);
  }
  return value as Record<string, unknown>;
}

function tieneDatoPropio(value: Record<string, unknown>, clave: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, clave);
  return Boolean(descriptor && "value" in descriptor);
}

function codigoErrorArca(value: unknown, campo: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  )
    throw new Error(`ARCA devolvió inválido ${campo}.`);
  return value;
}

function errorLanzadoEsAusencia602(value: unknown): boolean {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "code");
  return Boolean(
    descriptor &&
    "value" in descriptor &&
    typeof descriptor.value === "number" &&
    Number.isSafeInteger(descriptor.value) &&
    descriptor.value === 602,
  );
}

function caeArca(value: unknown): string {
  if (typeof value !== "string" || !/^\d{14}$/.test(value))
    throw new Error("ARCA devolvió inválido CodAutorizacion.");
  return value;
}

function codigosColeccion(contenedorRaw: unknown, clave: string, campo: string): number[] {
  const contenedor = registro(contenedorRaw, campo);
  if (!tieneDatoPropio(contenedor, clave)) return [];
  const coleccion = contenedor[clave];
  if (coleccion === null || coleccion === undefined) {
    throw new Error(`ARCA devolvió inválido ${campo}.${clave}.`);
  }
  return comoArray(coleccion, `${campo}.${clave}`).map((raw, index) => {
    const fila = registro(raw, `${campo}.${clave}[${index}]`);
    return codigoErrorArca(fila.Code, `${campo}.${clave}[${index}].Code`);
  });
}

function codigosRespuestaSolicitud(response: Record<string, unknown>): number[] {
  const codigos: number[] = [];
  if (tieneDatoPropio(response, "Errors")) {
    codigos.push(...codigosColeccion(response.Errors, "Err", "Errors"));
  }
  if (tieneDatoPropio(response, "FeDetResp")) {
    const detalleContenedor = registro(response.FeDetResp, "FeDetResp");
    if (tieneDatoPropio(detalleContenedor, "FECAEDetResponse")) {
      const detalles = comoArray(detalleContenedor.FECAEDetResponse, "FeDetResp.FECAEDetResponse");
      for (const [index, raw] of detalles.entries()) {
        const detalle = registro(raw, `FeDetResp.FECAEDetResponse[${index}]`);
        if (!tieneDatoPropio(detalle, "Observaciones")) continue;
        const observaciones = registro(
          detalle.Observaciones,
          `FeDetResp.FECAEDetResponse[${index}].Observaciones`,
        );
        codigos.push(
          ...codigosColeccion(
            observaciones,
            "Obs",
            `FeDetResp.FECAEDetResponse[${index}].Observaciones`,
          ),
        );
      }
    }
  }
  return [...new Set(codigos)].sort((a, b) => a - b);
}

function mensajeRechazoSeguro(codigos: number[]): string {
  return codigos.length > 0
    ? `ARCA informó un rechazo fiscal (códigos: ${codigos.join(", ")}).`
    : "ARCA informó un rechazo fiscal. Revisá los datos fiscales antes de reintentar.";
}

type ResultadoSolicitudCaeClasificado =
  | { resultado: "APROBADA"; cae: string; vencimiento: Date }
  | { resultado: "RECHAZADA"; codigo: string; mensaje: string };

type IdentidadDetalleSolicitudCae = {
  concepto: number;
  docTipo: number;
  docNro: number;
  fechaComprobante: string;
};

function identidadDetalleDesdePayload(
  payload: Record<string, unknown>,
): IdentidadDetalleSolicitudCae {
  const fechaComprobante = fechaArca(payload.CbteFch, "CbteFch");
  if (fechaComprobante === null) throw new Error("El payload CAE omitió CbteFch.");
  return {
    concepto: enteroArca(payload.Concepto, "Concepto"),
    docTipo: enteroArca(payload.DocTipo, "DocTipo"),
    docNro: enteroArca(payload.DocNro, "DocNro"),
    fechaComprobante,
  };
}

function clasificarSolicitudCae(
  raw: unknown,
  esperado: {
    emisorCuit: string;
    puntoVenta: number;
    cbteTipo: number;
    numero: number;
  } & IdentidadDetalleSolicitudCae,
): ResultadoSolicitudCaeClasificado {
  try {
    const salidaSdk = registro(raw, "CreateVoucherResult");
    const response = registro(salidaSdk.response, "FECAESolicitarResult");
    const errores = tieneDatoPropio(response, "Errors")
      ? codigosColeccion(response.Errors, "Err", "Errors")
      : [];
    if (errores.length > 0) {
      throw new ArcaRespuestaIncierta(
        "ARCA devolvió errores estructurados junto con un resultado de emisión.",
      );
    }

    const cabecera = registro(response.FeCabResp, "FeCabResp");
    const emisorEsperado = enteroArca(esperado.emisorCuit.replace(/\D/g, ""), "emisorCuit");
    if (
      enteroArca(cabecera.Cuit, "FeCabResp.Cuit") !== emisorEsperado ||
      enteroArca(cabecera.PtoVta, "FeCabResp.PtoVta") !== esperado.puntoVenta ||
      enteroArca(cabecera.CbteTipo, "FeCabResp.CbteTipo") !== esperado.cbteTipo ||
      enteroArca(cabecera.CantReg, "FeCabResp.CantReg") !== 1
    ) {
      throw new ArcaRespuestaIncierta("ARCA devolvió una cabecera con identidad distinta.");
    }

    const detalleContenedor = registro(response.FeDetResp, "FeDetResp");
    const detalles = comoArray(detalleContenedor.FECAEDetResponse, "FeDetResp.FECAEDetResponse");
    if (detalles.length !== 1) {
      throw new ArcaRespuestaIncierta("ARCA no devolvió exactamente un detalle de emisión.");
    }
    const detalle = registro(detalles[0], "FeDetResp.FECAEDetResponse[0]");
    if (
      enteroArca(detalle.Concepto, "FECAEDetResponse.Concepto") !== esperado.concepto ||
      enteroArca(detalle.DocTipo, "FECAEDetResponse.DocTipo") !== esperado.docTipo ||
      enteroArca(detalle.DocNro, "FECAEDetResponse.DocNro") !== esperado.docNro ||
      enteroArca(detalle.CbteDesde, "FECAEDetResponse.CbteDesde") !== esperado.numero ||
      enteroArca(detalle.CbteHasta, "FECAEDetResponse.CbteHasta") !== esperado.numero ||
      fechaArca(detalle.CbteFch, "FECAEDetResponse.CbteFch") !== esperado.fechaComprobante
    ) {
      throw new ArcaRespuestaIncierta("ARCA devolvió un detalle con identidad distinta.");
    }

    const resultadoCabecera = cabecera.Resultado;
    const resultadoDetalle = detalle.Resultado;
    if (
      (resultadoCabecera !== "A" && resultadoCabecera !== "R") ||
      resultadoDetalle !== resultadoCabecera
    ) {
      throw new ArcaRespuestaIncierta("ARCA devolvió resultados ausentes o contradictorios.");
    }

    if (resultadoDetalle === "A") {
      const cae = caeArca(detalle.CAE);
      const fechaRaw = detalle.CAEFchVto;
      const vencimiento = typeof fechaRaw === "string" ? parseFechaAfip(fechaRaw) : null;
      if (vencimiento === null || salidaSdk.cae !== cae || salidaSdk.caeFchVto !== fechaRaw) {
        throw new ArcaRespuestaIncierta("ARCA devolvió una aprobación inconsistente.");
      }
      return { resultado: "APROBADA", cae, vencimiento };
    }

    if (
      detalle.CAE !== "" ||
      (detalle.CAEFchVto !== undefined && detalle.CAEFchVto !== null && detalle.CAEFchVto !== "") ||
      salidaSdk.cae !== "" ||
      salidaSdk.caeFchVto !== ""
    ) {
      throw new ArcaRespuestaIncierta("ARCA devolvió un rechazo contradictorio.");
    }
    const codigos = codigosRespuestaSolicitud(response);
    return {
      resultado: "RECHAZADA",
      codigo: codigos[0]?.toString() ?? "RECHAZO_ARCA",
      mensaje: mensajeRechazoSeguro(codigos),
    };
  } catch (error) {
    if (error instanceof ArcaRespuestaIncierta) throw error;
    throw new ArcaRespuestaIncierta("ARCA devolvió una respuesta de emisión no comparable.");
  }
}

/** Construye el detalle FECAEDetRequest exclusivamente desde el snapshot fiscal congelado. */
export function crearPayloadCaeDesdeSnapshot(snapshot: SnapshotFiscalV2): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    CantReg: 1,
    PtoVta: snapshot.identidad.puntoVenta,
    CbteTipo: snapshot.identidad.cbteTipo,
    Concepto: snapshot.concepto,
    DocTipo: snapshot.receptor.docTipoArca,
    DocNro: Number(snapshot.receptor.docNroArca),
    CbteDesde: snapshot.identidad.numero,
    CbteHasta: snapshot.identidad.numero,
    CbteFch: snapshot.fechaComprobante.replaceAll("-", ""),
    ImpTotal: Number(snapshot.importeTotal),
    ImpTotConc: Number(snapshot.importeNoGravado),
    ImpNeto: Number(snapshot.importeNeto),
    ImpOpEx: Number(snapshot.importeExento),
    ImpIVA: Number(snapshot.importeIva),
    ImpTrib: Number(snapshot.importeTributos),
    MonId: snapshot.moneda,
    MonCotiz: Number(snapshot.cotizacion),
    CondicionIVAReceptorId: snapshot.receptor.condicionIvaReceptorId,
  };
  if (snapshot.alicuotasIva.length > 0)
    payload.Iva = snapshot.alicuotasIva.map((row) => ({
      Id: row.id,
      BaseImp: Number(row.baseImponible),
      Importe: Number(row.importe),
    }));
  if (snapshot.tributos.length > 0)
    payload.Tributos = snapshot.tributos.map((row) => ({
      Id: row.id,
      Desc: row.descripcion,
      BaseImp: Number(row.baseImponible),
      Alic: Number(row.alicuota),
      Importe: Number(row.importe),
    }));
  if (snapshot.cbtesAsoc.length > 0)
    payload.CbtesAsoc = snapshot.cbtesAsoc.map((row) => ({
      Tipo: row.tipo,
      PtoVta: row.puntoVenta,
      Nro: row.numero,
      Cuit: row.cuit,
      CbteFch: row.fecha.replaceAll("-", ""),
    }));
  return payload;
}

/** Convierte ResultGet completo a la representación canónica usada al conciliar. */
export function normalizarComprobanteArca(resultGet: unknown): ComprobanteArcaConsultado {
  const result = registro(resultGet, "ResultGet");
  if (result.Resultado !== "A") throw new Error("ARCA devolvió inválido ResultGet.Resultado.");
  const cae = caeArca(result.CodAutorizacion);
  const desde = enteroArca(result.CbteDesde, "CbteDesde");
  const hasta = enteroArca(result.CbteHasta, "CbteHasta");
  if (desde !== hasta) throw new Error("ARCA devolvió CbteDesde y CbteHasta distintos.");
  const alicuotas = comoArray(registro(result.Iva ?? {}, "Iva").AlicIva, "Iva.AlicIva").map(
    (raw) => {
      const row = registro(raw, "Iva.AlicIva");
      return {
        id: enteroArca(row.Id, "Iva.AlicIva.Id"),
        base: decimalArca(row.BaseImp, "Iva.AlicIva.BaseImp", 2),
        importe: decimalArca(row.Importe, "Iva.AlicIva.Importe", 2),
      };
    },
  );
  const tributos = comoArray(
    registro(result.Tributos ?? {}, "Tributos").Tributo,
    "Tributos.Tributo",
  ).map((raw) => {
    const row = registro(raw, "Tributos.Tributo");
    return {
      id: enteroArca(row.Id, "Tributos.Tributo.Id"),
      descripcion: textoArca(row.Desc, "Tributos.Tributo.Desc"),
      base: decimalArca(row.BaseImp, "Tributos.Tributo.BaseImp", 2),
      alicuota: decimalArca(row.Alic, "Tributos.Tributo.Alic", 2),
      importe: decimalArca(row.Importe, "Tributos.Tributo.Importe", 2),
    };
  });
  const asociados = comoArray(
    registro(result.CbtesAsoc ?? {}, "CbtesAsoc").CbteAsoc,
    "CbtesAsoc.CbteAsoc",
  ).map((raw) => {
    const row = registro(raw, "CbtesAsoc.CbteAsoc");
    return {
      tipo: enteroArca(row.Tipo, "CbtesAsoc.CbteAsoc.Tipo"),
      puntoVenta: enteroArca(row.PtoVta, "CbtesAsoc.CbteAsoc.PtoVta"),
      numero: enteroArca(row.Nro, "CbtesAsoc.CbteAsoc.Nro"),
      cuit: textoArca(row.Cuit, "CbtesAsoc.CbteAsoc.Cuit"),
      fecha: fechaArca(row.CbteFch, "CbtesAsoc.CbteAsoc.CbteFch", true),
    };
  });
  alicuotas.sort(
    (a, b) => a.id - b.id || a.base.localeCompare(b.base) || a.importe.localeCompare(b.importe),
  );
  tributos.sort(
    (a, b) =>
      a.id - b.id ||
      a.descripcion.localeCompare(b.descripcion) ||
      a.base.localeCompare(b.base) ||
      a.alicuota.localeCompare(b.alicuota) ||
      a.importe.localeCompare(b.importe),
  );
  asociados.sort(
    (a, b) =>
      a.tipo - b.tipo ||
      a.puntoVenta - b.puntoVenta ||
      a.numero - b.numero ||
      a.cuit.localeCompare(b.cuit) ||
      (a.fecha ?? "").localeCompare(b.fecha ?? ""),
  );
  return {
    puntoVenta: enteroArca(result.PtoVta, "PtoVta"),
    cbteTipo: enteroArca(result.CbteTipo, "CbteTipo"),
    numero: desde,
    cae,
    caeVencimiento: fechaArca(result.FchVto, "FchVto", true),
    concepto: enteroArca(result.Concepto, "Concepto"),
    docTipo: enteroArca(result.DocTipo, "DocTipo"),
    docNro: textoArca(result.DocNro, "DocNro"),
    condicionIvaReceptorId: enteroArca(result.CondicionIVAReceptorId, "CondicionIVAReceptorId"),
    fecha: fechaArca(result.CbteFch, "CbteFch")!,
    total: decimalArca(result.ImpTotal, "ImpTotal", 2),
    neto: decimalArca(result.ImpNeto, "ImpNeto", 2),
    exento: decimalArca(result.ImpOpEx, "ImpOpEx", 2),
    noGravado: decimalArca(result.ImpTotConc, "ImpTotConc", 2),
    iva: decimalArca(result.ImpIVA, "ImpIVA", 2),
    tributosTotal: decimalArca(result.ImpTrib, "ImpTrib", 2),
    moneda: textoArca(result.MonId, "MonId"),
    cotizacion: decimalArca(result.MonCotiz, "MonCotiz", 6),
    alicuotas,
    tributos,
    asociados,
  };
}

/**
 * Construye el cliente del SDK con el certificado descifrado.
 *
 * El import es dinámico a propósito: @arcasdk/core arrastra `soap` -> `fs`,
 * `https`, `xml2js`. Con un import estático, el bundler mete todo ese árbol en
 * cualquier módulo que toque este archivo. Así se carga sólo cuando de verdad
 * hay que pedir un CAE.
 */
export async function crearClienteArca(
  emisor: EmisorFiscal,
  ambiente: PuntoVenta["modo"],
  supabaseAdmin: unknown,
): Promise<ClienteArcaSdk> {
  const cert = decryptString(emisor.arca_cert_enc);
  const key = decryptString(emisor.arca_key_enc);
  if (!cert || !key) {
    throw new Error("No hay certificado de AFIP cargado. Completá la configuración fiscal.");
  }

  const { Arca } = await import("@arcasdk/core");
  const cuit = Number(emisor.cuit.replace(/\D/g, ""));
  const production = ambiente === "PRODUCCION";

  return new Arca({
    cuit,
    cert,
    key,
    production,
    // Nitro empaqueta el SDK CommonJS como ESM. Su valor por defecto intenta
    // resolver `__dirname` (inexistente en ESM) incluso con storage propio.
    // Esta ruta corta esa rama; no se usa porque ticketStorage está definido.
    ticketPath: "/tmp/quimex-arca-tickets",
    // Sin esto el SDK escribe el ticket en el bundle read-only de Vercel y se
    // cae la facturación entera. Ver ticket-storage.ts.
    ticketStorage: new SupabaseTicketStorage(
      supabaseAdmin as ClienteSupabaseTicketStorage,
      cuit,
      production,
    ),
    // Los servidores de AFIP usan TLS legacy: sin el agente de Node falla el
    // handshake. Requiere runtime Node (no edge).
    useHttpsAgent: true,
  });
}

/** Último comprobante autorizado por AFIP para (punto de venta, tipo). 0 si nunca emitió. */
export async function ultimoAutorizado(
  emisor: EmisorFiscal,
  pv: PuntoVenta,
  cbteTipo: number,
  supabaseAdmin: unknown,
): Promise<number> {
  if (MOCK) return 0;
  const arca = await crearClienteArca(emisor, pv.modo, supabaseAdmin);
  const r = await conTimeoutArca(
    arca.electronicBillingService.getLastVoucher(pv.numero, cbteTipo),
    "consultar el último comprobante",
  );
  return Number((r as { cbteNro?: number }).cbteNro ?? 0);
}

/**
 * Consulta un comprobante puntual en AFIP (FECompConsultar).
 *
 * Es la primitiva de RECUPERACIÓN: si createVoucher se fue por timeout, AFIP
 * pudo haberlo autorizado igual. Antes de reintentar hay que preguntar.
 *
 * Devuelve null SÓLO si AFIP dice explícitamente que el comprobante no existe
 * (error 602). Cualquier otro error se propaga: asumir "está libre" ante un
 * error de red es exactamente cómo se duplica un comprobante fiscal.
 */
export async function consultarComprobante(
  emisor: EmisorFiscal,
  pv: PuntoVenta,
  cbteTipo: number,
  numero: number,
  supabaseAdmin: unknown,
): Promise<{ cae: string; vencimiento: Date | null } | null> {
  const comprobante = await consultarComprobanteCompleto(
    emisor,
    pv,
    cbteTipo,
    numero,
    supabaseAdmin,
  );
  if (!comprobante) return null;
  return {
    cae: comprobante.cae,
    vencimiento: parseFechaAfip(comprobante.caeVencimiento?.replaceAll("-", "")),
  };
}

export async function consultarComprobanteCompleto(
  emisor: EmisorFiscal,
  pv: PuntoVenta,
  cbteTipo: number,
  numero: number,
  supabaseAdmin: unknown,
): Promise<ComprobanteArcaConsultado | null> {
  if (MOCK) return null;
  const arca = await crearClienteArca(emisor, pv.modo, supabaseAdmin);
  let raw: unknown;
  try {
    raw = await conTimeoutArca(
      arca.genericService.call("wsfe", "FECompConsultar", {
        FeCompConsReq: { CbteNro: numero, PtoVta: pv.numero, CbteTipo: cbteTipo },
      }),
      "consultar el comprobante",
    );
  } catch (e) {
    if (errorLanzadoEsAusencia602(e)) return null;
    throw e;
  }

  const envelope = registro(raw, "FECompConsultarResponse");
  const response = registro(envelope.FECompConsultarResult, "FECompConsultarResult");
  const errores = tieneDatoPropio(response, "Errors")
    ? (() => {
        const contenedor = registro(response.Errors, "Errors");
        if (!tieneDatoPropio(contenedor, "Err")) return [];
        if (contenedor.Err === null || contenedor.Err === undefined)
          throw new Error("ARCA devolvió inválido Errors.Err.");
        return comoArray(contenedor.Err, "Errors.Err").map((rawError) => {
          const error = registro(rawError, "Errors.Err");
          return codigoErrorArca(error.Code, "Errors.Err.Code");
        });
      })()
    : [];

  if (!tieneDatoPropio(response, "ResultGet")) {
    if (errores.length === 1 && errores[0] === 602) return null;
    throw new ArcaRespuestaIncierta("ARCA no devolvió un comprobante comparable.");
  }

  const result = registro(response.ResultGet, "ResultGet");
  if (errores.length > 0)
    throw new ArcaRespuestaIncierta(
      "ARCA devolvió un comprobante junto con errores estructurados.",
    );
  if (result.Resultado === "R" && result.CodAutorizacion === "")
    throw new ArcaRechazoDefinitivo("ARCA informó un rechazo definitivo para el comprobante.");
  if (result.Resultado !== "A")
    throw new ArcaRespuestaIncierta("ARCA devolvió un resultado no concluyente.");
  if (typeof result.CodAutorizacion !== "string" || !/^\d{14}$/.test(result.CodAutorizacion))
    throw new ArcaRespuestaIncierta("ARCA devolvió una aprobación sin autorización válida.");
  return normalizarComprobanteArca(result);
}

/** Pide el CAE a AFIP (FECAESolicitar). */
export async function solicitarCae(
  emisor: EmisorFiscal,
  pv: PuntoVenta,
  d: DatosCae,
  supabaseAdmin: unknown,
): Promise<RespuestaCae> {
  if (MOCK) {
    aplicarEscenarioSolicitudMock();
    // CAE simulado, determinístico, de 14 dígitos. Permite operar y demostrar el
    // flujo completo mientras el trámite del certificado con AFIP está en curso.
    // NO tiene validez legal.
    const semilla = `${emisor.cuit}${pv.numero}${d.cbteTipo}${d.numero}`;
    let h = 0;
    for (const c of semilla) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const cae = String(h).padStart(14, "7").slice(0, 14);
    const venc = new Date();
    venc.setDate(venc.getDate() + 10);
    return { cae, vencimiento: venc, modo: pv.modo };
  }

  const arca = await crearClienteArca(emisor, pv.modo, supabaseAdmin);
  const esC = TIPOS_C.has(d.cbteTipo);
  const tributos = Math.abs(d.tributos ?? 0);

  const payload: Record<string, unknown> = {
    CantReg: 1,
    PtoVta: pv.numero,
    CbteTipo: d.cbteTipo,
    Concepto: CONCEPTO_PRODUCTOS,
    DocTipo: d.docTipo,
    DocNro: d.docNro,
    CbteDesde: d.numero,
    CbteHasta: d.numero,
    CbteFch: fmtFechaAfip(d.fecha),
    ImpTotal: d.total,
    ImpTotConc: 0,
    // Clase C: no se discrimina IVA. AFIP exige ImpNeto == ImpTotal, ImpIVA == 0,
    // y RECHAZA el comprobante si le mandás el array Iva.
    ImpNeto: esC ? d.total - tributos : d.neto,
    ImpOpEx: 0,
    ImpIVA: esC ? 0 : d.iva,
    // AFIP valida ImpTotal == ImpNeto + ImpIVA + ImpTrib + ImpOpEx + ImpTotConc.
    // Las percepciones tienen que ir en ImpTrib con su array Tributos, o el
    // comprobante se rechaza (error 10048).
    ImpTrib: tributos,
    MonId: "PES",
    MonCotiz: 1,
    // Obligatorio desde 2025 (RG 5616).
    CondicionIVAReceptorId: d.condicionIvaReceptorId,
    ...(esC ? {} : { Iva: d.alicuotas }),
    // Id 99 = "Otros tributos" (percepciones/impuestos varios).
    ...(tributos > 0
      ? {
          Tributos: [
            {
              Id: 99,
              Desc: "Percepciones",
              BaseImp: esC ? d.total - tributos : d.neto,
              Alic: 0,
              Importe: tributos,
            },
          ],
        }
      : {}),
  };

  if (d.comprobantesAsociados?.length) {
    payload.CbtesAsoc = d.comprobantesAsociados.map((c) => ({
      Tipo: c.tipo,
      PtoVta: c.ptoVta,
      Nro: c.nro,
    }));
  }

  const identidadDetalle = identidadDetalleDesdePayload(payload);
  const result = await conTimeoutArca(
    arca.electronicBillingService.createVoucher(payload as never),
    "solicitar el CAE",
  );

  const clasificada = clasificarSolicitudCae(result, {
    emisorCuit: emisor.cuit,
    puntoVenta: pv.numero,
    cbteTipo: d.cbteTipo,
    numero: d.numero,
    ...identidadDetalle,
  });
  if (clasificada.resultado === "RECHAZADA") {
    throw new ArcaRechazoDefinitivo(clasificada.mensaje, clasificada.codigo);
  }
  return { cae: clasificada.cae, vencimiento: clasificada.vencimiento, modo: pv.modo };
}

/**
 * Writer v2: el único detalle enviado es el que Task 8 tradujo desde el
 * Snapshot persistido. A diferencia del adaptador legacy, no reconstruye
 * importes, tributos ni asociaciones.
 */
export async function solicitarCaeConPayload(
  emisor: EmisorFiscal,
  pv: PuntoVenta,
  payload: Record<string, unknown>,
  numero: number,
  supabaseAdmin: unknown,
): Promise<RespuestaCae> {
  if (MOCK) {
    aplicarEscenarioSolicitudMock();
    const semilla = `${emisor.cuit}${pv.numero}${String(payload.CbteTipo)}${numero}`;
    let hash = 0;
    for (const caracter of semilla) hash = (hash * 31 + caracter.charCodeAt(0)) >>> 0;
    const cae = String(hash).padStart(14, "7").slice(0, 14);
    const vencimiento = new Date();
    vencimiento.setUTCDate(vencimiento.getUTCDate() + 10);
    return { cae, vencimiento, modo: pv.modo };
  }

  const identidadDetalle = identidadDetalleDesdePayload(payload);
  const arca = await crearClienteArca(emisor, pv.modo, supabaseAdmin);
  const result = await conTimeoutArca(
    arca.electronicBillingService.createVoucher(payload as never),
    "solicitar el CAE",
  );
  const cbteTipo = enteroArca(payload.CbteTipo, "CbteTipo");
  const respuesta = clasificarSolicitudCae(result, {
    emisorCuit: emisor.cuit,
    puntoVenta: pv.numero,
    cbteTipo,
    numero,
    ...identidadDetalle,
  });
  if (respuesta.resultado === "RECHAZADA") {
    throw new ArcaRechazoDefinitivo(respuesta.mensaje, respuesta.codigo);
  }
  return {
    cae: respuesta.cae,
    vencimiento: respuesta.vencimiento,
    modo: pv.modo,
  };
}

/**
 * Arma el motivo legible del rechazo de AFIP desde la respuesta cruda de
 * FECAESolicitar. Junta los errores de nivel request (`Errors.Err[]`) y las
 * observaciones por comprobante (`FeDetResp.FECAEDetResponse[].Observaciones.Obs[]`),
 * Sólo conserva códigos numéricos validados. `Msg` es contenido no confiable y
 * puede incluir documentos, importes o secretos: nunca se concatena ni persiste.
 */
export function detalleRechazoAfip(response: unknown): string {
  try {
    const registroRespuesta = registro(response, "FECAESolicitarResult");
    const codigos = codigosRespuestaSolicitud(registroRespuesta);
    return codigos.length > 0 ? mensajeRechazoSeguro(codigos) : "";
  } catch {
    return "";
  }
}
