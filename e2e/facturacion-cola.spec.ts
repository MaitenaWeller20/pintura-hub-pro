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

test("tabs, conteos y paginación salen de la cola autoritativa", async ({ page }) => {
  await ingresar(page);
  await page.goto("/facturacion/cola");
  const tabs = page.getByRole("tablist", { name: /estados de la cola/i });
  await expect(tabs.getByRole("tab", { name: /Pendientes/ })).toContainText(/2[89]|3\d/);
  await expect(tabs.getByRole("tab", { name: /A revisar/ })).not.toContainText("—");
  await expect(tabs.getByRole("tab", { name: /Emitidas/ })).not.toContainText("—");
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await expect(page.getByText(/página 1 de 2/i)).toBeVisible();
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator("tbody tr").first()).toBeVisible();
});

test("filtros por documento/estado y limpieza conservan una consulta navegable", async ({
  page,
}) => {
  await ingresar(page);
  await page.goto("/facturacion/cola?tab=emitidas");
  await page.getByLabel(/Documento receptor/i).fill("30-71419966-4");
  await page.getByRole("button", { name: /Aplicar filtros/i }).click();
  // La URL preserva lo que escribió el operador; el server normaliza a dígitos
  // antes de ejecutar la consulta autoritativa.
  await expect(page).toHaveURL(/documento=30-71419966-4/);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("T13-E2E RECEPTOR CONGELADO");
  await expect(page.locator("tbody tr")).toContainText("SIMULADA");
  await page.getByRole("button", { name: /Limpiar/i }).click();
  await expect(page).not.toHaveURL(/documento=/);
});

test("mapea todos los estados operativos y reserva incidentes para administrador", async ({
  page,
}) => {
  await ingresar(page);
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
  await ingresar(page, "empleado");
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
  await ingresar(page);
  await page.goto(`/facturacion/cola?venta=${fixture.ventaPendienteId}`);
  const fila = page.locator("tbody tr", { hasText: "V-T13-E2E-001" });
  await expect(fila).toContainText(/\$\s*121/);
  await expect(fila).toContainText(/Cobrado.*40/);
  await expect(fila).toContainText(/Saldo.*81/);
  await fila.getByRole("button", { name: "Facturar" }).click();
  await expect(page.getByTestId("dialogo-emision-fiscal")).toBeVisible();
});

test("la NC hereda receptor y referencia original en modo sólo lectura", async ({ page }) => {
  await ingresar(page);
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
