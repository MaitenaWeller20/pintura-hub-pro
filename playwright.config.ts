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
const PUERTO = 8080;

export default defineConfig({
  testDir: "./e2e",
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
  ],

  webServer: {
    command: "bun run dev",
    url: `http://localhost:${PUERTO}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
