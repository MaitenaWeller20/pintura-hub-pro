export const ESCENARIOS_MOCK_FISCAL = [
  "OK",
  "CAIDA_PRE_REQUEST",
  "RECHAZO_DEFINITIVO",
  "TIMEOUT_POST_REQUEST",
  "QR_ERROR",
] as const;

export type EscenarioMockFiscal = (typeof ESCENARIOS_MOCK_FISCAL)[number];

export type EntornoMockFiscal = {
  NODE_ENV?: string;
  INVOICING_MOCK_TEST_RUNNER?: string;
  VITEST?: string;
  INVOICING_MOCK_MODE?: string;
  INVOICING_MOCK_SCENARIO?: string;
};

const escenarios = new Set<string>(ESCENARIOS_MOCK_FISCAL);

/**
 * Selector exclusivo del proceso servidor de pruebas.
 *
 * No recibe request, headers ni query params. NODE_ENV=test, el runner y el
 * modo explícito son condiciones acumulativas: ninguna variable aislada
 * habilita el mock.
 */
export function entornoHabilitaMockFiscal(entorno: EntornoMockFiscal): boolean {
  const runnerDeTest =
    entorno.VITEST === "true" || entorno.INVOICING_MOCK_TEST_RUNNER === "playwright";
  return entorno.NODE_ENV === "test" && runnerDeTest && entorno.INVOICING_MOCK_MODE === "true";
}

export function entornoMockFiscalDelProceso(): EntornoMockFiscal {
  return {
    // El acceso dinámico evita el reemplazo de process.env.NODE_ENV que Vite
    // aplica al compilar el dev server iniciado por Playwright.
    NODE_ENV: process.env["NODE_ENV"],
    INVOICING_MOCK_TEST_RUNNER: process.env["INVOICING_MOCK_TEST_RUNNER"],
    VITEST: process.env["VITEST"],
    INVOICING_MOCK_MODE: process.env["INVOICING_MOCK_MODE"],
    INVOICING_MOCK_SCENARIO: process.env["INVOICING_MOCK_SCENARIO"],
  };
}

export function crearFingerprintServidorFiscalE2E(entorno: EntornoMockFiscal): {
  app: "PinturaGest";
  nodeEnv: "test";
  runner: "playwright";
  mockMode: true;
  scenario: EscenarioMockFiscal;
} | null {
  if (!entornoHabilitaMockFiscal(entorno) || entorno.INVOICING_MOCK_TEST_RUNNER !== "playwright") {
    return null;
  }
  return {
    app: "PinturaGest",
    nodeEnv: "test",
    runner: "playwright",
    mockMode: true,
    scenario: resolverEscenarioMockFiscal(entorno),
  };
}

export function resolverEscenarioMockFiscal(entorno: EntornoMockFiscal): EscenarioMockFiscal {
  if (!entornoHabilitaMockFiscal(entorno)) return "OK";
  const value = entorno.INVOICING_MOCK_SCENARIO ?? "OK";
  if (!escenarios.has(value)) {
    throw new Error(`Escenario fiscal mock inválido: ${value}.`);
  }
  return value as EscenarioMockFiscal;
}

export function escenarioMockFiscalActual(): EscenarioMockFiscal {
  return resolverEscenarioMockFiscal(entornoMockFiscalDelProceso());
}
