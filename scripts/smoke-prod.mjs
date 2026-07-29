// ============================================================
// Humo contra PRODUCCIÓN. NO escribe nada.
//
//   PW_DIR=… node scripts/smoke-prod.mjs
//
// A propósito no se loguea ni crea datos: la base de prod tiene ventas, caja y
// facturas AFIP de verdad. Un presupuesto de prueba convertido sería una venta
// real, con stock real saliendo. Esto sólo confirma que el deploy sirve la app,
// que las rutas nuevas existen y que no explota nada en el arranque.
// ============================================================
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL ?? "https://quimex-pinturagest.vercel.app";
const require = createRequire(`${process.env.PW_DIR ?? "/tmp/pw"}/index.js`);
const { chromium } = require("playwright");

const fallos = [];
const chequear = (n, ok, d) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${ok ? "" : ` — ${d}`}`);
  if (!ok) fallos.push(n);
};

const browser = await chromium.launch();
const page = await browser.newPage();
const errores = [];
page.on("pageerror", (e) => errores.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errores.push(m.text());
});

try {
  console.log(`── ${BASE} ────────────────────────────────`);
  const r = await page.goto(`${BASE}/auth`, { waitUntil: "networkidle", timeout: 60000 });
  chequear("la app responde 200", r?.status() === 200, `status ${r?.status()}`);
  // `networkidle` no garantiza que React ya hidrató.
  const hayLogin = await page
    .getByRole("button", { name: "Ingresar" })
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  chequear("carga el login", hayLogin, "no apareció el botón Ingresar");

  // Rutas nuevas: sin sesión tienen que mandar al login, no tirar 404 ni
  // pantalla en blanco. Que el router las conozca prueba que el bundle nuevo
  // es el que está sirviendo.
  for (const ruta of ["/presupuestos", "/presupuestos/nuevo", "/pagos-proveedores"]) {
    const res = await page.goto(`${BASE}${ruta}`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1500);
    const enLogin = await page
      .getByRole("button", { name: "Ingresar" })
      .isVisible()
      .catch(() => false);
    chequear(
      `${ruta} existe y pide login`,
      res?.status() === 200 && enLogin,
      `status ${res?.status()}, login visible ${enLogin}`,
    );
  }

  const ruido = errores.filter(
    (e) => !/401|403|Failed to load resource|JWT|favicon/i.test(e),
  );
  chequear("sin errores de JS en el arranque", ruido.length === 0, ruido.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

console.log(
  fallos.length === 0
    ? "\n✅ El deploy está sirviendo lo nuevo.\n"
    : `\n❌ ${fallos.length} fallo(s):\n${fallos.map((f) => `   - ${f}`).join("\n")}\n`,
);
process.exit(fallos.length === 0 ? 0 : 1);
