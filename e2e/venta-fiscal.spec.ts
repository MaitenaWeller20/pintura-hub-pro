import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";

import { test, expect, ingresar } from "./apoyo";
import {
  cantidadVentasDelProductoE2E,
  configurarFlagsFacturacionFixture,
  leerEfectosVentaFixture,
  leerHuellaComercialFixture,
  leerReversionNotaCreditoFixture,
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
  await ingresar(page, "fiscalAdmin");
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

test("una VENTA neutral aprobada genera una NC total y abre la cola con receptor heredado", async ({
  page,
}) => {
  test.skip(ESCENARIO !== "OK", "La NC fiscal completa pertenece al escenario OK.");
  const antes = await leerReversionNotaCreditoFixture(fixture.ventaOriginalNotaCreditoId);
  expect(antes.original).toEqual({ estado: "ACTIVA", venta_anulada_por: null });
  expect(antes.nota).toBeNull();
  await ingresar(page, "fiscalAdmin");
  await page.goto("/ventas/nueva");

  await page.getByRole("combobox", { name: /Tipo comprobante/i }).click();
  await page.getByRole("option", { name: "Nota de Crédito" }).click();
  await page.getByRole("button", { name: "Buscar cliente…" }).click();
  await page.getByPlaceholder("Nombre o CUIT…").last().fill("T13-E2E OTRO COMPRADOR");
  await page.getByRole("button", { name: /T13-E2E OTRO COMPRADOR/ }).click();

  await page.getByRole("combobox", { name: /Venta fiscal que revierte/i }).click();
  await page.getByRole("option", { name: /V-T13-E2E-NC-ORIGINAL/ }).click();
  await expect(page.getByText(/reversión total/i).first()).toBeVisible();
  await expect(page.getByText("T13-E2E Producto fiscal")).toBeVisible();
  await expect(page.getByTestId("venta-buscar-producto")).toBeDisabled();

  await page.getByTestId("guardar-venta").click();
  await expect(page).toHaveURL(
    /\/facturacion\/cola\?venta=[0-9a-f-]+&resultado=venta_creada_factura_pendiente/,
    { timeout: 20_000 },
  );
  const fila = page.locator("tbody tr", { hasText: /Nota de crédito/ });
  await expect(fila).toContainText("Sin facturar");
  await expect
    .poll(async () => leerReversionNotaCreditoFixture(fixture.ventaOriginalNotaCreditoId))
    .toMatchObject({
      original: { estado: "ANULADA" },
      nota: {
        tipo_comprobante: "NOTA_CREDITO",
        estado: "ACTIVA",
        afip_estado: "SIN_FACTURAR",
        afip_cbte_asoc_id: fixture.ventaOriginalNotaCreditoId,
        total: -121,
      },
      itemsNota: 1,
      pagosNota: 0,
      movimientosStockOriginal: antes.movimientosStockOriginal + 1,
      stockProducto: antes.stockProducto + 1,
    });
  const despues = await leerReversionNotaCreditoFixture(fixture.ventaOriginalNotaCreditoId);
  expect(despues.original.venta_anulada_por).toBe(despues.nota?.id);
  await fila.getByRole("button", { name: "Facturar" }).click();
  const dialogo = page.getByTestId("dialogo-emision-fiscal");
  await expect(dialogo).toContainText(/conservan el receptor del comprobante original/i);
  await expect(dialogo.locator("fieldset")).toHaveAttribute("disabled", "");
  await dialogo.getByRole("button", { name: "Revisar datos fiscales" }).click();
  await expect(dialogo).toContainText("T13-E2E RECEPTOR NC HEREDADO", { timeout: 20_000 });
});

test("un cliente legacy obsoleto no puede guardar una ND después de activar v2", async ({
  page,
}) => {
  test.skip(ESCENARIO !== "OK", "El fence comercial de ND pertenece al escenario OK.");
  await configurarFlagsFacturacionFixture({ v2: false, legacy: true });
  try {
    await ingresar(page, "fiscalAdmin");
    await page.goto("/ventas/nueva");
    await page.getByRole("combobox", { name: /Tipo comprobante/i }).click();
    await page.getByRole("option", { name: "Nota de Débito" }).click();
    await page.getByRole("button", { name: "Buscar cliente…" }).click();
    await page.getByPlaceholder("Nombre o CUIT…").last().fill("T13-E2E COMPRADOR");
    await page.getByRole("button", { name: /T13-E2E COMPRADOR COMERCIAL/ }).click();
    await page.getByRole("combobox", { name: /Factura que rectifica/i }).click();
    await page.getByRole("option", { name: /V-T13-E2E-LEGACY-PEND/ }).click();
    await page
      .getByText("% sobre el total de la factura", { exact: true })
      .locator("..")
      .locator("input")
      .fill("10");

    const antes = await leerHuellaComercialFixture();
    await configurarFlagsFacturacionFixture({ v2: true, legacy: false });
    await page.getByTestId("guardar-venta").click();
    await expect(page.locator("[data-sonner-toaster]")).toContainText(
      /nota de débito.*fuera de alcance fiscal/i,
    );
    await expect(page).toHaveURL(/\/ventas\/nueva/);
    await expect.poll(() => leerHuellaComercialFixture()).toEqual(antes);
  } finally {
    await configurarFlagsFacturacionFixture({ v2: true, legacy: false });
  }
});

test("registrar sin facturar no abre receptor ni ARCA y crea una sola venta", async ({ page }) => {
  await ingresar(page, "fiscalAdmin");
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
  await ingresar(page, "fiscalAdmin");
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
  await expect(dialogo).toContainText(fixture.emisorRazonSocial);
  await expect(dialogo).toContainText(`CUIT ${fixture.emisorCuit}`);
  await expect(dialogo).toContainText(fixture.sucursalPrincipalNombre);
  await expect(dialogo).toContainText(`PV ${String(fixture.puntoVenta).padStart(5, "0")}`);
  await expect(dialogo).toContainText("Producción");
  await expect(dialogo).not.toContainText(/Emisor de la sucursal|a confirmar|Ambiente a confirmar/);
  await confirmarHastaCerrar(dialogo);

  await expect(page).toHaveURL(/resultado=factura_aprobada/, { timeout: 25_000 });
  await expect(page.locator("body")).toContainText(/aprob/i);
});

test("comercial, favorito CUIL y manual son fuentes explícitas; documento inválido no previsualiza", async ({
  page,
}) => {
  await ingresar(page, "fiscalAdmin");
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
  await ingresar(page, "fiscalAdmin");
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
  await ingresar(page, "fiscalAdmin");
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
  await ingresar(page, "fiscalAdmin");
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
  await ingresar(page, "fiscalAdmin");
  await page.goto("/ventas");
  const fila = page.locator("tbody tr", { hasText: "V-T13-E2E-APROBADA" });
  await fila.getByRole("button", { name: "Ver detalle de V-T13-E2E-APROBADA" }).click();
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
  await ingresar(page, "fiscalAdmin");
  await page.goto("/ventas");
  const fila = page.locator("tbody tr", { hasText: "V-T13-E2E-APROBADA" });
  await fila.getByRole("button", { name: "Ver detalle de V-T13-E2E-APROBADA" }).click();
  const dialogo = page.getByRole("dialog");
  await expect(dialogo).toContainText("T13-E2E RECEPTOR CONGELADO");
  await expect(dialogo).toContainText(fixture.fechaFiscalVisible);
  const descarga = page.waitForEvent("download");
  await dialogo.getByRole("button", { name: "PDF" }).click();
  const archivo = await descarga;
  const ruta = testInfo.outputPath("factura-fiscal.pdf");
  await archivo.saveAs(ruta);
  const bytes = await readFile(ruta, "latin1");
  expect(bytes).toContain("T13-E2E RECEPTOR CONGELADO");
  expect(bytes).toContain(fixture.fechaFiscalVisible);
  expect(bytes).not.toContain("DOCUMENTO INTERNO");
});

test("el listado muestra y busca comprador → receptor fiscal desde el snapshot congelado", async ({
  page,
}) => {
  test.skip(ESCENARIO !== "OK", "El receptor congelado aprobado pertenece al escenario OK.");
  await ingresar(page, "fiscalAdmin");
  await page.goto("/ventas");
  const busqueda = page.getByPlaceholder("Buscar comprobante, comprador o receptor…");
  await busqueda.fill("T13-E2E RECEPTOR CONGELADO");
  const fila = page.locator("tbody tr", { hasText: "V-T13-E2E-APROBADA" });
  await expect(fila).toBeVisible();
  await expect(fila).toContainText("T13-E2E OTRO COMPRADOR");
  await expect(fila.getByTestId(`receptor-${fixture.ventaAprobadaId}`)).toHaveText(
    "→ T13-E2E RECEPTOR CONGELADO",
  );
  await busqueda.fill("30714199664");
  await expect(fila).toBeVisible();
});

test("dos pestañas sobre la misma venta no repiten efectos comerciales", async ({ browser }) => {
  test.skip(ESCENARIO !== "OK", "La concurrencia aprobada pertenece al escenario OK.");
  const contextos = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const paginas = await Promise.all(contextos.map((contexto) => contexto.newPage()));
    await Promise.all(paginas.map((page) => ingresar(page, "fiscalAdmin")));
    await Promise.all(
      paginas.map((page) => page.goto(`/facturacion/cola?venta=${fixture.ventaPendienteId}`)),
    );
    const efectosAntes = await leerEfectosVentaFixture(fixture.ventaPendienteId);
    await Promise.all(
      paginas.map((page) => page.getByRole("button", { name: "Facturar" }).click()),
    );
    const dialogos = paginas.map((page) => page.getByTestId("dialogo-emision-fiscal"));
    await Promise.all(
      dialogos.map((dialogo) =>
        receptorManual(dialogo, {
          tipo: "CUIT",
          numero: "20345678906",
          razon: "T13-E2E COMPRADOR PAGINACIÓN",
          iva: "CONSUMIDOR_FINAL",
        }),
      ),
    );
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
