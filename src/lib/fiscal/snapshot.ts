import {
  condicionIvaReceptorId,
  cuitValido,
  type CondicionIva,
  type Letra,
} from "./codigos";
import type { TotalesFiscales } from "./iva";
import {
  validarReceptorFiscalConfirmado,
  type ReceptorFiscalConfirmado,
} from "./receptor";

export type EmisorSnapshotFiscal = {
  razon_social: string;
  nombre_fantasia: string | null;
  cuit: string;
  domicilio_fiscal: string | null;
  condicion_iva: CondicionIva;
  ingresos_brutos: string | null;
  inicio_actividades: string;
  telefono: string | null;
};

export type ReceptorSnapshotFiscal = {
  razon_social: string | null;
  cuit_dni: string | null;
  doc_tipo: number;
  doc_nro: number;
  condicion_iva: CondicionIva | null;
  domicilio: string | null;
};

export type ReceptorDeclaradoLegacy = Omit<ReceptorSnapshotFiscal, "condicion_iva"> & {
  condicion_iva: CondicionIva;
};

export type LineaSnapshotFiscal = {
  codigo: string;
  descripcion: string;
  cantidad: number;
  precio_unitario_sin_iva: number;
  descuento_porcentaje: number;
  iva_porcentaje: number;
  subtotal_con_iva: number;
};

export type SnapshotFiscal = {
  emisor: EmisorSnapshotFiscal;
  receptor: ReceptorSnapshotFiscal;
  condicion_venta: string | null;
  totales: TotalesFiscales;
  fecha: string;
  lineas: LineaSnapshotFiscal[];
  version: 1;
};

export type SnapshotFiscalInput = Omit<SnapshotFiscal, "version">;

export type IdentidadReservaFiscal = {
  cuit: string | null;
  punto_venta: number | null;
  cbte_tipo: number | null;
  ambiente: string | null;
};

export function identidadReservaCoincide(
  reserva: IdentidadReservaFiscal,
  esperada: IdentidadReservaFiscal,
): boolean {
  return (
    reserva.cuit === esperada.cuit &&
    reserva.punto_venta === esperada.punto_venta &&
    reserva.cbte_tipo === esperada.cbte_tipo &&
    reserva.ambiente === esperada.ambiente
  );
}

const CONDICIONES_IVA = new Set<CondicionIva>([
  "RESPONSABLE_INSCRIPTO",
  "MONOTRIBUTO",
  "EXENTO",
  "CONSUMIDOR_FINAL",
]);
const DOC_TIPOS_ARCA = new Set([80, 86, 87, 96, 99]);

