// ============================================================
// e2e de presupuestos contra la app LOCAL.
//   bun run dev && PW_DIR=/tmp/pw node scripts/test-presupuesto-e2e.mjs
//
// Verifica el flujo completo desde la pantalla: hacer un presupuesto, que NO
// mueva stock, y que al convertirlo la venta salga con el precio PRESUPUESTADO
// aunque el catálogo haya cambiado.
// ============================================================
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const require = createRequire(`${process.env.PW_DIR ?? "/tmp/pw"}/index.js`);
const { chromium } = require("playwright");

const psql = (sql) =>
  execFileSync(
    "docker",
    ["exec", "-i", "supabase_db_local", "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql],
    { encoding: "utf8" },
  ).trim();

const fallos = [];
const chequear = (n, ok, d) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${ok ? "" : ` — ${d}`}`);
  if (!ok) fallos.push(n);
};

const limpiar = () => {
  psql(`
    DELETE FROM public.venta_pagos vp USING public.ventas v
     WHERE v.id=vp.venta_id AND v.observaciones LIKE 'Presupuesto %';
    DELETE FROM public.cuenta_corriente_movimientos c USING public.ventas v
     WHERE v.id=c.venta_id AND v.observaciones LIKE 'Presupuesto %';
    DELETE FROM public.venta_items vi USING public.ventas v
     WHERE v.id=vi.venta_id AND v.observaciones LIKE 'Presupuesto %';
    UPDATE public.presupuestos SET estado='ANULADO', venta_id=NULL
     WHERE venta_id IN (SELECT id FROM public.ventas WHERE observaciones LIKE 'Presupuesto %');
    DELETE FROM public.ventas WHERE observaciones LIKE 'Presupuesto %';
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

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => fallos.push(`error de página: ${e.message}`));

try {
  console.log("── Sembrando ────────────────────────────────────────────");
  limpiar();
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
    psql(`select precio_sin_iva::text from public.presupuesto_items where presupuesto_id='${pres}'`) ===
      "9000.00",
    psql(`select precio_sin_iva::text from public.presupuesto_items where presupuesto_id='${pres}'`),
  );
  chequear(
    "NO movió stock",
    psql(`select cantidad::text from public.stock_sucursal s join public.productos p
            on p.id=s.producto_id where p.codigo='E2E-PRES'`) === "50.00",
  );

  console.log("── El producto sube de precio ───────────────────────────");
  psql(`UPDATE public.productos SET precio_sin_iva = 15000 WHERE codigo='E2E-PRES';`);

  console.log("── Convirtiendo en venta ────────────────────────────────");
  await page.goto(`${BASE}/presupuestos/${pres}`);
  await page.waitForSelector('[data-testid="convertir"]');
  await page.locator('[data-testid="convertir"]').click();
  await page.waitForSelector('[data-testid="conv-cliente"]');
  await page.locator('[data-testid="conv-cliente"]').click();
  await page.getByRole("option").first().click();
  await page.locator('[data-testid="conv-confirmar"]').click();
  await page.waitForTimeout(3000);

  const venta = psql(`select coalesce(venta_id::text,'') from public.presupuestos where id='${pres}'`);
  chequear("quedó convertido con su venta", venta !== "", "venta_id vacío");
  if (venta) {
    // EL PUNTO DE TODA LA FEATURE.
    chequear(
      "la venta usa el precio PRESUPUESTADO, no el de hoy",
      psql(`select precio_unitario_sin_iva::text from public.venta_items where venta_id='${venta}'`) ===
        "9000.00",
      psql(`select precio_unitario_sin_iva::text from public.venta_items where venta_id='${venta}'`),
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
}

console.log(
  fallos.length === 0
    ? "\n✅ Todo verde.\n"
    : `\n❌ ${fallos.length} fallo(s):\n${fallos.map((f) => `   - ${f}`).join("\n")}\n`,
);
process.exit(fallos.length === 0 ? 0 : 1);
