import { test, expect, ingresar } from "./apoyo";

/**
 * Los diálogos tienen que ser usables en una pantalla baja.
 *
 * Ésta es la prueba que hubiera agarrado el bug que reportó la clienta: el
 * diálogo de nuevo remito se derramaba fuera de la ventana y el botón de
 * guardar quedaba inalcanzable. En el monitor de la oficina no se notaba; en el
 * de la sucursal, sí. Por eso el viewport de estas pruebas es chico a propósito.
 */

const DIALOGOS = [
  { ruta: "/clientes", abrir: /^Nuevo$/, titulo: /nuevo cliente/i },
  { ruta: "/proveedores", abrir: /^Nuevo$/, titulo: /nuevo proveedor/i },
  { ruta: "/productos", abrir: /^Nuevo$/, titulo: /nuevo producto/i },
  { ruta: "/remitos", abrir: /^Nuevo remito$/, titulo: /nuevo remito/i },
  { ruta: "/usuarios", abrir: /^Nuevo$/, titulo: /nuevo usuario/i },
] as const;

test.describe("diálogos en pantalla baja", () => {
  test.beforeEach(async ({ page }) => {
    await ingresar(page);
  });

  for (const d of DIALOGOS) {
    test(`${d.ruta}: el diálogo entra en la pantalla y se puede usar`, async ({ page }) => {
      await page.goto(d.ruta);
      await page.getByRole("button", { name: d.abrir }).first().click();

      const dialogo = page.getByRole("dialog");
      await expect(dialogo).toBeVisible();
      await expect(dialogo).toContainText(d.titulo);

      // 1. No se derrama fuera de la ventana.
      const caja = await dialogo.boundingBox();
      expect(caja, "el diálogo no tiene caja").not.toBeNull();
      expect(caja!.y, `${d.ruta}: el diálogo se sale por arriba`).toBeGreaterThanOrEqual(-1);
      const alto = page.viewportSize()!.height;
      expect(caja!.y + caja!.height, `${d.ruta}: el diálogo se sale por abajo`).toBeLessThanOrEqual(
        alto + 1,
      );

      // 2. El botón de cerrar se puede tocar, aunque el formulario sea largo y
      //    se haya scrolleado hasta el fondo.
      await page.evaluate(() => {
        const sc = document.querySelector('[role="dialog"] div.overflow-y-auto');
        if (sc) sc.scrollTop = sc.scrollHeight;
      });
      const cerrar = dialogo.getByRole("button", { name: /close|cerrar/i }).first();
      await expect(cerrar, `${d.ruta}: la X se fue de la pantalla al scrollear`).toBeInViewport();

      // 3. Y el botón que guarda también.
      const guardar = dialogo.getByRole("button", { name: /guardar|crear/i }).first();
      await expect(guardar, `${d.ruta}: no se llega al botón de guardar`).toBeInViewport();
    });
  }

  test("remitos: el origen viene cargado y el motivo del bloqueo se explica", async ({ page }) => {
    // El bug: el origen no se precargaba nunca (el perfil llega después del
    // primer render) y el botón quedaba gris sin decir por qué.
    await page.goto("/remitos");
    await page.getByRole("button", { name: /^Nuevo remito$/ }).click();

    const dialogo = page.getByRole("dialog");
    const combos = dialogo.getByRole("combobox");
    await expect(
      combos.first(),
      "el origen tendría que venir con la sucursal propia",
    ).not.toHaveText("—");

    // Falta el destino: el diálogo lo tiene que DECIR, no sólo deshabilitar.
    await expect(dialogo).toContainText(/elegí la sucursal de destino/i);
  });

  test("remitos: el buscador de productos no se sale del diálogo", async ({ page }) => {
    // Estaba en un popover anclado al botón "Agregar": abría hacia afuera, se
    // salía del diálogo por la derecha y por abajo, y tapaba la tabla.
    await page.goto("/remitos");
    await page.getByRole("button", { name: /^Nuevo remito$/ }).click();

    const dialogo = page.getByRole("dialog");
    await dialogo.getByTestId("remito-buscar-producto").fill("ar");
    await page.waitForTimeout(1500);

    const caja = (await dialogo.boundingBox())!;
    const alto = page.viewportSize()!.height;
    expect(caja.y, "el diálogo se sale por arriba").toBeGreaterThanOrEqual(-1);
    expect(caja.y + caja.height, "el diálogo se sale por abajo").toBeLessThanOrEqual(alto + 1);

    // Los resultados tienen que quedar DENTRO del ancho del diálogo.
    const primerResultado = dialogo.locator("button", { hasText: /^\d{3}/ }).first();
    await expect(primerResultado).toBeVisible();
    const rb = (await primerResultado.boundingBox())!;
    expect(rb.x, "el resultado arranca antes del diálogo").toBeGreaterThanOrEqual(caja.x - 1);
    expect(rb.x + rb.width, "el resultado se pasa del diálogo").toBeLessThanOrEqual(
      caja.x + caja.width + 1,
    );

    // Y elegirlo lo agrega a la tabla.
    await primerResultado.click();
    await expect(dialogo.locator("tbody tr")).toHaveCount(1);
  });
});
