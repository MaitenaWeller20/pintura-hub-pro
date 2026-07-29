// ============================================================
// e2e del ingreso de mercadería A MANO contra la app LOCAL.
//
//   bun run dev  &&  PW_DIR=/tmp/pw node scripts/test-ingreso-manual-e2e.mjs
//
// Verifica lo único que importa de esta pantalla: que sume el stock de verdad,
// que deje kardex, y que guarde la equivalencia código-del-proveedor → producto
// (la tabla que hace que el próximo remito venga resuelto).
// Ver docs/superpowers/specs/2026-07-29-compras-plata-ingresos-mano-design.md §7
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

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => fallos.push(`error de página: ${e.message}`));

try {
  console.log("── Sembrando ────────────────────────────────────────────");
  psql(`
    DELETE FROM public.producto_codigos_proveedor pcp USING public.productos p
     WHERE p.id = pcp.producto_id AND p.codigo = 'ING-E2E';
    DELETE FROM public.stock_movimientos m USING public.productos p
     WHERE p.id = m.producto_id AND p.codigo = 'ING-E2E';
    DELETE FROM public.stock_sucursal s USING public.productos p
     WHERE p.id = s.producto_id AND p.codigo = 'ING-E2E';
    DELETE FROM public.productos WHERE codigo = 'ING-E2E';
    DELETE FROM public.proveedores WHERE razon_social = 'PROV E2E INGRESO';
    INSERT INTO public.proveedores (razon_social) VALUES ('PROV E2E INGRESO');
    INSERT INTO public.productos (codigo, nombre, precio_sin_iva, iva_porcentaje)
    VALUES ('ING-E2E', 'PRODUCTO E2E INGRESO MANUAL', 1000, 21);
  `);

  console.log("── Login ────────────────────────────────────────────────");
  await page.goto(`${BASE}/auth`);
  await page.getByRole("textbox", { name: "Email" }).fill("admin@local.test");
  await page.getByRole("textbox", { name: "Contraseña" }).fill("admin1234");
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL((u) => !/\/auth/.test(u.pathname), { timeout: 30000 });

  console.log("── Cargando el ingreso a mano ───────────────────────────");
  await page.goto(`${BASE}/ingresos-mercaderia/nuevo`);
  await page.waitForSelector('[data-testid="buscar-producto"]');

  // Ya no hay input de archivo: la extracción con IA se sacó.
  chequear("no queda el selector de archivo", (await page.locator("input[type=file]").count()) === 0);

  await page.locator('[data-testid="select-proveedor"]').click();
  await page.getByRole("option", { name: "PROV E2E INGRESO" }).click();

  // Buscar por CÓDIGO
  await page.locator('[data-testid="buscar-producto"]').fill("ING-E2E");
  await page.waitForSelector("text=PRODUCTO E2E INGRESO MANUAL", { timeout: 15000 });
  await page.getByText("PRODUCTO E2E INGRESO MANUAL").first().click();
  await page.waitForSelector('[data-testid="fila-ingreso"]');
  chequear("busca el producto por código y lo agrega", true);

  // Cantidad y código del proveedor
  await page.locator('[data-testid="fila-ingreso"] input[inputmode], [data-testid="fila-ingreso"] input')
    .first()
    .fill("7");
  const inputs = page.locator('[data-testid="fila-ingreso"] input');
  await inputs.nth(1).fill("KUM-8899");

  await page.locator('[data-testid="confirmar-ingreso"]').click();
  await page.waitForURL(/\/ingresos-mercaderia$/, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);

  console.log("── Verificando contra la base ───────────────────────────");
  chequear(
    "el stock subió 7",
    psql(`select coalesce(sum(cantidad),0)::text from public.stock_sucursal s
            join public.productos p on p.id = s.producto_id where p.codigo='ING-E2E'`) === "7.00",
    psql(`select coalesce(sum(cantidad),0)::text from public.stock_sucursal s
            join public.productos p on p.id = s.producto_id where p.codigo='ING-E2E'`),
  );
  chequear(
    "dejó kardex de INGRESO_MERCADERIA",
    psql(`select count(*)::text from public.stock_movimientos m
            join public.productos p on p.id = m.producto_id
           where p.codigo='ING-E2E' and m.tipo='INGRESO_MERCADERIA'`) === "1",
  );
  // Lo que Codex marcó: sin capturar el código del proveedor, la tabla que
  // aprende dejaba de aprender.
  chequear(
    "guardó la equivalencia del código del proveedor",
    psql(`select codigo_proveedor from public.producto_codigos_proveedor pcp
            join public.productos p on p.id = pcp.producto_id where p.codigo='ING-E2E'`) ===
      "KUM-8899",
    psql(`select coalesce(codigo_proveedor,'(nada)') from public.producto_codigos_proveedor pcp
            join public.productos p on p.id = pcp.producto_id where p.codigo='ING-E2E'`),
  );
} finally {
  await browser.close();
  psql(`
    DELETE FROM public.producto_codigos_proveedor pcp USING public.productos p
     WHERE p.id = pcp.producto_id AND p.codigo = 'ING-E2E';
    DELETE FROM public.ingreso_mercaderia_items i USING public.productos p
     WHERE p.id = i.producto_id AND p.codigo = 'ING-E2E';
    DELETE FROM public.stock_movimientos m USING public.productos p
     WHERE p.id = m.producto_id AND p.codigo = 'ING-E2E';
    DELETE FROM public.stock_sucursal s USING public.productos p
     WHERE p.id = s.producto_id AND p.codigo = 'ING-E2E';
    DELETE FROM public.productos WHERE codigo = 'ING-E2E';
  `);
}

console.log(fallos.length === 0 ? "\n✅ Todo verde.\n" : `\n❌ ${fallos.length} fallo(s):\n${fallos.map((f) => `   - ${f}`).join("\n")}\n`);
process.exit(fallos.length === 0 ? 0 : 1);
