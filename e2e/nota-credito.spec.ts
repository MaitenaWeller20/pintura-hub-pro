import { test, expect, ingresar } from "./apoyo";

/**
 * Nota de crédito SIN factura asociada.
 *
 * Pedido de Leo: "necesito que en las notas de crédito me deje guardar sin tener
 * que relacionarlo con alguna factura". El caso es la devolución cuya factura
 * original se emitió en el sistema viejo y no está cargada acá.
 *
 * Lo que estas pruebas cuidan no es sólo que se pueda guardar, sino que la
 * pantalla diga la verdad sobre lo que va a pasar: sin factura la nota queda
 * como documento interno y no se manda a AFIP.
 */

test.beforeEach(async ({ page }) => {
  await ingresar(page);
});

/**
 * Elige el tipo de comprobante.
 *
 * El selector se ubica por su etiqueta y no por posición: hay varios combobox en
 * la pantalla y el primero es el de sucursal. Los `<Label>` de este formulario
 * no tienen htmlFor (backlog: accesibilidad), así que no sirve getByLabel y hay
 * que ir al botón hermano.
 */
async function elegirTipo(page: import("@playwright/test").Page, etiqueta: RegExp) {
  const trigger = page.locator('label:has-text("Tipo comprobante") + button[role=combobox]');
  await trigger.waitFor({ state: "visible", timeout: 20_000 });
  await trigger.click();
  await page.getByRole("option", { name: etiqueta }).click();
}

test("la nota de crédito ofrece la opción de ir sin factura", async ({ page }) => {
  await page.goto("/ventas/nueva");
  await elegirTipo(page, /nota de cr[eé]dito/i);

  // El selector de factura tiene que existir y ofrecer la salida. Antes la única
  // forma de seguir era elegir una factura del cliente, y si no tenía ninguna la
  // pantalla decía "una nota siempre rectifica una factura": callejón sin salida.
  await expect(
    page.getByText(/factura que rectifica/i),
    "no apareció el campo de factura",
  ).toBeVisible();

  // Sin cliente el selector está deshabilitado, así que la opción se verifica
  // sobre el aviso, que es lo que el usuario lee para decidir.
  await expect(
    page.getByText(/documento interno/i).first(),
    "la pantalla no avisa que sin factura queda como documento interno",
  ).toBeVisible();
});

test("el aviso explica que sin factura no va a AFIP, y no miente sobre la norma", async ({
  page,
}) => {
  await page.goto("/ventas/nueva");
  await elegirTipo(page, /nota de cr[eé]dito/i);

  const cuerpo = page.locator("body");
  // El texto viejo afirmaba que "AFIP exige que toda nota indique el comprobante
  // que corrige". No es exacto —la RG 4540/19 admite el comprobante asociado O
  // el período— y encima dejaba al usuario sin saber qué hacer.
  await expect(
    cuerpo,
    "volvió el texto que afirma que AFIP exige el comprobante asociado",
  ).not.toContainText(/AFIP exige que toda nota indique el comprobante/i);

  await expect(cuerpo).toContainText(/no se manda a AFIP/i);
});

test("la nota de débito sigue exigiendo la factura", async ({ page }) => {
  await page.goto("/ventas/nueva");
  await elegirTipo(page, /nota de d[eé]bito/i);

  // La ND es un recargo calculado como porcentaje del total de la factura: sin
  // factura no hay base. El asterisco de obligatorio tiene que seguir estando.
  await expect(page.getByText(/factura que rectifica\s*\*/i)).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Sin factura — documento interno/i);
});

test("una venta normal no muestra nada de todo esto", async ({ page }) => {
  await page.goto("/ventas/nueva");
  // Sin tocar el tipo: el default es una factura común.
  await expect(page.getByText(/factura que rectifica/i)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/documento interno/i);
});

/**
 * Pedido de Agustina: poder ver qué trae un remito interno ANTES de aceptarlo.
 * Antes el listado sólo decía "4 ítems" y para saber qué venía había que
 * aprobarlo y mirar el stock después.
 */
test("remitos: se puede ver qué trae un remito antes de aceptarlo", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/remitos");

  // Se crea uno por la pantalla en vez de sembrarlo por SQL: así el test
  // también cubre el alta, que es lo que Renzo no podía hacer.
  await page.getByRole("button", { name: /^Nuevo remito$/ }).click();
  const alta = page.getByRole("dialog");
  await alta.waitFor({ state: "visible" });

  // Destino: la otra sucursal (el origen viene precargado con la propia).
  const destino = alta.locator('label:has-text("Destino") + button[role=combobox]');
  await destino.click();
  await page.getByRole("option").first().click();

  await page.getByTestId("remito-buscar-producto").fill("bl");
  const resultado = alta.locator("div.overflow-auto > button").first();
  await resultado.waitFor({ state: "visible", timeout: 15_000 });
  await resultado.click();

  await alta.getByRole("button", { name: /crear remito/i }).click();
  await expect(alta).not.toBeVisible({ timeout: 20_000 });

  const primeraFila = page.locator("tbody tr").first();
  await primeraFila.waitFor({ state: "visible", timeout: 20_000 });

  await primeraFila.getByRole("button", { name: /ver qué trae/i }).click();
  const dialogo = page.getByRole("dialog");
  await expect(dialogo).toBeVisible();

  // Lo que importa: que muestre los PRODUCTOS, no sólo cuántos son.
  await expect(dialogo.getByRole("columnheader", { name: /producto/i })).toBeVisible();
  await expect(dialogo.getByRole("columnheader", { name: /cantidad/i })).toBeVisible();
  await expect(dialogo).toContainText(/viene de/i);
  await expect(dialogo).toContainText(/va a/i);
});
