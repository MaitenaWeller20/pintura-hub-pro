import { describe, expect, it } from "vitest";
import { isDynamicImportError } from "./import-error";

describe("isDynamicImportError", () => {
  it("detecta el fallo de descarga de una pantalla lazy", () => {
    expect(
      isDynamicImportError(
        new TypeError(
          "Failed to fetch dynamically imported module: https://quimex-pinturagest.vercel.app/assets/arqueo-B9QuXIdx.js",
        ),
      ),
    ).toBe(true);
    expect(isDynamicImportError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isDynamicImportError(new TypeError("error loading dynamically imported module"))).toBe(true);
  });

  it("deja los errores normales al reintento del router", () => {
    expect(isDynamicImportError(new Error("No se pudo cargar la caja"))).toBe(false);
    expect(isDynamicImportError("Error desconocido")).toBe(false);
  });
});
