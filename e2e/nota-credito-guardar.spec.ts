import { test, expect, ingresar } from "./apoyo";

/**
 * El pedido de Leo, de punta a punta: que una nota de crédito SIN factura se
 * pueda GUARDAR de verdad desde la pantalla.
 *
 * Los otros tests de nota-credito.spec.ts miran que la pantalla ofrezca la
 * salida y diga la verdad. Este hace el recorrido completo y escribe en la base,
 * que es lo que se rompía: el botón Guardar quedaba gris para siempre.
 */

test.beforeEach(async ({ page }) => {
  await ingresar(page);
});

/** El selector se ubica por su etiqueta: hay varios combobox en la pantalla. */
function selectDe(page: import("@playwright/test").Page, etiqueta: string) {
  return page.locator(`label:has-text("${etiqueta}") + button[role=combobox]`);
}

async function elegirEnSelect(
  page: import("@playwright/test").Page,
  etiqueta: string,
  opcion: RegExp,
) {
  const trigger = selectDe(page, etiqueta);
  await trigger.waitFor({ state: "visible", timeout: 20_000 });
  await trigger.click();
  await page.getByRole("option", { name: opcion }).first().click();
}

test("se guarda una nota de crédito sin factura, a cuenta corriente", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/ventas/nueva");

  await elegirEnSelect(page, "Tipo comprobante", /nota de cr[eé]dito/i);
  await elegirEnSelect(page, "Condición", /cuenta corriente|cta/i);

  // Cliente: el primero que ofrezca el buscador.
  await page.getByRole("button", { name: /buscar cliente/i }).click();
  await page.getByPlaceholder(/nombre o cuit/i).fill("a");
  const primerCliente = page.locator("div[role=dialog], [data-radix-popper-content-wrapper]").getByRole("button").first();
  await primerCliente.waitFor({ state: "visible", timeout: 15_000 });
  await primerCliente.click();

  // Sin factura: es el punto de todo el cambio.
  await elegirEnSelect(page, "Factura que rectifica", /sin factura/i);
  await expect(page.getByText(/no se manda a AFIP/i)).toBeVisible();

  // Un producto cualquiera.
  await page.getByTestId("venta-buscar-producto").fill("a");
  const resultado = page.locator("div.max-h-\\[min\\(60vh\\,32rem\\)\\] > button").first();
  await resultado.waitFor({ state: "visible", timeout: 15_000 });
  await resultado.click();

  const guardar = page.getByRole("button", { name: /^Guardar$/ });
  await expect(guardar, "Guardar tiene que habilitarse sin factura asociada").toBeEnabled({
    timeout: 15_000,
  });
  await guardar.click();

  // Termina en el listado y la nota está.
  await expect(page).toHaveURL(/\/ventas\/?$/, { timeout: 30_000 });
  await expect(page.locator("tbody tr").first()).toContainText(/Nota de Cr[eé]dito/i, {
    timeout: 20_000,
  });
});

test("al contado sin cobrar nada, la pantalla explica qué falta", async ({ page }) => {
  await page.goto("/ventas/nueva");
  await elegirEnSelect(page, "Tipo comprobante", /nota de cr[eé]dito/i);

  await page.getByRole("button", { name: /buscar cliente/i }).click();
  await page.getByPlaceholder(/nombre o cuit/i).fill("a");
  const primerCliente = page.locator("[data-radix-popper-content-wrapper]").getByRole("button").first();
  await primerCliente.waitFor({ state: "visible", timeout: 15_000 });
  await primerCliente.click();

  await page.getByTestId("venta-buscar-producto").fill("a");
  const resultado = page.locator("div.max-h-\\[min\\(60vh\\,32rem\\)\\] > button").first();
  await resultado.waitFor({ state: "visible", timeout: 15_000 });
  await resultado.click();

  // Al contado (el default) y sin pagos: no le devuelve la plata al cliente ni
  // le acredita saldo. El motivo tiene que estar escrito, no ser un botón gris.
  await expect(page.getByText(/cómo se le devuelve la plata al cliente/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Guardar$/ })).toBeDisabled();
});
