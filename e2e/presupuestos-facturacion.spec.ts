import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";

import { expect, ingresar, test } from "./apoyo";
import {
  cerrarCajaGeneralPazFixture,
  leerConversionPresupuestoFixture,
  leerHuellaComercialFixture,
  limpiarFixturesFiscales,
  prepararFixturesFiscales,
  type FixtureFiscal,
} from "./fixtures/fiscal";

let fixture: FixtureFiscal;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  fixture = await prepararFixturesFiscales();
});
test.afterAll(async () => {
  await limpiarFixturesFiscales();
});

async function abrirConversion(
  page: Page,
  presupuestoId = fixture.presupuestoId,
): Promise<Locator> {
  await ingresar(page, "fiscalAdmin");
  await page.goto(`/presupuestos/${presupuestoId}`);
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

test("el anónimo muestra receptor, General Paz, caja y pagos neutrales antes de convertir", async ({
  page,
}) => {
  const dialogo = await abrirConversion(page);

  await expect(
    dialogo.getByRole("radio", { name: "Consumidor final / sin cliente" }),
  ).toBeChecked();
  await expect(dialogo.getByTestId("conv-cliente")).toHaveCount(0);
  await expect(dialogo).toContainText(`Sucursal: ${fixture.sucursalGeneralPazNombre}`);
  await expect(dialogo).toContainText("Caja abierta desde");
  await expect(dialogo).toContainText("Cuenta corriente necesita un cliente identificado");
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
});

test("Cancelar devuelve el foco al botón que abrió la conversión", async ({ page }) => {
  const dialogo = await abrirConversion(page);
  const abrir = page.getByTestId("convertir");
  await dialogo.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialogo).not.toBeVisible();
  await expect(abrir).toBeFocused();
});

test("Escape devuelve el foco al botón que abrió la conversión", async ({ page }) => {
  const dialogo = await abrirConversion(page);
  const abrir = page.getByTestId("convertir");
  await page.keyboard.press("Escape");
  await expect(dialogo).not.toBeVisible();
  await expect(abrir).toBeFocused();
});

