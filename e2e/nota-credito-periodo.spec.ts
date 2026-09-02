import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";

import { test, expect, ingresar, vigilarConsola } from "./apoyo";
import {
  cantidadVentasDelProductoE2E,
  configurarFlagNcPeriodoFixture,
  intentarNcPeriodoSinPermisoFixture,
  leerEfectosVentaFixture,
  leerNotaCreditoPeriodoFixture,
  limpiarFixturesFiscales,
  prepararFixturesFiscales,
  type FixtureFiscal,
} from "./fixtures/fiscal";

const ESCENARIO = process.env.INVOICING_MOCK_SCENARIO ?? "OK";
let fixture: FixtureFiscal;
let erroresConsola: string[];

function desplazarFechaIso(fecha: string, dias: number): string {
  const valor = new Date(`${fecha}T12:00:00.000Z`);
  valor.setUTCDate(valor.getUTCDate() + dias);
  return valor.toISOString().slice(0, 10);
}

function fechaVisible(fecha: string): string {
  return fecha.split("-").reverse().join("/");
}

function textoPdf(bytes: Buffer): string {
  const decodificado = bytes
    .toString("latin1")
    .replace(/\\(\d{3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    )
    .replace(/\\([()\\])/g, "$1")
    .replace(/\u00a0/g, " ")
    .replace(/\x97/g, "—");
  return [...decodificado.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)]
    .map((match) => match[1].replace(/\\([()\\])/g, "$1"))
    .join(" ")
    .replace(/\s+/g, " ");
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  fixture = await prepararFixturesFiscales();
});
test.afterAll(async () => {
  await limpiarFixturesFiscales();
});
test.beforeEach(async ({ page }) => {
  erroresConsola = vigilarConsola(page);
});
test.afterEach(async () => {
  expect(erroresConsola, "la historia no debe dejar errores inesperados en consola").toEqual([]);
});

async function elegirNotaCredito(page: Page): Promise<void> {
  await page.getByRole("combobox", { name: /Tipo comprobante/i }).click();
  await page.getByRole("option", { name: "Nota de Crédito" }).click();
}

async function elegirCliente(page: Page, nombre: string): Promise<void> {
  await page.getByRole("button", { name: "Buscar cliente…" }).click();
  await page.getByPlaceholder("Nombre o CUIT…").last().fill(nombre);
  await page.getByRole("button", { name: new RegExp(nombre) }).click();
}

async function abrirEditorPeriodo(page: Page, cliente: string): Promise<void> {
  await page.goto("/ventas/nueva");
  await expect(page.getByText("Nuevo comprobante")).toBeVisible();
  await elegirNotaCredito(page);
  await elegirCliente(page, cliente);
  await page.getByText("Sin factura puntual — asociar por período", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Asociación fiscal por período" })).toBeVisible();
}

async function completarBasePeriodo(page: Page, motivo: string): Promise<void> {
  await page.locator("#nc-periodo-desde").fill(fixture.fechaFiscal);
  await page.locator("#nc-periodo-hasta").fill(fixture.fechaFiscal);
  await page.locator("#nc-periodo-motivo").fill(motivo);
}

async function agregarProducto(page: Page): Promise<void> {
  await page.locator("#nc-producto").click();
  await page.getByRole("option", { name: /T13-E2E Producto fiscal/ }).click();
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
}

async function crearPendiente(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Crear nota pendiente" }).click();
  await expect(page).toHaveURL(
    /\/facturacion\/cola\?venta=[0-9a-f-]+&resultado=venta_creada_factura_pendiente/,
    { timeout: 25_000 },
  );
  const ventaId = new URL(page.url()).searchParams.get("venta");
  if (!ventaId) throw new Error("La cola no conservó el id de la NC por período creada.");
  return ventaId;
}

async function revisarPeriodo(dialogo: Locator): Promise<void> {
  await expect(dialogo.getByText("CUIT verificado por ARCA")).toBeVisible({ timeout: 20_000 });
  const revisar = dialogo.getByRole("button", { name: "Revisar datos fiscales" });
  await expect(revisar).toBeEnabled({ timeout: 20_000 });
  await revisar.click();
  await expect(dialogo.getByText("Letra resuelta")).toBeVisible({ timeout: 20_000 });
  await dialogo
    .getByText(/Confirmo que el período corresponde exactamente/i)
    .locator("..")
    .getByRole("checkbox")
    .check();
}

async function emitirPeriodo(dialogo: Locator): Promise<void> {
  const emitir = dialogo.getByRole("button", { name: "Emitir comprobante", exact: true });
  await expect(emitir).toBeEnabled();
  await emitir.click();
  const reconfirmar = dialogo.getByRole("button", { name: "Confirmar cambios y emitir" });
  const requiereReconfirmacion = await Promise.race([
    reconfirmar
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false),
    dialogo
      .waitFor({ state: "hidden", timeout: 15_000 })
      .then(() => false)
      .catch(() => false),
    dialogo
      .getByRole("alert")
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => false)
      .catch(() => false),
  ]);
  if (requiereReconfirmacion) {
    await expect(reconfirmar).toBeEnabled();
    await reconfirmar.click();
  }
}