function esRegistro(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizarDocumentoLogico(valor: string): string {
  if (!/^(?=.*\d)[\d .-]+$/.test(valor)) {
    throw new Error(
      "El formato del documento lógico en el snapshot v1 sólo admite dígitos, puntos, guiones y espacios.",
    );
  }
  return valor.replace(/[ .-]/g, "");
}

function receptorDesdeSnapshotV1(snapshot: unknown, letra: Letra): ReceptorDeclaradoLegacy {
  if (!esRegistro(snapshot) || snapshot.version !== 1 || !esRegistro(snapshot.receptor)) {
    throw new Error("La nota exige un snapshot v1 válido del receptor original.");
  }

  const receptor = snapshot.receptor;
  if (
    (receptor.razon_social !== null && typeof receptor.razon_social !== "string") ||
    (receptor.cuit_dni !== null && typeof receptor.cuit_dni !== "string") ||
    (receptor.domicilio !== null && typeof receptor.domicilio !== "string") ||
    typeof receptor.doc_tipo !== "number" ||
    !DOC_TIPOS_ARCA.has(receptor.doc_tipo) ||
    typeof receptor.doc_nro !== "number" ||
    !Number.isSafeInteger(receptor.doc_nro) ||
    receptor.doc_nro < 0 ||
    (receptor.condicion_iva !== null &&
      !CONDICIONES_IVA.has(receptor.condicion_iva as CondicionIva))
  ) {
    throw new Error("La nota exige un snapshot v1 válido del receptor original.");
  }

  const condicionDeclarada = receptor.condicion_iva as CondicionIva | null;
  let documentoLogico: string | null = null;
  if (receptor.doc_tipo === 99) {
    if (
      receptor.cuit_dni !== null ||
      receptor.doc_nro !== 0 ||
      (condicionDeclarada !== null && condicionDeclarada !== "CONSUMIDOR_FINAL")
    ) {
      throw new Error(
        "El receptor anónimo del snapshot v1 debe declarar cuit_dni null, DocTipo 99, DocNro 0 y condición consumidor final.",
      );
    }
  } else {
    if (receptor.cuit_dni === null) {
      throw new Error("El documento lógico del receptor identificado es obligatorio.");
    }
    documentoLogico = normalizarDocumentoLogico(receptor.cuit_dni as string);
    const largoValido =
      ([80, 86, 87].includes(receptor.doc_tipo) && /^\d{11}$/.test(documentoLogico)) ||
      (receptor.doc_tipo === 96 && /^\d{7,8}$/.test(documentoLogico));
    if (!largoValido) {
      throw new Error("El documento lógico no tiene la longitud exigida por DocTipo.");
    }
    if (documentoLogico !== String(receptor.doc_nro)) {
      throw new Error("El documento lógico del snapshot v1 no coincide exactamente con DocNro.");
    }
    if (receptor.doc_tipo === 80 && !cuitValido(documentoLogico)) {
      throw new Error("DocTipo 80 exige un CUIT válido en el snapshot v1 original.");
    }
    if (condicionDeclarada === null) {
      throw new Error("La condición de IVA es obligatoria para un receptor identificado.");
    }
  }

  const condicionEfectiva = condicionDeclarada ?? "CONSUMIDOR_FINAL";
  if (
    letra === "A" &&
    (!(condicionEfectiva === "RESPONSABLE_INSCRIPTO" || condicionEfectiva === "MONOTRIBUTO") ||
      receptor.doc_tipo !== 80 ||
      documentoLogico === null ||
      !cuitValido(documentoLogico))
  ) {
    throw new Error("La letra A es incompatible con la condición o el documento del receptor.");
  }
  if (letra === "B" && condicionEfectiva !== "EXENTO" && condicionEfectiva !== "CONSUMIDOR_FINAL") {
    throw new Error("La letra B es incompatible con la condición del receptor.");
  }

  return {
    razon_social: receptor.razon_social as string | null,
    cuit_dni: receptor.cuit_dni as string | null,
    doc_tipo: receptor.doc_tipo,
    doc_nro: receptor.doc_nro,
    // Snapshot v1 guardaba null para el consumidor final anónimo, pero el
    // payload legacy declaraba 5 mediante condicionIvaReceptorId(null).
    condicion_iva: condicionEfectiva,
    domicilio: receptor.domicilio as string | null,
  };
}

/**
 * Compatibilidad acotada del escritor legacy. Las notas heredan receptor del
 * snapshot v1 original; sólo una nota B histórica sin snapshot puede reconstruir
 * el viejo RI→Consumidor Final. Una factura nueva nunca entra en ese fallback.
 */
export function resolverReceptorFiscalLegacy(input: {
  tipoComprobante: string;
  letra: Letra;
  receptorVivo: ReceptorDeclaradoLegacy;
  snapshotOriginal: unknown | null;
}): ReceptorDeclaradoLegacy {
  const esNota =
    input.tipoComprobante === "NOTA_CREDITO" || input.tipoComprobante === "NOTA_DEBITO";
  if (!esNota) return { ...input.receptorVivo };
  if (input.snapshotOriginal !== null) {
    return receptorDesdeSnapshotV1(input.snapshotOriginal, input.letra);
  }
  if (input.letra === "B" && input.receptorVivo.condicion_iva === "RESPONSABLE_INSCRIPTO") {
    return { ...input.receptorVivo, condicion_iva: "CONSUMIDOR_FINAL" };
  }
  return { ...input.receptorVivo };
}

/**
 * Copia todos los valores que forman el comprobante legal. No conserva
 * referencias a objetos vivos: una corrección posterior no cambia el snapshot
 * que se persiste junto con la reserva del número fiscal.
 */
export function crearSnapshotFiscal(input: SnapshotFiscalInput): SnapshotFiscal {
  return {
    emisor: { ...input.emisor },
    receptor: { ...input.receptor },
    condicion_venta: input.condicion_venta,
    totales: {
      ...input.totales,
      alicuotas: input.totales.alicuotas.map((alicuota) => ({ ...alicuota })),
    },
    fecha: input.fecha,
    lineas: input.lineas.map((linea) => ({ ...linea })),
    version: 1,
  };
}

export type ItemSnapshotFiscalV2 = {
  id: string;
  productoId: string | null;
  codigo: string;
  descripcion: string;
  cantidad: string;
  precioUnitarioSinIva: string;
  descuentoPorcentaje: string;
  ivaPorcentaje: string;
  subtotalNeto: string;
  importeIva: string;
  subtotalTotal: string;
};

export type AlicuotaIvaSnapshotFiscalV2 = {
  id: number;
  baseImponible: string;
  importe: string;
};

export type TributoSnapshotFiscalV2 = {
  id: number;
  descripcion: string;
  baseImponible: string;
  alicuota: string;
  importe: string;
};

export type CbteAsocSnapshotFiscalV2 = {
  tipo: number;
  puntoVenta: number;
  numero: number;
  cuit: string;
  fecha: string;
};

export type SnapshotFiscalV2 = {
  version: 2;
  hash: string;
  venta: {
    id: string;
    numeroComercial: string;
    tipoComprobante: "VENTA" | "NOTA_CREDITO";
    condicionVenta: "CONTADO" | "CTA_CTE";
    fechaComercial: string;
  };
  items: ItemSnapshotFiscalV2[];
  emisor: {
    id: string;
    razonSocial: string;
    nombreFantasia: string | null;
    cuit: string;
    domicilioFiscal: string;
    condicionIva: CondicionIva;
    ingresosBrutos: string | null;
    inicioActividades: string;
    telefono: string | null;
  };
  sucursal: {
    id: string;
    nombre: string;
    direccion: string;
    telefono: string | null;
  };
  receptor: ReceptorFiscalConfirmado & { condicionIvaReceptorId: 1 | 4 | 5 | 6 };
  identidad: {
    numero: number;
    emisorCuit: string;
    puntoVenta: number;
    cbteTipo: number;
    modo: "PRODUCCION" | "HOMOLOGACION";
    simulado: boolean;
    validez: "PRODUCCION" | "HOMOLOGACION" | "SIMULADA";
  };
  letra: Letra;
  concepto: 1;
  fechaComprobante: string;
  importeNeto: string;
  importeExento: string;
  importeNoGravado: string;
  importeIva: string;
  importeTributos: string;
  importeTotal: string;
  alicuotasIva: AlicuotaIvaSnapshotFiscalV2[];
  tributos: TributoSnapshotFiscalV2[];
  moneda: "PES";
  cotizacion: string;
  ivaContenido: string;
  otrosImpuestosNacionalesIndirectos: string;
  origen: "VENTA" | "COMPROBANTE_ORIGINAL";
  comprobanteOriginalId: string | null;
  cbtesAsoc: CbteAsocSnapshotFiscalV2[];
};

export type SnapshotFiscalV2Input = Omit<SnapshotFiscalV2, "hash" | "version">;
type SnapshotFiscalV2Body = Omit<SnapshotFiscalV2, "hash">;

type JsonCanonico = null | boolean | string | number | JsonCanonico[] | { [key: string]: JsonCanonico };

const UUID_CANONICO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL_DOS = /^(0|[1-9][0-9]{0,11})\.[0-9]{2}$/;
const DECIMAL_SEIS = /^(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const IVA_ID_POR_PORCENTAJE: ReadonlyMap<string, number> = new Map([
  ["0.00", 3],
  ["2.50", 9],
  ["5.00", 8],
  ["10.50", 4],
  ["21.00", 5],
  ["27.00", 6],
]);
const IVA_IDS: ReadonlySet<number> = new Set(IVA_ID_POR_PORCENTAJE.values());

function validarUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const siguiente = value.charCodeAt(index + 1);
      if (!(siguiente >= 0xdc00 && siguiente <= 0xdfff)) {
        throw new Error("El snapshot contiene un surrogate UTF-16 no emparejado.");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("El snapshot contiene un surrogate UTF-16 no emparejado.");
    }
  }
}