test("convierte y factura Consumidor Final una vez, congela color y descarga el PDF", async ({
  page,
}, testInfo) => {
  const dialogo = await abrirConversion(page);
  await dialogo
    .getByTestId("editor-pagos")
    .getByRole("button", { name: /Agregar pago/i })
    .click();
  const confirmar = dialogo.getByTestId("conv-y-facturar");
  await confirmar.dblclick();

  const fiscal = page.getByTestId("dialogo-emision-fiscal");
  await expect(fiscal).toBeVisible({ timeout: 20_000 });
  await fiscal.getByRole("radio", { name: /Factura B\b/i }).check();
  await fiscal.getByRole("button", { name: "Revisar datos fiscales" }).click();
  await expect(fiscal.getByRole("button", { name: "Emitir comprobante" })).toBeVisible({
    timeout: 20_000,
  });
  await fiscal.getByRole("button", { name: "Emitir comprobante" }).click();
  await expect(page).toHaveURL(/resultado=factura_aprobada/, { timeout: 30_000 });

  await expect
    .poll(
      async () =>
        (await leerConversionPresupuestoFixture(fixture.presupuestoId)).presupuesto.estado,
    )
    .toBe("CONVERTIDO");
  const conversion = await leerConversionPresupuestoFixture(fixture.presupuestoId);
  expect(conversion.presupuesto.cliente_id).toBeNull();
  expect(conversion.presupuesto.conversion_payload_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(conversion.venta).toMatchObject({
    cliente_id: fixture.consumidorFinalId,
    sucursal_id: fixture.sucursalGeneralPazId,
    caja_sesion_id: fixture.cajaGeneralPazId,
    condicion_venta: "CONTADO",
  });
  expect(conversion.descripcion).toBe(fixture.descripcionColor);
  expect(conversion.pagos).toBe(1);
  expect(conversion.montoPagado).toBe(121);
  expect(conversion.movimientosStock).toBe(1);
  expect(conversion.cantidadStockMovida).toBe(-1);
  expect(conversion.movimientosCuentaCorriente).toBe(0);

  await page.goto(`/facturacion/cola?tab=emitidas&venta=${conversion.presupuesto.venta_id}`);
  const fila = page.locator("tbody tr", { hasText: conversion.venta!.numero_comprobante });
  await fila.getByRole("button", { name: "Ver/descargar" }).click();
  const detalle = page.getByTestId("dialogo-detalle-venta");
  await expect(detalle).toContainText(fixture.descripcionColor);
  await expect(detalle).toContainText("Consumidor Final");
  const descarga = page.waitForEvent("download");
  await detalle.getByRole("button", { name: "PDF" }).click();
  const archivo = await descarga;
  const ruta = testInfo.outputPath("presupuesto-consumidor-final-color.pdf");
  await archivo.saveAs(ruta);
  const pdf = await readFile(ruta, "latin1");
  const descripcionComoLiteralPdf = fixture.descripcionColor.replace(/([\\()])/g, "\\$1");
  expect(pdf).toContain(`(${descripcionComoLiteralPdf}) Tj`);
  expect(pdf).toContain("(Consumidor Final) Tj");

  const huellaAntesDeRecargar = await leerConversionPresupuestoFixture(fixture.presupuestoId);
  await page.goto(`/presupuestos/${fixture.presupuestoId}`);
  await page.reload();
  await expect(page.getByTestId("convertir")).toHaveCount(0);
  expect(await leerConversionPresupuestoFixture(fixture.presupuestoId)).toEqual(
    huellaAntesDeRecargar,
  );
});

test("sin caja bloquea ambas acciones y no autoabre ni muta el presupuesto", async ({ page }) => {
  await cerrarCajaGeneralPazFixture(fixture);
  const huellaAntes = await leerHuellaComercialFixture();
  const estadoAntes = await leerConversionPresupuestoFixture(fixture.presupuestoSinCajaId);
  const dialogo = await abrirConversion(page, fixture.presupuestoSinCajaId);

  await expect(dialogo).toContainText(`Sucursal: ${fixture.sucursalGeneralPazNombre}`);
  await expect(dialogo).toContainText("No hay caja abierta");
  await expect(dialogo.getByTestId("conv-confirmar")).toBeDisabled();
  await expect(dialogo.getByTestId("conv-y-facturar")).toBeDisabled();
  await page.reload();

  expect(await leerConversionPresupuestoFixture(fixture.presupuestoSinCajaId)).toEqual(estadoAntes);
  expect(await leerHuellaComercialFixture()).toEqual(huellaAntes);
});

test("un presupuesto identificado conserva picker y permite cuenta corriente", async ({ page }) => {
  const dialogo = await abrirConversion(page, fixture.presupuestoIdentificadoId);
  await expect(dialogo.getByRole("radio", { name: "Cliente identificado" })).toBeChecked();
  await expect(dialogo.getByTestId("conv-cliente")).toBeVisible();
  await dialogo.getByRole("combobox", { name: "Condición de venta" }).click();
  await page.getByRole("option", { name: "Cuenta corriente" }).click();
  await dialogo.getByTestId("conv-confirmar").click();

  await expect
    .poll(
      async () =>
        (await leerConversionPresupuestoFixture(fixture.presupuestoIdentificadoId)).presupuesto
          .estado,
    )
    .toBe("CONVERTIDO");
  const conversion = await leerConversionPresupuestoFixture(fixture.presupuestoIdentificadoId);
  expect(conversion.presupuesto.cliente_id).toBe(fixture.clienteCompradorId);
  expect(conversion.venta).toMatchObject({
    cliente_id: fixture.clienteCompradorId,
    sucursal_id: fixture.sucursalPrincipalId,
    condicion_venta: "CTA_CTE",
  });
  expect(conversion.pagos).toBe(0);
  expect(conversion.movimientosStock).toBe(1);
  expect(conversion.movimientosCuentaCorriente).toBe(1);
});
