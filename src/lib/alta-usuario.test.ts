import { describe, it, expect } from "vitest";
import {
  faltanteUsuario,
  generarPassword,
  PASSWORD_MINIMO,
  type FormAltaUsuario,
} from "./alta-usuario";

const SUC = "11111111-1111-1111-1111-111111111111";

/** Un alta que se puede guardar. Cada test le rompe UNA cosa. */
const ok = (): FormAltaUsuario => ({
  email: "maitena@casaforma.com",
  password: "Zx7-quimex-2026",
  username: "maitena",
  role: "empleado",
  sucursal_id: SUC,
});

describe("faltanteUsuario", () => {
  it("no encuentra nada que falte en un alta completa", () => {
    expect(faltanteUsuario(ok())).toBeNull();
  });

  it("un admin no necesita sucursal", () => {
    expect(faltanteUsuario({ ...ok(), role: "admin", sucursal_id: null })).toBeNull();
  });

  // EL CASO REPORTADO: contraseña de 4 caracteres, botón gris, cero explicación.
  it("dice cuántos caracteres le faltan a la contraseña", () => {
    const m = faltanteUsuario({ ...ok(), password: "aaaa" });
    expect(m).toContain("6");
    expect(m).toContain(String(PASSWORD_MINIMO));
  });

  it("pide sucursal cuando el rol es empleado", () => {
    expect(faltanteUsuario({ ...ok(), sucursal_id: null })).toContain("sucursal");
  });

  it.each([
    ["email vacío", { email: "" }, "email"],
    ["email sin arroba", { email: "maitena" }, "no parece un email"],
    ["sin contraseña", { password: "" }, "Falta la contraseña"],
    ["sin alias", { username: "" }, "alias"],
    ["alias de una letra", { username: "m" }, "2 caracteres"],
  ])("avisa: %s", (_caso, patch, esperado) => {
    expect(faltanteUsuario({ ...ok(), ...patch })).toContain(esperado);
  });

  // El orden importa: la pantalla muestra UN motivo, y tiene que ser el del
  // campo de más arriba. Si con todo vacío hablara de la sucursal, alguien
  // bajaría a elegirla y el botón seguiría gris.
  it("con todo vacío reclama primero el email", () => {
    expect(faltanteUsuario({})).toContain("email");
  });

  it("con el email puesto pasa a la contraseña, no al alias", () => {
    const m = faltanteUsuario({ email: "a@b.com" });
    expect(m).toContain("contraseña");
  });

  // Un espacio no es un nombre. Antes `!form.username` lo dejaba pasar y el alta
  // moría contra el zod del servidor con un mensaje ilegible.
  it("no toma los espacios como contenido", () => {
    expect(faltanteUsuario({ ...ok(), username: "   " })).toContain("alias");
    expect(faltanteUsuario({ ...ok(), email: "   " })).toContain("email");
  });

  it("acepta una contraseña de exactamente el mínimo", () => {
    expect(faltanteUsuario({ ...ok(), password: "a".repeat(PASSWORD_MINIMO) })).toBeNull();
    expect(faltanteUsuario({ ...ok(), password: "a".repeat(PASSWORD_MINIMO - 1) })).not.toBeNull();
  });
});

describe("generarPassword", () => {
  it("genera algo que la propia validación acepta", () => {
    for (let i = 0; i < 200; i++) {
      expect(faltanteUsuario({ ...ok(), password: generarPassword() })).toBeNull();
    }
  });

  // Se dicta por teléfono: un 0 leído como o es un llamado de vuelta.
  it("no usa caracteres que se confunden al dictarlos", () => {
    const prohibidos = /[lI1oO0]/;
    for (let i = 0; i < 200; i++) {
      expect(generarPassword()).not.toMatch(prohibidos);
    }
  });

  it("no repite", () => {
    const vistas = new Set(Array.from({ length: 200 }, () => generarPassword()));
    expect(vistas.size).toBe(200);
  });
});
