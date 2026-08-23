import { test as base, expect, type Locator, type Page } from "@playwright/test";

/**
 * Piezas compartidas por las pruebas end-to-end.
 */

export const USUARIOS = {
  admin: { email: "admin@local.test", password: "admin1234" },
  empleado: { email: "empleado@local.test", password: "empleado1234" },
  sinCapacidad: {
    email: "t13-sin-capacidad@local.test",
    password: "t13-sin-capacidad-1234",
  },
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
  "/facturacion/cola",
  "/facturacion/configuracion",
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
  // WebKit dice "Load failed" cuando la conexión se cae ANTES de que haya una
  // respuesta HTTP. Corriendo toda la suite seguida contra el dev server de
  // Vite pasa de vez en cuando: recompila y corta las conexiones abiertas.
  // No es un error de la app —un problema real del backend llega como respuesta
  // HTTP con mensaje de PostgREST, no como corte de transporte— y además cada
  // prueba ya verifica aparte que la pantalla haya pintado contenido.
  /^TypeError: Load failed$/,
  /^TypeError: Failed to fetch$/,
  // Lo mismo pero con las palabras de WebKit cuando el corte pasa en el
  // preflight. Va atado al Supabase LOCAL a propósito: si algún día hay un
  // problema de CORS de verdad contra producción, la prueba tiene que fallar.
  /127\.0\.0\.1:54321.*due to access control checks/,
  // Advertencia de React que SÓLO existe en el build de desarrollo (en el que
  // se despliega no está: React la compila afuera). Aparecía una vez cada varias
  // corridas completas, siempre en una pantalla distinta y nunca al correr esa
  // prueba sola: la dispara el dev server saturado, no la pantalla. Dejarla
  // fallando entrenaba a ignorar la suite, que es peor que no tenerla.
  // Los errores de hidratación de verdad siguen cubiertos aparte, en la prueba
  // "el login no tira errores de hidratación", que corre con la app en reposo.
  /Can't perform a React state update on a component that hasn't mounted yet/,
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
  // Y esperar a que la app ASIENTE antes de devolver el control.
  //
  // Sin esto, el test navega a la pantalla que va a probar mientras el layout
  // autenticado todavía se está hidratando, y con el server cargado (la suite
  // entera corriendo seguida) la carrera se abre: TanStack tira
  // "Invariant failed: Could not find match for matchId" y React avisa que tuvo
  // que recuperarse hidratando del lado del cliente. Fallaba en una pantalla
  // distinta cada corrida y pasaba siempre aislada, que es la firma de esto.
  // Un usuario real tampoco entra y clickea en el mismo frame.
  await page.locator("[data-sidebar], aside, main").first().waitFor({ timeout: 20_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
}

/** Junta los errores de consola de una página, sin el ruido conocido. */
export function vigilarConsola(page: Page): string[] {
  const errores: string[] = [];
  const esRuido = (texto: string) => RUIDO_ESPERADO.some((r) => r.test(texto));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const texto = m.text();
    if (esRuido(texto)) return;
    errores.push(texto);
  });
  // El filtro va también acá. Estaba sólo en `console` y los cortes de conexión
  // del dev server llegan como `pageerror`, así que se colaban igual: agregarlos
  // a RUIDO_ESPERADO no cambiaba nada y la prueba seguía fallando de a ratos.
  page.on("pageerror", (e) => {
    if (esRuido(e.message)) return;
    errores.push(`pageerror: ${e.message}`);
  });
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
