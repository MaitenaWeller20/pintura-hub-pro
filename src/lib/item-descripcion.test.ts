import { describe, expect, it } from "vitest";
import { MAX_DESCRIPCION_ITEM, normalizarDescripcionItem } from "./item-descripcion";

describe("descripción de una línea", () => {
  it("normaliza el código de color sin tocar su contenido", () => {
    expect(normalizarDescripcionItem("  Base 10 L   (Código 1234)  ")).toBe(
      "Base 10 L (Código 1234)",
    );
  });

  it("rechaza vacío y más de 160 caracteres", () => {
    expect(() => normalizarDescripcionItem(" \n\t ")).toThrow(/descripción/i);
    expect(() => normalizarDescripcionItem("x".repeat(MAX_DESCRIPCION_ITEM + 1))).toThrow(/160/);
  });
});
