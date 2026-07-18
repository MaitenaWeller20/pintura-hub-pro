import { describe, it, expect, beforeEach, afterEach } from "vitest";

const KEY_A = "clave-primaria-de-al-menos-32-caracteres-aaaa";
const KEY_B = "clave-nueva-de-al-menos-32-caracteres-bbbbbbbb";

describe("cifrado del certificado AFIP con rotación de clave", () => {
  const orig = { ...process.env };
  beforeEach(() => { process.env.ARCA_ENCRYPTION_KEY = KEY_A; delete process.env.ARCA_ENCRYPTION_KEY_PREVIOUS; });
  afterEach(() => { process.env = { ...orig }; });

  it("cifra y descifra con la clave primaria", async () => {
    const { encryptString, decryptString } = await import("./crypto");
    const enc = encryptString("secreto-del-cert");
    expect(decryptString(enc)).toBe("secreto-del-cert");
  });

  it("permite rotar: dato viejo (clave A) se descifra con A en PREVIOUS y B como primaria", async () => {
    const { encryptString, decryptString } = await import("./crypto");
    const encViejo = encryptString("cert-viejo"); // cifrado con KEY_A
    // rotamos: primaria pasa a B, la anterior (A) queda en PREVIOUS
    process.env.ARCA_ENCRYPTION_KEY = KEY_B;
    process.env.ARCA_ENCRYPTION_KEY_PREVIOUS = KEY_A;
    expect(decryptString(encViejo)).toBe("cert-viejo"); // se descifra con la anterior
  });

  it("LANZA (fail-loud) si ninguna clave sirve", async () => {
    const { encryptString, decryptString } = await import("./crypto");
    const enc = encryptString("x");
    process.env.ARCA_ENCRYPTION_KEY = KEY_B; // ni primaria ni previous (no seteada) sirven
    expect(() => decryptString(enc)).toThrow();
  });

  it("null/vacío devuelve null (no hay certificado cargado todavía)", async () => {
    const { decryptString } = await import("./crypto");
    expect(decryptString(null)).toBeNull();
    expect(decryptString("")).toBeNull();
  });
});
