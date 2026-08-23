import { test, expect, ingresar } from "./apoyo";
import {
  limpiarFixturesFiscales,
  prepararFixturesFiscales,
  type FixtureFiscal,
} from "./fixtures/fiscal";

/**
 * La lista de usuarios.
 *
 * Existe por un bug real: al agregar `profile_sucursales` quedaron DOS caminos
 * entre `profiles` y `sucursales`, PostgREST devolvió PGRST201 y la consulta
 * entera falló. Como la pantalla hacía `const { data = [] }`, mostró "No hay
 * usuarios" con la base llena — y nadie se enteró de que había un error.
 */

let fixture: FixtureFiscal;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  fixture = await prepararFixturesFiscales();
});
test.afterAll(async () => {
  await limpiarFixturesFiscales();
});

test("usuarios: la lista carga las identidades descartables propias del fixture", async ({
  page,
}) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto("/usuarios");

  await expect(page.locator("tbody tr", { hasText: "t13-admin" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("tbody tr", { hasText: "t13-empleado" })).toBeVisible();
  await expect(page.locator("tbody tr", { hasText: "t13-sin-capacidad" })).toBeVisible();

  // Si la consulta falla, la pantalla lo tiene que DECIR, no mostrar "no hay".
  await expect(page.locator("body")).not.toContainText(/no se pudo cargar la lista/i);
  await expect(page.locator("body")).not.toContainText(/^No hay usuarios\.$/);
});

test("usuarios: cada fila muestra su rol y su sucursal", async ({ page }) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto("/usuarios");
  await expect(page.locator("tbody tr").first()).toBeVisible({ timeout: 15_000 });

  // Que el embed de sucursales resuelva: si se rompe, la columna queda en "—"
  // para todos y es la señal de que el join volvió a fallar.
  const filaAdmin = page.locator("tbody tr", { hasText: "t13-admin" });
  await expect(filaAdmin).toContainText(/admin/);
  await expect(filaAdmin).toContainText(/CasaForma/);
});

test("usuarios: un admin puede otorgar y retirar la capacidad fiscal", async ({ page }) => {
  await ingresar(page, "fiscalAdmin");
  await page.goto("/usuarios");
  const fila = page.locator("tbody tr", { hasText: "t13-sin-capacidad" });
  await expect(fila).toBeVisible();
  await fila.getByTitle("Permisos y secciones").click();

  const dialogo = page.getByRole("dialog", { name: /Permisos de t13-sin-capacidad/ });
  const capacidad = dialogo.getByLabel("Puede facturar");
  await expect(capacidad).not.toBeChecked();
  await capacidad.check();
  await dialogo.getByRole("button", { name: "Guardar" }).click();
  await expect(page.locator("[data-sonner-toaster]")).toContainText("Permisos actualizados");

  await fila.getByTitle("Permisos y secciones").click();
  await expect(page.getByRole("dialog").getByLabel("Puede facturar")).toBeChecked();
  await page.getByRole("dialog").getByLabel("Puede facturar").uncheck();
  await page.getByRole("dialog").getByRole("button", { name: "Guardar" }).click();
});

test("usuarios: un empleado no puede auto-otorgarse capacidad por la API", async ({ page }) => {
  await ingresar(page, "sinCapacidad");
  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  expect(supabaseUrl).toMatch(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/);
  expect(anonKey, "falta la anon key local para probar el rechazo RLS").toBeTruthy();
  const accessToken = await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.endsWith("-auth-token")) continue;
      const value = JSON.parse(localStorage.getItem(key) ?? "null") as {
        access_token?: string;
      } | null;
      if (value?.access_token) return value.access_token;
    }
    return null;
  });
  expect(accessToken, "no se encontró la sesión local del empleado").toBeTruthy();

  const respuesta = await page.request.patch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${fixture.usuarioSinCapacidad.id}`,
    {
      headers: {
        apikey: anonKey!,
        authorization: `Bearer ${accessToken}`,
        prefer: "return=representation",
      },
      data: { puede_facturar: true },
    },
  );
  expect(respuesta.ok(), "la auto-elevación no debe ser aceptada").toBe(false);

  await page.goto("/ventas/nueva");
  await expect(page.getByTestId("registrar-y-facturar")).toHaveCount(0);
});
