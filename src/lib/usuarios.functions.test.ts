import { describe, expect, it } from "vitest";
import { ejecutarSetPuedeFacturar, ejecutarToggleUsuarioActivo } from "./usuarios.functions";

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

describe("toggleUsuarioActivo", () => {
  it("al inactivar cierra primero el perfil y recién después bloquea Auth", async () => {
    const llamadas: string[] = [];
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false },
        {
          async actualizarPerfil(userId, activo) {
            llamadas.push(`perfil:${userId}:${activo}`);
            return { data: { id: userId }, error: null };
          },
          async actualizarAuth(userId, banDuration) {
            llamadas.push(`auth:${userId}:${banDuration}`);
            return { error: null };
          },
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(llamadas).toEqual([`perfil:${EMPLEADO}:false`, `auth:${EMPLEADO}:876000h`]);
  });

  it("si falla la baja del perfil no intenta bloquear Auth ni informa éxito", async () => {
    const llamadas: string[] = [];
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false },
        {
          async actualizarPerfil() {
            llamadas.push("perfil:false");
            return { data: null, error: { message: "falló profiles" } };
          },
          async actualizarAuth() {
            llamadas.push("auth:ban");
            return { error: null };
          },
        },
      ),
    ).rejects.toThrow("falló profiles");
    expect(llamadas).toEqual(["perfil:false"]);
  });

  it("considera error que el UPDATE de baja no encuentre ninguna fila", async () => {
    const llamadas: string[] = [];
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false },
        {
          async actualizarPerfil() {
            llamadas.push("perfil:false");
            return { data: null, error: null };
          },
          async actualizarAuth() {
            llamadas.push("auth:ban");
            return { error: null };
          },
        },
      ),
    ).rejects.toThrow(/perfil.*no existe/i);
    expect(llamadas).toEqual(["perfil:false"]);
  });

  it("si falla el ban deja el perfil inactivo y devuelve el error de Auth", async () => {
    let perfilActivo = true;
    let authBloqueado = false;
    const llamadas: string[] = [];
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false },
        {
          async actualizarPerfil(_userId, activo) {
            llamadas.push(`perfil:${activo}`);
            perfilActivo = activo;
            return { data: { id: EMPLEADO }, error: null };
          },
          async actualizarAuth(_userId, banDuration) {
            llamadas.push(`auth:${banDuration}`);
            if (banDuration === "876000h") {
              return { error: { message: "falló el ban" } };
            }
            authBloqueado = false;
            return { error: null };
          },
        },
      ),
    ).rejects.toThrow("falló el ban");
    expect(llamadas).toEqual(["perfil:false", "auth:876000h"]);
    expect({ perfilActivo, authBloqueado }).toEqual({
      perfilActivo: false,
      authBloqueado: false,
    });
  });

  it("al reactivar quita primero el ban y sólo después abre el perfil", async () => {
    const llamadas: string[] = [];
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: true },
        {
          async actualizarPerfil(userId, activo) {
            llamadas.push(`perfil:${userId}:${activo}`);
            return { data: { id: userId }, error: null };
          },
          async actualizarAuth(userId, banDuration) {
            llamadas.push(`auth:${userId}:${banDuration}`);
            return { error: null };
          },
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(llamadas).toEqual([`auth:${EMPLEADO}:none`, `perfil:${EMPLEADO}:true`]);
  });

  it("si falla el unban no toca el perfil inactivo", async () => {
    let perfilActivo = false;
    const llamadas: string[] = [];
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: true },
        {
          async actualizarPerfil(_userId, activo) {
            llamadas.push(`perfil:${activo}`);
            perfilActivo = activo;
            return { data: { id: EMPLEADO }, error: null };
          },
          async actualizarAuth(_userId, banDuration) {
            llamadas.push(`auth:${banDuration}`);
            return { error: { message: "falló el unban" } };
          },
        },
      ),
    ).rejects.toThrow("falló el unban");
    expect(llamadas).toEqual(["auth:none"]);
    expect(perfilActivo).toBe(false);
  });

  it("si falla reactivar el perfil vuelve a bloquear Auth y devuelve el error real", async () => {
    const perfilActivo = false;
    let authBloqueado = true;
    const llamadas: string[] = [];
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: true },
        {
          async actualizarPerfil(_userId, activo) {
            llamadas.push(`perfil:${activo}`);
            return { data: null, error: { message: "falló reactivar profiles" } };
          },
          async actualizarAuth(_userId, banDuration) {
            llamadas.push(`auth:${banDuration}`);
            authBloqueado = banDuration !== "none";
            return { error: null };
          },
        },
      ),
    ).rejects.toThrow("falló reactivar profiles");
    expect(llamadas).toEqual(["auth:none", "perfil:true", "auth:876000h"]);
    expect({ perfilActivo, authBloqueado }).toEqual({
      perfilActivo: false,
      authBloqueado: true,
    });
  });

  it("si la reactivación no actualiza ninguna fila también restaura el ban", async () => {
    const llamadas: string[] = [];
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: true },
        {
          async actualizarPerfil() {
            llamadas.push("perfil:true");
            return { data: null, error: null };
          },
          async actualizarAuth(_userId, banDuration) {
            llamadas.push(`auth:${banDuration}`);
            return { error: null };
          },
        },
      ),
    ).rejects.toThrow(/perfil.*no existe/i);
    expect(llamadas).toEqual(["auth:none", "perfil:true", "auth:876000h"]);
  });

  it("si también falla el re-ban informa ambos errores y nunca éxito", async () => {
    const llamadas: string[] = [];
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: true },
        {
          async actualizarPerfil() {
            llamadas.push("perfil:true");
            return { data: null, error: { message: "falló reactivar profiles" } };
          },
          async actualizarAuth(_userId, banDuration) {
            llamadas.push(`auth:${banDuration}`);
            return banDuration === "none"
              ? { error: null }
              : { error: { message: "falló restaurar ban" } };
          },
        },
      ),
    ).rejects.toThrow(/falló reactivar profiles.*falló restaurar ban/i);
    expect(llamadas).toEqual(["auth:none", "perfil:true", "auth:876000h"]);
  });
});