function utf8Bytes(value: string): Uint8Array {
  validarUnicode(value);
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function compararUtf8(a: string, b: string): number {
  const left = utf8Bytes(a);
  const right = utf8Bytes(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function enteroDominio(value: JsonCanonico, key: string): number {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value[key] !== "number"
  ) {
    throw new Error(`El array canónico exige ${key} entero.`);
  }
  return value[key] as number;
}

function textoDominio(value: JsonCanonico, key: string): string {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value[key] !== "string"
  ) {
    throw new Error(`El array canónico exige ${key} textual.`);
  }
  return value[key] as string;
}

function compararTuplas(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    const comparison =
      typeof left === "number" && typeof right === "number"
        ? left - right
        : compararUtf8(String(left), String(right));
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compararDominio(key: string, a: JsonCanonico, b: JsonCanonico): number {
  if (key === "items") return compararUtf8(textoDominio(a, "id"), textoDominio(b, "id"));
  if (key === "alicuotasIva") return enteroDominio(a, "id") - enteroDominio(b, "id");
  if (key === "tributos") {
    return compararTuplas(
      [
        enteroDominio(a, "id"),
        textoDominio(a, "descripcion"),
        textoDominio(a, "baseImponible"),
        textoDominio(a, "alicuota"),
        textoDominio(a, "importe"),
      ],
      [
        enteroDominio(b, "id"),
        textoDominio(b, "descripcion"),
        textoDominio(b, "baseImponible"),
        textoDominio(b, "alicuota"),
        textoDominio(b, "importe"),
      ],
    );
  }
  if (key === "cbtesAsoc") {
    return compararTuplas(
      [
        enteroDominio(a, "tipo"),
        enteroDominio(a, "puntoVenta"),
        enteroDominio(a, "numero"),
        textoDominio(a, "cuit"),
        textoDominio(a, "fecha"),
      ],
      [
        enteroDominio(b, "tipo"),
        enteroDominio(b, "puntoVenta"),
        enteroDominio(b, "numero"),
        textoDominio(b, "cuit"),
        textoDominio(b, "fecha"),
      ],
    );
  }
  return 0;
}

function clonarCanonico(
  value: unknown,
  stack: WeakSet<object>,
  key: string | null,
  ordenarArrays: boolean,
): JsonCanonico {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    validarUnicode(value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error("Los números JSON del snapshot deben ser enteros seguros, finitos y canónicos.");
    }
    return value;
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new Error(`Tipo no serializable en snapshot fiscal: ${typeof value}.`);
  }
  if (typeof value !== "object") throw new Error("Valor no serializable en snapshot fiscal.");
  if (value instanceof Date) throw new Error("Date no es canónico: convierta la fecha a string.");
  if (stack.has(value)) throw new Error("El snapshot fiscal no puede ser cíclico.");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error("Los arrays fiscales deben usar el prototipo Array estándar.");
      }
      const ownKeys = Reflect.ownKeys(value);
      for (const ownKey of ownKeys) {
        if (ownKey === "length") continue;
        if (typeof ownKey !== "string" || !/^(0|[1-9][0-9]*)$/.test(ownKey)) {
          throw new Error("Los arrays fiscales no admiten propiedades adicionales.");
        }
        const numericIndex = Number(ownKey);
        if (
          !Number.isSafeInteger(numericIndex) ||
          numericIndex >= value.length ||
          String(numericIndex) !== ownKey
        ) {
          throw new Error("Los arrays fiscales no admiten propiedades adicionales.");
        }
      }
      const result: JsonCanonico[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) throw new Error("Los arrays fiscales no pueden contener huecos.");
        if (!descriptor.enumerable) {
          throw new Error("Los arrays fiscales no admiten índices no enumerables.");
        }
        if (descriptor.get || descriptor.set || !("value" in descriptor)) {
          throw new Error("Los arrays fiscales no admiten accessors.");
        }
        result.push(clonarCanonico(descriptor.value, stack, null, ordenarArrays));
      }
      if (ordenarArrays && key && ["items", "alicuotasIva", "tributos", "cbtesAsoc"].includes(key)) {
        result.sort((a, b) => compararDominio(key, a, b));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("El snapshot fiscal sólo admite objetos JSON planos.");
    }
    const result: Record<string, JsonCanonico> = {};
    const ownKeys = Reflect.ownKeys(value);
    for (const ownKey of ownKeys) {
      if (typeof ownKey !== "string") {
        throw new Error("El snapshot fiscal no admite claves Symbol.");
      }
      validarUnicode(ownKey);
      const descriptor = Object.getOwnPropertyDescriptor(value, ownKey)!;
      if (!descriptor.enumerable) {
        throw new Error("El snapshot fiscal no admite propiedades no enumerables.");
      }
      if (descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw new Error("El snapshot fiscal no admite accessors.");
      }
    }
    for (const ownKey of (ownKeys as string[]).sort(compararUtf8)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, ownKey)!;
      result[ownKey] = clonarCanonico(descriptor.value, stack, ownKey, ordenarArrays);
    }
    return result;
  } finally {
    stack.delete(value);
  }
}

