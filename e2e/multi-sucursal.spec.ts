import { test, expect, ingresar, USUARIOS } from "./apoyo";

/**
 * Un empleado que trabaja en más de una sucursal.
 *
 * Depende de que el empleado local esté habilitado en las dos. Si sólo está en
 * una, las pruebas se saltean con un motivo claro en vez de fallar: es una
 * cuestión de datos, no del código.
 */

test("admin: no ve el selector de sucursal (elige en cada venta)", async ({ page }) => {
  await ingresar(page, "admin");
  // El admin ya elige la sucursal comprobante por comprobante; un selector
  // global le agregaría un estado más que recordar.
  await expect(page.getByTestId("selector-sucursal")).toHaveCount(0);
});

test("empleado con dos sucursales: puede cambiar de una a la otra", async ({ page }) => {
  await ingresar(page, "empleado");

  // Esperar a que el menú termine de montar. Sin esto el selector todavía no
  // existe y la prueba se saltearía sola fingiendo que falta un dato.
  await expect(page.locator("[data-sidebar], aside").first()).toBeVisible();
  const selector = page.getByTestId("selector-sucursal");
  const tieneVarias = await selector
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(
    !tieneVarias,
    "el empleado local está habilitado en una sola sucursal: habilitalo en las dos para correr esta prueba",
  );

  const antes = (await selector.innerText()).trim();
  await expect(page.locator("body")).toContainText(/trabajando en/i);

  await selector.click();
  const opciones = page.getByRole("option");
  await expect(opciones).not.toHaveCount(0);

  // Elegir la que NO está activa.
  const otra = opciones.filter({ hasNotText: antes }).first();
  const nombreOtra = (await otra.innerText()).trim();
  await otra.click();

  // Recarga completa: sin eso quedarían a la vista datos de la sucursal anterior.
  await page.waitForLoadState("load");
  await expect(page.getByTestId("selector-sucursal")).toContainText(nombreOtra);

  // Y la app entera tiene que reflejarlo, no sólo el selector.
  await expect(page.locator("body")).toContainText(nombreOtra);
});

test("empleado: la sucursal en la que trabaja se ve sin buscarla", async ({ page }) => {
  // Vender en la sucursal equivocada descuenta el stock donde no está la
  // mercadería y numera mal el comprobante: tiene que estar a la vista.
  await ingresar(page, "empleado");
  await page.goto("/ventas/nueva");
  await expect(page.locator("body")).toContainText(/casaforma/i);
});

test.describe("seguridad", () => {
  test("un empleado no puede habilitarse una sucursal por su cuenta", async ({ page }) => {
    await ingresar(page, "empleado");

    // Se intenta por la API, saltándose la pantalla — que es como lo intentaría
    // alguien de verdad. La barrera está en la base (RLS), no en el botón.
    const resultado = await page.evaluate(async (email) => {
      const mod = await import("/src/integrations/supabase/client.ts");
      const sb = (mod as any).supabase;
      const { data: yo } = await sb.auth.getUser();
      const { data: sucs } = await sb.from("sucursales").select("id");
      const { error } = await sb
        .from("profile_sucursales")
        .insert({ profile_id: yo.user.id, sucursal_id: sucs[sucs.length - 1].id });
      return { email, error: error?.message ?? null };
    }, USUARIOS.empleado.email);

    expect(resultado.error, "la RLS tendría que haberlo rechazado").not.toBeNull();
  });
});