test("sin capacidad no ve el modo por período y la RPC directa falla con permiso humano", async ({
  page,
}) => {
  test.skip(ESCENARIO !== "OK", "La matriz de permisos pertenece al escenario OK.");
  await ingresar(page, "sinCapacidad");
  await page.goto("/ventas/nueva");
  await elegirNotaCredito(page);
  await expect(
    page.getByText("Sin factura puntual — asociar por período", { exact: true }),
  ).toHaveCount(0);

  await expect(intentarNcPeriodoSinPermisoFixture(fixture)).resolves.toEqual({
    code: "42501",
    message: expect.stringMatching(/permiso efectivo para emitir NC por período/i),
  });
});

test("fechas, motivo y liquidación inválidos quedan inline y no disparan un POST", async ({
  page,
}) => {
  test.skip(ESCENARIO !== "OK", "La validación inline pertenece al escenario OK.");
  await ingresar(page, "fiscalAdmin");
  await abrirEditorPeriodo(page, "T13-E2E CLIENTE PERIODO RI");
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });

  await page.getByRole("button", { name: "Crear nota pendiente" }).click();
  await expect(page.getByRole("alert")).toHaveText("Indicá la fecha inicial del período.");
  expect(posts).toEqual([]);

  await page.locator("#nc-periodo-desde").fill(fixture.fechaFiscal);
  await page.locator("#nc-periodo-hasta").fill(desplazarFechaIso(fixture.fechaFiscal, -1));
  await page.locator("#nc-periodo-motivo").fill("Motivo válido para aislar el rango");
  await agregarProducto(page);
  await page.getByRole("button", { name: "Crear nota pendiente" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Indicá una fecha final válida y posterior o igual a la inicial.",
  );
  expect(posts).toEqual([]);

  await page.locator("#nc-periodo-hasta").fill(fixture.fechaFiscal);
  await page.locator("#nc-periodo-motivo").fill("");
  await page.getByRole("button", { name: "Crear nota pendiente" }).click();
  await expect(page.getByRole("alert")).toHaveText("Indicá el motivo de la nota de crédito.");
  expect(posts).toEqual([]);

  await page.locator("#nc-periodo-motivo").fill("Motivo válido E2E");
  await page.getByRole("button", { name: "Agregar medio" }).click();
  await page.getByLabel("Monto de reintegro 1").fill("120");
  await page.getByRole("button", { name: "Crear nota pendiente" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "El reintegro debe distribuir el total exacto entre sus medios de pago.",
  );
  expect(posts).toEqual([]);
});

