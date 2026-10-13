import { test, expect, ingresar } from "./apoyo";
import {
  CLIENTE_NOTAS_E2E,
  MARCA_VENTA_NC_E2E,
  PRODUCTO_NC_CODIGO_E2E,
  limpiarEfectosNotasRemitosE2E,
  limpiarFixtureNotasRemitosE2E,
  leerVentaNotaCreditoE2E,
  prepararFixtureNotasRemitosE2E,
} from "./fixtures/nota-credito-remitos";

/**
 * El pedido de Leo, de punta a punta: que una nota de crédito SIN factura se
 * pueda GUARDAR de verdad desde la pantalla.
 *
 * Los otros tests de nota-credito.spec.ts miran que la pantalla ofrezca la
 * salida y diga la verdad. Este hace el recorrido completo y escribe en la base,
 * que es lo que se rompía: el botón Guardar quedaba gris para siempre.
 */

test.beforeAll(async () => {
  await prepararFixtureNotasRemitosE2E();
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

test("el writer fiscal retirado no guarda una nota interna ni deja efectos", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/ventas/nueva");

  await elegirEnSelect(page, "Tipo comprobante", /nota de cr[eé]dito/i);
  await elegirEnSelect(page, "Condición", /cuenta corriente|cta/i);

  await page.getByRole("button", { name: /buscar cliente/i }).click();
  await page.getByPlaceholder(/nombre o cuit/i).fill(CLIENTE_NOTAS_E2E);
  const cliente = page.getByRole("button", { name: new RegExp(CLIENTE_NOTAS_E2E) });
  await cliente.waitFor({ state: "visible", timeout: 15_000 });
  await cliente.click();

  // En v2 ya no hay selector: el alta manual es siempre interna.
  await expect(page.getByText(/factura que rectifica/i)).toHaveCount(0);
  await expect(page.getByTestId("aviso-nota-credito-interna")).toContainText(
    /no se informa a ARCA/i,
  );

  await page.getByTestId("venta-buscar-producto").fill(PRODUCTO_NC_CODIGO_E2E);
  const resultado = page.getByRole("button", { name: new RegExp(PRODUCTO_NC_CODIGO_E2E) });
  await resultado.waitFor({ state: "visible", timeout: 15_000 });
  await resultado.click();
  await page.locator('label:has-text("Observaciones") + textarea').fill(MARCA_VENTA_NC_E2E);

  const guardar = page.getByRole("button", { name: /^Guardar$/ });
  await expect(guardar).toBeEnabled();
  await guardar.click();
  await expect(
    page.getByText("La facturación está en mantenimiento. No se registró ningún comprobante."),
  ).toBeVisible();
  await expect(leerVentaNotaCreditoE2E()).rejects.toThrow(
    "La UI debía crear una única nota de crédito T14",
  );
});

test("al contado sin cobrar nada, la pantalla explica qué falta", async ({ page }) => {
  await page.goto("/ventas/nueva");
  await elegirEnSelect(page, "Tipo comprobante", /nota de cr[eé]dito/i);

  await page.getByRole("button", { name: /buscar cliente/i }).click();
  await page.getByPlaceholder(/nombre o cuit/i).fill(CLIENTE_NOTAS_E2E);
  const cliente = page.getByRole("button", { name: new RegExp(CLIENTE_NOTAS_E2E) });
  await cliente.waitFor({ state: "visible", timeout: 15_000 });
  await cliente.click();

  await page.getByTestId("venta-buscar-producto").fill(PRODUCTO_NC_CODIGO_E2E);
  const resultado = page.getByRole("button", { name: new RegExp(PRODUCTO_NC_CODIGO_E2E) });
  await resultado.waitFor({ state: "visible", timeout: 15_000 });
  await resultado.click();

  // Al contado (el default) y sin pagos: no le devuelve la plata al cliente ni
  // le acredita saldo. El motivo tiene que estar escrito, no ser un botón gris.
  await expect(page.getByText(/cómo se le devuelve la plata al cliente/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Guardar$/ })).toBeDisabled();
});
