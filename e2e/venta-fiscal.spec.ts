import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";

import { test, expect, ingresar } from "./apoyo";
import {
  cantidadVentasDelProductoE2E,
  leerEfectosVentaFixture,
  limpiarFixturesFiscales,
  prepararFixturesFiscales,
  type FixtureFiscal,
} from "./fixtures/fiscal";

const ESCENARIO = process.env.INVOICING_MOCK_SCENARIO ?? "OK";
let fixture: FixtureFiscal;

test.beforeAll(async () => {
  fixture = await prepararFixturesFiscales();
});
test.afterAll(async () => {
  await limpiarFixturesFiscales();
});

async function cargarVentaBasica(page: Page, pago = 40) {
  await page.goto("/ventas/nueva");
  await expect(page.getByText("Nuevo comprobante")).toBeVisible();

  await page.getByRole("button", { name: "Buscar cliente…" }).click();
  const buscadorCliente = page.getByPlaceholder("Nombre o CUIT…").last();
  await buscadorCliente.fill("T13-E2E COMPRADOR");
  await page.getByRole("button", { name: /T13-E2E COMPRADOR COMERCIAL/ }).click();

  await page.getByTestId("venta-buscar-producto").fill("T13-E2E-PROD");
  await page.getByRole("button", { name: /T13-E2E-PROD.*Producto fiscal/ }).click();

  const editor = page.getByTestId("editor-pagos");
  await editor.getByRole("button", { name: /agregar pago/i }).click();
  await editor.getByLabel("Monto").fill(String(pago));
  await expect(page.getByText(/La factura se emite por el total/)).toBeVisible();
}

async function revisar(dialogo: Locator) {
  await dialogo.getByRole("button", { name: "Revisar datos fiscales" }).click();
  await expect(dialogo.getByRole("button", { name: /Emitir comprobante/ })).toBeVisible({
    timeout: 20_000,
  });
}

async function receptorManual(
  dialogo: Locator,
  input: { tipo: "CUIT" | "CUIL" | "DNI"; numero: string; razon: string; iva: string },
) {
  await dialogo.getByText("Otro receptor", { exact: true }).click();
  await dialogo.getByLabel("Tipo de documento").selectOption(input.tipo);
  await dialogo.getByLabel("Número de documento").fill(input.numero);
  await dialogo.getByLabel("Razón social").fill(input.razon);
  await dialogo.getByLabel("Condición de IVA").selectOption(input.iva);
  await dialogo
    .getByText(/Confirmo que revisé el documento/i)
    .locator("..")
    .getByRole("checkbox")
    .check();
}

async function confirmarHastaCerrar(dialogo: Locator) {
  const emitir = dialogo.getByRole("button", { name: "Emitir comprobante" });
  await emitir.dblclick();
  const reconfirmar = dialogo.getByRole("button", { name: "Confirmar cambios y emitir" });
  if (await reconfirmar.isVisible({ timeout: 2_500 }).catch(() => false)) {
    await reconfirmar.click();
  }
}

test("la venta neutral ofrece exactamente cobrar/registrar y facturar o registrar sin facturar", async ({
  page,
}) => {
  await ingresar(page);
  await cargarVentaBasica(page);

  await expect(page.getByTestId("registrar-y-facturar")).toHaveText(/Registrar venta y facturar/);
  await expect(page.getByTestId("registrar-sin-facturar")).toHaveText(/Registrar sin facturar/);
  await expect(page.getByRole("combobox", { name: /Tipo comprobante/ })).toHaveText("Venta");
  await expect(page.getByRole("button", { name: /Factura [AB]/ })).toHaveCount(0);
  const resumen = page.getByTestId("resumen-cierre-venta");
  await expect(resumen.getByText("Total de la venta")).toBeVisible();
  await expect(resumen.getByText("$ 121,00", { exact: true })).toBeVisible();
  await expect(resumen.getByText("Cobrado ahora")).toBeVisible();
  await expect(resumen.getByText("$ 40,00", { exact: true })).toBeVisible();
  await expect(resumen.getByText("Saldo pendiente")).toBeVisible();
  await expect(resumen.getByText("$ 81,00", { exact: true })).toBeVisible();
});

test("registrar sin facturar no abre receptor ni ARCA y crea una sola venta", async ({ page }) => {
  await ingresar(page);
  const antes = await cantidadVentasDelProductoE2E();
  await cargarVentaBasica(page);
  await page.getByTestId("registrar-sin-facturar").dblclick();

  await expect(page.getByTestId("dialogo-emision-fiscal")).toHaveCount(0);
  await expect(page).toHaveURL(
    /\/facturacion\/cola\?venta=[0-9a-f-]+&resultado=venta_creada_factura_pendiente/,
    { timeout: 20_000 },
  );
  await expect.poll(() => cantidadVentasDelProductoE2E()).toBe(antes + 1);
});