test("admin devuelve producto, valida CUIT comercial, recibe CAE y materializa efectos/PDF una vez", async ({
  page,
}, testInfo) => {
  test.skip(ESCENARIO !== "OK", "La aprobación determinística pertenece al escenario OK.");
  await ingresar(page, "fiscalAdmin");
  await abrirEditorPeriodo(page, "T13-E2E CLIENTE PERIODO RI");
  await completarBasePeriodo(page, "Devolución E2E del período");
  const periodoDesde = desplazarFechaIso(fixture.fechaFiscal, -1);
  await page.locator("#nc-periodo-desde").fill(periodoDesde);
  await agregarProducto(page);
  await page.getByRole("button", { name: "Agregar medio" }).click();
  await page.getByLabel("Forma de reintegro 1").click();
  await page.getByRole("option", { name: "Transferencia" }).click();
  await page.getByLabel("Monto de reintegro 1").fill("60");
  await page.getByRole("button", { name: "Agregar medio" }).click();
  await page.getByLabel("Forma de reintegro 2").click();
  await page.getByRole("option", { name: "Tarjeta de crédito" }).click();
  await page.getByLabel("Monto de reintegro 2").fill("61");

  const ventaId = await crearPendiente(page);
  await expect
    .poll(() => leerNotaCreditoPeriodoFixture(ventaId))
    .toMatchObject({
      venta: { afip_estado: "SIN_FACTURAR", nc_efectos_aplicados_at: null },
      pagos: [],
      stock: [],
      deuda: [],
    });
  const dialogo = page.getByTestId("dialogo-emision-fiscal");
  await expect(dialogo).toContainText("T13-E2E CLIENTE PERIODO RI");
  await revisarPeriodo(dialogo);
  await expect(dialogo).toContainText("T13-E2E RECEPTOR PADRÓN MOCK");
  await expect(dialogo).toContainText("Transferencia");
  await expect(dialogo).toContainText("Tarjeta Crédito");
  await emitirPeriodo(dialogo);

  const resultadoEmision = await leerNotaCreditoPeriodoFixture(ventaId);
  expect(resultadoEmision.venta?.afip_estado, {
    message: JSON.stringify({
      clase: resultadoEmision.venta?.afip_error_clase,
      codigo: resultadoEmision.venta?.afip_error_codigo,
      fase: resultadoEmision.venta?.afip_error_fase,
    }),
  }).toBe("APROBADO");
  await expect(page).toHaveURL(/resultado=factura_aprobada/, { timeout: 25_000 });
  const detalle = page.getByTestId("dialogo-detalle-venta");
  await expect(detalle).toBeVisible({ timeout: 20_000 });
  await expect(detalle).toContainText("Auditoría de NC por período");
  await expect(detalle).toContainText("Período asociado (snapshot v3)");
  await expect(detalle).toContainText("Efectos aplicados el");
  await expect(detalle).toContainText("T13-E2E RECEPTOR PADRÓN MOCK");
  await expect(detalle.getByRole("button", { name: "PDF" })).toBeEnabled();

  const estado = await leerNotaCreditoPeriodoFixture(ventaId);
  expect(estado.venta).toMatchObject({
    afip_estado: "APROBADO",
    afip_fase: "PERSISTIDO",
    cae: expect.stringMatching(/^\d{14}$/),
    nc_periodo_modalidad: "DEVOLUCION_PRODUCTOS",
    nc_resolucion: "REINTEGRO",
  });
  expect(estado.venta.nc_efectos_aplicados_at).not.toBeNull();
  expect(estado.stock).toEqual([
    expect.objectContaining({ producto_id: fixture.productoId, tipo: "DEVOLUCION", cantidad: 1 }),
  ]);
  expect(estado.deuda).toEqual([]);
  expect(estado.pagos).toHaveLength(2);
  expect(estado.pagos).toEqual(
    expect.arrayContaining([
      { forma_pago: "TARJETA_CREDITO", monto: -61 },
      { forma_pago: "TRANSFERENCIA", monto: -60 },
    ]),
  );
  expect(estado.reintegros).toEqual([
    { forma_pago: "TARJETA_CREDITO", monto: 61, orden: 0 },
    { forma_pago: "TRANSFERENCIA", monto: 60, orden: 1 },
  ]);
  expect(estado.intentos).toHaveLength(1);
  expect(estado.venta.afip_snapshot).toMatchObject({
    version: 3,
    origen: "PERIODO_ASOCIADO",
    periodoAsoc: { desde: periodoDesde, hasta: fixture.fechaFiscal },
    cbtesAsoc: [],
  });

  const descarga = page.waitForEvent("download");
  await detalle.getByRole("button", { name: "PDF" }).click();
  const archivo = await descarga;
  const ruta = testInfo.outputPath("nota-credito-periodo.pdf");
  await archivo.saveAs(ruta);
  const contenidoPdf = textoPdf(await readFile(ruta));
  expect(contenidoPdf).toContain("T13-E2E RECEPTOR PADRÓN MOCK");
  expect(contenidoPdf).toContain(estado.venta.cae!);
  expect(contenidoPdf).toContain("Motivo: Devolución E2E del período");
  expect(contenidoPdf).toContain("Modalidad: Devolución de productos");
  expect(contenidoPdf).toContain(
    `Período asociado: ${fechaVisible(periodoDesde)} a ${fechaVisible(fixture.fechaFiscal)}`,
  );

  await page.reload();
  await expect
    .poll(async () => (await leerNotaCreditoPeriodoFixture(ventaId)).pagos)
    .toEqual(estado.pagos);
  const despuesDeRecargar = await leerNotaCreditoPeriodoFixture(ventaId);
  expect(despuesDeRecargar.pagos).toEqual(estado.pagos);
  expect(despuesDeRecargar.stock).toEqual([
    expect.objectContaining({ tipo: "DEVOLUCION", cantidad: 1 }),
  ]);
  expect(despuesDeRecargar.intentos).toHaveLength(1);
});

