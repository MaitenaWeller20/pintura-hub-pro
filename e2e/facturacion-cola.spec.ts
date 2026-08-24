import type { Locator } from "@playwright/test";

import { test, expect, ingresar } from "./apoyo";
import {
  limpiarFixturesFiscales,
  prepararFixturesFiscales,
  type FixtureFiscal,
} from "./fixtures/fiscal";

let fixture: FixtureFiscal;
type LetraFactura = "A" | "B";

function opcionLetra(dialogo: Locator, letra: LetraFactura) {
  return dialogo.getByRole("radio", { name: new RegExp(`Factura ${letra}\\b`, "i") });
}

async function revisar(dialogo: Locator, letra: LetraFactura) {
  const opcion = opcionLetra(dialogo, letra);
  await opcion.check();
  await expect(opcion).toBeChecked();
  const boton = dialogo.getByRole("button", { name: "Revisar datos fiscales" });
  await expect(boton).toBeEnabled();
  await boton.click();
  await expect(dialogo.getByRole("button", { name: /Emitir comprobante/ })).toBeVisible({
    timeout: 20_000,
  });
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  fixture = await prepararFixturesFiscales();
});
test.afterAll(async () => {
  await limpiarFixturesFiscales();
});

test("tabs y paginación navegan sólo sobre identificadores propios del fixture", async ({
  page,
}) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto(`/facturacion/cola?documento=${encodeURIComponent(fixture.documentoCola)}`);
  const tabs = page.getByRole("tablist", { name: /estados de la cola/i });
  await expect(tabs.getByRole("tab", { name: /Pendientes/ })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /A revisar/ })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /Emitidas/ })).toBeVisible();
  for (const panel of ["pendientes", "revisar", "emitidas", "historial"]) {
    await expect(page.locator(`#cola-panel-${panel}`)).toHaveCount(1);
  }
  const pendientes = tabs.getByRole("tab", { name: /Pendientes/ });
  await expect(pendientes).toHaveAttribute("aria-controls", "cola-panel-pendientes");
  await pendientes.focus();
  await page.keyboard.press("End");
  await expect(tabs.getByRole("tab", { name: /Historial/ })).toBeFocused();
  await expect(tabs.getByRole("tab", { name: /Historial/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Home");
  await expect(pendientes).toBeFocused();
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    "cola-tab-pendientes",
  );
  await expect(page.getByText(/28 registros · página 1 de 2/)).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await expect(page.locator("tbody")).toContainText("V-T13-E2E-001");
  await expect(page.locator("tbody")).not.toContainText("V-T13-E2E-028");
  await expect(page.getByRole("button", { name: /Siguiente/ })).toBeEnabled();
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByText(/28 registros · página 2 de 2/)).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(page.locator("tbody")).toContainText("V-T13-E2E-028");
});

test("filtros por documento/estado y limpieza conservan una consulta navegable", async ({
  page,
}) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto("/facturacion/cola?tab=emitidas");
  await page.getByLabel(/Documento receptor/i).fill("30-71419966-4");
  await page.getByRole("button", { name: /Aplicar filtros/i }).click();
  // La URL preserva lo que escribió el operador; el server normaliza a dígitos
  // antes de ejecutar la consulta autoritativa.
  await expect(page).toHaveURL(/documento=30-71419966-4/);
  const aprobadaPropia = page.locator("tbody tr", { hasText: "V-T13-E2E-APROBADA" });
  await expect(aprobadaPropia).toBeVisible();
  await expect(aprobadaPropia).toContainText("T13-E2E RECEPTOR CONGELADO");
  await expect(aprobadaPropia).toContainText("Producción · validez legal");
  await page.getByRole("button", { name: /Limpiar/i }).click();
  await expect(page).not.toHaveURL(/documento=/);
});