function serializarNormalizado(value: JsonCanonico): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializarNormalizado).join(",")}]`;
  const keys = Object.keys(value).sort(compararUtf8);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${serializarNormalizado(value[key])}`)
    .join(",")}}`;
}

export function serializarSnapshotFiscal(valueWithoutHash: unknown): string {
  if (esRegistro(valueWithoutHash) && Object.prototype.hasOwnProperty.call(valueWithoutHash, "hash")) {
    throw new Error("serializarSnapshotFiscal recibe el valor sin hash.");
  }
  return serializarNormalizado(clonarCanonico(valueWithoutHash, new WeakSet(), null, true));
}

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** SHA-256 síncrono y browser-safe sobre bytes UTF-8, sin dependencias de Node. */
export function sha256HexUtf8(value: string): string {
  const bytes = utf8Bytes(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotateRight(words[index - 15], 7) ^
        rotateRight(words[index - 15], 18) ^
        (words[index - 15] >>> 3);
      const s1 =
        rotateRight(words[index - 2], 17) ^
        rotateRight(words[index - 2], 19) ^
        (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

export function calcularHashSnapshotFiscal(valueWithoutHash: unknown): string {
  return sha256HexUtf8(serializarSnapshotFiscal(valueWithoutHash));
}

function objeto(value: unknown, label: string): Record<string, unknown> {
  if (!esRegistro(value)) throw new Error(`${label} debe ser un objeto.`);
  return value;
}

function clavesExactas(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort(compararUtf8);
  const wanted = [...expected].sort(compararUtf8);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} tiene claves faltantes o desconocidas.`);
  }
}

function texto(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} es obligatorio.`);
  return value;
}

function uuid(value: unknown, label: string, nullable = false): string | null {
  const result = texto(value, label, nullable);
  if (result !== null && !UUID_CANONICO.test(result)) throw new Error(`${label} debe ser UUID canónico.`);
  return result;
}

function entero(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} debe ser un entero seguro entre ${min} y ${max}.`);
  }
  return value as number;
}

function fecha(value: unknown, label: string): string {
  const result = texto(value, label)!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error(`${label} debe usar YYYY-MM-DD.`);
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error(`${label} no es una fecha válida.`);
  }
  return result;
}

