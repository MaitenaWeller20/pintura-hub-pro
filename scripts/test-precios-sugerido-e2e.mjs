// ============================================================
// e2e de "precio de venta desde el sugerido al público" contra la app LOCAL.
//
// Requisitos:
//   bun run dev                              (localhost:8080)
//   supabase start && supabase migration up  (base local con la migración)
//   ./scripts/crear-admin-local.sh           (admin@local.test / admin1234)
//   npm i playwright                         (en algún lado; se pasa por PW_DIR)
//
// Uso:
//   PW_DIR=/tmp/pw node scripts/test-precios-sugerido-e2e.mjs
//
// Cubre la §10 del spec 2026-07-29-precios-sugerido-publico-design.md, y sobre
// todo el escenario que ningún unit test puede probar entero: que una importación
// REAL, contra Supabase, no degrade el precio de los productos que ya tenían
// sugerido cargado.
// ============================================================
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
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

const fixtures = "/tmp/precios-e2e";
mkdirSync(fixtures, { recursive: true });

// Números REALES de la lista N° 125 de Quimexur, producto 4000-00400.
const CON_SUGERIDO = `CÓDIGO,DESCRIPCIÓN,ENV.,PRECIO DE LISTA,Sugerido al público C/IVA
E2E-00400,MEMBRANA LIQUIDA,4,30774.4,34370.6
E2E-VACIO,SUGERIDO EN BLANCO,4,30774.4,
E2E-SINPRE,SIN NINGUN PRECIO,1,,
`;
// La "lista de actualización": sube el costo y NO trae la columna del sugerido.
const SIN_SUGERIDO = `CÓDIGO,DESCRIPCIÓN,ENV.,PRECIO DE LISTA
E2E-00400,MEMBRANA LIQUIDA,4,40000
`;
writeFileSync(`${fixtures}/con-sugerido.csv`, CON_SUGERIDO);
writeFileSync(`${fixtures}/sin-sugerido.csv`, SIN_SUGERIDO);

const fallos = [];
const chequear = (nombre, ok, detalle) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${nombre}${ok ? "" : ` — ${detalle}`}`);
  if (!ok) fallos.push(nombre);
};
const fila = (codigo) => {
  const r = psql(
    `select coalesce(precio_sugerido_publico::text,'-'), precio_sin_iva::text, precio_fabrica::text,
            round(precio_sin_iva*(1+iva_porcentaje/100),2)::text, coalesce(stock_minimo::text,'-'),
            coalesce(marca_id::text,'-'), coalesce(tamano_envase::text,'-')
       from public.productos where codigo='${codigo}'`,
  );
  if (!r) return null;
  const [sugerido, neto, costo, cIva, stockMin, marca, envase] = r.split("|");
  return { sugerido, neto, costo, cIva, stockMin, marca, envase };
};

const importar = async (page, archivo) => {
  await page.goto(`${BASE}/productos/importar`);
  await page.waitForSelector("input[type=file]");
  await page.setInputFiles("input[type=file]", archivo);
  await page.waitForSelector("text=Vista previa");
  // El markup del negocio es 30%; la base local puede tener otro.
  await page.locator("input[type=number]").nth(1).fill("30");
  const boton = page.getByRole("button", { name: /Confirmar importación/ });
  await boton.waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      !document.querySelector("button:not([disabled]) , button")?.disabled ||
      [...document.querySelectorAll("button")].some(
        (b) => /Confirmar importación/.test(b.textContent) && !b.disabled,
      ),
    { timeout: 15000 },
  );
  await boton.click();
  await page.waitForURL(/\/productos$/, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1500);
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => fallos.push(`error de página: ${e.message}`));

try {
  console.log("── Limpiando productos E2E- ─────────────────────────────");
  psql("delete from public.productos where codigo like 'E2E-%'");

  console.log("── Login ────────────────────────────────────────────────");
  await page.goto(`${BASE}/auth`);
  await page.getByRole("textbox", { name: "Email" }).fill("admin@local.test");
  await page.getByRole("textbox", { name: "Contraseña" }).fill("admin1234");
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL((u) => !/\/auth/.test(u.pathname), { timeout: 30000 });

  console.log("── 1. Importar CON la columna del sugerido ──────────────");
  await importar(page, `${fixtures}/con-sugerido.csv`);

  const a = fila("E2E-00400");
  chequear("el costo sale de la lista − 42%", a?.costo === "17849.15", a?.costo);
  chequear("guarda el sugerido tal cual", a?.sugerido === "34370.60", a?.sugerido);
  chequear("el neto sale del sugerido", a?.neto === "36927.09", a?.neto);
  chequear("la góndola es sugerido + 30%", a?.cIva === "44681.78", a?.cIva);

  // Regresión: una celda en blanco no es un borrado.
  const vacio = fila("E2E-VACIO");
  chequear("celda vacía: queda sin sugerido y va por costo", vacio?.sugerido === "-", vacio?.sugerido);
  chequear("celda vacía: el precio sale del costo", vacio?.neto === "23203.90", vacio?.neto);

  // Una fila sin ningún precio no puede entrar: se vendería a $0.
  chequear("una fila sin ningún precio NO se importa", fila("E2E-SINPRE") === null, "se importó");

  console.log("── 2. Sembrar datos que la lista de Quimex no trae ──────");
  psql(`update public.productos set stock_minimo=7, tamano_envase=4,
        marca_id=(select id from public.marcas limit 1) where codigo='E2E-00400'`);
  const antes = fila("E2E-00400");

  console.log("── 3. Reimportar SIN la columna del sugerido ────────────");
  await importar(page, `${fixtures}/sin-sugerido.csv`);

  const b = fila("E2E-00400");
  // EL BLOQUEANTE: sin esta protección el precio caería de 44.681 a 30.160.
  chequear("conserva el sugerido guardado", b?.sugerido === "34370.60", b?.sugerido);
  chequear("el precio de venta NO se degrada al costo", b?.neto === "36927.09", b?.neto);
  chequear("la góndola sigue en sugerido + 30%", b?.cIva === "44681.78", b?.cIva);
  // El costo SÍ tiene que subir: la lista nueva vale 40.000.
  chequear("el costo sí se actualiza con la lista nueva", b?.costo === "23200.00", b?.costo);

  // La lista de Quimex no trae marca, ni stock mínimo, ni envase: reimportarla no
  // puede borrarlos. Es la misma clase de bug que puso el envase como stock.
  chequear("no borra el stock mínimo", b?.stockMin === antes?.stockMin, `${antes?.stockMin} → ${b?.stockMin}`);
  chequear("no borra la marca", b?.marca === antes?.marca, `${antes?.marca} → ${b?.marca}`);
  chequear("no borra el tamaño de envase", b?.envase === antes?.envase, `${antes?.envase} → ${b?.envase}`);

  console.log("── 4. La tabla de productos ─────────────────────────────");
  await page.goto(`${BASE}/productos`);
  await page.waitForSelector("table");
  const cols = await page.$$eval("thead th", (ts) => ts.map((t) => t.textContent.trim()));
  for (const c of ["Lista", "Costo", "Costo c/IVA", "Sugerido", "Venta c/IVA"]) {
    chequear(`la columna "${c}" está en la tabla`, cols.includes(c), cols.join(" | "));
  }
} finally {
  await browser.close();
  psql("delete from public.productos where codigo like 'E2E-%'");
}

console.log(
  fallos.length === 0
    ? "\n✅ Todo verde.\n"
    : `\n❌ ${fallos.length} fallo(s):\n${fallos.map((f) => `   - ${f}`).join("\n")}\n`,
);
process.exit(fallos.length === 0 ? 0 : 1);