test("el diálogo compartido separa comprador/receptor, deriva A y bloquea el doble submit", async ({
  page,
}) => {
  test.skip(ESCENARIO !== "OK", "La aprobación completa pertenece al escenario OK.");
  await ingresar(page);
  await cargarVentaBasica(page);
  await page.getByTestId("registrar-y-facturar").click();
  const dialogo = page.getByTestId("dialogo-emision-fiscal");
  await expect(dialogo).toBeVisible();
  await expect(dialogo).toContainText("T13-E2E COMPRADOR COMERCIAL");

  await receptorManual(dialogo, {
    tipo: "CUIT",
    numero: "30-71419966-4",
    razon: "T13-E2E RECEPTOR DISTINTO",
    iva: "RESPONSABLE_INSCRIPTO",
  });
  await revisar(dialogo);
  await expect(dialogo).toContainText(/Factura A/i);
  await expect(dialogo).toContainText("T13-E2E RECEPTOR DISTINTO");
  await confirmarHastaCerrar(dialogo);

  await expect(page).toHaveURL(/resultado=factura_aprobada/, { timeout: 25_000 });
  await expect(page.locator("body")).toContainText(/aprob/i);
});

test("comercial, favorito CUIL y manual son fuentes explícitas; documento inválido no previsualiza", async ({
  page,
}) => {
  await ingresar(page);
  await cargarVentaBasica(page);
  await page.getByTestId("registrar-y-facturar").click();
  const dialogo = page.getByTestId("dialogo-emision-fiscal");

  await revisar(dialogo);
  await expect(dialogo).toContainText(/Factura B/i);

  await dialogo.getByText("Guardado", { exact: true }).click();
  await expect(dialogo.getByLabel("Receptor guardado")).toContainText(/FAVORITO CUIL/);
  await revisar(dialogo);
  await expect(dialogo).toContainText(/Factura B/i);

  await receptorManual(dialogo, {
    tipo: "CUIT",
    numero: "123",
    razon: "Documento inválido",
    iva: "RESPONSABLE_INSCRIPTO",
  });
  await dialogo.getByRole("button", { name: "Revisar datos fiscales" }).click();
  await expect(dialogo).toContainText(/CUIT.*válido|dígito verificador/i);
  await expect(dialogo.getByRole("button", { name: "Emitir comprobante" })).toHaveCount(0);
});

