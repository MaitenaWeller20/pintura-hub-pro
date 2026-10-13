import type { AmbienteArca } from "./contexto";
import { codigoErrorFiscalUsuario, crearErrorFiscalUsuario } from "./error-usuario";
import {
  esCodigoErrorPadronArca,
  type CodigoErrorPadronArca,
  type ReceptorPadronArca,
} from "./padron-arca-shared";
import { z } from "zod";

export type EstadoPadronArcaPublico = {
  padron_probado_at: string | null;
  padron_validacion_activa: boolean;
  padron_ultimo_error_codigo: CodigoErrorPadronArca | null;
  padron_ultimo_error_at: string | null;
};

export type CredencialArcaPublica = {
  ambiente: AmbienteArca;
  tiene_clave: boolean;
  tiene_certificado: boolean;
  cert_vence_at: string | null;
  cert_alias: string | null;
  probada_at: string | null;
  habilitada: boolean;
} & EstadoPadronArcaPublico;

export type CredencialArcaSecreta = {
  ambiente: AmbienteArca;
  arca_key_enc: string | null;
  arca_cert_enc: string | null;
  cert_vence_at: string | null;
  cert_alias: string | null;
  probada_at: string | null;
  habilitada: boolean;
  padron_probado_at: string | null;
  padron_validacion_activa: boolean;
  padron_ultimo_error_codigo: string | null;
  padron_ultimo_error_at: string | null;
};

/** Convierte filas privadas en el único formato que puede llegar al navegador. */
export function normalizarCredencialesPublicas(
  rows: CredencialArcaSecreta[],
): CredencialArcaPublica[] {
  return (["HOMOLOGACION", "PRODUCCION"] as const).map((ambiente) => {
    const row = rows.find((item) => item.ambiente === ambiente);
    const codigoGuardado = row?.padron_ultimo_error_codigo ?? null;
    return {
      ambiente,
      tiene_clave: Boolean(row?.arca_key_enc),
      tiene_certificado: Boolean(row?.arca_cert_enc),
      cert_vence_at: row?.cert_vence_at ?? null,
      cert_alias: row?.cert_alias ?? null,
      probada_at: row?.probada_at ?? null,
      habilitada: row?.habilitada ?? false,
      padron_probado_at: row?.padron_probado_at ?? null,
      padron_validacion_activa: row?.padron_validacion_activa ?? false,
      padron_ultimo_error_codigo:
        codigoGuardado === null
          ? null
          : esCodigoErrorPadronArca(codigoGuardado)
            ? codigoGuardado
            : "PADRON_CONFIG_INVALIDA",
      padron_ultimo_error_at: row?.padron_ultimo_error_at ?? null,
    };
  });
}

export type EntradaPruebaActivacionPadron = {
  mockMode: boolean;
  cuitEmisor: string;
  consultar(cuit: string): Promise<ReceptorPadronArca>;
  registrarExito(fecha: string): Promise<void>;
  registrarFallo(input: { codigo: CodigoErrorPadronArca; fecha: string }): Promise<void>;
  ahora(): Date;
};

export type EntradaPruebaPadron = {
  emisor_id: string;
  ambiente: AmbienteArca;
};

export type ResultadoPruebaPadron = {
  cuit: string;
  razon_social: string;
  probado_at: string;
};

export async function ejecutarPruebaActivacionPadron(
  input: EntradaPruebaActivacionPadron,
): Promise<ResultadoPruebaPadron> {
  if (input.mockMode) throw crearErrorFiscalUsuario("PADRON_CONFIG_INVALIDA");

  let ahora: Date;
  try {
    ahora = input.ahora();
  } catch {
    throw crearErrorFiscalUsuario("PADRON_CONFIG_INVALIDA");
  }
  if (!(ahora instanceof Date) || !Number.isFinite(ahora.getTime())) {
    throw crearErrorFiscalUsuario("PADRON_CONFIG_INVALIDA");
  }
  const fecha = ahora.toISOString();

  try {
    const receptor = await input.consultar(input.cuitEmisor);
    if (receptor.cuit !== input.cuitEmisor) {
      throw crearErrorFiscalUsuario("RESPUESTA_PADRON_INVALIDA");
    }
    await input.registrarExito(fecha);
    return {
      cuit: receptor.cuit,
      razon_social: receptor.razonSocial,
      probado_at: fecha,
    };
  } catch (cause) {
    let marcado = null;
    try {
      marcado = codigoErrorFiscalUsuario(cause);
    } catch {
      // Una excepción remota hostil no puede escapar de la clasificación cerrada.
    }
    const codigo = esCodigoErrorPadronArca(marcado) ? marcado : "PADRON_CONFIG_INVALIDA";
    try {
      await input.registrarFallo({ codigo, fecha });
    } catch {
      throw crearErrorFiscalUsuario("PADRON_CONFIG_INVALIDA");
    }
    throw crearErrorFiscalUsuario(codigo);
  }
}

type EstadoPrivadoCredencial = Pick<
  CredencialArcaSecreta,
  "arca_key_enc" | "arca_cert_enc" | "cert_vence_at" | "probada_at"
>;

