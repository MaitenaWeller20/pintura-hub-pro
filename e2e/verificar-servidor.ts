/**
 * Antes de correr nada: confirmar que en el puerto está NUESTRA app.
 *
 * Playwright no reutiliza servidores porque el escenario fiscal pertenece al
 * proceso. Este chequeo sigue distinguiendo nuestra app de otro servicio si el
 * puerto elegido ya estaba ocupado o el arranque quedó apuntando a otro lugar.
 *
 * Esto lo convierte en un mensaje solo, claro, y antes de perder diez minutos.
 */
import type { FullConfig } from "@playwright/test";

import {
  crearRepositorioEmpleadoLocalHttp,
  prepararAdminLocalE2E,
  prepararEmpleadoLocalE2E,
  type LimpiarEmpleadoLocalE2E,
} from "./empleado-local";

type EntornoServidorE2E = {
  NODE_ENV?: string;
  INVOICING_MOCK_TEST_RUNNER?: string;
  INVOICING_MOCK_MODE?: string;
  INVOICING_MOCK_SCENARIO?: string;
};

const ESCENARIOS = new Set(["OK", "RECHAZO_DEFINITIVO", "TIMEOUT_POST_REQUEST", "QR_ERROR"]);

export function validarEntornoServidorE2E(entorno: EntornoServidorE2E): void {
  if (
    entorno.NODE_ENV !== "test" ||
    entorno.INVOICING_MOCK_TEST_RUNNER !== "playwright" ||
    entorno.INVOICING_MOCK_MODE !== "true"
  ) {
    throw new Error(
      "El servidor Playwright no está aislado en NODE_ENV=test + runner Playwright + modo mock " +
        `(node=${entorno.NODE_ENV ?? "ausente"}, ` +
        `runner=${entorno.INVOICING_MOCK_TEST_RUNNER === "playwright"}, ` +
        `mock=${entorno.INVOICING_MOCK_MODE === "true"}).`,
    );
  }
  const escenario = entorno.INVOICING_MOCK_SCENARIO ?? "OK";
  if (!ESCENARIOS.has(escenario)) {
    throw new Error(`El servidor Playwright recibió un escenario fiscal inválido: ${escenario}.`);
  }
}

export function esFingerprintPinturaGest(estado: number, cuerpo: string): boolean {
  return estado === 200 && /PinturaGest/i.test(cuerpo);
}

export function esFingerprintServidorFiscalE2E(
  estado: number,
  cuerpo: string,
  escenarioEsperado: string,
): boolean {
  if (estado !== 200) return false;
  try {
    const value = JSON.parse(cuerpo) as Record<string, unknown>;
    return (
      value.app === "PinturaGest" &&
      value.nodeEnv === "test" &&
      value.runner === "playwright" &&
      value.mockMode === true &&
      value.scenario === escenarioEsperado
    );
  } catch {
    return false;
  }
}

export default async function verificarServidor(config: FullConfig) {
  validarEntornoServidorE2E(process.env);

  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) return;

  const url = `${baseURL}/auth`;
  let cuerpo = "";
  let estado = 0;
  try {
    const r = await fetch(url);
    estado = r.status;
    cuerpo = await r.text();
  } catch (e) {
    throw new Error(
      `No se pudo hablar con ${url}.\n` +
        `Levantá el entorno con: bun run dev  (y supabase start si hace falta)\n` +
        `Detalle: ${(e as Error).message}`,
    );
  }

  // El <title> lo pone la app; cualquier otro servidor no lo va a tener.
  const esNuestra = esFingerprintPinturaGest(estado, cuerpo);
  if (!esNuestra) {
    throw new Error(
      `En ${baseURL} hay algo escuchando, pero NO es PinturaGest ` +
        `(GET /auth devolvió ${estado}).\n` +
        `Playwright lo estaba tomando por el dev server y todas las pruebas ` +
        `fallaban en el login sin decir por qué.\n\n` +
        `Mirá qué lo ocupa:  lsof -nP -iTCP:${new URL(baseURL).port} -sTCP:LISTEN\n` +
        `Después cerrá ese proceso, o cambiá PUERTO en playwright.config.ts.`,
    );
  }

  const escenario = process.env.INVOICING_MOCK_SCENARIO ?? "OK";
  const endpoint = `${baseURL}/api/e2e-fingerprint`;
  let respuestaFingerprint: Response;
  try {
    respuestaFingerprint = await fetch(endpoint, { cache: "no-store" });
  } catch (error) {
    throw new Error(
      `El servidor local no expuso su fingerprint fiscal E2E. Detalle: ${(error as Error).message}`,
    );
  }
  const cuerpoFingerprint = await respuestaFingerprint.text();
  if (!esFingerprintServidorFiscalE2E(respuestaFingerprint.status, cuerpoFingerprint, escenario)) {
    throw new Error(
      "El proceso servidor no confirmó NODE_ENV=test + runner Playwright + modo mock + escenario esperado.",
    );
  }

  // Un reset limpio sólo tiene los datos de catálogo. La suite histórica entra
  // con admin@local.test y los escenarios de permisos usan además un empleado
  // en ambas sucursales. Ambos fixtures se crean acá y el teardown revierte
  // sólo lo creado o agregado por esta corrida.
  const repositorioEmpleado = crearRepositorioEmpleadoLocalHttp(process.env);
  const limpiezas: LimpiarEmpleadoLocalE2E[] = [];
  try {
    limpiezas.push(await prepararAdminLocalE2E(repositorioEmpleado));
    limpiezas.push(await prepararEmpleadoLocalE2E(repositorioEmpleado));
  } catch (error) {
    const errores: unknown[] = [error];
    for (const limpiar of [...limpiezas].reverse()) {
      try {
        await limpiar();
      } catch (cleanupError) {
        errores.push(cleanupError);
      }
    }
    if (errores.length > 1) {
      throw new AggregateError(errores, "Falló el bootstrap E2E y también su limpieza.");
    }
    throw error;
  }

  return async () => {
    const errores: unknown[] = [];
    for (const limpiar of [...limpiezas].reverse()) {
      try {
        await limpiar();
      } catch (error) {
        errores.push(error);
      }
    }
    if (errores.length > 0) {
      throw new AggregateError(errores, "No se pudieron limpiar todos los usuarios locales E2E.");
    }
  };
}
