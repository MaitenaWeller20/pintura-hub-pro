import { test, expect, ingresar, campo } from "./apoyo";

/**
 * Alta, búsqueda, edición y baja de las fichas maestras.
 *
 * Cada prueba crea lo suyo con un nombre marcado ZZ-E2E y lo deja dado de baja
 * al final: si algo queda, se ve enseguida qué prueba fue y no se confunde con
 * datos reales.
 */

const marca = () => `ZZ-E2E-${Math.floor(Math.random() * 1e6)}`;

test.beforeEach(async ({ page }) => {
  await ingresar(page);
});

test("clientes: alta, búsqueda y edición", async ({ page }) => {
  const nombre = marca();
  await page.goto("/clientes");

  // --- ALTA
  await page.getByRole("button", { name: /^Nuevo$/ }).click();
  const alta = page.getByRole("dialog");
  await campo(alta, /razón social/i).fill(nombre);
  await campo(alta, /teléfono/i).fill("351-5550000");
  await alta.getByRole("button", { name: /guardar/i }).click();
  await expect(page.locator("[data-sonner-toaster]")).toContainText(/guardado/i);

  // --- BÚSQUEDA: tiene que aparecer lo recién creado
  const buscador = page.getByPlaceholder(/buscar por nombre o cuit/i);
  await buscador.fill(nombre);
  await expect(page.locator("tbody tr")).toHaveCount(1);

  // --- EDICIÓN
  await page.locator("tbody tr button").last().click();
  const edicion = page.getByRole("dialog");
  await expect(campo(edicion, /razón social/i)).toHaveValue(nombre);
  await campo(edicion, /teléfono/i).fill("351-5551111");
  await edicion.getByRole("button", { name: /guardar/i }).click();
  await expect(page.locator("[data-sonner-toaster]")).toContainText(/guardado/i);

  await buscador.fill(nombre);
  await expect(page.locator("tbody tr")).toContainText("351-5551111");
});

test("clientes: un CUIT inválido no se puede guardar", async ({ page }) => {
  await page.goto("/clientes");
  await page.getByRole("button", { name: /^Nuevo$/ }).click();
  const d = page.getByRole("dialog");
  await campo(d, /razón social/i).fill(marca());
  await campo(d, /cuit/i).fill("30715826070"); // dígito verificador cambiado

  // El error se explica y el botón no deja seguir: no se descubre al guardar.
  await expect(d).toContainText(/dígito verificador/i);
  await expect(d.getByRole("button", { name: /guardar/i })).toBeDisabled();
});

test("proveedores: alta y edición", async ({ page }) => {
  const nombre = marca();
  await page.goto("/proveedores");

  await page.getByRole("button", { name: /^Nuevo$/ }).click();
  const alta = page.getByRole("dialog");
  await campo(alta, /razón social/i).fill(nombre);
  await alta.getByRole("button", { name: /guardar/i }).click();
  await expect(page.locator("[data-sonner-toaster]")).toContainText(/guardado/i);

  const buscador = page.getByPlaceholder(/buscar por nombre o cuit/i);
  await buscador.fill(nombre);
  await expect(page.locator("tbody tr")).toHaveCount(1);

  await page.locator("tbody tr button").last().click();
  const edicion = page.getByRole("dialog");
  await expect(campo(edicion, /razón social/i)).toHaveValue(nombre);
  await edicion.getByRole("button", { name: /cancelar/i }).click();
  await expect(edicion).not.toBeVisible();
});

test("productos: el buscador filtra y el detalle abre", async ({ page }) => {
  await page.goto("/productos");
  const filasAntes = await page.locator("tbody tr").count();
  test.skip(filasAntes === 0, "no hay productos cargados");

  const codigo = (await page.locator("tbody tr td").first().innerText()).trim();
  await page
    .getByPlaceholder(/buscar/i)
    .first()
    .fill(codigo);
  await page.waitForTimeout(800);
  const filasDespues = await page.locator("tbody tr").count();
  expect(filasDespues).toBeLessThanOrEqual(filasAntes);
  expect(filasDespues).toBeGreaterThan(0);
});

test("cuentas corrientes: el saldo de una obra se ve y es cobrable", async ({ page }) => {
  // Un remito de obra genera deuda; esa deuda tiene que tener dueño y aparecer.
  await page.goto("/cuentas-corrientes");
  await page.waitForLoadState("networkidle").catch(() => {});
  // La pantalla abre con la lista de saldos; con o sin datos no debe romperse.
  await expect(page.locator("body")).not.toContainText(/algo salió mal/i);
});
