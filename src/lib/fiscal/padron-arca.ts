import { z } from "zod";
import { cuitValido } from "./codigos";
import { crearErrorFiscalUsuario } from "./error-usuario";

const IMPUESTO_MONOTRIBUTO = 20;
const IMPUESTO_IVA = 30;

export const receptorPadronArcaSchema = z
  .object({
    cuit: z.string().refine(cuitValido),
    razonSocial: z.string().trim().min(1),
    domicilioFiscal: z.string().trim().min(1).nullable(),
    estado: z.literal("ACTIVO"),
    tipoPersona: z.enum(["FISICA", "JURIDICA"]),
    condicionIvaConfirmada: z.enum(["RESPONSABLE_INSCRIPTO", "MONOTRIBUTO"]).nullable(),
    verificadoArcaAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ReceptorPadronArca = z.infer<typeof receptorPadronArcaSchema>;

export const CODIGOS_ERROR_PADRON_ARCA = [
  "PADRON_ARCA_CAIDO",
  "PADRON_NO_AUTORIZADO",
  "PADRON_CONFIG_INVALIDA",
  "CUIT_INVALIDO",
  "CUIT_NO_ENCONTRADO",
  "CUIT_INACTIVO",
  "RESPUESTA_PADRON_INVALIDA",
  "CONDICION_FISCAL_INCOMPATIBLE",
] as const;

export type CodigoErrorPadronArca = (typeof CODIGOS_ERROR_PADRON_ARCA)[number];

export function esCodigoErrorPadronArca(value: unknown): value is CodigoErrorPadronArca {
  return (
    typeof value === "string" && (CODIGOS_ERROR_PADRON_ARCA as readonly string[]).includes(value)
  );
}

export type DependenciasPadronArca = {
  obtenerContribuyente(cuit: number): Promise<unknown | null>;
  ahora(): Date;
};

function respuestaInvalida(): never {
  throw crearErrorFiscalUsuario("RESPUESTA_PADRON_INVALIDA");
}

function esRegistro(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototipo = Object.getPrototypeOf(value);
    if (prototipo !== Object.prototype && prototipo !== null) return false;
    return Reflect.ownKeys(value).every((clave) => {
      if (typeof clave !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, clave);
      return Boolean(descriptor && "value" in descriptor && !descriptor.get && !descriptor.set);
    });
  } catch {
    return false;
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

function listaRegistros(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
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
        (clave) =>
          typeof clave !== "string" || (clave !== "length" && !/^(0|[1-9]\d*)$/.test(clave)),
      ) ||
      claves.length !== longitud + 1
    ) {
      respuestaInvalida();
    }
    const registros: Record<string, unknown>[] = [];
    for (let index = 0; index < longitud; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set)
        respuestaInvalida();
      if (!esRegistro(descriptor.value)) respuestaInvalida();
      registros.push(descriptor.value);
    }
    return registros;
  } catch {
    return respuestaInvalida();
  }
}

function impuestoActivo(bloque: unknown, idImpuesto: number): boolean {
  if (!esRegistro(bloque)) return false;
  return listaRegistros(bloque.impuesto).some(
    (item) => entero(item.idImpuesto) === idImpuesto && texto(item.estadoImpuesto) === "AC",
  );
}

function condicionConfirmada(
  persona: Record<string, unknown>,
): ReceptorPadronArca["condicionIvaConfirmada"] {
  const ri = impuestoActivo(persona.datosRegimenGeneral, IMPUESTO_IVA);
  const mono = impuestoActivo(persona.datosMonotributo, IMPUESTO_MONOTRIBUTO);
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
    throw crearErrorFiscalUsuario("CUIT_INACTIVO");
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
  if (!esRegistro(generales.domicilioFiscal)) respuestaInvalida();
  const segmentos = ["direccion", "localidad", "descripcionProvincia", "codPostal"]
    .map((campo) => parteDomicilio(generales.domicilioFiscal as Record<string, unknown>, campo))
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
  if (!esRegistro(respuesta)) respuestaInvalida();
  if (!esRegistro(respuesta.datosGenerales)) respuestaInvalida();
  const generales = respuesta.datosGenerales;
  const cuitNumerico = Number(cuit);
  validarIdentidad(respuesta, generales, cuitNumerico);
  const tipo = tipoPersona(respuesta, generales);
  validarEstadoActivo(respuesta, generales);
  const resultado = {
    cuit,
    razonSocial: identidad(generales, tipo),
    domicilioFiscal: domicilioFiscal(generales),
    estado: "ACTIVO" as const,
    tipoPersona: tipo,
    condicionIvaConfirmada: condicionConfirmada(respuesta),
    verificadoArcaAt: fechaVerificacion(ahora),
  };
  const validacion = receptorPadronArcaSchema.safeParse(resultado);
  if (!validacion.success) respuestaInvalida();
  return validacion.data;
}

export async function consultarPadronArca(
  cuit: string,
  deps: DependenciasPadronArca,
): Promise<ReceptorPadronArca> {
  if (!cuitValido(cuit)) throw crearErrorFiscalUsuario("CUIT_INVALIDO");
  const cuitCanonico = cuit.replace(/\D/g, "");
  const respuesta = await deps.obtenerContribuyente(Number(cuitCanonico));
  if (respuesta === null) throw crearErrorFiscalUsuario("CUIT_NO_ENCONTRADO");
  let ahora: Date;
  try {
    ahora = deps.ahora();
  } catch {
    return respuestaInvalida();
  }
  return normalizarContribuyente(cuitCanonico, respuesta, ahora);
}
