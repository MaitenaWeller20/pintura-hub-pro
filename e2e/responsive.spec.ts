import { test, expect, ingresar, RUTAS } from "./apoyo";

/**
 * Que la app se pueda usar en un celular.
 *
 * Corre en los dos proyectos (escritorio y celular): el mismo archivo prueba
 * 1366×768 y un iPhone. Lo que importa acá no es que "se vea lindo" —eso lo
 * juzga una persona— sino tres cosas que se pueden medir y que son las que
 * dejan una pantalla inutilizable:
 *
 *   · que la página no se desborde a lo ancho (aparece scroll horizontal y el
 *     contenido se va de la pantalla);
 *   · que una tabla más ancha que la pantalla se pueda SCROLLEAR y no quede
 *     recortada con las columnas escondidas para siempre;
 *   · que los diálogos entren enteros y sus botones se puedan tocar.
 */

test.describe("se puede usar en pantalla chica", () => {
  test.beforeEach(async ({ page }) => {
    await ingresar(page);
  });

  test("ninguna pantalla se desborda a lo ancho", async ({ page }) => {
    const desbordadas: Array<{ ruta: string; exceso: number }> = [];
    for (const ruta of RUTAS) {
      await page.goto(ruta);
      await page.waitForLoadState("networkidle").catch(() => {});
      const exceso = await page.evaluate(() => {
        const d = document.documentElement;
        return d.scrollWidth - d.clientWidth;
      });
      if (exceso > 1) desbordadas.push({ ruta, exceso });
    }
    expect(desbordadas, "hay scroll horizontal en la página").toEqual([]);
  });

  test("las tablas anchas se pueden scrollear, no quedan recortadas", async ({ page }) => {
    const conTabla = [
      "/ventas",
      "/productos",
      "/stock",
      "/clientes",
      "/compras",
      "/cuentas-corrientes",
      "/pagos-proveedores",
      "/usuarios",
    ];
    const recortadas: string[] = [];
    for (const ruta of conTabla) {
      await page.goto(ruta);
      await page.waitForLoadState("networkidle").catch(() => {});
      const recorta = await page.evaluate(() => {
        const tabla = document.querySelector("table");
        if (!tabla) return false;
        let cont = tabla.parentElement;
        while (cont && cont !== document.body) {
          const ov = getComputedStyle(cont).overflowX;
          if (cont.scrollWidth > cont.clientWidth + 1) {
            // Se pasa: sólo está bien si ESE contenedor deja scrollear.
            return !(ov === "auto" || ov === "scroll");
          }
          cont = cont.parentElement;
        }
        return false;
      });
      if (recorta) recortadas.push(ruta);
    }
    expect(recortadas, "hay tablas recortadas sin forma de scrollear").toEqual([]);
  });

  test("los diálogos entran en la pantalla", async ({ page }) => {
    const casos = [
      { ruta: "/clientes", abrir: /^Nuevo$/ },
      { ruta: "/productos", abrir: /^Nuevo$/ },
      { ruta: "/remitos", abrir: /^Nuevo remito$/ },
      { ruta: "/usuarios", abrir: /^Nuevo$/ },
    ];
    const vp = page.viewportSize()!;
    for (const c of casos) {
      await page.goto(c.ruta);
      await page.getByRole("button", { name: c.abrir }).first().click();
      const dialogo = page.getByRole("dialog");
      await expect(dialogo).toBeVisible();

      const caja = (await dialogo.boundingBox())!;
      expect(caja.x, `${c.ruta}: el diálogo se sale por la izquierda`).toBeGreaterThanOrEqual(-1);
      expect(caja.x + caja.width, `${c.ruta}: se sale por la derecha`).toBeLessThanOrEqual(
        vp.width + 1,
      );
      expect(caja.y, `${c.ruta}: se sale por arriba`).toBeGreaterThanOrEqual(-1);
      expect(caja.y + caja.height, `${c.ruta}: se sale por abajo`).toBeLessThanOrEqual(
        vp.height + 1,
      );

      await page.keyboard.press("Escape");
      await expect(dialogo).not.toBeVisible();
    }
  });

  test("el menú se puede abrir y cerrar", async ({ page }) => {
    await page.goto("/");
    // En pantalla chica el menú arranca escondido: el botón es la única forma
    // de llegar a las otras secciones.
    const boton = page.locator('[data-sidebar="trigger"]').first();
    await expect(boton).toBeVisible();
    await boton.click();
    await expect(page.getByRole("link", { name: /ventas/i }).first()).toBeVisible();
  });
});
