import { types as tiposNode } from "node:util";
import { cuitValido } from "./codigos";
import { crearErrorFiscalUsuario } from "./error-usuario";
import {
  esCodigoErrorPadronArca,
  receptorPadronArcaSchema,
  type CodigoErrorPadronArca,
  type ReceptorPadronArca,
} from "./padron-arca-shared";

export {
  CODIGOS_ERROR_PADRON_ARCA,
  esCodigoErrorPadronArca,
  receptorPadronArcaSchema,
  type CodigoErrorPadronArca,
  type ReceptorPadronArca,
} from "./padron-arca-shared";

const IMPUESTO_MONOTRIBUTO = 20;
const IMPUESTO_IVA = 30;

export type DependenciasPadronArca = {
  obtenerContribuyente(cuit: number): Promise<unknown | null>;
  ahora(): Date;
};

const CODIGO_ERROR_PADRON_INTERNO = Symbol("codigoErrorPadronArcaInterno");

type ErrorPadronArcaInterno = Error & {
  [CODIGO_ERROR_PADRON_INTERNO]: CodigoErrorPadronArca;
};

function crearErrorPadronInterno(codigo: CodigoErrorPadronArca): ErrorPadronArcaInterno {
  const error = new Error("PADRON_ARCA_INTERNO") as ErrorPadronArcaInterno;
  Object.defineProperty(error, CODIGO_ERROR_PADRON_INTERNO, {
    value: codigo,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return error;
}

/**
 * Reconoce sólo errores creados por este módulo. El símbolo privado impide
 * que una respuesta o un rechazo del SDK falsifique un código de dominio.
 */
export function codigoErrorPadronArcaInterno(cause: unknown): CodigoErrorPadronArca | null {
  if (typeof cause !== "object" || cause === null || tiposNode.isProxy(cause)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, CODIGO_ERROR_PADRON_INTERNO);
    return descriptor && "value" in descriptor && esCodigoErrorPadronArca(descriptor.value)
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function errorPadron(codigo: CodigoErrorPadronArca): never {
  throw crearErrorPadronInterno(codigo);
}

function respuestaInvalida(): never {
  return errorPadron("RESPUESTA_PADRON_INVALIDA");
}

function snapshotRegistroUnaVez(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    tiposNode.isProxy(value) ||
    Array.isArray(value)
  ) {
    respuestaInvalida();
  }
  const prototipo = Object.getPrototypeOf(value);
  if (prototipo !== Object.prototype && prototipo !== null) respuestaInvalida();
  const copia: Record<string, unknown> = Object.create(null);
  for (const clave of Reflect.ownKeys(value)) {
    if (typeof clave !== "string") respuestaInvalida();
    const descriptor = Object.getOwnPropertyDescriptor(value, clave);
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) {
      respuestaInvalida();
    }
    Object.defineProperty(copia, clave, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return copia;
}

function snapshotsIguales(
  primero: Record<string, unknown>,
  segundo: Record<string, unknown>,
): boolean {
  const primerasClaves = Object.keys(primero);
  const segundasClaves = Object.keys(segundo);
  return (
    primerasClaves.length === segundasClaves.length &&
    primerasClaves.every(
      (clave, index) =>
        clave === segundasClaves[index] && Object.is(primero[clave], segundo[clave]),
    )
  );
}

function snapshotRegistro(value: unknown): Record<string, unknown> {
  try {
    const primero = snapshotRegistroUnaVez(value);
    const segundo = snapshotRegistroUnaVez(value);
    if (!snapshotsIguales(primero, segundo)) respuestaInvalida();
    return segundo;
  } catch {
    return respuestaInvalida();
  }
}

function tieneCampo(registro: Record<string, unknown>, campo: string): boolean {
  return Object.hasOwn(registro, campo);
}

function texto(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalizado = value.trim();
  return normalizado === "" ? null : normalizado;
}

function entero(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
    ? value
    : null;
}

function snapshotListaUnaVez(value: unknown): unknown[] {
  if (
    typeof value !== "object" ||
    value === null ||
    tiposNode.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    respuestaInvalida();
  const descriptorLongitud = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !descriptorLongitud ||
    !("value" in descriptorLongitud) ||
    !Number.isSafeInteger(descriptorLongitud.value) ||
    descriptorLongitud.value < 0
  ) {
    respuestaInvalida();
  }
  const longitud = descriptorLongitud.value;
  const claves = Reflect.ownKeys(value);
  if (
    claves.some(
      (clave) => typeof clave !== "string" || (clave !== "length" && !/^(0|[1-9]\d*)$/.test(clave)),
    ) ||
    claves.length !== longitud + 1
  ) {
    respuestaInvalida();
  }
  const valores: unknown[] = [];
  for (let index = 0; index < longitud; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set)
      respuestaInvalida();
    valores.push(descriptor.value);
  }
  return valores;
}

function snapshotListaRegistros(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  try {
    const primeros = snapshotListaUnaVez(value);
    const segundos = snapshotListaUnaVez(value);
    if (
      primeros.length !== segundos.length ||
      primeros.some((item, index) => !Object.is(item, segundos[index]))
    ) {
      respuestaInvalida();
    }
    return segundos.map(snapshotRegistro);
  } catch {
    return respuestaInvalida();
  }
}

function impuestoActivo(
  persona: Record<string, unknown>,
  campo: "datosRegimenGeneral" | "datosMonotributo",
  idImpuestoBuscado: number,
): boolean {
  if (!tieneCampo(persona, campo) || persona[campo] === undefined) return false;
  const bloque = snapshotRegistro(persona[campo]);
  const impuestos = snapshotListaRegistros(
    tieneCampo(bloque, "impuesto") ? bloque.impuesto : undefined,
  );
  return impuestos.some((item) => {
    const idImpuesto = entero(item.idImpuesto);
    const estadoImpuesto = texto(item.estadoImpuesto);
    if (idImpuesto === null || estadoImpuesto === null) respuestaInvalida();
    return idImpuesto === idImpuestoBuscado && estadoImpuesto === "AC";
  });
}

function condicionConfirmada(
  persona: Record<string, unknown>,
): ReceptorPadronArca["condicionIvaConfirmada"] {
  const ri = impuestoActivo(persona, "datosRegimenGeneral", IMPUESTO_IVA);
  const mono = impuestoActivo(persona, "datosMonotributo", IMPUESTO_MONOTRIBUTO);
  if (ri && mono) respuestaInvalida();
  return ri ? "RESPONSABLE_INSCRIPTO" : mono ? "MONOTRIBUTO" : null;
}

function valoresDeCampo(
  persona: Record<string, unknown>,
  generales: Record<string, unknown>,
  campo: string,
): unknown[] {
  return [
    ...(tieneCampo(persona, campo) ? [persona[campo]] : []),
    ...(tieneCampo(generales, campo) ? [generales[campo]] : []),
  ];
}

function validarIdentidad(
  persona: Record<string, unknown>,
  generales: Record<string, unknown>,
  cuit: number,
): void {
  const ids = valoresDeCampo(persona, generales, "idPersona");
  if (ids.length === 0 || ids.some((id) => entero(id) !== cuit)) respuestaInvalida();
}

function tipoPersona(
  persona: Record<string, unknown>,
  generales: Record<string, unknown>,
): ReceptorPadronArca["tipoPersona"] {
  const tipos = valoresDeCampo(persona, generales, "tipoPersona");
  if (tipos.length === 0 || tipos.some((tipo) => tipo !== "FISICA" && tipo !== "JURIDICA")) {
    respuestaInvalida();
  }
  const [tipo] = tipos as ReceptorPadronArca["tipoPersona"][];
  if (tipos.some((otro) => otro !== tipo)) respuestaInvalida();
  return tipo;
}

function validarEstadoActivo(
  persona: Record<string, unknown>,
  generales: Record<string, unknown>,
): void {
  const estados = valoresDeCampo(persona, generales, "estadoClave");
  if (estados.length === 0 || estados.some((estado) => typeof estado !== "string")) {
    respuestaInvalida();
  }
  if (estados.some((estado) => estado !== "ACTIVO")) {
    errorPadron("CUIT_INACTIVO");
  }
}

function identidad(
  generales: Record<string, unknown>,
  tipo: ReceptorPadronArca["tipoPersona"],
): string {
  if (tipo === "JURIDICA") {
    const razonSocial = texto(generales.razonSocial);
    if (!razonSocial) respuestaInvalida();
    return razonSocial;
  }
  const apellido = texto(generales.apellido);
  const nombre = texto(generales.nombre);
  if (!apellido || !nombre) respuestaInvalida();
  return `${apellido} ${nombre}`;
}

function parteDomicilio(domicilio: Record<string, unknown>, campo: string): string | null {
  if (!tieneCampo(domicilio, campo)) return null;
  const value = domicilio[campo];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") respuestaInvalida();
  return texto(value);
}

function domicilioFiscal(generales: Record<string, unknown>): string | null {
  if (!tieneCampo(generales, "domicilioFiscal") || generales.domicilioFiscal === null) return null;
  const domicilio = snapshotRegistro(generales.domicilioFiscal);
  const segmentos = ["direccion", "localidad", "descripcionProvincia", "codPostal"]
    .map((campo) => parteDomicilio(domicilio, campo))
    .filter((parte): parte is string => parte !== null);
  const vistos = new Set<string>();
  return (
    segmentos
      .filter((parte) => {
        const clave = parte.toLocaleLowerCase("es-AR");
        if (vistos.has(clave)) return false;
        vistos.add(clave);
        return true;
      })
      .join(", ") || null
  );
}

function fechaVerificacion(ahora: Date): string {
  if (!(ahora instanceof Date) || !Number.isFinite(ahora.getTime())) respuestaInvalida();
  try {
    return ahora.toISOString();
  } catch {
    return respuestaInvalida();
  }
}

function normalizarContribuyente(
  cuit: string,
  respuesta: unknown,
  ahora: Date,
): ReceptorPadronArca {
  const persona = snapshotRegistro(respuesta);
  if (!tieneCampo(persona, "datosGenerales")) respuestaInvalida();
  const generales = snapshotRegistro(persona.datosGenerales);
  const cuitNumerico = Number(cuit);
  validarIdentidad(persona, generales, cuitNumerico);
  const tipo = tipoPersona(persona, generales);
  validarEstadoActivo(persona, generales);
  const resultado = {
    cuit,
    razonSocial: identidad(generales, tipo),
    domicilioFiscal: domicilioFiscal(generales),
    estado: "ACTIVO" as const,
    tipoPersona: tipo,
    condicionIvaConfirmada: condicionConfirmada(persona),
    verificadoArcaAt: fechaVerificacion(ahora),
  };
  const validacion = receptorPadronArcaSchema.safeParse(resultado);
  if (!validacion.success) respuestaInvalida();
  return validacion.data;
}

export async function consultarPadronArcaInterno(
  cuit: string,
  deps: DependenciasPadronArca,
): Promise<ReceptorPadronArca> {
  if (!cuitValido(cuit)) errorPadron("CUIT_INVALIDO");
  const cuitCanonico = cuit.replace(/\D/g, "");
  const respuesta = await deps.obtenerContribuyente(Number(cuitCanonico));
  if (respuesta === null) errorPadron("CUIT_NO_ENCONTRADO");
  let ahora: Date;
  try {
    ahora = deps.ahora();
  } catch {
    return respuestaInvalida();
  }
  return normalizarContribuyente(cuitCanonico, respuesta, ahora);
}

export async function consultarPadronArca(
  cuit: string,
  deps: DependenciasPadronArca,
): Promise<ReceptorPadronArca> {
  try {
    return await consultarPadronArcaInterno(cuit, deps);
  } catch (cause) {
    const codigo = codigoErrorPadronArcaInterno(cause) ?? "RESPUESTA_PADRON_INVALIDA";
    throw crearErrorFiscalUsuario(codigo);
  }
}
