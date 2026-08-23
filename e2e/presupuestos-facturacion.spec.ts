import type { Locator, Page } from "@playwright/test";

import { expect, ingresar, test } from "./apoyo";
import {
  cantidadVentasDelProductoE2E,
  leerPresupuestoFixture,
  limpiarFixturesFiscales,
  prepararFixturesFiscales,
  type FixtureFiscal,
} from "./fixtures/fiscal";

const ESCENARIO = process.env.INVOICING_MOCK_SCENARIO ?? "OK";
let fixture: FixtureFiscal;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  fixture = await prepararFixturesFiscales();
});
test.afterAll(async () => {
  await limpiarFixturesFiscales();
});

async function abrirConversion(page: Page): Promise<Locator> {
  await ingresar(page);
  await page.goto(`/presupuestos/${fixture.presupuestoId}`);
  await page.getByTestId("convertir").click();
  const dialogo = page.getByRole("dialog", { name: "Convertir en venta" });
  await expect(dialogo).toBeVisible();
  return dialogo;
}

async function cargarPagosMixtos(page: Page, dialogo: Locator) {
  const editor = dialogo.getByTestId("editor-pagos");
  await editor.getByRole("button", { name: /Agregar pago/i }).click();
  await editor.getByLabel("Monto").fill("40");
  await editor.getByRole("combobox").click();
  await page.getByRole("option", { name: "Transferencia" }).click();
  await editor.getByRole("button", { name: /Agregar pago/i }).click();
  await editor.getByLabel("Monto").nth(1).fill("20");
}

test("la conversión v2 es neutral y comparte pagos mixtos, total cobrado y saldo", async ({
  page,
}) => {
  const dialogo = await abrirConversion(page);

  await expect(dialogo).toContainText("Venta · la letra se deriva al facturar");
  await expect(dialogo.getByText(/Factura [AB]/)).toHaveCount(0);
  await cargarPagosMixtos(page, dialogo);
  const resumen = dialogo.getByTestId("resumen-cierre-venta");
  await expect(resumen).toContainText(/Total de la venta/);
  await expect(resumen).toContainText(/121/);
  await expect(resumen).toContainText(/Cobrado ahora/);
  await expect(resumen).toContainText(/60/);
  await expect(resumen).toContainText(/Saldo pendiente/);
  await expect(resumen).toContainText(/61/);
  await expect(resumen).toContainText(/La factura se emite por el total/);
});

test("convierte una vez, conserva venta_id y una falla fiscal deja CONVERTIDO", async ({
  page,
}) => {
  const antes = await cantidadVentasDelProductoE2E();
  const dialogo = await abrirConversion(page);
  await cargarPagosMixtos(page, dialogo);

  await dialogo.getByTestId("conv-y-facturar").dblclick();
  const fiscal = page.getByTestId("dialogo-emision-fiscal");
  await expect(fiscal).toBeVisible({ timeout: 20_000 });
  await fiscal.getByRole("button", { name: "Revisar datos fiscales" }).click();
  await expect(fiscal.getByRole("button", { name: "Emitir comprobante" })).toBeVisible({
    timeout: 20_000,
  });
  await fiscal.getByRole("button", { name: "Emitir comprobante" }).dblclick();

  const resultadoEsperado =
    ESCENARIO === "TIMEOUT_POST_REQUEST"
      ? "venta_creada_requiere_revision"
      : ESCENARIO === "RECHAZO_DEFINITIVO"
        ? "venta_creada_factura_pendiente"
        : "factura_aprobada";
  await expect(page).toHaveURL(new RegExp(`resultado=${resultadoEsperado}`), { timeout: 30_000 });

  await expect.poll(async () => leerPresupuestoFixture()).toMatchObject({ estado: "CONVERTIDO" });
  const guardado = await leerPresupuestoFixture();
  const url = new URL(page.url());
  expect(url.searchParams.get("venta")).toBe(guardado.venta_id);
  await expect.poll(() => cantidadVentasDelProductoE2E()).toBe(antes + 1);

  if (ESCENARIO === "TIMEOUT_POST_REQUEST" || ESCENARIO === "RECHAZO_DEFINITIVO") {
    await page.goto(`/presupuestos/${fixture.presupuestoId}`);
    await expect(page.getByTestId("convertir")).toHaveCount(0);
    await expect(page.locator("body")).toContainText(guardado.venta_id!);
    await expect(page.locator("body")).toContainText(/No vuelvas a convertirlo/i);
  }
});
