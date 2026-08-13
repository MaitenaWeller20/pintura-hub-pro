import { describe, it, expect, vi, afterEach } from "vitest";
import { uuidv4 } from "./uuid";

const RE_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv4", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("usa crypto.randomUUID cuando existe", () => {
    const fake = "11111111-1111-4111-8111-111111111111";
    vi.stubGlobal("crypto", { randomUUID: () => fake });
    expect(uuidv4()).toBe(fake);
  });

  it("cae a getRandomValues en contexto no seguro (http por IP) y devuelve un v4 válido", () => {
    // Sin randomUUID, como en un secure-context ausente.
    vi.stubGlobal("crypto", {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 0xff;
        return a;
      },
    });
    const id = uuidv4();
    expect(id).toMatch(RE_UUID_V4);
  });

  it("el fallback marca versión 4 y variante correctas sin importar los bytes crudos", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (a: Uint8Array) => {
        a.fill(0xff); // fuerza todos los bits en 1 para probar el enmascarado
        return a;
      },
    });
    const id = uuidv4();
    expect(id[14]).toBe("4"); // versión
    expect(["8", "9", "a", "b"]).toContain(id[19]); // variante
    expect(id).toMatch(RE_UUID_V4);
  });
});
