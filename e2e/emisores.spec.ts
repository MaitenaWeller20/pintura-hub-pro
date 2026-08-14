import { test, expect, ingresar, campo } from "./apoyo";

/**
 * Los datos que salen en el encabezado de los impresos.
 *
 * Pedido de Leo: que en presupuestos y remitos salgan la dirección y el celular.
 * Antes los PDF los leían de `fiscal_config`, que en producción está vacío, así
 * que salían pelados. Ahora salen del emisor de cada sucursal — y son dos
 * personas jurídicas distintas, una por local.
 */

test.beforeEach(async ({ page }) => {
  await ingresar(page);
  await page.goto("/facturacion");
  await page.getByText(/datos que salen en los impresos/i).waitFor({ timeout: 20_000 });
});

test("se ven los dos emisores, cada uno con su local", async ({ page }) => {
  // Los datos viven en el `value` de los inputs, no en el texto de la página:
  // toContainText sobre el body no los ve.
  const valores = await page
    .locator("input")
    .evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
  const todo = valores.join(" | ");
  expect(todo, "falta un emisor").toContain("Aplicaciones y Servicios SRL");
  expect(todo, "falta el otro emisor").toContain("Grupo Casa Forma SAS");
  // Y los datos que pidió Leo, cada uno con el suyo.
  expect(todo).toContain("3513229459");
  expect(todo).toContain("3512146766");
});

test("la pantalla aclara que la factura no usa estos datos", async ({ page }) => {
  // Importa que se entienda: una factura ya emitida se reimprime con lo que se
  // le declaró a AFIP, no con lo que diga esta pantalla hoy.
  await expect(page.locator("body")).toContainText(/la factura no usa esto/i);
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
  await page.getByText(/datos que salen en los impresos/i).waitFor({ timeout: 20_000 });
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
