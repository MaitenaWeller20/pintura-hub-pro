/**
 * Códigos de AFIP y matriz de tipo de comprobante.
 *
 * Todo lo de acá viene verificado contra lubricentro y MesaYa, que facturan en
 * producción. Los mapas LANZAN en vez de devolver un default: mandar un código
 * equivocado a AFIP no es un error que quieras descubrir en la declaración de IVA.
 */

export type CondicionIva =
  | "RESPONSABLE_INSCRIPTO"
  | "MONOTRIBUTO"
  | "EXENTO"
  | "CONSUMIDOR_FINAL";

export type Letra = "A" | "B" | "C";

/** Los tipos de comprobante que maneja quimex. */
export type TipoComprobante =
  | "FACTURA_A"
  | "FACTURA_B"
  | "FACTURA_C"
  | "NOTA_CREDITO"
  | "NOTA_DEBITO"
  | "REMITO"
  | "REMITO_OBRA"
  | "FAC_INTERNA_CTA_CTE";

/**
 * Documentos INTERNOS: mueven mercadería y deuda, pero NO son comprobantes
 * fiscales y NO se mandan a AFIP. Es la distinción más importante del módulo.
 */
export const TIPOS_INTERNOS: ReadonlySet<string> = new Set([
  "REMITO",
  "REMITO_OBRA",
  "FAC_INTERNA_CTA_CTE",
]);

export const esComprobanteFiscal = (tipo: string): boolean => !TIPOS_INTERNOS.has(tipo);

/** El cliente de quimex mapea su tipo impositivo al del emisor/receptor de AFIP. */
export const CONDICION_IVA_CLIENTE: Record<string, CondicionIva> = {
  RESPONSABLE_INSCRIPTO: "RESPONSABLE_INSCRIPTO",
  MONOTRIBUTISTA: "MONOTRIBUTO",
  EXENTO: "EXENTO",
  CONSUMIDOR_FINAL: "CONSUMIDOR_FINAL",
};

/**
 * Matriz A/B/C.
 *   - Emisor monotributista -> siempre C.
 *   - Emisor RI + receptor RI -> A.
 *   - Emisor RI + cualquier otro (o sin cliente) -> B.
 */
export function determinarLetra(
  condEmisor: CondicionIva,
  condReceptor: CondicionIva | null | undefined,
): Letra {
  if (condEmisor === "MONOTRIBUTO") return "C";
  if (condReceptor === "RESPONSABLE_INSCRIPTO") return "A";
  return "B";
}

export function facturaDeLetra(letra: Letra): TipoComprobante {
  return letra === "A" ? "FACTURA_A" : letra === "C" ? "FACTURA_C" : "FACTURA_B";
}

/** La letra de una factura ya emitida (para derivar la letra de su nota de crédito). */
export function letraDeFactura(tipo: string): Letra {
  if (tipo === "FACTURA_A") return "A";
  if (tipo === "FACTURA_C") return "C";
  return "B";
}

/**
 * Código de comprobante de AFIP (CbteTipo).
 * Las notas de crédito/débito heredan la letra del comprobante que rectifican.
 */
export function cbteTipoAfip(tipo: string, letra: Letra): number {
  const mapa: Record<string, Record<Letra, number>> = {
    FACTURA_A: { A: 1, B: 6, C: 11 },
    FACTURA_B: { A: 1, B: 6, C: 11 },
    FACTURA_C: { A: 1, B: 6, C: 11 },
    NOTA_CREDITO: { A: 3, B: 8, C: 13 },
    NOTA_DEBITO: { A: 2, B: 7, C: 12 },
  };
  const porLetra = mapa[tipo];
  if (!porLetra) {
    throw new Error(`Tipo de comprobante sin equivalente en AFIP: ${tipo}`);
  }
  return porLetra[letra];
}

/**
 * Comprobantes clase C: no discriminan IVA. AFIP RECHAZA un comprobante C que
 * traiga el array Iva, y exige ImpNeto == ImpTotal con ImpIVA == 0.
 * 11 = Factura C, 12 = Nota de Débito C, 13 = Nota de Crédito C, 15 = Recibo C.
 */
export const TIPOS_C: ReadonlySet<number> = new Set([11, 12, 13, 15]);

/** Id de alícuota de IVA de AFIP a partir del porcentaje. */
export function ivaIdAfip(porcentaje: number): number {
  const mapa: Record<string, number> = {
    "0": 3,
    "2.5": 9,
    "5": 8,
    "10.5": 4,
    "21": 5,
    "27": 6,
  };
  // Normalizamos: "21.0" y 21.00 tienen que caer en la misma clave que 21.
  const id = mapa[String(Number(porcentaje))];
  if (!id) throw new Error(`Alícuota de IVA no soportada por AFIP: ${porcentaje}%`);
  return id;
}

/** Alícuotas que AFIP acepta. Tiene que quedar sincronizado con ivaIdAfip. */
export const ALICUOTAS_SOPORTADAS = [0, 2.5, 5, 10.5, 21, 27] as const;

/**
 * Valida una alícuota, con fallback.
 *
 * El guard de null/undefined/"" NO es paranoia: `Number(null)` y `Number("")` dan
 * 0, que ES una alícuota válida (exento). Sin el guard, un campo que no vino se
 * convertiría silenciosamente en 0% en vez de tomar el default. Y al revés, el
 * clásico `Number(x) || 21` colapsa un 0% legítimo a 21%, porque 0 es falsy.
 * Los dos errores terminan en IVA mal declarado. Esto está sacado literal de
 * lubricentro, donde el bug ya ocurrió.
 */
export function alicuotaValida(valor: unknown, fallback: number): number {
  if (valor === null || valor === undefined || valor === "") return fallback;
  const n = typeof valor === "number" ? valor : Number(valor);
  return Number.isFinite(n) && (ALICUOTAS_SOPORTADAS as readonly number[]).includes(n)
    ? n
    : fallback;
}

/** Tipo de documento del receptor. */
export function docTipoAfip(cuitDni: string | null | undefined): number {
  const limpio = (cuitDni ?? "").replace(/\D/g, "");
  if (limpio.length === 11) return 80; // CUIT
  if (limpio.length >= 7 && limpio.length <= 8) return 96; // DNI
  return 99; // consumidor final / sin identificar
}

/** Número de documento del receptor. 0 cuando no hay documento (va con DocTipo 99). */
export function docNroAfip(cuitDni: string | null | undefined): number {
  return Number((cuitDni ?? "").replace(/\D/g, "")) || 0;
}

/**
 * CondicionIVAReceptorId — obligatorio desde 2025 (RG 5616).
 * Sin esto AFIP rechaza el comprobante.
 */
export function condicionIvaReceptorId(cond: CondicionIva | null | undefined): number {
  const mapa: Record<CondicionIva, number> = {
    RESPONSABLE_INSCRIPTO: 1,
    EXENTO: 4,
    CONSUMIDOR_FINAL: 5,
    MONOTRIBUTO: 6,
  };
  return (cond && mapa[cond]) || 5; // 5 = consumidor final
}

/** Concepto WSFEv1: 1 productos, 2 servicios, 3 ambos. Una pinturería vende productos. */
export const CONCEPTO_PRODUCTOS = 1;
