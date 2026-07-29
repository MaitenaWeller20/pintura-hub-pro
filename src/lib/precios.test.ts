import { describe, it, expect } from "vitest";
import {
  ALICUOTAS_IVA,
  MARKUP_DEFAULT,
  calcularPrecios,
  costoDeLista,
  normalizarIva,
  origenDelPrecio,
} from "./precios";

// Números REALES de "LP N° 125 - Quimexur", producto 4000-00400
// (*IMPER* POLIURETANICA MEMBRANA LIQUIDA x4). Es el producto con el que el
// cliente mostró que el sistema calculaba mal: la góndola decía $28.076 cuando
// Quimex sugiere $34.370.
const LISTA = 30774.4;
const DESCUENTO = 42;
const COSTO = 17849.15; // LISTA − 42%
const SUGERIDO = 34370.6; // c/IVA, de la misma lista
const MARKUP = 30;

describe("costoDeLista", () => {
  it("aplica el descuento comercial de Quimex", () => {
    expect(costoDeLista(LISTA, DESCUENTO)).toBe(COSTO);
  });
  it("sin descuento el costo es el precio de lista", () => {
    expect(costoDeLista(LISTA, 0)).toBe(LISTA);
  });
  it("tolera basura", () => {
    expect(costoDeLista(null, DESCUENTO)).toBe(0);
    expect(costoDeLista("", DESCUENTO)).toBe(0);
    // Sin descuento válido cae al del negocio, no a 0% (que inflaría el costo).
    expect(costoDeLista(LISTA, null)).toBe(COSTO);
  });
});

describe("normalizarIva", () => {
  it("acepta las alícuotas de AFIP", () => {
    for (const a of ALICUOTAS_IVA) expect(normalizarIva(a)).toBe(a);
    expect(normalizarIva("10.5")).toBe(10.5);
  });

  // El caso real: el cliente mapeó "Sugerido al público C/IVA" al campo "IVA %".
  // Antes eso sólo ensuciaba la vista; ahora el IVA es un DIVISOR y corromperia
  // el neto que se factura.
  it("descarta cualquier cosa que no sea una alícuota", () => {
    expect(normalizarIva(34370.6)).toBe(21);
    expect(normalizarIva(105)).toBe(21);
    expect(normalizarIva(-1)).toBe(21);
    expect(normalizarIva(19)).toBe(21);
    expect(normalizarIva("abc")).toBe(21);
    expect(normalizarIva(null)).toBe(21);
    expect(normalizarIva(undefined)).toBe(21);
    expect(normalizarIva("")).toBe(21);
  });

  it("0 es exento, no 'vacío'", () => {
    expect(normalizarIva(0)).toBe(0);
  });
});

describe("calcularPrecios — la cadena completa", () => {
  const base = {
    precio_fabrica: COSTO,
    iva_porcentaje: 21,
    markup_porcentaje: MARKUP,
  };

  it("CON sugerido: el precio de venta sale del sugerido, no del costo", () => {
    const r = calcularPrecios({ ...base, precio_sugerido_publico: SUGERIDO });
    expect(r.costo_c_iva).toBe(21597.47); // lo que se le paga a Quimex
    expect(r.precio_sin_iva).toBe(36927.09); // lo que se factura
    expect(r.venta_c_iva).toBe(44681.78); // la góndola: sugerido + 30%
    expect(r.origen).toBe("sugerido");
  });

  // Esta es la prueba de que no se rompe nada existente: hasta que no se
  // reimporte la lista con la columna nueva, TODOS los productos de producción
  // pasan por acá y tienen que dar exactamente lo de siempre.
  it("SIN sugerido: sigue el cálculo viejo, por costo", () => {
    const r = calcularPrecios(base);
    expect(r.precio_sin_iva).toBe(23203.9);
    expect(r.venta_c_iva).toBe(28076.72);
    expect(r.origen).toBe("costo");
  });

  it("sugerido en 0 o null va por costo (0 no es un sugerido válido)", () => {
    expect(calcularPrecios({ ...base, precio_sugerido_publico: 0 }).origen).toBe("costo");
    expect(calcularPrecios({ ...base, precio_sugerido_publico: null }).origen).toBe("costo");
  });

  it("el markup propio del producto le gana al default", () => {
    const r = calcularPrecios(
      { ...base, precio_sugerido_publico: SUGERIDO, markup_porcentaje: 50 },
      { markupDefault: 30 },
    );
    expect(r.markup).toBe(50);
    expect(r.venta_c_iva).toBe(+(SUGERIDO * 1.5).toFixed(2));
  });

  it("sin markup propio usa el default que le pasen", () => {
    const r = calcularPrecios(
      { ...base, precio_sugerido_publico: SUGERIDO, markup_porcentaje: null },
      { markupDefault: 40 },
    );
    expect(r.markup).toBe(40);
  });

  it("sin default disponible usa el del negocio, no 50", () => {
    expect(calcularPrecios({ ...base, markup_porcentaje: null }).markup).toBe(MARKUP_DEFAULT);
    expect(MARKUP_DEFAULT).toBe(30);
  });

  // §3.2: la planilla puede traer el neto ya calculado. Ese camino existe hoy y
  // no se rompe.
  it("un precio s/IVA explícito le gana al sugerido y al costo", () => {
    const r = calcularPrecios({
      ...base,
      precio_sugerido_publico: SUGERIDO,
      precio_sin_iva: 9999,
    });
    expect(r.precio_sin_iva).toBe(9999);
    expect(r.origen).toBe("manual");
  });

  it("pero si el explícito coincide con la fórmula, se reporta como derivado", () => {
    const r = calcularPrecios({
      ...base,
      precio_sugerido_publico: SUGERIDO,
      precio_sin_iva: 36927.09,
    });
    expect(r.origen).toBe("sugerido");
  });

  it("un IVA inválido no corrompe el neto: cae a 21", () => {
    const r = calcularPrecios({
      ...base,
      precio_sugerido_publico: SUGERIDO,
      iva_porcentaje: SUGERIDO, // la columna de precio mapeada al IVA
    });
    expect(r.precio_sin_iva).toBe(36927.09);
  });

  it("IVA 0 (exento): el sugerido ya es el neto", () => {
    const r = calcularPrecios({
      ...base,
      precio_sugerido_publico: SUGERIDO,
      iva_porcentaje: 0,
    });
    expect(r.precio_sin_iva).toBe(44681.78);
    expect(r.venta_c_iva).toBe(44681.78);
  });

  it("un producto sin ningún dato de precio no explota", () => {
    const r = calcularPrecios({});
    expect(r.precio_sin_iva).toBe(0);
    expect(r.venta_c_iva).toBe(0);
  });
});

