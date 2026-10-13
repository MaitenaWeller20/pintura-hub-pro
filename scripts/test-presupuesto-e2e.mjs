// ============================================================
// e2e de presupuestos contra la app LOCAL.
//   NODE_ENV=test INVOICING_MOCK_TEST_RUNNER=playwright INVOICING_MOCK_MODE=true \
//     INVOICING_MOCK_SCENARIO=OK bun run dev
//   NODE_ENV=test INVOICING_MOCK_TEST_RUNNER=playwright INVOICING_MOCK_MODE=true \
//     INVOICING_MOCK_SCENARIO=OK PW_DIR=/tmp/pw node scripts/test-presupuesto-e2e.mjs
//
// Verifica el flujo completo desde la pantalla: hacer un presupuesto, que NO
// mueva stock, y que al convertirlo la venta salga con el precio PRESUPUESTADO
// aunque el catálogo haya cambiado.
// ============================================================
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const baseUrl = new URL(BASE);
if (!/^(127\.0\.0\.1|localhost)$/.test(baseUrl.hostname)) {
  throw new Error("El E2E de presupuesto sólo puede abrir una app local.");
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
  const ventas = psql(`select coalesce(string_agg(quote_literal(venta_id::text), ','), '')
    from public.presupuestos where nombre_cliente='E2E PRESUPUESTO' and venta_id is not null`);
  const ids = ventas ? `(${ventas})` : "(NULL)";
  psql(`
    DELETE FROM public.emision_fiscal_intentos WHERE venta_id IN ${ids};
    DELETE FROM public.venta_pagos WHERE venta_id IN ${ids};
    DELETE FROM public.cuenta_corriente_movimientos WHERE venta_id IN ${ids};
    DELETE FROM public.stock_movimientos WHERE referencia_id IN ${ids};
    DELETE FROM public.venta_items WHERE venta_id IN ${ids};
    UPDATE public.presupuestos SET venta_id=NULL WHERE venta_id IN ${ids};
    DELETE FROM public.ventas WHERE id IN ${ids};
    DELETE FROM public.presupuesto_items i USING public.presupuestos p
     WHERE p.id=i.presupuesto_id AND p.nombre_cliente='E2E PRESUPUESTO';
    DELETE FROM public.presupuestos WHERE nombre_cliente='E2E PRESUPUESTO';
    DELETE FROM public.stock_movimientos m USING public.productos p
     WHERE p.id=m.producto_id AND p.codigo='E2E-PRES';
    DELETE FROM public.stock_sucursal s USING public.productos p
     WHERE p.id=s.producto_id AND p.codigo='E2E-PRES';
    DELETE FROM public.productos WHERE codigo='E2E-PRES';
  `);
};

await verificarServidorAislado();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => fallos.push(`error de página: ${e.message}`));
const flagsOriginales = psql(`select facturacion_receptor_v2_enabled::text || '|' ||
  facturacion_legacy_writer_enabled::text from public.settings where id=true`);

