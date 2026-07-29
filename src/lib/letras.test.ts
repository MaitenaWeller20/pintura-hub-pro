import { describe, it, expect } from "vitest";
import { montoEnLetras } from "./letras";

// Un recibo escribe el importe en letras porque el número se puede retocar.
// Si las letras dicen otra cosa que el número, el recibo no sirve.
describe("montoEnLetras", () => {
  it("los casos de todos los días", () => {
    expect(montoEnLetras(0)).toBe("cero con 00/100 pesos");
    expect(montoEnLetras(1)).toBe("uno con 00/100 pesos");
    expect(montoEnLetras(15)).toBe("quince con 00/100 pesos");
    expect(montoEnLetras(100)).toBe("cien con 00/100 pesos");
    expect(montoEnLetras(101)).toBe("ciento uno con 00/100 pesos");
  });

  it("21 a 29 van juntos, de 30 para arriba con 'y'", () => {
    expect(montoEnLetras(21)).toBe("veintiuno con 00/100 pesos");
    expect(montoEnLetras(28)).toBe("veintiocho con 00/100 pesos");
    expect(montoEnLetras(31)).toBe("treinta y uno con 00/100 pesos");
    expect(montoEnLetras(99)).toBe("noventa y nueve con 00/100 pesos");
  });

  it("mil, no 'un mil'", () => {
    expect(montoEnLetras(1000)).toBe("mil con 00/100 pesos");
    expect(montoEnLetras(2000)).toBe("dos mil con 00/100 pesos");
    expect(montoEnLetras(1500)).toBe("mil quinientos con 00/100 pesos");
  });

  it("millones", () => {
    expect(montoEnLetras(1000000)).toBe("un millón con 00/100 pesos");
    expect(montoEnLetras(4000000)).toBe("cuatro millones con 00/100 pesos");
    // El ejemplo del cliente: "compraron a Quimex 4 millones, le pagaron 2".
    expect(montoEnLetras(2000000)).toBe("dos millones con 00/100 pesos");
  });

  it("los centavos van en números", () => {
    expect(montoEnLetras(1234.5)).toBe("mil doscientos treinta y cuatro con 50/100 pesos");
    expect(montoEnLetras(0.05)).toBe("cero con 05/100 pesos");
    expect(montoEnLetras(44681.78)).toBe(
      "cuarenta y cuatro mil seiscientos ochenta y uno con 78/100 pesos",
    );
  });

  it("no explota con basura", () => {
    expect(montoEnLetras(NaN)).toBe("cero con 00/100 pesos");
    expect(montoEnLetras(-50)).toContain("menos");
  });
});