function instante(value: unknown, label: string, nullable = false): string | null {
  const result = texto(value, label, nullable);
  if (result === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result)) {
    throw new Error(`${label} debe ser un instante ISO UTC.`);
  }
  const parsed = new Date(result);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} no es un instante válido.`);
  const canonico = result.includes(".")
    ? parsed.toISOString()
    : parsed.toISOString().replace(".000Z", "Z");
  if (canonico !== result) throw new Error(`${label} no es un instante válido y canónico.`);
  return result;
}

function centavos(value: unknown, label: string, positivo = false): bigint {
  if (typeof value !== "string" || !DECIMAL_DOS.test(value)) {
    throw new Error(`${label} debe ser decimal canónico con dos posiciones.`);
  }
  const [whole, fraction] = value.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction);
  if (positivo && result <= 0n) throw new Error(`${label} debe ser positivo.`);
  return result;
}

function porcentaje(value: unknown, label: string): bigint {
  const result = centavos(value, label);
  if (result > 10_000n) throw new Error(`${label} no puede superar 100.00.`);
  return result;
}

function redondearCocientePositivo(numerador: bigint, denominador: bigint): bigint {
  return (numerador + denominador / 2n) / denominador;
}

function ordenado<T>(values: readonly T[], compare: (a: T, b: T) => number): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1], value) <= 0);
}

function validarCuerpoV2(value: Record<string, unknown>, exigirOrdenCanonico: boolean): SnapshotFiscalV2Body {
  clavesExactas(
    value,
    [
      "version", "venta", "items", "emisor", "sucursal", "receptor", "identidad", "letra",
      "concepto", "fechaComprobante", "importeNeto", "importeExento", "importeNoGravado",
      "importeIva", "importeTributos", "importeTotal", "alicuotasIva", "tributos", "moneda",
      "cotizacion", "ivaContenido", "otrosImpuestosNacionalesIndirectos", "origen",
      "comprobanteOriginalId", "cbtesAsoc",
    ],
    "SnapshotFiscalV2",
  );
  if (value.version !== 2) throw new Error("El snapshot fiscal debe ser versión 2.");

  const venta = objeto(value.venta, "venta");
  clavesExactas(
    venta,
    ["id", "numeroComercial", "tipoComprobante", "condicionVenta", "fechaComercial"],
    "venta",
  );
  uuid(venta.id, "venta.id");
  texto(venta.numeroComercial, "venta.numeroComercial");
  if (!['VENTA', 'NOTA_CREDITO'].includes(String(venta.tipoComprobante))) {
    if (venta.tipoComprobante === "NOTA_DEBITO") {
      throw new Error("La nota de débito nueva queda fuera de alcance.");
    }
    throw new Error("venta.tipoComprobante no está soportado por snapshot v2.");
  }
  if (!['CONTADO', 'CTA_CTE'].includes(String(venta.condicionVenta))) {
    throw new Error("venta.condicionVenta es desconocida.");
  }
  instante(venta.fechaComercial, "venta.fechaComercial");

  const emisor = objeto(value.emisor, "emisor");
  clavesExactas(
    emisor,
    ["id", "razonSocial", "nombreFantasia", "cuit", "domicilioFiscal", "condicionIva", "ingresosBrutos", "inicioActividades", "telefono"],
    "emisor",
  );
  uuid(emisor.id, "emisor.id");
  texto(emisor.razonSocial, "emisor.razonSocial");
  texto(emisor.nombreFantasia, "emisor.nombreFantasia", true);
  if (typeof emisor.cuit !== "string" || !cuitValido(emisor.cuit)) throw new Error("emisor.cuit debe ser válido.");
  texto(emisor.domicilioFiscal, "emisor.domicilioFiscal");
  if (emisor.condicionIva !== "RESPONSABLE_INSCRIPTO") {
    throw new Error("El rollout v2 sólo admite un emisor Responsable Inscripto (RI).");
  }
  texto(emisor.ingresosBrutos, "emisor.ingresosBrutos", true);
  fecha(emisor.inicioActividades, "emisor.inicioActividades");
  texto(emisor.telefono, "emisor.telefono", true);

  const sucursal = objeto(value.sucursal, "sucursal");
  clavesExactas(sucursal, ["id", "nombre", "direccion", "telefono"], "sucursal");
  uuid(sucursal.id, "sucursal.id");
  texto(sucursal.nombre, "sucursal.nombre");
  texto(sucursal.direccion, "sucursal.direccion");
  texto(sucursal.telefono, "sucursal.telefono", true);

  const identidad = objeto(value.identidad, "identidad");
  clavesExactas(
    identidad,
    ["numero", "emisorCuit", "puntoVenta", "cbteTipo", "modo", "simulado", "validez"],
    "identidad",
  );
  entero(identidad.numero, "identidad.numero", 1, 2_147_483_647);
  if (identidad.emisorCuit !== emisor.cuit) throw new Error("El CUIT de identidad no coincide con el emisor.");
  entero(identidad.puntoVenta, "identidad.puntoVenta", 1, 99_999);
  entero(identidad.cbteTipo, "identidad.cbteTipo", 1, 9_999);
  if (!['PRODUCCION', 'HOMOLOGACION'].includes(String(identidad.modo))) throw new Error("identidad.modo inválido.");
  if (typeof identidad.simulado !== "boolean") throw new Error("identidad.simulado debe ser booleano.");
  if (!['PRODUCCION', 'HOMOLOGACION', 'SIMULADA'].includes(String(identidad.validez))) throw new Error("identidad.validez inválida.");
  const validezEsperada = identidad.simulado ? "SIMULADA" : identidad.modo;
  if (identidad.validez !== validezEsperada) throw new Error("Modo, simulación y validez son incoherentes.");

  if (!['A', 'B', 'C'].includes(String(value.letra))) throw new Error("La letra fiscal es desconocida.");
  if (value.concepto !== 1) throw new Error("El rollout actual exige Concepto=1.");
  fecha(value.fechaComprobante, "fechaComprobante");

  const importeNeto = centavos(value.importeNeto, "importeNeto");
  const importeExento = centavos(value.importeExento, "importeExento");
  const importeNoGravado = centavos(value.importeNoGravado, "importeNoGravado");
  const importeIva = centavos(value.importeIva, "importeIva");
  const importeTributos = centavos(value.importeTributos, "importeTributos");
  const importeTotal = centavos(value.importeTotal, "importeTotal", true);
  if (importeNeto + importeExento + importeNoGravado + importeIva + importeTributos !== importeTotal) {
    throw new Error("El total fiscal no coincide con neto, exento, no gravado, IVA y tributos.");
  }

  if (!Array.isArray(value.items) || value.items.length === 0) throw new Error("items debe contener al menos una línea.");
  const itemIds = new Set<string>();
  let itemsNeto = 0n;
  let itemsIva = 0n;
  let itemsBaseIvaCero = 0n;
  const gruposIvaEsperados = new Map<number, { base: bigint; importe: bigint }>();
  for (const rawItem of value.items) {
    const item = objeto(rawItem, "item");
    clavesExactas(
      item,
      ["id", "productoId", "codigo", "descripcion", "cantidad", "precioUnitarioSinIva", "descuentoPorcentaje", "ivaPorcentaje", "subtotalNeto", "importeIva", "subtotalTotal"],
      "item",
    );
    const id = uuid(item.id, "item.id")!;
    if (itemIds.has(id)) throw new Error("Los items no pueden repetir id.");
    itemIds.add(id);
    uuid(item.productoId, "item.productoId", true);
    texto(item.codigo, "item.codigo");
    texto(item.descripcion, "item.descripcion");
    const cantidad = centavos(item.cantidad, "item.cantidad", true);
    const precioUnitario = centavos(item.precioUnitarioSinIva, "item.precioUnitarioSinIva");
    const descuento = porcentaje(item.descuentoPorcentaje, "item.descuentoPorcentaje");
    if (typeof item.ivaPorcentaje !== "string" || !IVA_ID_POR_PORCENTAJE.has(item.ivaPorcentaje)) {
      throw new Error("item.ivaPorcentaje no está soportado.");
    }
    const tasaIva = porcentaje(item.ivaPorcentaje, "item.ivaPorcentaje");
    const neto = centavos(item.subtotalNeto, "item.subtotalNeto");
    const iva = centavos(item.importeIva, "item.importeIva");
    const total = centavos(item.subtotalTotal, "item.subtotalTotal", true);
    const netoEsperado = redondearCocientePositivo(
      precioUnitario * cantidad * (10_000n - descuento),
      1_000_000n,
    );
    const ivaEsperado = redondearCocientePositivo(netoEsperado * tasaIva, 10_000n);
    if (neto !== netoEsperado || iva !== ivaEsperado || total !== netoEsperado + ivaEsperado) {
      throw new Error(
        "Los subtotales del item no coinciden con cantidad, precio neto, descuento e IVA redondeados por línea.",
      );
    }
    itemsNeto += neto;
    itemsIva += iva;
    const idIva = IVA_ID_POR_PORCENTAJE.get(item.ivaPorcentaje)!;
    if (idIva === 3) {
      itemsBaseIvaCero += neto;
    } else {
      const grupo = gruposIvaEsperados.get(idIva) ?? { base: 0n, importe: 0n };
      grupo.base += neto;
      grupo.importe += iva;
      gruposIvaEsperados.set(idIva, grupo);
    }
  }
  if (itemsNeto !== importeNeto + importeExento + importeNoGravado || itemsIva !== importeIva) {
    throw new Error("Los items no coinciden con el neto/exento/no gravado/IVA de cabecera.");
  }
  if (exigirOrdenCanonico && !ordenado(value.items as JsonCanonico[], (a, b) => compararDominio("items", a, b))) {
    throw new Error("items no respeta el orden canónico.");
  }

  const baseNoCero = [...gruposIvaEsperados.values()].reduce(
    (total, grupo) => total + grupo.base,
    0n,
  );
  const baseGravadaIvaCero = importeNeto - baseNoCero;
  if (baseGravadaIvaCero < 0n) {
    throw new Error("La base imponible de IVA no coincide con los items.");
  }
  if (itemsBaseIvaCero !== importeExento + importeNoGravado + baseGravadaIvaCero) {
    throw new Error(
      "Los items con IVA 0% no coinciden con exento, no gravado y base gravada a tasa cero.",
    );
  }
  if (baseGravadaIvaCero > 0n) {
    gruposIvaEsperados.set(3, { base: baseGravadaIvaCero, importe: 0n });
  }

  if (!Array.isArray(value.alicuotasIva)) throw new Error("alicuotasIva debe ser un array.");
  const alicuotaIds = new Set<number>();
  for (const rawRow of value.alicuotasIva) {
    const row = objeto(rawRow, "alicuotaIva");
    clavesExactas(row, ["id", "baseImponible", "importe"], "alicuotaIva");
    const id = entero(row.id, "alicuotaIva.id", 1, 9999);
    if (!IVA_IDS.has(id)) throw new Error("alicuotaIva.id no está soportado por ARCA.");
    if (alicuotaIds.has(id)) throw new Error("Las alícuotas de IVA no pueden repetir id.");
    alicuotaIds.add(id);
    const base = centavos(row.baseImponible, "alicuotaIva.baseImponible");
    const iva = centavos(row.importe, "alicuotaIva.importe");
    if (base === 0n && iva === 0n) throw new Error("Una alícuota de IVA vacía no se envía a ARCA.");
    const esperado = gruposIvaEsperados.get(id);
    if (!esperado || base !== esperado.base || iva !== esperado.importe) {
      throw new Error("El id o los importes del desglose de IVA no coinciden con los items.");
    }
  }
  if (alicuotaIds.size !== gruposIvaEsperados.size) {
    throw new Error("El desglose de IVA tiene alícuotas faltantes o adicionales.");
  }
  if (exigirOrdenCanonico && !ordenado(value.alicuotasIva as JsonCanonico[], (a, b) => compararDominio("alicuotasIva", a, b))) {
    throw new Error("alicuotasIva no respeta el orden canónico.");
  }

  if (!Array.isArray(value.tributos)) throw new Error("tributos debe ser un array.");
  const tributoKeys = new Set<string>();
  let tributosTotal = 0n;
  for (const rawTributo of value.tributos) {
    const tributo = objeto(rawTributo, "tributo");
    clavesExactas(tributo, ["id", "descripcion", "baseImponible", "alicuota", "importe"], "tributo");
    const id = entero(tributo.id, "tributo.id", 1, 9999);
    const descripcion = texto(tributo.descripcion, "tributo.descripcion")!;
    const base = centavos(tributo.baseImponible, "tributo.baseImponible");
    const tasa = porcentaje(tributo.alicuota, "tributo.alicuota");
    const importe = centavos(tributo.importe, "tributo.importe");
    if (base === 0n && tasa === 0n && importe === 0n) throw new Error("Un tributo vacío no se envía a ARCA.");
    const domainKey = `${id}\u0000${descripcion}\u0000${tributo.baseImponible}\u0000${tributo.alicuota}\u0000${tributo.importe}`;
    if (tributoKeys.has(domainKey)) throw new Error("Los tributos no pueden repetir su clave de dominio.");
    tributoKeys.add(domainKey);
    tributosTotal += importe;
  }
  if (tributosTotal !== importeTributos) throw new Error("Los tributos no coinciden con la cabecera.");
  if (exigirOrdenCanonico && !ordenado(value.tributos as JsonCanonico[], (a, b) => compararDominio("tributos", a, b))) {
    throw new Error("tributos no respeta el orden canónico.");
  }

  const receptor = objeto(value.receptor, "receptor");
  clavesExactas(
    receptor,
    ["razonSocial", "domicilio", "tipoDocumento", "numeroDocumento", "docTipoArca", "docNroArca", "condicionIva", "origen", "origenId", "verificadoArcaAt", "condicionIvaReceptorId"],
    "receptor",
  );
  const { condicionIvaReceptorId: receptorCondicionId, ...receptorBase } = receptor;
  validarReceptorFiscalConfirmado(receptorBase, Number(importeTotal) / 100);
  instante(receptor.verificadoArcaAt, "receptor.verificadoArcaAt", true);
  const condicionId = condicionIvaReceptorId(receptor.condicionIva as CondicionIva);
  if (receptorCondicionId !== condicionId) throw new Error("La condición IVA del receptor no coincide con su id ARCA.");

  const letra = value.letra as Letra;
  const esperada =
    receptor.condicionIva === "RESPONSABLE_INSCRIPTO" || receptor.condicionIva === "MONOTRIBUTO"
      ? "A"
      : "B";
  if (letra !== esperada) throw new Error("La letra no coincide con la condición IVA del receptor.");
  const tiposFactura: Record<Letra, number> = { A: 1, B: 6, C: 11 };
  const tiposNc: Record<Letra, number> = { A: 3, B: 8, C: 13 };
  const tipoEsperado = venta.tipoComprobante === "VENTA" ? tiposFactura[letra] : tiposNc[letra];
  if (identidad.cbteTipo !== tipoEsperado) throw new Error("La letra y el CbteTipo no coinciden.");

  if (value.moneda !== "PES" || value.cotizacion !== "1.000000" || !DECIMAL_SEIS.test(String(value.cotizacion))) {
    throw new Error("El rollout actual exige moneda PES y cotización 1.000000 positiva.");
  }
  const ivaContenido = centavos(value.ivaContenido, "ivaContenido");
  centavos(
    value.otrosImpuestosNacionalesIndirectos,
    "otrosImpuestosNacionalesIndirectos",
  );
  const ivaContenidoEsperado =
    letra === "B" && receptor.condicionIva === "CONSUMIDOR_FINAL"
      ? importeIva
      : 0n;
  if (ivaContenido !== ivaContenidoEsperado) throw new Error("IVA Contenido no coincide con el comprobante.");

  if (!Array.isArray(value.cbtesAsoc)) throw new Error("cbtesAsoc debe ser un array.");
  const asocKeys = new Set<string>();
  for (const rawAsoc of value.cbtesAsoc) {
    const asoc = objeto(rawAsoc, "cbteAsoc");
    clavesExactas(asoc, ["tipo", "puntoVenta", "numero", "cuit", "fecha"], "cbteAsoc");
    entero(asoc.tipo, "cbteAsoc.tipo", 1, 9_999);
    entero(asoc.puntoVenta, "cbteAsoc.puntoVenta", 1, 99_999);
    entero(asoc.numero, "cbteAsoc.numero", 1, 2_147_483_647);
    if (typeof asoc.cuit !== "string" || !cuitValido(asoc.cuit)) throw new Error("cbteAsoc.cuit debe ser válido.");
    fecha(asoc.fecha, "cbteAsoc.fecha");
    const domainKey = `${asoc.tipo}|${asoc.puntoVenta}|${asoc.numero}|${asoc.cuit}|${asoc.fecha}`;
    if (asocKeys.has(domainKey)) throw new Error("Las asociaciones no pueden repetirse.");
    asocKeys.add(domainKey);
  }
  if (exigirOrdenCanonico && !ordenado(value.cbtesAsoc as JsonCanonico[], (a, b) => compararDominio("cbtesAsoc", a, b))) {
    throw new Error("cbtesAsoc no respeta el orden canónico.");
  }
  if (venta.tipoComprobante === "VENTA") {
    if (value.origen !== "VENTA" || value.comprobanteOriginalId !== null || value.cbtesAsoc.length !== 0) {
      throw new Error("Una factura ordinaria no admite comprobante original ni asociaciones.");
    }
  } else {
    if (value.origen !== "COMPROBANTE_ORIGINAL") throw new Error("La NC debe provenir del comprobante original.");
    uuid(value.comprobanteOriginalId, "comprobanteOriginalId");
    if (value.cbtesAsoc.length !== 1) throw new Error("La NC automática exige exactamente una asociación.");
    const asoc = value.cbtesAsoc[0] as Record<string, unknown>;
    if (
      asoc.tipo !== tiposFactura[letra] ||
      asoc.puntoVenta !== identidad.puntoVenta ||
      asoc.cuit !== identidad.emisorCuit
    ) {
      throw new Error("La asociación de la NC no coincide con letra, PV y CUIT del original.");
    }
  }

  return value as unknown as SnapshotFiscalV2Body;
}

function congelarProfundo<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) congelarProfundo(child);
    Object.freeze(value);
  }
  return value;
}

export function crearSnapshotFiscalV2(input: SnapshotFiscalV2Input): SnapshotFiscalV2 {
  if (
    esRegistro(input) &&
    (Object.prototype.hasOwnProperty.call(input, "version") ||
      Object.prototype.hasOwnProperty.call(input, "hash"))
  ) {
    throw new Error("SnapshotFiscalV2Input contiene claves desconocidas: version/hash son internas.");
  }
  const normalized = clonarCanonico(input, new WeakSet(), null, true);
  const body = validarCuerpoV2(
    objeto({ ...(normalized as Record<string, JsonCanonico>), version: 2 }, "SnapshotFiscalV2"),
    true,
  );
  const hash = calcularHashSnapshotFiscal(body);
  return congelarProfundo({ ...body, hash } as SnapshotFiscalV2);
}

export function validarSnapshotFiscalV2(value: unknown): SnapshotFiscalV2 {
  const cloned = clonarCanonico(value, new WeakSet(), null, false);
  const snapshot = objeto(cloned, "SnapshotFiscalV2 persistido");
  if (snapshot.version !== 2) throw new Error("El snapshot persistido debe ser versión 2.");
  clavesExactas(snapshot, [
    "version", "hash", "venta", "items", "emisor", "sucursal", "receptor", "identidad", "letra",
    "concepto", "fechaComprobante", "importeNeto", "importeExento", "importeNoGravado",
    "importeIva", "importeTributos", "importeTotal", "alicuotasIva", "tributos", "moneda",
    "cotizacion", "ivaContenido", "otrosImpuestosNacionalesIndirectos", "origen",
    "comprobanteOriginalId", "cbtesAsoc",
  ], "SnapshotFiscalV2 persistido");
  if (typeof snapshot.hash !== "string" || !SHA256_HEX.test(snapshot.hash)) {
    throw new Error("El hash del snapshot v2 debe ser SHA-256 hexadecimal.");
  }
  const { hash, ...body } = snapshot;
  validarCuerpoV2(body, true);
  const recalculated = calcularHashSnapshotFiscal(body);
  if (hash !== recalculated) throw new Error("El hash del snapshot v2 no coincide con sus datos.");
  return congelarProfundo(snapshot as unknown as SnapshotFiscalV2);
}