try {
  console.log("── Sembrando ────────────────────────────────────────────");
  limpiar();
  psql(`update public.settings set facturacion_receptor_v2_enabled=true,
    facturacion_legacy_writer_enabled=false where id=true`);
  psql(`
    INSERT INTO public.productos (codigo,nombre,precio_sin_iva,iva_porcentaje)
    VALUES ('E2E-PRES','PRODUCTO E2E PRESUPUESTO',10000,21);
    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
    VALUES ((SELECT id FROM public.productos WHERE codigo='E2E-PRES'),
            (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1), 50)
    ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET cantidad = 50;
  `);

  console.log("── Login ────────────────────────────────────────────────");
  await page.goto(`${BASE}/auth`);
  await page.getByRole("textbox", { name: "Email" }).fill("admin@local.test");
  await page.getByRole("textbox", { name: "Contraseña" }).fill("admin1234");
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL((u) => !/\/auth/.test(u.pathname), { timeout: 30000 });

  console.log("── Haciendo el presupuesto ──────────────────────────────");
  await page.goto(`${BASE}/presupuestos/nuevo`);
  await page.waitForSelector('[data-testid="buscar-producto-presup"]');

  await page.locator('[data-testid="presup-sucursal"]').click();
  await page.getByRole("option").first().click();
  await page.locator('[data-testid="presup-nombre-cliente"]').fill("E2E PRESUPUESTO");

  await page.locator('[data-testid="buscar-producto-presup"]').fill("E2E-PRES");
  await page.waitForSelector("text=PRODUCTO E2E PRESUPUESTO", { timeout: 15000 });
  await page.getByText("PRODUCTO E2E PRESUPUESTO").first().click();
  await page.waitForSelector('[data-testid="fila-presupuesto"]');

  const nums = page.locator('[data-testid="fila-presupuesto"] input');
  await nums.nth(0).fill("2"); // cantidad
  await nums.nth(1).fill("10"); // descuento %

  await page.getByRole("button", { name: "Guardar" }).click();
  await page.waitForURL(/\/presupuestos$/, { timeout: 30000 });
  await page.waitForTimeout(1200);

  const pres = psql(
    `select id::text from public.presupuestos where nombre_cliente='E2E PRESUPUESTO' limit 1`,
  );
  chequear("el presupuesto se guardó", pres !== "", "no aparece en la base");
  chequear(
    "el precio lo puso el servidor (10.000 − 10%)",
    psql(
      `select precio_sin_iva::text from public.presupuesto_items where presupuesto_id='${pres}'`,
    ) === "9000.00",
    psql(
      `select precio_sin_iva::text from public.presupuesto_items where presupuesto_id='${pres}'`,
    ),
  );
  chequear(
    "NO movió stock",
    psql(`select cantidad::text from public.stock_sucursal s join public.productos p
            on p.id=s.producto_id where p.codigo='E2E-PRES'`) === "50.00",
  );

  console.log("── El buscador pega contra el servidor ──────────────────");
  const numero = psql(`select numero from public.presupuestos where id='${pres}'`);
  await page.goto(`${BASE}/presupuestos`);
  await page.waitForSelector('[data-testid="buscar-presupuesto"]');
  await page.locator('[data-testid="buscar-presupuesto"]').fill(numero);
  await page.waitForTimeout(1500);
  chequear(
    "encuentra el presupuesto por número",
    await page.getByText(numero).first().isVisible(),
    "no aparece",
  );
  await page.locator('[data-testid="buscar-presupuesto"]').fill("E2E PRESUPUESTO");
  await page.waitForTimeout(1500);
  chequear(
    "y también por nombre de cliente suelto",
    await page.getByText(numero).first().isVisible(),
    "no aparece",
  );
  // Una fecha futura no tiene que traer nada: el filtro por fecha existe.
  await page.locator('[data-testid="buscar-presupuesto"]').fill("");
  await page.locator('[data-testid="presup-desde"]').fill("2099-01-01");
  await page.waitForTimeout(1500);
  chequear(
    "el filtro por fecha filtra de verdad",
    !(await page
      .getByText(numero)
      .first()
      .isVisible()
      .catch(() => false)),
    "el presupuesto sigue apareciendo con desde=2099",
  );

  console.log("── El producto sube de precio ───────────────────────────");
  psql(`UPDATE public.productos SET precio_sin_iva = 15000 WHERE codigo='E2E-PRES';`);

  console.log("── Convirtiendo en venta ────────────────────────────────");
  await page.goto(`${BASE}/presupuestos/${pres}`);
  await page.waitForSelector('[data-testid="convertir"]');
  await page.locator('[data-testid="convertir"]').click();
  await page.waitForSelector('[data-testid="conv-cliente"]');
  await page.locator('[data-testid="conv-cliente"]').click();
  await page.getByRole("option").first().click(); // buscador contra el servidor
  // La conversión v2 comparte el editor mixto de Ventas: no hay A/B ni una
  // forma de pago única separada.
  chequear(
    "la conversión neutral no preselecciona Factura A/B",
    (await page.getByText(/Factura [AB]/).count()) === 0,
    "todavía aparece una letra elegible",
  );
  const editor = page.locator('[data-testid="editor-pagos"]');
  await editor.getByRole("button", { name: /Agregar pago/i }).click();
  await editor.getByRole("combobox").click();
  await page.getByRole("option", { name: "Transferencia" }).click();
  await page.locator('[data-testid="conv-confirmar"]').click();
  await page.waitForURL(
    /\/facturacion\/cola\?venta=[0-9a-f-]+&resultado=venta_creada_factura_pendiente/,
    { timeout: 30000 },
  );

  const venta = psql(
    `select coalesce(venta_id::text,'') from public.presupuestos where id='${pres}'`,
  );
  chequear("quedó convertido con su venta", venta !== "", "venta_id vacío");
  if (venta) {
    // EL PUNTO DE TODA LA FEATURE.
    chequear(
      "la venta usa el precio PRESUPUESTADO, no el de hoy",
      psql(
        `select precio_unitario_sin_iva::text from public.venta_items where venta_id='${venta}'`,
      ) === "9000.00",
      psql(
        `select precio_unitario_sin_iva::text from public.venta_items where venta_id='${venta}'`,
      ),
    );
    chequear(
      "el pago quedó como transferencia, no como efectivo",
      psql(`select forma_pago::text from public.venta_pagos where venta_id='${venta}'`) ===
        "TRANSFERENCIA",
      psql(`select forma_pago::text from public.venta_pagos where venta_id='${venta}'`),
    );
    chequear(
      "la venta neutral quedó SIN_FACTURAR",
      psql(`select tipo_comprobante::text || '|' || afip_estado::text
            from public.ventas where id='${venta}'`) === "VENTA|SIN_FACTURAR",
      psql(`select tipo_comprobante::text || '|' || afip_estado::text
            from public.ventas where id='${venta}'`),
    );
    chequear(
      "convertir sin facturar no creó intento fiscal",
      psql(
        `select count(*)::text from public.emision_fiscal_intentos where venta_id='${venta}'`,
      ) === "0",
      "apareció un intento fiscal",
    );
    chequear(
      "ahora SÍ descontó stock (50 − 2)",
      psql(`select cantidad::text from public.stock_sucursal s join public.productos p
              on p.id=s.producto_id where p.codigo='E2E-PRES'`) === "48.00",
      psql(`select cantidad::text from public.stock_sucursal s join public.productos p
              on p.id=s.producto_id where p.codigo='E2E-PRES'`),
    );
  }
} finally {
  await browser.close();
  limpiar();
  const [v2, legacy] = flagsOriginales.split("|");
  psql(`update public.settings set facturacion_receptor_v2_enabled=${v2},
    facturacion_legacy_writer_enabled=${legacy} where id=true`);
}

console.log(
  fallos.length === 0
    ? "\n✅ Todo verde.\n"
    : `\n❌ ${fallos.length} fallo(s):\n${fallos.map((f) => `   - ${f}`).join("\n")}\n`,
);
process.exit(fallos.length === 0 ? 0 : 1);