test("ventas encuentra el receptor congelado por CUIT formateado", async ({ page }) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto("/ventas");
  await page.getByPlaceholder("Buscar comprobante, comprador o receptor…").fill("30-71419966-4");
  const venta = page.locator("tbody tr", { hasText: "V-T13-E2E-APROBADA" });
  await expect(venta).toBeVisible();
  await expect(venta).toContainText("T13-E2E RECEPTOR CONGELADO");
  await expect(venta).toContainText("Producción · validez legal");
});

test("mapea todos los estados operativos y reserva incidentes para administrador", async ({
  page,
}) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto("/facturacion/cola?tab=revisar");
  const cuerpo = page.locator("tbody");
  await expect(cuerpo).toContainText("Corregir/reintentar");
  await expect(cuerpo).toContainText("Verificar con ARCA");
  await expect(cuerpo).toContainText(/Liberar claim verificado|Procesando/);
  await expect(cuerpo).toContainText(/Ver incidente|Liberar claim verificado/);
  await expect(cuerpo).toContainText(/Corregible|Conciliar|Bloqueado|Legacy/);

  const bloqueado = page.locator("tbody tr", { hasText: "V-T13-E2E-BLOQUEADO" });
  await bloqueado.getByRole("button", { name: "Ver incidente", exact: true }).click();
  const incidente = page.getByTestId("dialogo-incidente-fiscal");
  await expect(incidente).toBeVisible();
  await expect(incidente).toContainText(/sólo lectura/i);
  await expect(incidente).toContainText(/no.*reemite/i);
  await incidente.getByTestId("cerrar-incidente-fiscal").click();

  await page.getByRole("tab", { name: /Historial/ }).click();
  await expect(page.locator("tbody")).toContainText("Cancelado");
  await page.getByRole("tab", { name: /Emitidas/ }).click();
  await expect(page.locator("tbody")).toContainText("Aprobado");
});

test("empleado queda forzado a su sucursal y ve incidentes como Requiere administrador", async ({
  page,
}) => {
  await ingresar(page, "fiscalEmpleado");
  await page.goto(`/facturacion/cola?tab=pendientes&sucursal=${fixture.sucursalAlternaId}`);
  await expect(page.locator("tbody")).not.toContainText("V-T13-E2E-OTRA");
  await expect(page.locator("tbody")).toContainText("V-T13-E2E-001");

  await page.goto("/facturacion/cola?tab=revisar");
  const reconciliar = page.locator("tbody tr", { hasText: "V-T13-E2E-RECONCILIAR" });
  await expect(reconciliar).toContainText("Requiere administrador");
  await expect(reconciliar.getByRole("button")).toBeDisabled();
});

test("empleado no puede confirmar ni facturar una venta fuera de ventana", async ({ page }) => {
  await ingresar(page, "fiscalEmpleado");
  await page.goto(`/facturacion/cola?venta=${fixture.ventaAntiguaId}`);
  const antigua = page.locator("tbody tr", { hasText: "V-T13-E2E-028" });
  await expect(antigua).toContainText("Requiere administrador");
  await expect(antigua.getByRole("button", { name: "Requiere administrador" })).toBeDisabled();
  await expect(page.getByTestId("dialogo-emision-fiscal")).toHaveCount(0);
  await expect(page.getByLabel(/Confirmo emitir fuera del plazo/i)).toHaveCount(0);
});

