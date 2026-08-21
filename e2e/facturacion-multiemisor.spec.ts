import { test, expect, ingresar } from "./apoyo";

test.beforeEach(async ({ page }) => {
  await ingresar(page);
  await page.goto("/facturacion");
});

test("separa CSR, certificado y PV por CUIT", async ({ page }) => {
  const aplicaciones = page.getByTestId("arca-emisor-30714199664");
  const grupo = page.getByTestId("arca-emisor-30717322467");

  await expect(aplicaciones).toContainText("APLICACIONES Y SERVICIOS S.R.L.");
  await expect(aplicaciones).toContainText("30-71419966-4");
  await expect(aplicaciones).toContainText("CasaForma General Paz");
  await expect(aplicaciones).toContainText("00005");

  await expect(grupo).toContainText("GRUPO CASA FORMA S.A.S.");
  await expect(grupo).toContainText("30-71732246-7");
  await expect(grupo).toContainText("CasaForma O'Higgins");
  await expect(grupo).toContainText(/bloquead|inactiv|pendiente/i);

  await expect(aplicaciones.getByRole("button", { name: /CSR de producción/i })).toHaveCount(1);
  await expect(grupo.getByRole("button", { name: /CSR de producción/i })).toHaveCount(1);
});

test("un PV inválido no se puede guardar", async ({ page }) => {
  const card = page.getByTestId("arca-emisor-30714199664");
  const input = card.getByLabel(/número de punto de venta/i);

  await input.fill("0");
  await expect(card.getByText(/entero mayor a 0/i)).toBeVisible();
  await expect(card.getByRole("button", { name: /^Guardar PV$/ })).toBeDisabled();
});
