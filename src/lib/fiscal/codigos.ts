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
 * Letra REAL emitida, derivada del CbteTipo de AFIP guardado en la venta
 * (afip_cbte_tipo). Es la fuente de verdad para la letra de una nota de crédito:
 * una venta tipeada FACTURA_A pero emitida como B (ver puedeForzarConsumidorFinal)
 * tiene afip_cbte_tipo=6, y su NC debe salir B, no A.
 *   A: 1 (Fac), 2 (ND), 3 (NC)  ·  B: 6, 7, 8  ·  C: 11, 12, 13, 15
 */
export function letraDeCbteTipo(cbteTipo: number | null | undefined): Letra {
  if (cbteTipo != null && [6, 7, 8].includes(cbteTipo)) return "B";
  if (cbteTipo != null && TIPOS_C.has(cbteTipo)) return "C";
  return "A";
}

/**
 * ¿Se puede emitir Factura B (Consumidor Final) a un cliente RESPONSABLE INSCRIPTO?
 * Sólo cuando emisor Y receptor son RI: ahí la matriz daría A, pero el negocio a
 * veces quiere B. Para cualquier otra condición del receptor la letra ya es B (o C),
 * así que el "forzado" no aplica. Es server-authoritative: sólo habilita el
 * downgrade A→B, nunca al revés.
 */
export function puedeForzarConsumidorFinal(
  condEmisor: CondicionIva,
  condReceptor: CondicionIva | null | undefined,
): boolean {
  return condEmisor === "RESPONSABLE_INSCRIPTO" && condReceptor === "RESPONSABLE_INSCRIPTO";
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
 * Valida un CUIT argentino con el dígito verificador (módulo 11).
 * Un CUIT válido tiene 11 dígitos; el último es el verificador calculado sobre
 * los primeros 10 con los coeficientes [5,4,3,2,7,6,5,4,3,2].
 */
export function cuitValido(valor: string | null | undefined): boolean {
  const limpio = (valor ?? "").replace(/\D/g, "");
  if (limpio.length !== 11) return false;
  const coef = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(limpio[i]) * coef[i];
  const resto = suma % 11;
  let verificador = 11 - resto;
  if (verificador === 11) verificador = 0;
  else if (verificador === 10) verificador = 9;
  return verificador === Number(limpio[10]);
}

/**
 * Valida el identificador de un cliente para el form.
 *   - vacío         -> válido (consumidor final sin identificar)
 *   - 7 u 8 dígitos -> DNI, se acepta sin chequeo de verificador
 *   - 11 dígitos    -> CUIT, debe pasar el módulo 11
 *   - cualquier otra longitud -> inválido
 * Devuelve el mensaje de error, o null si es válido.
 */
export function validarCuitDni(valor: string | null | undefined): string | null {
  const limpio = (valor ?? "").replace(/\D/g, "");
  if (limpio.length === 0) return null;
  if (limpio.length === 7 || limpio.length === 8) return null;
  if (limpio.length === 11) {
    return cuitValido(limpio) ? null : "El CUIT no es válido (dígito verificador incorrecto).";
  }
  return "Ingresá un CUIT (11 dígitos) o un DNI (7 u 8 dígitos).";
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
