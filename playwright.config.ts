import { defineConfig, devices } from "@playwright/test";

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
// sin tocar el archivo:  E2E_PUERTO=8123 npx playwright test
const PUERTO = Number(process.env.E2E_PUERTO ?? 8080);

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
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