test("empleado autorizado acredita ajuste al cliente comercial con otro receptor y sin stock", async ({
  page,
}) => {
  test.skip(ESCENARIO !== "OK", "El ajuste completo pertenece al escenario OK.");
  await ingresar(page, "fiscalEmpleado");
  await abrirEditorPeriodo(page, "T13-E2E CLIENTE AJUSTE");
  await completarBasePeriodo(page, "Bonificación E2E del período");
  await page.getByText("Bonificación o ajuste", { exact: true }).click();
  await page.locator("#nc-periodo-concepto").fill("Diferencia comercial E2E");
  await page.locator("#nc-periodo-importe").fill("100");
  await page.getByText("Acreditar saldo a favor", { exact: true }).click();
  const ventaId = await crearPendiente(page);

  const dialogo = page.getByTestId("dialogo-emision-fiscal");
  await dialogo.getByRole("radio", { name: "Otro receptor" }).check();
  await dialogo.getByLabel("CUIT", { exact: true }).fill("30-62114631-5");
  await expect(dialogo.getByText("CUIT verificado por ARCA")).toBeVisible({ timeout: 20_000 });
  await revisarPeriodo(dialogo);
  await expect(dialogo).toContainText("T13-E2E OTRO RECEPTOR PADRÓN MOCK");
  await expect(dialogo).toContainText("T13-E2E CLIENTE AJUSTE");
  await emitirPeriodo(dialogo);

  await expect(page).toHaveURL(/resultado=factura_aprobada/, { timeout: 25_000 });
  await expect
    .poll(() => leerNotaCreditoPeriodoFixture(ventaId))
    .toMatchObject({
      venta: {
        cliente_id: fixture.clienteAjusteId,
        afip_estado: "APROBADO",
        nc_periodo_modalidad: "BONIFICACION_AJUSTE",
        nc_resolucion: "SALDO_FAVOR",
        nc_efectos_aplicados_at: expect.any(String),
      },
      pagos: [],
      stock: [],
      deuda: [{ cliente_id: fixture.clienteAjusteId, tipo: "CREDITO", monto: 121 }],
    });
  const estado = await leerNotaCreditoPeriodoFixture(ventaId);
  expect(estado.venta.afip_snapshot).toMatchObject({
    receptor: {
      razonSocial: "T13-E2E OTRO RECEPTOR PADRÓN MOCK",
      numeroDocumento: "30621146315",
    },
    notaCredito: { modalidad: "BONIFICACION_AJUSTE" },
  });
});

