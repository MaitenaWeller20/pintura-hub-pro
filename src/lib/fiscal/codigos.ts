/**
 * Códigos de AFIP y matriz de tipo de comprobante.
 *
 * Todo lo de acá viene verificado contra lubricentro y MesaYa, que facturan en
 * producción. Los mapas LANZAN en vez de devolver un default: mandar un código
 * equivocado a AFIP no es un error que quieras descubrir en la declaración de IVA.
 */

export type CondicionIva = "RESPONSABLE_INSCRIPTO" | "MONOTRIBUTO" | "EXENTO" | "CONSUMIDOR_FINAL";

export type Letra = "A" | "B" | "C";

/** Letras que el operador puede elegir para una venta nueva del rollout v2. */
export type LetraFacturaSolicitada = Extract<Letra, "A" | "B">;

/** Los tipos de comprobante que maneja quimex. */
export type TipoComprobante =
  | "VENTA"
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

const TIPOS_FISCALES: ReadonlySet<string> = new Set([
  "VENTA",
  "FACTURA_A",
  "FACTURA_B",
  "FACTURA_C",
  "NOTA_CREDITO",
  "NOTA_DEBITO",
]);

export const esComprobanteFiscal = (tipo: string): boolean => TIPOS_FISCALES.has(tipo);

/**
 * Una nota de crédito/débito SIN comprobante asociado es la reversión interna de
 * algo que nunca se declaró a AFIP: la que genera anular_venta cuando el original
 * no tenía CAE (un remito, o una factura anulada antes de emitirla).
 *
 * No es un pendiente fiscal. No hay nada que rectificar ante AFIP, y encima no se
 * PODRÍA emitir aunque se quisiera: el original quedó ANULADA y ya no puede
 * obtener un CAE. Antes estas notas mostraban el botón de emitir y fallaban
 * siempre, quedando como pendientes irresolubles.
 */
export function esNotaInterna(
  tipo: string,
  afipCbteAsocId: string | null | undefined,
  periodoDesde?: string | null,
  periodoHasta?: string | null,
): boolean {
  const tienePeriodoCompleto = Boolean(periodoDesde && periodoHasta);
  return (
    (tipo === "NOTA_CREDITO" || tipo === "NOTA_DEBITO") && !afipCbteAsocId && !tienePeriodoCompleto
  );
}

/** El cliente de quimex mapea su tipo impositivo al del emisor/receptor de AFIP. */
export const CONDICION_IVA_CLIENTE: Record<string, CondicionIva> = {
  RESPONSABLE_INSCRIPTO: "RESPONSABLE_INSCRIPTO",
  MONOTRIBUTISTA: "MONOTRIBUTO",
  EXENTO: "EXENTO",
  CONSUMIDOR_FINAL: "CONSUMIDOR_FINAL",
};

/**
 * Matriz vigente del rollout para un emisor Responsable Inscripto.
 * La emisión nueva de clase C queda fuera de alcance; los códigos C se conservan
 * para leer comprobantes históricos y derivar sus notas.
 */
export function determinarLetra(
  condEmisor: CondicionIva,
  condReceptor: CondicionIva | null | undefined,
): Letra {
  if (condEmisor !== "RESPONSABLE_INSCRIPTO") {
    throw new Error("El rollout fiscal actual sólo admite un emisor RI.");
  }
  if (condReceptor === "RESPONSABLE_INSCRIPTO" || condReceptor === "MONOTRIBUTO") {
    return "A";
  }
  if (condReceptor === "EXENTO" || condReceptor === "CONSUMIDOR_FINAL") return "B";
  throw new Error("La condición de IVA del receptor debe estar confirmada.");
}

/**
 * Confirma que la letra elegida por el operador sea compatible con la
 * condición impositiva ya resuelta del receptor. La elección sigue siendo
 * explícita: esta función valida, pero nunca la corrige silenciosamente.
 */
export function validarLetraSolicitada(
  condEmisor: CondicionIva,
  condReceptor: CondicionIva | null | undefined,
  letraSolicitada: LetraFacturaSolicitada,
): LetraFacturaSolicitada {
  if (letraSolicitada !== "A" && letraSolicitada !== "B") {
    throw new Error("La letra solicitada debe ser A o B.");
  }
  const compatible = determinarLetra(condEmisor, condReceptor);
  if (letraSolicitada !== compatible) {
    throw new Error(
      `La letra ${letraSolicitada} no es compatible con la condición de IVA ${String(condReceptor)} del receptor.`,
    );
  }
  return letraSolicitada;
}

export function facturaDeLetra(letra: Letra): TipoComprobante {
  return letra === "A" ? "FACTURA_A" : letra === "C" ? "FACTURA_C" : "FACTURA_B";
}

/** La letra de una factura ya emitida (para derivar la letra de su nota de crédito). */
export function letraDeFactura(tipo: string): Letra {
  if (tipo === "FACTURA_A") return "A";
  if (tipo === "FACTURA_B") return "B";
  if (tipo === "FACTURA_C") return "C";
  throw new Error(`El tipo ${tipo} no tiene letra de factura confirmada.`);
}

