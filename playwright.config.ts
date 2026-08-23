import { defineConfig, devices } from "@playwright/test";

import { normalizarEntornoSupabaseLocalE2E } from "./e2e/entorno-supabase-local";

/**
 * Pruebas end-to-end contra el entorno LOCAL.
 *
 * Por qué existen: hasta ahora cada entrega se probaba a mano una vez y no
 * quedaba nada corriendo, así que una pantalla que se rompía en un rincón que
 * nadie tocó no la agarraba nadie hasta que la clienta la encontraba. Estas
 * pruebas corren solas.
 *
 *   bun run e2e            # todo
 *   bun run e2e:ui         # con la interfaz de Playwright, para mirar qué pasa
 *
 * NUNCA corren contra producción: `baseURL` apunta al dev server local y varias
 * pruebas escriben datos.
 */
// El 8080 es un puerto muy popular y a veces lo ocupa otra cosa. Se puede mover
// sin tocar el archivo: E2E_PUERTO=8123 npm run e2e
const PUERTO = Number(process.env.E2E_PUERTO ?? 8080);
const ESCENARIOS_FISCALES = new Set([
  "OK",
  "RECHAZO_DEFINITIVO",
  "TIMEOUT_POST_REQUEST",
  "QR_ERROR",
]);
const ESCENARIO_FISCAL = process.env.INVOICING_MOCK_SCENARIO ?? "OK";
const ENTORNO_SUPABASE_LOCAL = normalizarEntornoSupabaseLocalE2E(process.env);

if (
  process.env.NODE_ENV !== "test" ||
  process.env.INVOICING_MOCK_TEST_RUNNER !== "playwright" ||
  process.env.INVOICING_MOCK_MODE !== "true"
) {
  throw new Error(
    "Playwright exige NODE_ENV=test + runner Playwright + INVOICING_MOCK_MODE=true; se bloqueó cualquier posibilidad de ARCA externa.",
  );
}
if (!ESCENARIOS_FISCALES.has(ESCENARIO_FISCAL)) {
  throw new Error(`INVOICING_MOCK_SCENARIO inválido: ${ESCENARIO_FISCAL}.`);
}
// Los entrypoints exportan el mismo fingerprint antes de cargar este archivo;
// webServer recibe además una copia explícita y no depende de mutaciones tardías.
export default defineConfig({
  testDir: "./e2e",
  // Chequea que en el puerto esté la app y no otra cosa. Ver el archivo: sin
  // esto, cualquier servidor ajeno que quede en el 8080 hace fallar las 100
  // pruebas en el login sin explicar por qué.
  globalSetup: "./e2e/verificar-servidor.ts",
  // Los ABMC escriben en la misma base: en paralelo se pisan entre sí.
  workers: 1,
  fullyParallel: false,
  // Un test que queda colgado es un test que nadie va a esperar.
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  // En CI, un test que pasa sólo a veces es ruido: mejor que falle y se mire.
  retries: 0,
  forbidOnly: !!process.env.CI,

  use: {
    baseURL: `http://localhost:${PUERTO}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
  },

  projects: [
    {
      name: "escritorio",
      use: {
        ...devices["Desktop Chrome"],
        // La resolución de la máquina de San Armento, que es donde aparecieron
        // los diálogos rotos. Probar en un monitor grande los escondía.
        viewport: { width: 1366, height: 768 },
      },
    },
    {
      // Un celular de verdad. Corre sólo el humo y los diálogos: los ABMC y los
      // flujos largos ya se cubren en escritorio y duplicarlos acá sería el
      // doble de tiempo para probar la misma lógica.
      name: "celular",
      testMatch: /(humo|dialogos|responsive)\.spec\.ts/,
      use: { ...devices["iPhone 14"] },
    },
  ],

  webServer: {
    command: `bun run dev --port ${PUERTO}`,
    url: `http://localhost:${PUERTO}`,
    // Un escenario pertenece al proceso, no a la request. Reusar un Vite que
    // quedó levantado permitiría correr QR_ERROR contra un servidor OK (o al
    // revés), por eso cada invocación crea y destruye su propio proceso.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      ...ENTORNO_SUPABASE_LOCAL,
      NODE_ENV: "test",
      INVOICING_MOCK_TEST_RUNNER: "playwright",
      INVOICING_MOCK_MODE: "true",
      INVOICING_MOCK_SCENARIO: ESCENARIO_FISCAL,
    },
  },
});
