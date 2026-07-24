import { describe, it, expect } from "vitest";
import {
  FIELDS_TARGET,
  SINONIMOS,
  autoMapear,
  detectarFilaEncabezados,
  normalizar,
  numOr,
  parseNumAr,
} from "./importar-productos";

// Encabezados REALES de "LP N° 125 - Quimexur (12-6-2026).xlsx". Los espacios de
// más y el punto de "ENV." son del archivo, no erratas.
const LISTA_PLANA = [
  " CÓDIGO  ",
  " DESCRIPCIÓN ",
  " ENV. ",
  " PRECIO DE LISTA ",
  " Sugerido al público C/IVA ",
  "__EMPTY",
  "__EMPTY_1",
  "__EMPTY_2",
];
const LISTA_ACTUALIZACION = [" CÓDIGO  ", " DESCRIPCIÓN ", " ENV. ", " PRECIO DE LISTA "];

describe("normalizar", () => {
  it("saca acentos, mayúsculas, espacios y puntuación", () => {
    expect(normalizar(" CÓDIGO  ")).toBe("codigo");
    expect(normalizar(" ENV. ")).toBe("env");
    expect(normalizar(" Sugerido al público C/IVA ")).toBe("sugeridoalpublicociva");
  });
});

describe("parseNumAr", () => {
  it("formato argentino: punto miles, coma decimal", () => {
    expect(parseNumAr("1.234,56")).toBe(1234.56);
    expect(parseNumAr("1.234.567")).toBe(1234567);
  });
  it("un solo punto es decimal (no miles): la lista de Quimexur viene así", () => {
    // Decisión de 6b6a3fe: sin coma, un único punto se respeta como decimal.
    // "224410.56" no puede volverse 22441056 (rompía numeric). El costo asumido
    // es que un "45.000" pensado como miles se lee 45.
    expect(parseNumAr("224410.56")).toBe(224410.56);
    expect(parseNumAr("45.000")).toBe(45);
  });
  it("números ya numéricos pasan derecho", () => {
    expect(parseNumAr(20)).toBe(20);
  });
  it("vacío o basura da NaN", () => {
    expect(parseNumAr("")).toBeNaN();
    expect(parseNumAr(null)).toBeNaN();
  });
  it("numOr usa el default cuando no hay número", () => {
    expect(numOr("", 21)).toBe(21);
    expect(numOr("0", 21)).toBe(0);
  });
});

describe("autoMapear con la lista real de Quimexur", () => {
  it("manda la columna ENV. al tamaño de envase, no a otro lado", () => {
    expect(autoMapear(LISTA_PLANA).tamano_envase).toBe(" ENV. ");
    expect(autoMapear(LISTA_ACTUALIZACION).tamano_envase).toBe(" ENV. ");
  });

  it("mapea código, nombre y precio de lista", () => {
    const m = autoMapear(LISTA_PLANA);
    expect(m.codigo).toBe(" CÓDIGO  ");
    expect(m.nombre).toBe(" DESCRIPCIÓN ");
    expect(m.precio_lista).toBe(" PRECIO DE LISTA ");
  });

  it("no engancha 'Sugerido al público C/IVA' al % de IVA (rompía numeric(5,2))", () => {
    expect(autoMapear(LISTA_PLANA).iva_porcentaje).toBeUndefined();
  });

  it("no reutiliza una misma columna para dos campos", () => {
    const usadas = Object.values(autoMapear(LISTA_PLANA));
    expect(new Set(usadas).size).toBe(usadas.length);
  });
});

// El bug del 24/07/2026: el inventario de producción quedó cargado con el tamaño
// de envase porque esta pantalla ofrecía destinos "Stock O'Higgins" / "Stock
// General Paz" y la única columna numérica libre de la lista de precios es ENV.
// La lista de precios NO trae stock: no debe existir ningún destino que lo escriba.
describe("la importación de precios no puede tocar el stock", () => {
  const esDestinoDeStockDeSucursal = (key: string) =>
    key.startsWith("stock_") && key !== "stock_minimo";

  it("no hay campos destino de stock por sucursal", () => {
    expect(FIELDS_TARGET.map((f) => f.key).filter(esDestinoDeStockDeSucursal)).toEqual([]);
  });

  it("tampoco quedan sinónimos de stock por sucursal", () => {
    expect(Object.keys(SINONIMOS).filter(esDestinoDeStockDeSucursal)).toEqual([]);
  });

  it("aunque la planilla traiga columnas de stock, no se mapean a nada de stock", () => {
    const m = autoMapear(["CODIGO", "DESCRIPCION", "ENV", "STOCK OHIGGINS", "STOCK GENERAL PAZ"]);
    expect(Object.keys(m).filter(esDestinoDeStockDeSucursal)).toEqual([]);
    expect(m.tamano_envase).toBe("ENV");
  });

  it("stock_minimo sigue existiendo: es el umbral de alerta del producto, no inventario", () => {
    expect(FIELDS_TARGET.map((f) => f.key)).toContain("stock_minimo");
    expect(autoMapear(["CODIGO", "NOMBRE", "STOCK MINIMO"]).stock_minimo).toBe("STOCK MINIMO");
  });
});

describe("detectarFilaEncabezados", () => {
  it("saltea el título y encuentra la fila de encabezados", () => {
    const aoa = [
      ["LISTA DE PRECIOS N° 125", "", "", ""],
      [" CÓDIGO  ", " DESCRIPCIÓN ", " ENV. ", " PRECIO DE LISTA "],
      ["1000-02000", "SOL MEX SOLVENTE BLANCO", 20, 224410.56],
    ];
    expect(detectarFilaEncabezados(aoa)).toBe(1);
  });

  it("si los encabezados están en la primera fila, devuelve 0", () => {
    expect(detectarFilaEncabezados([["CÓDIGO", "DESCRIPCIÓN", "PRECIO DE LISTA"]])).toBe(0);
  });
});