test("Sin facturar → Facturar exige letra y revisa B con CUIL opcional", async ({ page }) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto(`/facturacion/cola?venta=${fixture.ventaPendienteId}`);
  const fila = page.locator("tbody tr", { hasText: "V-T13-E2E-001" });
  await expect(fila).toContainText(/\$\s*121/);
  await expect(fila).toContainText(/Cobrado.*40/);
  await expect(fila).toContainText(/Saldo.*81/);
  await fila.getByRole("button", { name: "Facturar" }).click();
  const dialogo = page.getByTestId("dialogo-emision-fiscal");
  await expect(dialogo).toBeVisible();
  await expect(opcionLetra(dialogo, "A")).not.toBeChecked();
  await expect(opcionLetra(dialogo, "B")).not.toBeChecked();
  await expect(dialogo.getByRole("button", { name: "Revisar datos fiscales" })).toBeDisabled();

  const opcionB = opcionLetra(dialogo, "B");
  await opcionB.check();
  await expect(opcionB).toBeChecked();
  await dialogo.getByText("Otro receptor", { exact: true }).click();
  await dialogo.getByLabel("Tipo de documento (opcional)").selectOption("CUIL");
  await dialogo.getByLabel("Número de documento (opcional)").fill(fixture.documentoCola);
  await dialogo.getByLabel("Razón social").fill("T13-E2E RECEPTOR B IDENTIFICADO");
  await dialogo.getByLabel("Condición de IVA").selectOption("CONSUMIDOR_FINAL");
  await dialogo
    .getByText(/Confirmo que revisé el documento/i)
    .locator("..")
    .getByRole("checkbox")
    .check();
  await revisar(dialogo, "B");
  await expect(dialogo).toContainText("Factura B");
  await expect(dialogo).toContainText("T13-E2E RECEPTOR B IDENTIFICADO");
  await expect(dialogo).toContainText("CUIL 20345678906");
});

test("la NC no ofrece selector y hereda letra, receptor y referencia original", async ({
  page,
}) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto(`/facturacion/cola?venta=${fixture.notaCreditoId}`);
  const fila = page.locator("tbody tr", { hasText: "NC-T13-E2E-PENDIENTE" });
  await fila.getByRole("button", { name: "Facturar" }).click();
  const dialogo = page.getByTestId("dialogo-emision-fiscal");
  await expect(dialogo).toContainText(/conservan el receptor del comprobante original/i);
  await expect(dialogo.locator("fieldset")).toHaveAttribute("disabled", "");
  await expect(dialogo.getByText("Otro receptor", { exact: true })).toHaveCount(0);
  await expect(dialogo.getByRole("radio", { name: /Factura [AB]/i })).toHaveCount(0);
  const revisarNota = dialogo.getByRole("button", { name: "Revisar datos fiscales" });
  await expect(revisarNota).toBeEnabled();
  await revisarNota.click();
  await expect(dialogo).toContainText("T13-E2E RECEPTOR CONGELADO", { timeout: 20_000 });
  await expect(dialogo).toContainText(/comprobante original/i);
  await expect(dialogo).toContainText("Domicilio fiscal receptor");
  await expect(dialogo).toContainText("Factura A");
  await expect(dialogo).toContainText(`PV ${String(fixture.puntoVenta).padStart(5, "0")}`);
  await expect(dialogo).toContainText("00913001");
});

test("APROBADO abre detalle fiscal descargable y restaura el foco al salir", async ({ page }) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto(`/facturacion/cola?tab=emitidas&venta=${fixture.ventaAprobadaId}`);
  const fila = page.locator("tbody tr", { hasText: "V-T13-E2E-APROBADA" });
  const abrir = fila.getByRole("button", { name: "Ver/descargar" });
  await abrir.click();
  const dialogo = page.getByTestId("dialogo-detalle-venta");
  await expect(dialogo).toBeVisible();
  await expect(dialogo).toContainText("T13-E2E RECEPTOR CONGELADO");
  await expect(dialogo).toContainText("Producción · validez legal");
  await expect(dialogo).toContainText("Domicilio fiscal receptor");
  const descarga = page.waitForEvent("download");
  await dialogo.getByRole("button", { name: "PDF" }).click();
  await descarga;
  await page.keyboard.press("Escape");
  await expect(dialogo).not.toBeVisible();
  await expect(abrir).toBeFocused();
});

