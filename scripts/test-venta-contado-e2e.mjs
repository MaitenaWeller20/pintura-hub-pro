// ============================================================
// e2e de "al contado se cobra entero" desde la pantalla de ventas.
//   bun run dev && PW_DIR=… node scripts/test-venta-contado-e2e.mjs
//
// La regla vive en crear_venta, pero lo que importa es que el cajero NO llegue
// a apretar Guardar para comerse el error: la pantalla tiene que frenarlo antes
// y decirle qué hacer.
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

const limpiar = () =>
  psql(`
    DELETE FROM public.venta_pagos vp USING public.ventas v
     WHERE v.id=vp.venta_id AND v.observaciones='E2E CONTADO';
    DELETE FROM public.cuenta_corriente_movimientos c USING public.ventas v
     WHERE v.id=c.venta_id AND v.observaciones='E2E CONTADO';
    DELETE FROM public.venta_items vi USING public.ventas v
     WHERE v.id=vi.venta_id AND v.observaciones='E2E CONTADO';
    DELETE FROM public.venta_items vi USING public.productos p
     WHERE p.id=vi.producto_id AND p.codigo='E2E-CONT';
    DELETE FROM public.ventas WHERE observaciones='E2E CONTADO';
    DELETE FROM public.stock_movimientos m USING public.productos p
     WHERE p.id=m.producto_id AND p.codigo='E2E-CONT';
    DELETE FROM public.stock_sucursal s USING public.productos p
     WHERE p.id=s.producto_id AND p.codigo='E2E-CONT';
    DELETE FROM public.productos WHERE codigo='E2E-CONT';
  `);

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

  const guardar = page.getByRole("button", { name: "Guardar" });
  chequear(
    "sin cobrar un peso, Guardar está bloqueado",
    await guardar.isDisabled(),
    "el botón está habilitado con la venta sin pagar",
  );
  chequear(
    "y la pantalla dice qué hacer",
    await page.getByText(/hay que cobrar algo/i).isVisible(),
    "no aparece el aviso",
  );

  console.log("── Cobrando una parte (el fiado del mostrador) ──────────");
  await page.getByRole("button", { name: /Agregar pago|Pago/i }).first().click();
  await page.waitForTimeout(600);
  // El pago viene con el total; lo bajo a una seña.
  const monto = page.locator("text=Monto").locator("..").locator("input");
  await monto.fill("500");
  await monto.blur();
  await page.waitForTimeout(600);
  chequear(
    "con una parte cobrada ya se puede guardar",
    await guardar.isEnabled(),
    "sigue bloqueado con el pago parcial",
  );

  await guardar.click();
  await page.waitForTimeout(4000);
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
    chequear(
      "y guardó los 500 cobrados",
      psql(`select v.total_pagado::text from public.ventas v
              join public.venta_items vi on vi.venta_id=v.id
              join public.productos p on p.id=vi.producto_id where p.codigo='E2E-CONT'`) === "500.00",
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
