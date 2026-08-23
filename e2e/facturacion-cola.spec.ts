import { test, expect, ingresar } from "./apoyo";
import {
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

test("tabs y paginación navegan sólo sobre identificadores propios del fixture", async ({
  page,
}) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto(`/facturacion/cola?documento=${encodeURIComponent(fixture.documentoCola)}`);
  const tabs = page.getByRole("tablist", { name: /estados de la cola/i });
  await expect(tabs.getByRole("tab", { name: /Pendientes/ })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /A revisar/ })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /Emitidas/ })).toBeVisible();
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
  await expect(aprobadaPropia).toContainText("PRODUCCION");
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

test("venta exacta abre el mismo diálogo y muestra total, cobrado y saldo separados", async ({
  page,
}) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto(`/facturacion/cola?venta=${fixture.ventaPendienteId}`);
  const fila = page.locator("tbody tr", { hasText: "V-T13-E2E-001" });
  await expect(fila).toContainText(/\$\s*121/);
  await expect(fila).toContainText(/Cobrado.*40/);
  await expect(fila).toContainText(/Saldo.*81/);
  await fila.getByRole("button", { name: "Facturar" }).click();
  await expect(page.getByTestId("dialogo-emision-fiscal")).toBeVisible();
});

test("la NC hereda receptor y referencia original en modo sólo lectura", async ({ page }) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto(`/facturacion/cola?venta=${fixture.notaCreditoId}`);
  const fila = page.locator("tbody tr", { hasText: "NC-T13-E2E-PENDIENTE" });
  await fila.getByRole("button", { name: "Facturar" }).click();
  const dialogo = page.getByTestId("dialogo-emision-fiscal");
  await expect(dialogo).toContainText(/conservan el receptor del comprobante original/i);
  await expect(dialogo.locator("fieldset")).toHaveAttribute("disabled", "");
  await expect(dialogo.getByText("Otro receptor", { exact: true })).toHaveCount(0);
  await dialogo.getByRole("button", { name: "Revisar datos fiscales" }).click();
  await expect(dialogo).toContainText("T13-E2E RECEPTOR CONGELADO", { timeout: 20_000 });
  await expect(dialogo).toContainText(/comprobante original/i);
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
  const descarga = page.waitForEvent("download");
  await dialogo.getByRole("button", { name: "PDF" }).click();
  await descarga;
  await page.keyboard.press("Escape");
  await expect(dialogo).not.toBeVisible();
  await expect(abrir).toBeFocused();
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
