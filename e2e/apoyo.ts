import { test as base, expect, type Locator, type Page } from "@playwright/test";

/**
 * Piezas compartidas por las pruebas end-to-end.
 */

export const USUARIOS = {
  admin: { email: "admin@local.test", password: "admin1234" },
  empleado: { email: "empleado@local.test", password: "empleado1234" },
} as const;

/** Todas las pantallas detrás del login. La lista es el inventario a cubrir. */
export const RUTAS = [
  "/",
  "/ventas",
  "/ventas/nueva",
  "/presupuestos",
  "/presupuestos/nuevo",
  "/remitos",
  "/productos",
  "/productos/importar",
  "/stock",
  "/clientes",
  "/compras",
  "/compras/nueva",
  "/ingresos-mercaderia",
  "/ingresos-mercaderia/nuevo",
  "/proveedores",
  "/pagos-proveedores",
  "/gastos",
  "/pagos",
  "/cuentas-corrientes",
  "/caja",
  "/arqueo",
  "/reportes",
  "/facturacion",
  "/usuarios",
] as const;

/**
 * Errores de consola que ya existen y no son de esta app: extensiones del
 * navegador, ruido de Vite en desarrollo. Sin esta lista el chequeo de consola
 * sería tan ruidoso que nadie lo miraría.
 */
const RUIDO_ESPERADO = [
  /Download the React DevTools/i,
  /\[vite\]/i,
  /Failed to load resource.*favicon/i,
];

export async function ingresar(page: Page, quien: keyof typeof USUARIOS = "admin") {
  const { email, password } = USUARIOS[quien];
  await page.goto("/auth");
  // Sesiones huérfanas de corridas anteriores hacen fallar el login con un
  // usuario que ya no existe. Se limpia antes de escribir nada.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto("/auth");
  await page.getByLabel(/email|correo/i).fill(email);
  await page.getByLabel(/contraseña|password/i).fill(password);
  await page.getByRole("button", { name: /ingresar|entrar|iniciar/i }).click();
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

/** Junta los errores de consola de una página, sin el ruido conocido. */
export function vigilarConsola(page: Page): string[] {
  const errores: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const texto = m.text();
    if (RUIDO_ESPERADO.some((r) => r.test(texto))) return;
    errores.push(texto);
  });
  page.on("pageerror", (e) => errores.push(`pageerror: ${e.message}`));
  return errores;
}

/**
 * Un elemento tiene que estar DENTRO de la ventana y ser clickeable.
 *
 * Es la comprobación que hubiera agarrado el bug de los remitos: el botón
 * existía en el DOM y hasta se podía "clickear" por código, pero estaba fuera
 * de la pantalla y para el usuario no existía.
 */
export async function estaAlAlcance(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
  }, selector);
}

/**
 * El input que va con una etiqueta.
 *
 * No se usa `getByLabel` porque en los formularios de la app los `<Label>` no
 * tienen `htmlFor` ni los `<Input>` `id`: están sueltos dentro del mismo `div`.
 * Eso es una deuda de accesibilidad anotada aparte; mientras tanto las pruebas
 * buscan por la estructura real del DOM en vez de fingir que no existe.
 */
export function campo(raiz: Locator, etiqueta: RegExp): Locator {
  return raiz
    .locator("div")
    .filter({ has: raiz.page().locator("label").filter({ hasText: etiqueta }) })
    .last()
    .locator("input")
    .first();
}

export const test = base;
export { expect };
