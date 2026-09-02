import { test, expect, ingresar } from "./apoyo";
import {
  MARCA_REMITO_EDITAR_E2E,
  MARCA_REMITO_VER_E2E,
  PRODUCTO_REMITO_A_CODIGO_E2E,
  PRODUCTO_REMITO_B_CODIGO_E2E,
  limpiarEfectosNotasRemitosE2E,
  limpiarFixtureNotasRemitosE2E,
  leerRemitoE2E,
  prepararFixtureNotasRemitosE2E,
  type FixtureNotasRemitosE2E,
} from "./fixtures/nota-credito-remitos";

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

let fixture: FixtureNotasRemitosE2E;

test.beforeAll(async () => {
  fixture = await prepararFixtureNotasRemitosE2E();
});

test.afterEach(async () => {
  await limpiarEfectosNotasRemitosE2E();
});

test.afterAll(async () => {
  await limpiarFixtureNotasRemitosE2E();
});

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

test("en v2 la nota de crédito manual ya nace interna y no pide factura", async ({ page }) => {
  await page.goto("/ventas/nueva");
  await elegirTipo(page, /nota de cr[eé]dito/i);

  await expect(page.getByTestId("aviso-nota-credito-interna")).toBeVisible();
  await expect(page.getByText(/factura que rectifica/i)).toHaveCount(0);
  await expect(page.locator("body")).toContainText(/sin factura asociada/i);
});

test("el aviso explica que sin factura no va a ARCA, y no miente sobre la norma", async ({
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

  await expect(cuerpo).toContainText(/no se informa a ARCA/i);
});

test("v2 no ofrece el alta manual de nota de débito", async ({ page }) => {
  await page.goto("/ventas/nueva");
  const trigger = page.locator('label:has-text("Tipo comprobante") + button[role=combobox]');
  await trigger.click();
  await expect(page.getByRole("option", { name: /nota de d[eé]bito/i })).toHaveCount(0);
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

  const destino = alta.locator('label:has-text("Destino") + button[role=combobox]');
  await destino.click();
  await page.getByRole("option", { name: fixture.sucursalDestinoNombre, exact: true }).click();

  await page.getByTestId("remito-buscar-producto").fill(PRODUCTO_REMITO_A_CODIGO_E2E);
  const resultado = alta.getByRole("button", {
    name: new RegExp(PRODUCTO_REMITO_A_CODIGO_E2E),
  });
  await resultado.waitFor({ state: "visible", timeout: 15_000 });
  await resultado.click();
  await alta.locator('label:has-text("Observaciones") + textarea').fill(MARCA_REMITO_VER_E2E);

  await alta.getByRole("button", { name: /crear remito/i }).click();
  await expect(alta).not.toBeVisible({ timeout: 20_000 });

  const remito = await leerRemitoE2E(MARCA_REMITO_VER_E2E);
  const filaPropia = page.getByRole("row").filter({ hasText: remito.numero });
  await expect(filaPropia).toHaveCount(1, { timeout: 20_000 });

  await filaPropia.getByRole("button", { name: /ver qué trae/i }).click();
  const dialogo = page.getByRole("dialog");
  await expect(dialogo).toBeVisible();

  // Lo que importa: que muestre los PRODUCTOS, no sólo cuántos son.
  await expect(dialogo.getByRole("columnheader", { name: /producto/i })).toBeVisible();
  await expect(dialogo.getByRole("columnheader", { name: /cantidad/i })).toBeVisible();
  await expect(dialogo).toContainText(/viene de/i);
  await expect(dialogo).toContainText(/va a/i);
  await expect(dialogo).toContainText(PRODUCTO_REMITO_A_CODIGO_E2E);
});

test("remitos: el origen puede corregir los productos mientras está pendiente", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/remitos");

  await page.getByRole("button", { name: /^Nuevo remito$/ }).click();
  const alta = page.getByRole("dialog");
  const destino = alta.locator('label:has-text("Destino") + button[role=combobox]');
  await destino.click();
  await page.getByRole("option", { name: fixture.sucursalDestinoNombre, exact: true }).click();

  await page.getByTestId("remito-buscar-producto").fill(PRODUCTO_REMITO_A_CODIGO_E2E);
  const primerProducto = alta.getByRole("button", {
    name: new RegExp(PRODUCTO_REMITO_A_CODIGO_E2E),
  });
  await primerProducto.waitFor({ state: "visible", timeout: 15_000 });
  await primerProducto.click();
  await alta.locator('label:has-text("Observaciones") + textarea').fill(MARCA_REMITO_EDITAR_E2E);
  await alta.getByRole("button", { name: /crear remito/i }).click();
  await expect(alta).not.toBeVisible({ timeout: 20_000 });

  const remito = await leerRemitoE2E(MARCA_REMITO_EDITAR_E2E);
  const filaPropia = page.getByRole("row").filter({ hasText: remito.numero });
  await expect(filaPropia).toHaveCount(1, { timeout: 20_000 });
  await filaPropia.getByRole("button", { name: /editar remito/i }).click();

  const edicion = page.getByRole("dialog");
  await expect(edicion.getByRole("heading", { name: /editar remito/i })).toBeVisible();
  await expect(edicion.getByText(/el origen no se puede cambiar/i)).toBeVisible();

  await edicion.getByRole("button", { name: /quitar producto/i }).click();
  await edicion.getByTestId("remito-buscar-producto").fill(PRODUCTO_REMITO_B_CODIGO_E2E);
  const reemplazo = edicion.getByRole("button", {
    name: new RegExp(PRODUCTO_REMITO_B_CODIGO_E2E),
  });
  await reemplazo.waitFor({ state: "visible", timeout: 15_000 });
  await reemplazo.click();

  await edicion
    .locator('label:has-text("Observaciones") + textarea')
    .fill(`${MARCA_REMITO_EDITAR_E2E} · Producto corregido`);
  await edicion.getByRole("button", { name: /guardar cambios/i }).click();
  await expect(edicion).not.toBeVisible({ timeout: 20_000 });

  await filaPropia.getByRole("button", { name: /ver qué trae/i }).click();
  const detalle = page.getByRole("dialog");
  await expect(detalle).toContainText(PRODUCTO_REMITO_B_CODIGO_E2E);
  await expect(detalle).toContainText("Producto corregido");
});
