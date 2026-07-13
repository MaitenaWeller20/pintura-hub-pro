import { decryptString } from "./crypto";
import { fmtFechaAfip, parseFechaAfip } from "./fecha";
import { TIPOS_C, CONCEPTO_PRODUCTOS } from "./codigos";
import { SupabaseTicketStorage } from "./ticket-storage";
import type { AlicuotaAfip } from "./iva";

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

export const MOCK = process.env.INVOICING_MOCK_MODE === "true";

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

function conTimeout<T>(p: Promise<T>, etiqueta: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new AfipTimeout(`AFIP no respondió al ${etiqueta} (${TIMEOUT_MS / 1000}s).`)),
        TIMEOUT_MS,
      ),
    ),
  ]);
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
  if (err?.name === "AfipTimeout") return true;
  if (
    err?.code &&
    ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ENETUNREACH", "EPIPE"].includes(
      err.code,
    )
  ) {
    return true;
  }
  return /AfipTimeout|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|ENETUNREACH|socket hang up|network error|getaddrinfo|\b50[234]\b|Service Unavailable|Gateway Time-?out|Bad Gateway|ECONNABORTED/i.test(
    String(err?.message ?? ""),
  );
}

/**
 * Construye el cliente del SDK con el certificado descifrado.
 *
 * El import es dinámico a propósito: @arcasdk/core arrastra `soap` -> `fs`,
 * `https`, `xml2js`. Con un import estático, el bundler mete todo ese árbol en
 * cualquier módulo que toque este archivo. Así se carga sólo cuando de verdad
 * hay que pedir un CAE.
 */
async function buildArca(emisor: EmisorFiscal, pv: PuntoVenta, supabaseAdmin: any) {
  const cert = decryptString(emisor.arca_cert_enc);
  const key = decryptString(emisor.arca_key_enc);
  if (!cert || !key) {
    throw new Error("No hay certificado de AFIP cargado. Completá la configuración fiscal.");
  }

  const { Arca } = await import("@arcasdk/core");
  const cuit = Number(emisor.cuit.replace(/\D/g, ""));
  const production = pv.modo === "PRODUCCION";

  return new Arca({
    cuit,
    cert,
    key,
    production,
    // Sin esto el SDK escribe el ticket en el bundle read-only de Vercel y se
    // cae la facturación entera. Ver ticket-storage.ts.
    ticketStorage: new SupabaseTicketStorage(supabaseAdmin, cuit, production) as any,
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
  supabaseAdmin: any,
): Promise<number> {
  if (MOCK) return 0;
  const arca = await buildArca(emisor, pv, supabaseAdmin);
  const r = await conTimeout(
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
  supabaseAdmin: any,
): Promise<{ cae: string; vencimiento: Date | null } | null> {
  if (MOCK) return null;
  const arca = await buildArca(emisor, pv, supabaseAdmin);
  try {
    const info = await conTimeout(
      arca.electronicBillingService.getVoucherInfo(numero, pv.numero, cbteTipo),
      "consultar el comprobante",
    );
    if (!info) return null;
    const i = info as { codAutorizacion?: string; fchVto?: string };
    if (!i.codAutorizacion) return null;
    return { cae: String(i.codAutorizacion), vencimiento: parseFechaAfip(i.fchVto) };
  } catch (e) {
    const msg = String((e as Error)?.message ?? "");
    if (/602|no existen datos|not found|no existe/i.test(msg)) return null;
    throw e;
  }
}

/** Pide el CAE a AFIP (FECAESolicitar). */
export async function solicitarCae(
  emisor: EmisorFiscal,
  pv: PuntoVenta,
  d: DatosCae,
  supabaseAdmin: any,
): Promise<RespuestaCae> {
  if (MOCK) {
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

  const arca = await buildArca(emisor, pv, supabaseAdmin);
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

  const result = await conTimeout(
    arca.electronicBillingService.createVoucher(payload as never),
    "solicitar el CAE",
  );

  const r = result as { cae?: string; caeFchVto?: string; observaciones?: unknown; errores?: unknown };

  // EL CHEQUE MÁS IMPORTANTE DEL ARCHIVO: cuando AFIP RECHAZA un comprobante, el
  // SDK igual resuelve bien, pero con cae vacío. Sin esto guardaríamos una
  // factura "válida" sin CAE.
  if (!r.cae || String(r.cae).trim() === "") {
    const obs = r.observaciones ?? r.errores;
    throw new Error(
      "AFIP no autorizó el comprobante" +
        (obs ? `: ${JSON.stringify(obs)}` : ". Revisá los datos fiscales e intentá de nuevo."),
    );
  }

  return { cae: String(r.cae), vencimiento: parseFechaAfip(r.caeFchVto), modo: pv.modo };
}
