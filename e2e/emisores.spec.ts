import { test, expect, ingresar, campo } from "./apoyo";
import { limpiarFixturesFiscales, prepararFixturesFiscales } from "./fixtures/fiscal";

/**
 * Los datos que salen en el encabezado de los impresos.
 *
 * Pedido de Leo: que en presupuestos y remitos salgan la dirección y el celular.
 * Antes los PDF los leían de `fiscal_config`, que en producción está vacío, así
 * que salían pelados. Ahora salen del emisor de cada sucursal — y son dos
 * personas jurídicas distintas, una por local.
 */

test.beforeAll(async () => {
  await prepararFixturesFiscales();
});
test.afterAll(async () => {
  await limpiarFixturesFiscales();
});
test.beforeEach(async ({ page }) => {
  await ingresar(page);
  await page.goto("/facturacion/configuracion");
  await page.getByText(/identidad fiscal e impresos/i).waitFor({ timeout: 20_000 });
});

test("se ven los dos emisores, cada uno con su local", async ({ page }) => {
  // Los datos viven en el `value` de los inputs, no en el texto de la página:
  // toContainText sobre el body no los ve.
  const valores = await page
    .locator("input")
    .evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
  const todo = valores.join(" | ");
  expect(todo, "falta un emisor").toContain("APLICACIONES Y SERVICIOS S.R.L.");
  expect(todo, "falta el otro emisor").toContain("GRUPO CASA FORMA S.A.S.");
  // Y los datos que pidió Leo, cada uno con el suyo.
  expect(todo).toContain("3513229459");
  expect(todo).toContain("3512146766");
});

test("la pantalla aclara que una factura emitida no cambia", async ({ page }) => {
  await expect(page.locator("body")).toContainText(/al emitir una factura se congelan/i);
});

test("cambiar el celular de una sucursal se guarda de verdad", async ({ page }) => {
  // El bloque del local: se ubica por el nombre de la sucursal.
  const bloque = page
    .locator('[data-testid="contacto-sucursal"]')
    .filter({ hasText: "CasaForma General Paz" });
  const celular = campo(bloque, /celular/i);
  const original = await celular.inputValue();

  await celular.fill("3510000000");
  await bloque.getByRole("button", { name: /^Guardar$/ }).click();
  await expect(page.locator("[data-sonner-toaster]")).toContainText(/guardado/i, {
    timeout: 15_000,
  });

  // Recargar es la parte que importa: que haya viajado a la base, no que el
  // formulario se acuerde de lo que uno tipeó.
  await page.reload();
  await page.getByText(/identidad fiscal e impresos/i).waitFor({ timeout: 20_000 });
  await expect
    .poll(async () =>
      (
        await page
          .locator("input")
          .evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value))
      ).join(" | "),
    )
    .toContain("3510000000");

  // Y se deja como estaba, que esto corre contra datos compartidos.
  const bloque2 = page
    .locator('[data-testid="contacto-sucursal"]')
    .filter({ hasText: "CasaForma General Paz" });
  await campo(bloque2, /celular/i).fill(original);
  await bloque2.getByRole("button", { name: /^Guardar$/ }).click();
  await expect(page.locator("[data-sonner-toaster]")).toContainText(/guardado/i, {
    timeout: 15_000,
  });
});
