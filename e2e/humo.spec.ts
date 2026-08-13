import { test, expect, ingresar, vigilarConsola, RUTAS } from "./apoyo";

/**
 * Humo: cada pantalla abre, muestra algo y no tira errores.
 *
 * Es barato y agarra lo que más duele: una pantalla que quedó rota después de
 * un cambio en otro lado. Corre a 1366x768, la resolución donde aparecieron los
 * problemas que reportó la clienta.
 */

test.describe("todas las pantallas abren", () => {
  test.beforeEach(async ({ page }) => {
    await ingresar(page);
  });

  for (const ruta of RUTAS) {
    test(`${ruta} abre sin errores`, async ({ page }) => {
      const errores = vigilarConsola(page);
      await page.goto(ruta);

      // Que no haya quedado en el login por una sesión perdida.
      await expect(page).not.toHaveURL(/\/auth/);

      // Algo se tiene que ver: un h1 o contenido real. Una pantalla en blanco
      // devuelve 200 igual, así que el status no alcanza como prueba.
      const cuerpo = page.locator("main, body");
      await expect(cuerpo.first()).toBeVisible();
      await page.waitForLoadState("networkidle").catch(() => {});
      const texto = (await cuerpo.first().innerText()).trim();
      expect(texto.length, `la pantalla ${ruta} se ve vacía`).toBeGreaterThan(40);

      // Nada de "algo salió mal" ni pantallas de error del router.
      await expect(page.locator("body")).not.toContainText(/algo salió mal|unexpected error/i);

      expect(errores, `errores de consola en ${ruta}`).toEqual([]);
    });
  }

  test("ninguna pantalla se desborda a lo ancho", async ({ page }) => {
    const desbordadas: string[] = [];
    for (const ruta of RUTAS) {
      await page.goto(ruta);
      await page.waitForLoadState("networkidle").catch(() => {});
      const desborda = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (desborda) desbordadas.push(ruta);
    }
    expect(desbordadas, "hay scroll horizontal en la página").toEqual([]);
  });
});