test("Escape devuelve foco y el diálogo queda contenido para teclado", async ({ page }) => {
  await ingresar(page);
  await cargarVentaBasica(page);
  const boton = page.getByTestId("registrar-y-facturar");
  await boton.click();
  const dialogo = page.getByTestId("dialogo-emision-fiscal");
  await expect(dialogo.locator('input[name="origen-receptor"]').first()).toBeFocused();
  const caja = await dialogo.boundingBox();
  expect(caja).not.toBeNull();
  expect(caja!.y + caja!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  await page.keyboard.press("Escape");
  await expect(dialogo).not.toBeVisible();
  await expect(boton).toBeFocused();
});

test("un empleado sin capacidad no ve facturar y la URL directa queda guardada", async ({
  page,
}) => {
  await ingresar(page, "sinCapacidad");
  await page.goto("/ventas/nueva");
  await expect(page.getByTestId("registrar-y-facturar")).toHaveCount(0);
  await expect(page.getByTestId("registrar-sin-facturar")).toBeVisible();
  await expect(page.locator("body")).toContainText(/permiso Puede facturar para emitirla/i);
  await page.goto(`/facturacion/cola?venta=${fixture.ventaPendienteId}`);
  await expect(page).not.toHaveURL(/\/facturacion\/cola/);
});

test("resultado parcial: el timeout posterior al request conserva la venta y exige revisión sin recrearla", async ({
  page,
}) => {
  test.skip(
    ESCENARIO !== "TIMEOUT_POST_REQUEST",
    "La incertidumbre posterior al request requiere su proceso TIMEOUT_POST_REQUEST.",
  );
  await ingresar(page);
  const antes = await cantidadVentasDelProductoE2E();
  await cargarVentaBasica(page);
  await page.getByTestId("registrar-y-facturar").click();
  const dialogo = page.getByTestId("dialogo-emision-fiscal");
  await revisar(dialogo);
  await confirmarHastaCerrar(dialogo);
  await expect(page).toHaveURL(/resultado=venta_creada_requiere_revision/, { timeout: 25_000 });
  await expect.poll(() => cantidadVentasDelProductoE2E()).toBe(antes + 1);
});

test("rechazo definitivo conserva la venta para corregir sin repetir el cobro", async ({
  page,
}) => {
  test.skip(
    ESCENARIO !== "RECHAZO_DEFINITIVO",
    "El rechazo fiscal requiere su proceso RECHAZO_DEFINITIVO.",
  );
  await ingresar(page);
  const antes = await cantidadVentasDelProductoE2E();
  await cargarVentaBasica(page);
  await page.getByTestId("registrar-y-facturar").click();
  const dialogo = page.getByTestId("dialogo-emision-fiscal");
  await revisar(dialogo);
  await confirmarHastaCerrar(dialogo);
  await expect(page).toHaveURL(/resultado=venta_creada_factura_pendiente/, { timeout: 25_000 });
  await expect.poll(() => cantidadVentasDelProductoE2E()).toBe(antes + 1);
});

test("bloquea PDF sin QR: QR_ERROR no descarga un documento interno", async ({ page }) => {
  test.skip(ESCENARIO !== "QR_ERROR", "La falla de QR requiere su proceso QR_ERROR.");
  await ingresar(page);
  await page.goto("/ventas");
  const fila = page.locator("tbody tr", { hasText: "V-T13-E2E-APROBADA" });
  await fila.getByRole("button").first().click();
  const dialogo = page.getByRole("dialog");
  let descargo = false;
  page.once("download", () => {
    descargo = true;
  });
  await dialogo.getByRole("button", { name: "PDF" }).click();
  await expect(page.locator("[data-sonner-toaster]")).toContainText(/QR.*obligatorio/i);
  await page.waitForTimeout(500);
  expect(descargo).toBe(false);
});

test("el PDF aprobado usa receptor y fecha congelados", async ({ page }, testInfo) => {
  test.skip(ESCENARIO !== "OK", "La descarga fiscal válida pertenece al escenario OK.");
  await ingresar(page);
  await page.goto("/ventas");
  const fila = page.locator("tbody tr", { hasText: "V-T13-E2E-APROBADA" });
  await fila.getByRole("button").first().click();
  const dialogo = page.getByRole("dialog");
  await expect(dialogo).toContainText("T13-E2E RECEPTOR CONGELADO");
  await expect(dialogo).toContainText("23/08/2026");
  const descarga = page.waitForEvent("download");
  await dialogo.getByRole("button", { name: "PDF" }).click();
  const archivo = await descarga;
  const ruta = testInfo.outputPath("factura-fiscal.pdf");
  await archivo.saveAs(ruta);
  const bytes = await readFile(ruta, "latin1");
  expect(bytes).toContain("T13-E2E RECEPTOR CONGELADO");
  expect(bytes).toContain("23/08/2026");
  expect(bytes).not.toContain("DOCUMENTO INTERNO");
});

test("dos pestañas sobre la misma venta no repiten efectos comerciales", async ({ browser }) => {
  test.skip(ESCENARIO !== "OK", "La concurrencia aprobada pertenece al escenario OK.");
  const contextos = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const paginas = await Promise.all(contextos.map((contexto) => contexto.newPage()));
    await Promise.all(paginas.map((page) => ingresar(page)));
    await Promise.all(
      paginas.map((page) => page.goto(`/facturacion/cola?venta=${fixture.ventaPendienteId}`)),
    );
    const efectosAntes = await leerEfectosVentaFixture(fixture.ventaPendienteId);
    await Promise.all(
      paginas.map((page) => page.getByRole("button", { name: "Facturar" }).click()),
    );
    const dialogos = paginas.map((page) => page.getByTestId("dialogo-emision-fiscal"));
    await Promise.all(dialogos.map(revisar));
    await Promise.all(
      dialogos.map((dialogo) =>
        dialogo.getByRole("button", { name: "Emitir comprobante" }).click(),
      ),
    );
    await expect
      .poll(async () => (await leerEfectosVentaFixture(fixture.ventaPendienteId)).estadoFiscal, {
        timeout: 20_000,
      })
      .toBe("APROBADO");
    await expect
      .poll(() => paginas.some((page) => /resultado=factura_aprobada/.test(page.url())))
      .toBe(true);
    const efectosDespues = await leerEfectosVentaFixture(fixture.ventaPendienteId);
    expect(efectosDespues.cae).toMatch(/^\d{14}$/);
    expect(efectosDespues.numeroFiscal).toBeGreaterThan(0);
    expect(efectosDespues.ventas).toBe(efectosAntes.ventas);
    expect(efectosDespues.items).toBe(efectosAntes.items);
    expect(efectosDespues.pagos).toBe(efectosAntes.pagos);
    expect(efectosDespues.stock).toBe(efectosAntes.stock);
    expect(efectosDespues.deuda).toBe(efectosAntes.deuda);
    expect(efectosDespues.intentos).toBe(efectosAntes.intentos + 1);
  } finally {
    await Promise.all(contextos.map((contexto) => contexto.close()));
  }
});
