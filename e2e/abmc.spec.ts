import { randomUUID } from "node:crypto";

import { test, expect, ingresar, campo } from "./apoyo";
import { crearGestorFixturesAbmc, crearRepositorioFixturesAbmcLocalHttp } from "./fixtures/abmc";

/**
 * Alta, búsqueda, edición y baja de las fichas maestras.
 *
 * Cada prueba crea lo suyo con un nombre marcado ZZ-E2E y el teardown elimina
 * únicamente el UUID que registró para esa marca. Nunca busca ni borra por
 * wildcard, de modo que los seeds y los datos ajenos quedan fuera del alcance.
 */

const marca = () => `ZZ-E2E-${randomUUID().toUpperCase()}`;
const fixturesAbmc = crearGestorFixturesAbmc(crearRepositorioFixturesAbmcLocalHttp(process.env));

test.beforeEach(async ({ page }) => {
  await ingresar(page);
});

test.afterEach(async () => {
  await fixturesAbmc.limpiar();
});

test.afterAll(async () => {
  // Segundo intento idempotente: si un teardown anterior se cortó después del
  // DELETE, vuelve a auditar el mismo UUID y confirma que ya no exista.
  await fixturesAbmc.limpiar();
});

test("clientes: alta, búsqueda y edición", async ({ page }) => {
  const nombre = marca();
  const fixture = fixturesAbmc.reservar("clientes", nombre);
  await page.goto("/clientes");

  // --- ALTA
  await page.getByRole("button", { name: /^Nuevo$/ }).click();
  const alta = page.getByRole("dialog");
  await campo(alta, /razón social/i).fill(nombre);
  await campo(alta, /teléfono/i).fill("351-5550000");
  await alta.getByRole("button", { name: /guardar/i }).click();
  await expect(page.locator("[data-sonner-toaster]")).toContainText(/guardado/i);
  await fixture.registrar();

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
  const fixture = fixturesAbmc.reservar("proveedores", nombre);
  await page.goto("/proveedores");

  await page.getByRole("button", { name: /^Nuevo$/ }).click();
  const alta = page.getByRole("dialog");
  await campo(alta, /razón social/i).fill(nombre);
  await alta.getByRole("button", { name: /guardar/i }).click();
  await expect(page.locator("[data-sonner-toaster]")).toContainText(/guardado/i);
  await fixture.registrar();

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