// El c/IVA que se muestra se deriva del neto GUARDADO, no del sugerido × markup,
// para que la pantalla coincida con la factura. Eso puede costar un centavo.
describe("ida y vuelta del redondeo", () => {
  it("la góndola no se despega más de un centavo del sugerido + markup", () => {
    for (const sugerido of [34370.6, 8221.68, 129153.33, 1, 0.99, 158105.1]) {
      for (const iva of [0, 2.5, 5, 10.5, 21, 27]) {
        const r = calcularPrecios({
          precio_sugerido_publico: sugerido,
          iva_porcentaje: iva,
          markup_porcentaje: MARKUP,
        });
        // El objetivo se redondea igual que el precio: comparar contra el
        // producto crudo agrega ruido de float propio de la aserción (0.0100…09)
        // y haría fallar un cálculo que está bien.
        const objetivo = +(sugerido * 1.3).toFixed(2);
        expect(Math.abs(r.venta_c_iva - objetivo)).toBeLessThanOrEqual(0.01 + 1e-9);
      }
    }
  });
});

describe("origenDelPrecio — qué explica el precio guardado", () => {
  const prod = {
    precio_fabrica: COSTO,
    precio_sugerido_publico: SUGERIDO,
    markup_porcentaje: MARKUP,
    iva_porcentaje: 21,
  };

  it("reconoce un precio derivado del sugerido", () => {
    expect(origenDelPrecio({ ...prod, precio_sin_iva: 36927.09 })).toBe("sugerido");
  });

  it("reconoce un precio derivado del costo", () => {
    expect(
      origenDelPrecio({ ...prod, precio_sugerido_publico: null, precio_sin_iva: 23203.9 }),
    ).toBe("costo");
  });

  // Sin esto la tabla mostraría "sug." sobre un precio que nadie derivó del
  // sugerido: el diálogo deja escribirlo a mano y el alta rápida de Ingresos de
  // mercadería crea productos con el neto directo.
  it("un precio puesto a mano se declara manual, aunque el producto tenga sugerido", () => {
    expect(origenDelPrecio({ ...prod, precio_sin_iva: 25000 })).toBe("manual");
  });

  it("tolera un centavo de diferencia", () => {
    expect(origenDelPrecio({ ...prod, precio_sin_iva: 36927.1 })).toBe("sugerido");
    expect(origenDelPrecio({ ...prod, precio_sin_iva: 36927.08 })).toBe("sugerido");
    expect(origenDelPrecio({ ...prod, precio_sin_iva: 36927.2 })).toBe("manual");
  });

  it("un producto creado a mano, sin costo ni sugerido, es manual", () => {
    expect(origenDelPrecio({ precio_sin_iva: 5000 })).toBe("manual");
  });

  it("coincide con lo que devuelve calcularPrecios", () => {
    for (const e of [
      { ...prod },
      { ...prod, precio_sugerido_publico: null },
      { ...prod, precio_fabrica: 0, precio_sugerido_publico: null },
    ]) {
      const r = calcularPrecios(e);
      expect(origenDelPrecio({ ...e, precio_sin_iva: r.precio_sin_iva })).toBe(r.origen);
    }
  });
});
