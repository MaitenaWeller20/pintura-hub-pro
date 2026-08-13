import { test, expect, ingresar } from "./apoyo";

/**
 * La lista de usuarios.
 *
 * Existe por un bug real: al agregar `profile_sucursales` quedaron DOS caminos
 * entre `profiles` y `sucursales`, PostgREST devolvió PGRST201 y la consulta
 * entera falló. Como la pantalla hacía `const { data = [] }`, mostró "No hay
 * usuarios" con la base llena — y nadie se enteró de que había un error.
 */

test("usuarios: la lista carga con los usuarios que hay", async ({ page }) => {
  await ingresar(page, "admin");
  await page.goto("/usuarios");

  await expect(page.locator("tbody tr").first()).toBeVisible({ timeout: 15_000 });
  const filas = await page.locator("tbody tr").count();
  expect(filas, "la lista de usuarios vino vacía").toBeGreaterThan(0);

  // Si la consulta falla, la pantalla lo tiene que DECIR, no mostrar "no hay".
  await expect(page.locator("body")).not.toContainText(/no se pudo cargar la lista/i);
  await expect(page.locator("body")).not.toContainText(/^No hay usuarios\.$/);
});

test("usuarios: cada fila muestra su rol y su sucursal", async ({ page }) => {
  await ingresar(page, "admin");
  await page.goto("/usuarios");
  await expect(page.locator("tbody tr").first()).toBeVisible({ timeout: 15_000 });

  // Que el embed de sucursales resuelva: si se rompe, la columna queda en "—"
  // para todos y es la señal de que el join volvió a fallar.
  const filaAdmin = page.locator("tbody tr", { hasText: "admin" }).first();
  await expect(filaAdmin).toContainText(/admin/);
  await expect(filaAdmin).toContainText(/CasaForma/);
});
