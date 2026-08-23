// ============================================================
// e2e de "al contado se cobra entero" desde la pantalla de ventas.
//   NODE_ENV=test INVOICING_MOCK_TEST_RUNNER=playwright INVOICING_MOCK_MODE=true \
//     INVOICING_MOCK_SCENARIO=OK bun run dev
//   NODE_ENV=test INVOICING_MOCK_TEST_RUNNER=playwright INVOICING_MOCK_MODE=true \
//     INVOICING_MOCK_SCENARIO=OK PW_DIR=… node scripts/test-venta-contado-e2e.mjs
//
// La regla vive en crear_venta, pero lo que importa es que el cajero NO llegue
// a apretar Guardar para comerse el error: la pantalla tiene que frenarlo antes
// y decirle qué hacer.
// ============================================================
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const baseUrl = new URL(BASE);
if (!/^(127\.0\.0\.1|localhost)$/.test(baseUrl.hostname)) {
  throw new Error("El E2E de venta sólo puede abrir una app local.");
}
if (
  process.env.NODE_ENV !== "test" ||
  process.env.INVOICING_MOCK_TEST_RUNNER !== "playwright" ||
  process.env.INVOICING_MOCK_MODE !== "true" ||
  process.env.INVOICING_MOCK_SCENARIO !== "OK"
) {
  throw new Error("El E2E exige NODE_ENV=test + runner Playwright + mock=true + escenario OK.");
}
const require = createRequire(`${process.env.PW_DIR ?? "/tmp/pw"}/index.js`);
const { chromium } = require("playwright");
const configSupabase = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
const projectId = configSupabase.match(/^project_id\s*=\s*"([a-z0-9_-]+)"/m)?.[1];
if (!projectId) throw new Error("No se pudo resolver el project_id del Supabase local.");
const dbContainer = `supabase_db_${projectId}`;

const psql = (sql) =>
  execFileSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql],
    { encoding: "utf8" },
  ).trim();