export function validarHabilitacionCredencial(
  credencial: EstadoPrivadoCredencial,
  habilitada: boolean,
  ahora = new Date(),
): void {
  if (!habilitada) return;
  if (!credencial.arca_key_enc || !credencial.arca_cert_enc) {
    throw new Error("Cargá y verificá el certificado antes de habilitar esta credencial.");
  }
  const vence = credencial.cert_vence_at ? new Date(credencial.cert_vence_at) : null;
  if (!vence || !Number.isFinite(vence.getTime()) || vence <= ahora) {
    throw new Error("El certificado está vencido o no tiene un vencimiento válido.");
  }
  if (!credencial.probada_at) {
    throw new Error("Primero hay que probar la conexión real con ARCA.");
  }
}

export type EstadoFiscalPublicoMinimo = { mock_mode: boolean };

export const QUERY_KEY_ESTADO_FISCAL_PUBLICO = ["fiscal-runtime-public"] as const;
export const QUERY_KEY_CONFIG_FISCAL_ADMIN = ["fiscal-config-multiemisor"] as const;

/** Respuesta operativa deliberadamente mínima para usuarios no administradores. */
export function estadoFiscalPublicoMinimo(mockMode: boolean): EstadoFiscalPublicoMinimo {
  return { mock_mode: mockMode };
}

export type ResultadoPruebaSecuencias = {
  secuencia_b: { cbte_tipo: 6; ultimo: number };
  secuencia_a: { cbte_tipo: 1; ultimo: number };
};

type ConsultarUltimo = (cbteTipo: 6 | 1) => Promise<number>;
type RegistrarConexion = (campos: { probada_at: string }) => Promise<void>;

/**
 * Verifica acceso técnico a ambas secuencias. No recibe ni puede escribir la
 * evidencia administrativa del emisor.
 */
export async function probarAccesoSecuenciasFactura(
  consultarUltimo: ConsultarUltimo,
  registrarConexion?: RegistrarConexion,
  ahora = new Date(),
): Promise<ResultadoPruebaSecuencias> {
  const ultimoB = await consultarUltimo(6);
  const ultimoA = await consultarUltimo(1);
  if (!Number.isInteger(ultimoB) || ultimoB < 0 || !Number.isInteger(ultimoA) || ultimoA < 0) {
    throw new Error("ARCA devolvió una secuencia de comprobantes inválida.");
  }
  if (registrarConexion) {
    await registrarConexion({ probada_at: ahora.toISOString() });
  }
  return {
    secuencia_b: { cbte_tipo: 6, ultimo: ultimoB },
    secuencia_a: { cbte_tipo: 1, ultimo: ultimoA },
  };
}

/** En simulación no resuelve certificados ni abre un flujo que parezca una prueba real. */
export async function probarConexionSegunModo(
  mockMode: boolean,
  ejecutarReal: () => Promise<ResultadoPruebaSecuencias>,
): Promise<ResultadoPruebaSecuencias> {
  if (mockMode) {
    return {
      secuencia_b: { cbte_tipo: 6, ultimo: 0 },
      secuencia_a: { cbte_tipo: 1, ultimo: 0 },
    };
  }
  return ejecutarReal();
}

function fechaIsoCalendarioValida(fecha: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const comprobacion = new Date(Date.UTC(year, month - 1, day));
  return (
    comprobacion.getUTCFullYear() === year &&
    comprobacion.getUTCMonth() === month - 1 &&
    comprobacion.getUTCDate() === day
  );
}

export const confirmacionModalidadFacturaASchema = z
  .object({
    emisor_id: z.string().uuid(),
    modalidad: z.enum(["ESTANDAR_CONFIRMADA", "NO_SOPORTADA"]),
    evidencia: z
      .string()
      .trim()
      .min(1, "La fuente o evidencia es obligatoria.")
      .max(1_000, "La fuente o evidencia no puede superar 1000 caracteres."),
    revalidar_at: z
      .string()
      .refine(fechaIsoCalendarioValida, "La fecha de revalidación no es válida."),
  })
  .strict();

export type ConfirmacionModalidadFacturaA = z.infer<typeof confirmacionModalidadFacturaASchema>;

export function actualizacionModalidadFacturaA(
  entrada: ConfirmacionModalidadFacturaA,
  adminId: string,
  ahora = new Date(),
) {
  if (!Number.isFinite(ahora.getTime())) throw new Error("La hora del servidor no es válida.");
  return {
    factura_a_modalidad: entrada.modalidad,
    factura_a_confirmada_at: ahora.toISOString(),
    factura_a_confirmada_por: adminId,
    factura_a_evidencia: entrada.evidencia.trim(),
    factura_a_revalidar_at: entrada.revalidar_at,
  } as const;
}

/** Impide incluso crear el cliente service-role antes de autenticar al admin. */
export async function autorizarAntesDeClientePrivilegiado<T>(
  autorizar: () => Promise<void>,
  crearCliente: () => Promise<T>,
): Promise<T> {
  await autorizar();
  return crearCliente();
}

export function exigirEmisorActualizado(fila: { id: string } | null): void {
  if (!fila?.id) throw new Error("El emisor no existe o ya no está disponible.");
}
