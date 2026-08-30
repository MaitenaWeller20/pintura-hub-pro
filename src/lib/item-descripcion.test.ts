import { describe, expect, it } from "vitest";
import { MAX_DESCRIPCION_ITEM, normalizarDescripcionItem } from "./item-descripcion";

const WHITESPACE_UNICODE = [
  ["BOM U+FEFF", "\uFEFF"],
  ["NEXT LINE U+0085", "\u0085"],
  ["NBSP U+00A0", "\u00A0"],
] as const;

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

  it.each(WHITESPACE_UNICODE)("colapsa y recorta %s", (_caso, whitespace) => {
    expect(
      normalizarDescripcionItem(`${whitespace}Base${whitespace}${whitespace}10 L${whitespace}`),
    ).toBe("Base 10 L");
  });

  it.each(WHITESPACE_UNICODE)(
    "rechaza una descripción formada sólo por %s",
    (_caso, whitespace) => {
      expect(() => normalizarDescripcionItem(whitespace.repeat(3))).toThrow(/descripción/i);
    },
  );

  it("acepta exactamente 160 emoji medidos como code points", () => {
    const descripcion = "😀".repeat(MAX_DESCRIPCION_ITEM);
    expect(normalizarDescripcionItem(descripcion)).toBe(descripcion);
  });

  it("rechaza 161 emoji medidos como code points", () => {
    expect(() => normalizarDescripcionItem("😀".repeat(MAX_DESCRIPCION_ITEM + 1))).toThrow(/160/);
  });
});
