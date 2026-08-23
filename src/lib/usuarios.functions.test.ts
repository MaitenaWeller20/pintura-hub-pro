import { describe, expect, it } from "vitest";
import { ejecutarSetPuedeFacturar } from "./usuarios.functions";

const ADMIN = "a0000000-0000-4000-8000-000000000001";
const EMPLEADO = "e0000000-0000-4000-8000-000000000002";

describe("setPuedeFacturar", () => {
  it("rechaza a quien no es admin antes de intentar cambiar la capacidad", async () => {
    const llamadas: string[] = [];
    await expect(
      ejecutarSetPuedeFacturar(
        { actorId: EMPLEADO, user_id: EMPLEADO, value: true },
        {
          async rpc(nombre) {
            llamadas.push(nombre);
            return nombre === "is_admin"
              ? { data: false, error: null }
              : { data: null, error: null };
          },
        },
      ),
    ).rejects.toThrow(/solo admin/i);
    expect(llamadas).toEqual(["is_admin"]);
  });

  it("usa la RPC JWT-bound exacta después de revalidar al admin", async () => {
    const llamadas: Array<{ nombre: string; args: Record<string, unknown> }> = [];
    await expect(
      ejecutarSetPuedeFacturar(
        { actorId: ADMIN, user_id: EMPLEADO, value: true },
        {
          async rpc(nombre, args) {
            llamadas.push({ nombre, args });
            return nombre === "is_admin"
              ? { data: true, error: null }
              : { data: null, error: null };
          },
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(llamadas).toEqual([
      { nombre: "is_admin", args: { _user_id: ADMIN } },
      {
        nombre: "administrar_puede_facturar",
        args: { p_profile_id: EMPLEADO, p_puede_facturar: true },
      },
    ]);
  });

  it("propaga un fallo de la RPC sin informar éxito", async () => {
    await expect(
      ejecutarSetPuedeFacturar(
        { actorId: ADMIN, user_id: EMPLEADO, value: false },
        {
          async rpc(nombre) {
            return nombre === "is_admin"
              ? { data: true, error: null }
              : { data: null, error: { message: "permiso denegado" } };
          },
        },
      ),
    ).rejects.toThrow("permiso denegado");
  });
});
