import { test, expect, ingresar } from "./apoyo";

/**
 * Filtrar por saldo en cuentas corrientes.
 *
 * Pedido de Leo: "que me deje filtrar por los que tienen saldo para pagar". Con
 * la lista larga, encontrar a quién cobrarle era leerla entera.
 */

test.beforeEach(async ({ page }) => {
  await ingresar(page);
  await page.goto("/cuentas-corrientes");
  await page.locator("tbody tr").first().waitFor({ state: "visible", timeout: 20_000 });
});

/** Cuántas filas hay en la tabla de clientes. */
const filas = (page: import("@playwright/test").Page) => page.locator("tbody tr");

async function elegirFiltro(page: import("@playwright/test").Page, opcion: RegExp) {
  await page.getByTestId("filtro-saldo").click();
  await page.getByRole("option", { name: opcion }).click();
}

test("arranca mostrando todos, no filtrado", async ({ page }) => {
  // A propósito: la pantalla es la cuenta corriente general, no una de
  // cobranzas. Si arrancara en "con deuda", los clientes en cero parecerían
  // borrados.
  await expect(page.getByTestId("filtro-saldo")).toContainText(/todos/i);
});

test("filtrar por deuda achica la lista y muestra el total a cobrar", async ({ page }) => {
  const antes = await filas(page).count();

  await elegirFiltro(page, /^Con deuda$/);
  await expect(page.getByTestId("total-filtrado")).toContainText(/total a cobrar/i);

  const despues = await filas(page).count();
  expect(despues, "filtrar no puede traer MÁS filas").toBeLessThanOrEqual(antes);

  // Y lo que queda, debe: ni cero ni a favor.
  const saldos = await page.locator("tbody tr td:nth-child(5)").allInnerTexts();
  for (const s of saldos) {
    expect(s, `"${s}" no es una deuda`).not.toMatch(/a favor/i);
    const n = Number(s.replace(/[^\d,-]/g, "").replace(/\./g, "").replace(",", "."));
    if (!Number.isNaN(n)) expect(n, `"${s}" no es mayor que cero`).toBeGreaterThan(0);
  }
});

test("el saldo a favor se muestra en positivo", async ({ page }) => {
  await elegirFiltro(page, /saldo a favor/i);
  const texto = await page.getByTestId("total-filtrado").innerText();
  if (/total a favor/i.test(texto)) {
    expect(texto, "un total a favor en negativo no dice nada").not.toMatch(/total a favor\s*-/i);
  }
});

test("si el filtro vacía la lista, el mensaje dice por qué", async ({ page }) => {
  await elegirFiltro(page, /saldo a favor/i);
  if ((await filas(page).count()) === 0) {
    // Lo que NO tiene que decir es "no hay clientes con cuenta corriente":
    // haría pensar que se perdieron los datos.
    await expect(page.locator("body")).not.toContainText(/no hay clientes con cuenta corriente/i);
    await expect(page.locator("body")).toContainText(/ningún cliente tiene saldo a favor/i);
  }
});
