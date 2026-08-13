// ============================================================
// e2e de "prender un producto apagado" contra la app LOCAL.
//
//   bun run dev  &&  PW_DIR=/tmp/pw node scripts/test-activar-productos-e2e.mjs
//
// Reproduce el caso real: la clienta cargó los precios de los KUM y siguieron
// apareciendo "Inactivo", o sea que no se podían vender y no había forma de
// prenderlos. Verifica las dos puertas nuevas:
//
//   1. el botón "Activar (N)" masivo, con selección MIXTA (con precio y sin
//      precio), y que el cartel diga las dos cosas;
//   2. el switch del diálogo de edición, incluido que NO se pueda prender sin
//      precio y que se habilite solo en cuanto se le carga uno.
//
// Y el final que importa: que el producto prendido aparezca en /ventas/nueva,
// que es lo que la clienta no podía hacer.
// Ver docs/superpowers/specs/2026-08-10-activar-productos-design.md
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

const limpiar = () => psql(`DELETE FROM public.productos WHERE codigo LIKE 'ZZ-E2E-%';`);

// Tres con precio y dos sin: la selección mixta es la que hace hablar al cartel.
const sembrar = () => {
  limpiar();
  psql(`
    INSERT INTO public.productos (codigo, nombre, precio_sin_iva, precio_fabrica, iva_porcentaje, activo, archivado)
    VALUES ('ZZ-E2E-1','ZZE2E AGUARRAS X 900CC - KUM', 5432.10, 2926.37, 21, false, false),
           ('ZZ-E2E-2','ZZE2E AGUARRAS X4 LTS - KUM', 20426.04, 11003.04, 21, false, false),
           ('ZZ-E2E-3','ZZE2E APLICADOR SILICONA KUM', 13583.35,  7317.22, 21, false, false),
           ('ZZ-E2E-4','ZZE2E ANTIOXIDO AZUL X1',            0,        0, 21, false, false),
           ('ZZ-E2E-5','ZZE2E AUTOPOLISH x500',              0,        0, 21, false, false);
  `);
};

const estado = (codigo) =>
  psql(`SELECT activo||'/'||precio_sin_iva FROM public.productos WHERE codigo='${codigo}';`);

sembrar();

const browser = await chromium.launch();
const page = await browser.newPage();
page.setDefaultTimeout(15000);

try {
  // ---------- login ----------
  await page.goto(`${BASE}/auth`);
  await page.getByRole("textbox", { name: "Email" }).fill("admin@local.test");
  await page.getByRole("textbox", { name: "Contraseña" }).fill("admin1234");
  await page.getByRole("button", { name: /Entrar|Ingresar|Iniciar/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth"));

  // ---------- 1. el masivo, con selección mixta ----------
  await page.goto(`${BASE}/productos`);
  await page.locator('input[placeholder*="Buscar"]').fill("ZZE2E");
  await page.waitForTimeout(400);

  const pills = page.getByText("Inactivo", { exact: true });
  chequear(
    "los 5 sembrados se ven como Inactivo",
    (await pills.count()) === 5,
    `vi ${await pills.count()}`,
  );

  // El botón no existe hasta que hay algo tildado.
  chequear(
    "sin selección no hay botón Activar",
    (await page.locator('[data-testid="activar-masivo"]').count()) === 0,
  );

  // Tildar todo lo filtrado con el checkbox del encabezado.
  await page.locator("thead input, thead button[role=checkbox]").first().click();
  const btn = page.locator('[data-testid="activar-masivo"]');
  await btn.waitFor();
  chequear(
    "el botón dice cuántos va a prender (3 de los 5)",
    /Activar \(3\)/.test(await btn.textContent()),
    await btn.textContent(),
  );

  await btn.click();

  // EL CARTEL QUE IMPORTA: tiene que nombrar los saltados. Sin eso, la clienta
  // cree que ya puede vender los otros dos.
  const cartel = page.locator("[data-sonner-toast]").first();
  await cartel.waitFor();
  const texto = await cartel.textContent();
  chequear("el cartel dice los activados", /3 activados/.test(texto), texto);
  chequear("el cartel dice los saltados y por qué", /2 sin precio/.test(texto), texto);

  chequear("en la base quedaron activos los 3 con precio", estado("ZZ-E2E-1") === "true/5432.10");
  chequear("y los 2 sin precio siguen apagados", estado("ZZ-E2E-4") === "false/0.00");

  // ---------- 2. el switch del diálogo ----------
  // Un producto sin precio: el switch tiene que estar deshabilitado y decir por qué.
  await page.goto(`${BASE}/productos`);
  await page.locator('input[placeholder*="Buscar"]').fill("ZZ-E2E-4");
  await page.waitForTimeout(400);
  await page.locator('tbody tr button[title="Editar"]').first().click();

  const sw = page.locator('[data-testid="producto-activo"]');
  await sw.waitFor();
  chequear("sin precio, el switch está deshabilitado", await sw.isDisabled());
  chequear(
    "y dice el motivo, no queda mudo",
    /\$0/.test(await page.locator('[data-testid="motivo-no-activar"]').textContent()),
  );

  // Cargarle el precio lo destraba SIN guardar: lee el formulario, no la base.
  const precio = page.locator("label:has-text('Precio s/IVA')").locator("..").locator("input");
  await precio.fill("9999");
  await precio.blur();
  chequear("con precio, el switch se habilita solo", await sw.isEnabled());

  await sw.click();
  await page.getByRole("button", { name: "Guardar" }).click();
  await page.waitForTimeout(1200);
  chequear("guardado: quedó activo con su precio", estado("ZZ-E2E-4") === "true/9999.00");

  // ---------- 3. lo que la clienta no podía hacer ----------
  await page.goto(`${BASE}/ventas/nueva`);
  // La búsqueda de productos vive en un popover, y el botón que lo abre está
  // deshabilitado hasta que hay sucursal (un admin sin sucursal propia tiene que
  // elegirla). Es el mismo camino que hace la clienta.
  const agregar = page.getByRole("button", { name: /Agregar/ }).first();
  if (await agregar.isDisabled()) {
    await page.getByRole("combobox").first().click();
    await page.getByRole("option").first().click();
  }
  await agregar.click();
  await page.locator('input[placeholder="Código o nombre…"]').fill("ZZE2E AGUARRAS X 900");
  await page.waitForTimeout(700);
  chequear(
    "el producto prendido ya se puede elegir en una venta",
    (await page.getByText("ZZE2E AGUARRAS X 900CC - KUM").count()) > 0,
  );
  // El espejo: uno que sigue apagado NO tiene que aparecer, o el filtro de la
  // pantalla de ventas no estaría filtrando nada.
  await page.locator('input[placeholder="Código o nombre…"]').fill("ZZE2E AUTOPOLISH");
  await page.waitForTimeout(700);
  chequear(
    "y uno que sigue apagado no aparece",
    (await page.getByText("ZZE2E AUTOPOLISH x500").count()) === 0,
  );
} finally {
  await browser.close();
  limpiar();
}

console.log(`\n${fallos.length ? `FALLÓ: ${fallos.join(", ")}` : "todo ok"}`);
process.exit(fallos.length ? 1 : 0);
