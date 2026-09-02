import { expect, ingresar, test } from "./apoyo";
import {
  limpiarCorreccionFormaPagoE2E,
  MOTIVO_CORRECCION_PAGO_E2E,
  NUMERO_VENTA_CORRECCION_PAGO_E2E,
  prepararCorreccionFormaPagoE2E,
  verificarCorreccionFormaPagoE2E,
} from "./fixtures/correccion-forma-pago";

test.beforeAll(async () => {
  await prepararCorreccionFormaPagoE2E();
});

test.afterAll(async () => {
  await limpiarCorreccionFormaPagoE2E();
});

test.beforeEach(async ({ page }) => {
  await ingresar(page);
});

test("admin corrige sólo la forma, conserva el importe y ve la auditoría", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/ventas");

  await page.getByPlaceholder(/buscar comprobante/i).fill(NUMERO_VENTA_CORRECCION_PAGO_E2E);
  const fila = page.getByRole("row").filter({ hasText: NUMERO_VENTA_CORRECCION_PAGO_E2E });
  await expect(fila).toHaveCount(1, { timeout: 20_000 });
  await fila.getByRole("button", { name: /ver detalle/i }).click();

  const detalle = page.getByTestId("dialogo-detalle-venta");
  await expect(detalle).toBeVisible();
  await expect(detalle).toContainText("Efectivo");
  await expect(detalle).toContainText("$ 121,00");
  await detalle.getByRole("button", { name: /corregir forma de pago/i }).click();

  const correccion = page.getByRole("dialog").filter({ hasText: /corregir forma de pago/i });
  await expect(correccion).toBeVisible();
  const importe = correccion.getByLabel(/importe \(no editable\)/i);
  await expect(importe).toHaveValue("$ 121,00");
  await expect(importe).toHaveAttribute("readonly", "");

  await correccion.locator('label:has-text("Forma de pago") + button[role=combobox]').click();
  await page.getByRole("option", { name: "Transferencia", exact: true }).click();
  await correccion.getByLabel(/motivo de la corrección/i).fill(MOTIVO_CORRECCION_PAGO_E2E);
  await correccion.getByRole("button", { name: /guardar corrección/i }).click();

  await expect(correccion).not.toBeVisible({ timeout: 20_000 });
  await expect(detalle.getByRole("heading", { name: /historial de correcciones/i })).toBeVisible();
  await expect(detalle).toContainText("Transferencia");
  await expect(detalle).toContainText(MOTIVO_CORRECCION_PAGO_E2E);

  await verificarCorreccionFormaPagoE2E();
});