test("un fallo de cabecera muestra progreso, permite reintentar y cerrar con foco restaurado", async ({
  page,
}) => {
  await ingresar(page, "fiscalAdmin");
  let bloquearCabecera = true;
  let demorarPrimera = true;
  let liberarCabecera: (() => void) | undefined;
  await page.route(/\/rest\/v1\/ventas\?/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("id") !== `eq.${fixture.ventaAprobadaId}`) {
      await route.continue();
      return;
    }
    if (demorarPrimera) {
      demorarPrimera = false;
      await new Promise<void>((resolve) => {
        liberarCabecera = resolve;
      });
    }
    if (bloquearCabecera) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          code: "T13_E2E",
          message: "CABECERA_E2E_INDISPONIBLE",
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/facturacion/cola?tab=emitidas&venta=${fixture.ventaAprobadaId}`);
  const fila = page.locator("tbody tr", { hasText: "V-T13-E2E-APROBADA" });
  const abrir = fila.getByRole("button", { name: "Ver/descargar" });
  await abrir.click();
  await expect(page.getByRole("status")).toContainText("Cargando detalle de la venta");
  expect(liberarCabecera).toBeDefined();
  liberarCabecera?.();

  const error = page.getByRole("alert").filter({ hasText: "CABECERA_E2E_INDISPONIBLE" });
  await expect(error).toBeVisible();
  await expect(error.getByRole("button", { name: "Reintentar detalle" })).toBeVisible();
  await error.getByRole("button", { name: "Cerrar detalle" }).click();
  await expect(error).not.toBeVisible();
  await expect(abrir).toBeFocused();

  await abrir.click();
  const segundoError = page.getByRole("alert").filter({ hasText: "CABECERA_E2E_INDISPONIBLE" });
  await expect(segundoError).toBeVisible();
  bloquearCabecera = false;
  await segundoError.getByRole("button", { name: "Reintentar detalle" }).click();
  await expect(page.getByTestId("dialogo-detalle-venta")).toBeVisible();
});

test("un detalle incompleto bloquea el PDF y permite reintentar o cerrar desde la cola", async ({
  page,
}) => {
  await ingresar(page, "fiscalAdmin");
  let bloquearItems = true;
  await page.route(/\/rest\/v1\/venta_items\?/, async (route) => {
    const url = new URL(route.request().url());
    if (bloquearItems && url.searchParams.get("venta_id") === `eq.${fixture.ventaAprobadaId}`) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          code: "T13_E2E",
          message: "ITEMS_E2E_INDISPONIBLES",
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/facturacion/cola?tab=emitidas&venta=${fixture.ventaAprobadaId}`);
  const fila = page.locator("tbody tr", { hasText: "V-T13-E2E-APROBADA" });
  const abrir = fila.getByRole("button", { name: "Ver/descargar" });
  await abrir.click();
  const dialogo = page.getByTestId("dialogo-detalle-venta");
  await expect(dialogo.getByRole("alert")).toContainText("ITEMS_E2E_INDISPONIBLES");
  await expect(dialogo.getByRole("button", { name: "PDF" })).toBeDisabled();
  bloquearItems = false;
  await dialogo.getByRole("button", { name: "Reintentar" }).click();
  await expect(dialogo).toContainText("Producto congelado al emitir");
  await expect(dialogo.getByRole("button", { name: "PDF" })).toBeEnabled();
  await dialogo.getByRole("button", { name: "Cerrar" }).click();
  await expect(dialogo).not.toBeVisible();
  await expect(abrir).toBeFocused();
});

test("CANCELADO abre detalle readonly sin descarga y restaura el foco", async ({ page }) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto(`/facturacion/cola?tab=historial&venta=${fixture.ventaCanceladaId}`);
  const fila = page.locator("tbody tr", { hasText: "V-T13-E2E-CANCELADO" });
  const abrir = fila.getByRole("button", { name: "Ver", exact: true });
  await abrir.click();
  const dialogo = page.getByTestId("dialogo-detalle-venta");
  await expect(dialogo).toBeVisible();
  await expect(dialogo).toContainText(/estado fiscal/i);
  await expect(dialogo.getByRole("button", { name: "PDF" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialogo).not.toBeVisible();
  await expect(abrir).toBeFocused();
});