const fallos = [];
const chequear = (n, ok, d) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${ok ? "" : ` — ${d}`}`);
  if (!ok) fallos.push(n);
};

const verificarServidorAislado = async () => {
  const response = await fetch(`${BASE}/api/e2e-fingerprint`, { cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (
    response.status !== 200 ||
    body?.app !== "PinturaGest" ||
    body?.nodeEnv !== "test" ||
    body?.runner !== "playwright" ||
    body?.mockMode !== true ||
    body?.scenario !== "OK"
  ) {
    throw new Error("El servidor local no confirmó el fingerprint fiscal E2E estricto.");
  }
};

const limpiar = () => {
  const ventas = psql(`select coalesce(string_agg(quote_literal(v.id::text), ','), '')
    from public.ventas v join public.venta_items vi on vi.venta_id=v.id
    join public.productos p on p.id=vi.producto_id where p.codigo='E2E-CONT'`);
  const ids = ventas ? `(${ventas})` : "(NULL)";
  psql(`
    DELETE FROM public.emision_fiscal_intentos WHERE venta_id IN ${ids};
    DELETE FROM public.venta_pagos WHERE venta_id IN ${ids};
    DELETE FROM public.cuenta_corriente_movimientos WHERE venta_id IN ${ids};
    DELETE FROM public.stock_movimientos WHERE referencia_id IN ${ids};
    DELETE FROM public.venta_items WHERE venta_id IN ${ids};
    DELETE FROM public.ventas WHERE id IN ${ids};
    DELETE FROM public.stock_movimientos m USING public.productos p
     WHERE p.id=m.producto_id AND p.codigo='E2E-CONT';
    DELETE FROM public.stock_sucursal s USING public.productos p
     WHERE p.id=s.producto_id AND p.codigo='E2E-CONT';
    DELETE FROM public.productos WHERE codigo='E2E-CONT';
  `);
};

await verificarServidorAislado();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => fallos.push(`error de página: ${e.message}`));

try {
  console.log("── Sembrando ────────────────────────────────────────────");
  limpiar();
  psql(`
    INSERT INTO public.productos (codigo,nombre,precio_sin_iva,iva_porcentaje)
    VALUES ('E2E-CONT','PRODUCTO E2E CONTADO',1000,21);
    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
    VALUES ((SELECT id FROM public.productos WHERE codigo='E2E-CONT'),
            (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1), 30)
    ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET cantidad = 30;
  `);
  const stock0 = psql(`select cantidad::text from public.stock_sucursal s
     join public.productos p on p.id=s.producto_id where p.codigo='E2E-CONT'`);

  console.log("── Login ────────────────────────────────────────────────");
  await page.goto(`${BASE}/auth`);
  await page.getByRole("textbox", { name: "Email" }).fill("admin@local.test");
  await page.getByRole("textbox", { name: "Contraseña" }).fill("admin1234");
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL((u) => !/\/auth/.test(u.pathname), { timeout: 30000 });

  console.log("── Cargando una venta al contado ────────────────────────");
  await page.goto(`${BASE}/ventas/nueva`);
  await page.getByRole("button", { name: /Buscar cliente/i }).click();
  await page.locator('input[placeholder="Nombre o CUIT…"]').waitFor();
  await page.waitForTimeout(1500);
  await page.locator(".max-h-64 button").first().click();

  await page.getByRole("button", { name: "Agregar" }).first().click();
  await page.locator('input[placeholder="Código o nombre…"]').fill("E2E-CONT");
  await page.waitForTimeout(1500);
  await page.getByText("PRODUCTO E2E CONTADO").first().click();
  await page.waitForTimeout(800);

  const registrar = page.getByTestId("registrar-sin-facturar");
  chequear(
    "sin cobrar un peso, Registrar sin facturar está bloqueado",
    await registrar.isDisabled(),
    "el botón está habilitado con la venta sin pagar",
  );
  chequear(
    "y la pantalla dice qué hacer",
    await page.getByText(/hay que cobrar algo/i).isVisible(),
    "no aparece el aviso",
  );

  console.log("── Cobrando una parte (el fiado del mostrador) ──────────");
  await page
    .getByRole("button", { name: /Agregar pago|Pago/i })
    .first()
    .click();
  await page.waitForTimeout(600);
  // El pago viene con el total; lo bajo a una seña.
  const monto = page.locator("text=Monto").locator("..").locator("input");
  await monto.fill("500");
  await monto.blur();
  await page.waitForTimeout(600);
  chequear(
    "con una parte cobrada ya se puede guardar",
    await registrar.isEnabled(),
    "sigue bloqueado con el pago parcial",
  );

  await registrar.click();
  await page.waitForURL(
    /\/facturacion\/cola\?venta=[0-9a-f-]+&resultado=venta_creada_factura_pendiente/,
    { timeout: 30000 },
  );
  chequear(
    "registrar sin facturar no abrió receptor",
    (await page.getByTestId("dialogo-emision-fiscal").count()) === 0,
    "se abrió el diálogo fiscal",
  );
  const venta = psql(
    `select count(*)::text from public.ventas v join public.venta_items vi on vi.venta_id=v.id
      join public.productos p on p.id=vi.producto_id where p.codigo='E2E-CONT'`,
  );
  chequear("la venta se guardó", venta === "1", `hay ${venta} ventas`);
  if (venta === "1") {
    const estado = psql(`select v.estado_pago::text from public.ventas v
              join public.venta_items vi on vi.venta_id=v.id
              join public.productos p on p.id=vi.producto_id where p.codigo='E2E-CONT'`);
    chequear("quedó PARCIAL, no PAGADA", estado === "PARCIAL", estado);
    const fiscal = psql(`select v.afip_estado::text from public.ventas v
              join public.venta_items vi on vi.venta_id=v.id
              join public.productos p on p.id=vi.producto_id where p.codigo='E2E-CONT'`);
    chequear("quedó SIN_FACTURAR", fiscal === "SIN_FACTURAR", fiscal);
    chequear(
      "registrar sin facturar no creó intento fiscal",
      psql(`select count(*)::text from public.emision_fiscal_intentos i
              join public.venta_items vi on vi.venta_id=i.venta_id
              join public.productos p on p.id=vi.producto_id where p.codigo='E2E-CONT'`) === "0",
      "apareció un intento fiscal",
    );
    chequear(
      "y guardó los 500 cobrados",
      psql(`select v.total_pagado::text from public.ventas v
              join public.venta_items vi on vi.venta_id=v.id
              join public.productos p on p.id=vi.producto_id where p.codigo='E2E-CONT'`) ===
        "500.00",
      psql(`select v.total_pagado::text from public.ventas v
              join public.venta_items vi on vi.venta_id=v.id
              join public.productos p on p.id=vi.producto_id where p.codigo='E2E-CONT'`),
    );
    chequear(
      "y recién ahí salió el stock",
      psql(`select cantidad::text from public.stock_sucursal s
              join public.productos p on p.id=s.producto_id where p.codigo='E2E-CONT'`) !== stock0,
      "el stock no cambió",
    );
  }
} finally {
  await browser.close();
  limpiar();
}

console.log(
  fallos.length === 0
    ? "\n✅ Todo verde.\n"
    : `\n❌ ${fallos.length} fallo(s):\n${fallos.map((f) => `   - ${f}`).join("\n")}\n`,
);
process.exit(fallos.length === 0 ? 0 : 1);