test("flag apagado oculta sólo el camino por período y conserva la venta ordinaria", async ({
  page,
}) => {
  test.skip(ESCENARIO !== "OK", "El gate de rollout pertenece al escenario OK.");
  const ventasAntes = await cantidadVentasDelProductoE2E();
  await configurarFlagNcPeriodoFixture(false);
  try {
    await ingresar(page, "fiscalAdmin");
    await page.goto("/ventas/nueva");
    await elegirNotaCredito(page);
    await expect(
      page.getByText("Sin factura puntual — asociar por período", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("Revertir una factura específica", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Nota interna — sin informar a ARCA", { exact: true }),
    ).toBeVisible();
    await page.getByRole("combobox", { name: /Tipo comprobante/i }).click();
    await page.getByRole("option", { name: "Venta" }).click();
    await expect(page.getByTestId("registrar-y-facturar")).toBeVisible();
    await expect(page.getByTestId("registrar-sin-facturar")).toBeVisible();
    await elegirCliente(page, "T13-E2E COMPRADOR COMERCIAL");
    await page.getByTestId("venta-buscar-producto").fill("T13-E2E-PROD");
    await page.getByRole("button", { name: /T13-E2E-PROD.*Producto fiscal/ }).click();
    const editorPagos = page.getByTestId("editor-pagos");
    await editorPagos.getByRole("button", { name: /agregar pago/i }).click();
    await editorPagos.getByLabel("Monto").fill("121");
    await page.getByTestId("registrar-sin-facturar").click();
    await expect(page).toHaveURL(
      /\/facturacion\/cola\?venta=[0-9a-f-]+&resultado=venta_creada_factura_pendiente/,
      { timeout: 20_000 },
    );
    const ventaId = new URL(page.url()).searchParams.get("venta");
    if (!ventaId) throw new Error("La venta ordinaria no devolvió su identidad persistida.");
    await expect.poll(() => cantidadVentasDelProductoE2E()).toBe(ventasAntes + 1);
    await expect
      .poll(() => leerEfectosVentaFixture(ventaId))
      .toMatchObject({
        estadoFiscal: "SIN_FACTURAR",
        ventas: 1,
        items: 1,
        pagos: 1,
        stock: 1,
        deuda: 0,
        intentos: 0,
      });
  } finally {
    await configurarFlagNcPeriodoFixture(true);
  }
});

test("caída previa muestra el copy exacto y no aplica efectos", async ({ page }) => {
  test.skip(ESCENARIO !== "CAIDA_PRE_REQUEST", "Requiere proceso CAIDA_PRE_REQUEST.");
  await ingresar(page, "fiscalAdmin");
  await abrirEditorPeriodo(page, "T13-E2E CLIENTE PERIODO RI");
  await completarBasePeriodo(page, "Caída previa E2E");
  await agregarProducto(page);
  await page.getByText("Acreditar saldo a favor", { exact: true }).click();
  const ventaId = await crearPendiente(page);
  const dialogo = page.getByTestId("dialogo-emision-fiscal");
  await revisarPeriodo(dialogo);
  await emitirPeriodo(dialogo);
  await expect(dialogo.getByRole("alert")).toHaveText(
    "ARCA está caída. No se pudo emitir la nota de crédito. Intentá nuevamente en otro momento.",
    { timeout: 20_000 },
  );
  await expect
    .poll(() => leerNotaCreditoPeriodoFixture(ventaId))
    .toMatchObject({
      venta: { afip_estado: "ERROR_CORREGIBLE", nc_efectos_aplicados_at: null },
      pagos: [],
      stock: [],
      deuda: [],
    });
});

test("timeout posterior bloquea reemisión, concilia el CAE y aplica efectos una vez", async ({
  page,
}) => {
  test.skip(ESCENARIO !== "TIMEOUT_POST_REQUEST", "Requiere proceso TIMEOUT_POST_REQUEST.");
  await ingresar(page, "fiscalAdmin");
  await abrirEditorPeriodo(page, "T13-E2E CLIENTE PERIODO RI");
  await completarBasePeriodo(page, "Timeout posterior E2E");
  await agregarProducto(page);
  await page.getByText("Acreditar saldo a favor", { exact: true }).click();
  const ventaId = await crearPendiente(page);
  const dialogo = page.getByTestId("dialogo-emision-fiscal");
  await revisarPeriodo(dialogo);
  await emitirPeriodo(dialogo);
  await expect(dialogo.getByRole("alert")).toHaveText(
    "ARCA está caída y estamos verificando si autorizó la nota. No vuelvas a emitirla.",
    { timeout: 20_000 },
  );
  await expect(dialogo.getByRole("button", { name: /Emitir comprobante/ })).toHaveCount(0);
  await expect
    .poll(() => leerNotaCreditoPeriodoFixture(ventaId))
    .toMatchObject({
      venta: { afip_estado: "RECONCILIAR", nc_efectos_aplicados_at: null },
      stock: [],
      deuda: [],
    });
  await dialogo.getByRole("button", { name: "Cancelar" }).click();
  const verificar = page.getByRole("button", { name: "Verificar con ARCA", exact: true });
  await expect(verificar).toBeVisible({
    timeout: 20_000,
  });
  await verificar.click();
  await expect(page.getByText("ARCA confirmó y recuperó el comprobante.")).toBeVisible({
    timeout: 25_000,
  });
  await expect
    .poll(() => leerNotaCreditoPeriodoFixture(ventaId))
    .toMatchObject({
      venta: {
        afip_estado: "APROBADO",
        nc_efectos_aplicados_at: expect.any(String),
        cae: expect.stringMatching(/^\d{14}$/),
      },
      pagos: [],
      stock: [expect.objectContaining({ tipo: "DEVOLUCION", cantidad: 1 })],
      deuda: [{ cliente_id: fixture.clientePeriodoId, tipo: "CREDITO", monto: 121 }],
    });
  const final = await leerNotaCreditoPeriodoFixture(ventaId);
  expect(final.intentos).toHaveLength(1);
});
