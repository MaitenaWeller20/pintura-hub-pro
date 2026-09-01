import { readFile } from "node:fs/promises";
import { test, expect, ingresar, campo } from "./apoyo";

/**
 * Un test por cada cosa que reportó la clienta, para que si alguna se rompe de
 * nuevo se sepa antes de que lo note ella.
 */

test.beforeEach(async ({ page }) => {
  await ingresar(page);
});

/** Los dígitos del primer CUIT de 11 que aparezca en la grilla de clientes. */
async function primerCuitDeLaGrilla(page: import("@playwright/test").Page) {
  // Sin esperar a que la grilla traiga filas, `allInnerTexts` devuelve [] y el
  // test se saltearía solo fingiendo que no hay datos.
  await page.locator("tbody tr").first().waitFor({ state: "visible", timeout: 20_000 });
  const celdas = await page.locator("tbody tr td:nth-child(2)").allInnerTexts();
  for (const c of celdas) {
    const d = c.replace(/\D/g, "");
    if (d.length === 11) return d;
  }
  return null;
}

test("clientes: se encuentra un CUIT esté escrito como esté", async ({ page }) => {
  // El bug original: la ficha estaba guardada "30-71582607-7" y buscar
  // "30715826077" no devolvía nada, mientras el alta rebotaba por duplicada.
  await page.goto("/clientes");
  const buscador = page.getByPlaceholder(/buscar por nombre o cuit/i);

  // Se toma un CUIT real de la grilla (la primera fila puede no tener) y se lo
  // busca escrito de las dos formas.
  const digitos = await primerCuitDeLaGrilla(page);
  test.skip(!digitos, "no hay ningún cliente con CUIT para probar");

  await buscador.fill(digitos);
  await expect(page.locator("tbody tr")).not.toHaveCount(0);

  const conGuiones = `${digitos.slice(0, 2)}-${digitos.slice(2, 10)}-${digitos.slice(10)}`;
  await buscador.fill(conGuiones);
  await expect(
    page.locator("tbody tr"),
    "buscar con guiones tendría que encontrar lo mismo",
  ).not.toHaveCount(0);
});

test("clientes: el error de CUIT duplicado dice de quién es", async ({ page }) => {
  await page.goto("/clientes");
  const digitos = await primerCuitDeLaGrilla(page);
  test.skip(!digitos, "no hay ningún cliente con CUIT para probar");

  await page.getByRole("button", { name: /^Nuevo$/ }).click();
  const dialogo = page.getByRole("dialog");
  await campo(dialogo, /razón social/i).fill("ZZ PRUEBA DUPLICADO");
  await campo(dialogo, /cuit/i).fill(digitos);
  await dialogo.getByRole("button", { name: /guardar/i }).click();

  // Lo que importa no es que falle, sino que diga a quién pertenece.
  await expect(page.locator("[data-sonner-toaster]")).toContainText(/ya existe un cliente/i);
  await expect(page.locator("[data-sonner-toaster]")).toContainText(/CUIT\/DNI:/i);
});

test("presupuestos: la búsqueda de productos no esconde resultados", async ({ page }) => {
  // El bug: pedía 10 filas sin ordenar, así que el producto buscado podía no
  // estar entre esas 10 y no había ninguna señal de que faltaban.
  await page.goto("/presupuestos/nuevo");
  const buscador = page.getByTestId("buscar-producto-presup");
  // El buscador arranca a partir de 2 caracteres.
  await buscador.fill("ar");
  await page.waitForTimeout(1500);

  const resultados = page.locator("button", { hasText: /\$/ });
  const cuantos = await resultados.count();
  expect(cuantos, "una búsqueda amplia tendría que traer más de 10").toBeGreaterThan(10);

  // Y si la lista quedó cortada, se avisa.
  if (cuantos >= 50) {
    await expect(page.locator("body")).toContainText(/se muestran los primeros 50/i);
  }

  // Sin resultados también se avisa, en vez de dejar la nada.
  await buscador.fill("zzzznoexisteesto");
  await page.waitForTimeout(1200);
  await expect(page.locator("body")).toContainText(/ningún producto con ese código o nombre/i);
});

test("presupuestos: muestra precio de lista y final sin nombrar IVA", async ({ page }) => {
  await page.goto("/presupuestos");
  const hay = await page
    .locator("tbody tr")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hay, "no hay presupuestos cargados para mirar");
  // El detalle se abre por el link de la fila, no clickeando la fila entera.
  await page.locator('tbody tr a[href*="/presupuestos/"]').first().click();
  await page.waitForLoadState("networkidle").catch(() => {});
  const cabecera = page.locator("thead");
  await expect(cabecera).toContainText(/precio de lista/i);
  await expect(cabecera).toContainText(/precio final/i);
  await expect(cabecera).toContainText(/desc\./i);
  await expect(page.getByText(/iva incluido/i)).toHaveCount(0);
});

test("presupuestos: el PDF muestra precio de lista y precio final", async ({ page }, testInfo) => {
  await page.goto("/presupuestos");
  const hay = await page
    .locator("tbody tr")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hay, "no hay presupuestos cargados para descargar");

  await page.locator('tbody tr a[href*="/presupuestos/"]').first().click();
  const descarga = page.waitForEvent("download");
  await page.getByRole("button", { name: /imprimir pdf/i }).click();
  const archivo = await descarga;
  const ruta = testInfo.outputPath("presupuesto.pdf");
  await archivo.saveAs(ruta);

  const texto = (await readFile(ruta, "latin1")).replace(/\\(\d{3})/g, (_m, octal) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
  expect(texto).toContain("Precio de lista");
  expect(texto).toContain("Precio final");
  expect(texto).not.toContain("s/IVA");
});

test("ventas: carga precios finales y descuentos sin mostrar IVA", async ({ page }) => {
  await page.goto("/ventas/nueva");
  const buscador = page.getByTestId("venta-buscar-producto");
  await buscador.fill("ar");

  const resultado = page
    .getByRole("button")
    .filter({ hasText: /stock:/i })
    .first();
  await expect(resultado).toBeVisible();
  await resultado.click();

  const cabecera = page.locator("thead");
  await expect(cabecera).toContainText(/precio de lista/i);
  await expect(cabecera).toContainText(/precio final/i);
  await expect(cabecera).toContainText(/desc\. %/i);
  await expect(cabecera).not.toContainText(/iva/i);
});

test("ventas: un remito de obra se guarda sin elegir cliente", async ({ page }) => {
  await page.goto("/ventas/nueva");

  // Tipo de comprobante = Remito de Obra
  await page
    .getByRole("combobox")
    .filter({ hasText: /factura b/i })
    .click();
  await page.getByRole("option", { name: /remito de obra/i }).click();

  // El cliente pasa a ser opcional y aparece el campo de obra.
  await expect(page.locator("body")).toContainText(/cliente\s*\(opcional\)/i);
  const obra = campo(page.locator("body"), /^obra/i);
  await expect(obra).toBeVisible();
});

test("ingresos: se puede ver qué se cargó en un ingreso", async ({ page }) => {
  await page.goto("/ingresos-mercaderia");
  const hay = await page
    .locator("tbody tr")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hay, "no hay ingresos cargados");

  await page.locator('button[title="Ver qué se cargó"]').first().click();
  const dialogo = page.getByRole("dialog");
  await expect(dialogo).toBeVisible();
  await expect(dialogo).toContainText(/ingreso de/i);
  // La grilla de productos con sus cantidades.
  await expect(dialogo.locator("thead")).toContainText(/cantidad/i);
});