/**
 * Letra REAL emitida, derivada del CbteTipo de AFIP guardado en la venta
 * (afip_cbte_tipo). Es la fuente de verdad para la letra de una nota de crédito:
 * la nota hereda esa letra autorizada sin releer ni reinterpretar datos vivos.
 *   A: 1 (Fac), 2 (ND), 3 (NC)  ·  B: 6, 7, 8  ·  C: 11, 12, 13, 15
 */
export function letraDeCbteTipo(cbteTipo: number | null | undefined): Letra {
  if (cbteTipo != null && [1, 2, 3].includes(cbteTipo)) return "A";
  if (cbteTipo != null && [6, 7, 8].includes(cbteTipo)) return "B";
  if (cbteTipo != null && TIPOS_C.has(cbteTipo)) return "C";
  throw new Error(`CbteTipo desconocido: ${String(cbteTipo)}`);
}

/**
 * Código de comprobante de AFIP (CbteTipo).
 * Las notas de crédito/débito heredan la letra del comprobante que rectifican.
 */
export function cbteTipoAfip(tipo: string, letra: Letra): number {
  if (letra !== "A" && letra !== "B" && letra !== "C") {
    throw new Error("El CbteTipo exige una letra original confirmada.");
  }
  if (tipo === "VENTA") {
    if (letra === "A") return 1;
    if (letra === "B") return 6;
    throw new Error("VENTA requiere una letra confirmada A o B.");
  }
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

/** Una NC por período sólo usa los tipos estándar de WSFE, nunca FCE. */
export function cbteTipoAfipNcPeriodo(letra: Letra): number {
  if (letra !== "A" && letra !== "B" && letra !== "C") {
    throw new Error("La NC por período sólo admite los CbteTipo ARCA 3, 8 o 13.");
  }
  const cbteTipo = cbteTipoAfip("NOTA_CREDITO", letra);
  if (![3, 8, 13].includes(cbteTipo)) {
    throw new Error("La NC por período sólo admite los CbteTipo ARCA 3, 8 o 13.");
  }
  return cbteTipo;
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
 * El camino inverso de ivaIdAfip: del Id de AFIP al porcentaje. Hace falta para
 * imprimir el IVA discriminado por alícuota ("IVA 21% s/ $1.000"), que es lo que
 * se le declaró y lo que el comprobante tiene que mostrar.
 */
export function porcentajeDeIvaId(id: number): number {
  const mapa: Record<number, number> = { 3: 0, 9: 2.5, 8: 5, 4: 10.5, 5: 21, 6: 27 };
  const p = mapa[id];
  if (p === undefined) throw new Error(`Id de alícuota de IVA desconocido: ${id}`);
  return p;
}

/** Letra y código impreso de AFIP para el recuadro del comprobante. */
export const CBTE_INFO: Record<number, { letra: Letra; cod: string }> = {
  1: { letra: "A", cod: "01" },
  2: { letra: "A", cod: "02" },
  3: { letra: "A", cod: "03" },
  6: { letra: "B", cod: "06" },
  7: { letra: "B", cod: "07" },
  8: { letra: "B", cod: "08" },
  11: { letra: "C", cod: "11" },
  12: { letra: "C", cod: "12" },
  13: { letra: "C", cod: "13" },
  15: { letra: "C", cod: "15" },
};

/** Título del comprobante según un CbteTipo de AFIP conocido. */
export function tituloDeCbteTipo(cbteTipo: number | null | undefined): string {
  if ([1, 6, 11].includes(cbteTipo as number)) return "FACTURA";
  if ([3, 8, 13].includes(cbteTipo as number)) return "NOTA DE CRÉDITO";
  if ([2, 7, 12].includes(cbteTipo as number)) return "NOTA DE DÉBITO";
  if (cbteTipo === 15) return "RECIBO";
  throw new Error(`CbteTipo desconocido: ${String(cbteTipo)}`);
}

/** Etiqueta legible de una condición de IVA, para imprimir. */
export const CONDICION_IVA_LABEL: Record<CondicionIva, string> = {
  RESPONSABLE_INSCRIPTO: "Responsable Inscripto",
  MONOTRIBUTO: "Monotributo",
  EXENTO: "Exento",
  CONSUMIDOR_FINAL: "Consumidor Final",
};

/**
 * Régimen de Transparencia Fiscal al Consumidor (Ley 27.743, RG 5614): los
 * comprobantes clase B y C emitidos a consumidor final tienen que mostrar el IVA
 * contenido y la leyenda. En A no aplica (el IVA ya va discriminado por diseño).
 */
export function requiereLeyendaTransparencia(
  cbteTipo: number,
  condReceptor: CondicionIva | null | undefined,
): boolean {
  const letra = CBTE_INFO[cbteTipo]?.letra;
  return (letra === "B" || letra === "C") && condReceptor === "CONSUMIDOR_FINAL";
}

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

/**
 * @deprecated Compatibilidad exclusiva del escritor/lector legacy.
 * El camino fiscal v2 usa documentoFiscalArca() con tipo explícito y nunca llama
 * a este helper, que infiere por longitud.
 */
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
  if (limpio === "00000000000") return false;
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
