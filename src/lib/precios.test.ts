import { describe, it, expect } from "vitest";
import {
  ALICUOTAS_IVA,
  DESCUENTO_PROVEEDOR_DEFAULT,
  MARKUP_DEFAULT,
  calcularPrecios,
  costoDeLista,
  normalizarIva,
  baseDelPrecio,
  descuentoEfectivo,
  coincideConFormula,
  simularOperacion,
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
    // Sin descuento válido compra a precio de lista: un proveedor nuevo no
    // puede heredar silenciosamente el 42% comercial de Quimex.
    expect(costoDeLista(LISTA, null)).toBe(LISTA);
  });
});

describe("descuentoEfectivo", () => {
  const GLOBAL = { descuento_proveedor_porcentaje: 0 };

  // EL CASO QUE PIDIÓ LA CLIENTA: "no todos es el 42%". Quimex manda una lista
  // sola y no descuenta igual todos los renglones.
  it("el del producto le gana a todos", () => {
    expect(
      descuentoEfectivo({ descuento_porcentaje: 28 }, { descuento_porcentaje: 35 }, GLOBAL),
    ).toBe(28);
  });

  it("el del proveedor le gana al global", () => {
    expect(descuentoEfectivo(null, { descuento_porcentaje: 35 }, GLOBAL)).toBe(35);
    expect(
      descuentoEfectivo({ descuento_porcentaje: null }, { descuento_porcentaje: 35 }, GLOBAL),
    ).toBe(35);
  });

  it("un proveedor nuevo sin descuento configurado usa 0%", () => {
    expect(descuentoEfectivo(null, { descuento_porcentaje: null }, GLOBAL)).toBe(0);
    expect(descuentoEfectivo(null, null, GLOBAL)).toBe(0);
  });

  // Un producto (o un proveedor) al que se le compra a precio de lista, sin
  // descuento. Si esto cayera al global, su costo quedaría 42% más barato.
  it("un descuento de 0 es válido y NO cae al escalón de abajo", () => {
    expect(
      descuentoEfectivo({ descuento_porcentaje: 0 }, { descuento_porcentaje: 35 }, GLOBAL),
    ).toBe(0);
    expect(descuentoEfectivo(null, { descuento_porcentaje: 0 }, GLOBAL)).toBe(0);
    expect(descuentoEfectivo(null, null, { descuento_proveedor_porcentaje: 0 })).toBe(0);
  });

  it("sin nada cargado usa 0%", () => {
    expect(descuentoEfectivo(null, null, null)).toBe(DESCUENTO_PROVEEDOR_DEFAULT);
    expect(DESCUENTO_PROVEEDOR_DEFAULT).toBe(0);
  });

  // La escalera completa, escalón por escalón. Es el contrato que el COALESCE
  // de `cambiar_precios_masivo` tiene que respetar clavado.
  it.each([
    [10, 20, 30, 10],
    [null, 20, 30, 20],
    [null, null, 30, 30],
    [null, null, null, 0],
    [0, 20, 30, 0],
    [null, 0, 30, 0],
    [null, null, 0, 0],
  ])("producto=%s proveedor=%s settings=%s -> %s", (prod, prov, set, esperado) => {
    expect(
      descuentoEfectivo(
        { descuento_porcentaje: prod },
        { descuento_porcentaje: prov },
        { descuento_proveedor_porcentaje: set },
      ),
    ).toBe(esperado);
  });

  it("se enchufa con costoDeLista", () => {
    expect(costoDeLista(LISTA, descuentoEfectivo({ descuento_porcentaje: 35 }, null))).toBe(
      20003.36,
    );
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

  // `origen` de calcularPrecios dice POR QUÉ RAMA salió el número, que es lo que
  // necesita el resumen de la importación. Para etiquetar un producto ya guardado
  // está baseDelPrecio, que es otra pregunta y da "sugerido" acá.
  it("origen es la rama que se usó, no el dato que el producto tiene", () => {
    const e = { ...base, precio_sugerido_publico: SUGERIDO, precio_sin_iva: 36927.09 };
    expect(calcularPrecios(e).origen).toBe("manual"); // el precio vino de la planilla
    expect(baseDelPrecio(e)).toBe("sugerido"); // pero el producto tiene sugerido
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

describe("baseDelPrecio — de qué dato sale el precio (hecho, no deducción)", () => {
  it("con sugerido cargado, la base es el sugerido", () => {
    expect(baseDelPrecio({ precio_fabrica: COSTO, precio_sugerido_publico: SUGERIDO })).toBe(
      "sugerido",
    );
  });
  it("sin sugerido pero con costo, la base es el costo", () => {
    expect(baseDelPrecio({ precio_fabrica: COSTO, precio_sugerido_publico: null })).toBe("costo");
  });
  it("sin ninguno de los dos, el precio está a mano", () => {
    expect(baseDelPrecio({ precio_sin_iva: 5000 })).toBe("manual");
    expect(baseDelPrecio({ precio_fabrica: 0, precio_sugerido_publico: 0 })).toBe("manual");
  });
});

describe("coincideConFormula — ¿el precio guardado es el que da la fórmula hoy?", () => {
  const prod = {
    precio_fabrica: COSTO,
    precio_sugerido_publico: SUGERIDO,
    markup_porcentaje: MARKUP,
    iva_porcentaje: 21,
  };

  it("reconoce un precio derivado del sugerido", () => {
    expect(coincideConFormula({ ...prod, precio_sin_iva: 36927.09 })).toBe(true);
  });

  it("reconoce un precio derivado del costo", () => {
    expect(
      coincideConFormula({ ...prod, precio_sugerido_publico: null, precio_sin_iva: 23203.9 }),
    ).toBe(true);
  });

  it("un precio puesto a mano no coincide", () => {
    expect(coincideConFormula({ ...prod, precio_sin_iva: 25000 })).toBe(false);
  });

  it("tolera un centavo", () => {
    expect(coincideConFormula({ ...prod, precio_sin_iva: 36927.1 })).toBe(true);
    expect(coincideConFormula({ ...prod, precio_sin_iva: 36927.08 })).toBe(true);
    expect(coincideConFormula({ ...prod, precio_sin_iva: 36927.2 })).toBe(false);
  });

  // El bug que reportaron los dos reviews: si `coincideConFormula` le pasara el
  // precio guardado a calcularPrecios, éste tomaría la rama del override explícito
  // y todo coincidiría siempre consigo mismo.
  it("no se compara contra sí mismo", () => {
    expect(coincideConFormula({ ...prod, precio_sin_iva: 999999 })).toBe(false);
  });

  it("un producto sin base nunca 'coincide' (no hay fórmula que aplicar)", () => {
    expect(coincideConFormula({ precio_sin_iva: 5000 })).toBe(false);
  });

  // Cambiar el markup default deja ~1100 productos sin coincidir. Es CIERTO (sus
  // precios se calcularon con el markup viejo) y por eso el badge dice "≠" en tono
  // neutro y no "puesto a mano", que sería una acusación falsa.
  it("cambiar el markup default hace que dejen de coincidir", () => {
    const sinMarkupPropio = { ...prod, markup_porcentaje: null, precio_sin_iva: 36927.09 };
    expect(coincideConFormula(sinMarkupPropio, { markupDefault: 30 })).toBe(true);
    expect(coincideConFormula(sinMarkupPropio, { markupDefault: 35 })).toBe(false);
    expect(baseDelPrecio(sinMarkupPropio)).toBe("sugerido"); // la base NO cambia
  });
});

// simularOperacion es el ESPEJO de la RPC `cambiar_precios_masivo` para la vista
// previa. Sin historial de precios ni deshacer, esa pantalla es la única defensa
// contra un aumento mal aplicado: si el espejo y el SQL dicen cosas distintas, la
// pantalla miente. Los dos primeros casos son los que un review adversarial
// reprodujo contra la base real.
describe("simularOperacion — el espejo de la RPC", () => {
  // El precio guardado está a un centavo EXACTO de la fórmula. Con toFixed, JS
  // decía "no coincide" (y la pantalla prometía no tocarlo) mientras Postgres
  // decía "coincide" y lo pisaba: la góndola se movía +16% sin aviso.
  it("clasifica igual que Postgres en el borde del centavo (arriba)", () => {
    const p = {
      precio_lista: 20000,
      precio_fabrica: 10000.05,
      precio_sugerido_publico: null,
      precio_sin_iva: 13000.08,
      iva_porcentaje: 21,
      markup_porcentaje: null,
    };
    // round(10000.05 * 1.3, 2) = 13000.07 en Postgres; con toFixed daba 13000.06.
    // Sin precio_sin_iva, para que no tome la rama del override explícito.
    expect(
      calcularPrecios({ ...p, precio_sin_iva: null }, { markupDefault: 30 }).precio_sin_iva,
    ).toBe(13000.07);
    expect(coincideConFormula(p, { markupDefault: 30 })).toBe(true);
    expect(simularOperacion(p, "RECALCULAR_COSTO", 0, { markupDefault: 30 }).derivado).toBe(true);
  });

  it("clasifica igual que Postgres en el borde del centavo (abajo)", () => {
    const p = {
      precio_lista: 20000,
      precio_fabrica: 10000.05,
      precio_sugerido_publico: null,
      precio_sin_iva: 13000.05,
      iva_porcentaje: 21,
      markup_porcentaje: null,
    };
    expect(coincideConFormula(p, { markupDefault: 30 })).toBe(false);
    expect(simularOperacion(p, "RECALCULAR_COSTO", 0, { markupDefault: 30 }).derivado).toBe(false);
  });

  it("AUMENTO: sube la lista y RE-DERIVA el costo con el descuento del proveedor", () => {
    const r = simularOperacion(
      {
        precio_lista: LISTA,
        precio_fabrica: COSTO,
        precio_sugerido_publico: SUGERIDO,
        precio_sin_iva: 36927.09,
        iva_porcentaje: 21,
        markup_porcentaje: MARKUP,
      },
      "AUMENTO",
      20,
      { markupDefault: MARKUP, descuentoGlobal: 42 },
    );
    expect(r.precio_lista).toBe(36929.28);
    expect(r.precio_fabrica).toBe(21418.98); // 36929.28 × 0.58, NO 17849.15 × 1.2
    expect(r.precio_sugerido_publico).toBe(41244.72);
    // El mismo número que devolvió la RPC en scripts/test-precios-masivo.sh: el
    // espejo y el SQL tienen que coincidir hasta el centavo.
    expect(r.precio_sin_iva).toBe(44312.51);
    expect(r.venta_c_iva).toBe(53618.14);
    expect(r.cambia).toBe(true);
  });

  it("usa el descuento del proveedor, no el global", () => {
    const r = simularOperacion(
      {
        precio_lista: 10000,
        precio_fabrica: 6500,
        precio_sin_iva: 8450,
        iva_porcentaje: 21,
        proveedor: { descuento_porcentaje: 35 },
      },
      "RECALCULAR_COSTO",
      0,
      { markupDefault: 30, descuentoGlobal: 42 },
    );
    expect(r.precio_fabrica).toBe(6500); // 10000 × 0.65, no × 0.58
    expect(r.cambia).toBe(false); // ya estaba bien
  });

  // El toast decía "0 con precio recalculado" cuando en realidad no había nada
  // que cambiar, y se leía como "falló".
  it("marca cambia=false cuando la operación no toca nada", () => {
    const p = {
      precio_lista: 10000,
      precio_fabrica: 10000,
      precio_sin_iva: 13000,
      iva_porcentaje: 21,
      markup_porcentaje: 30,
    };
    expect(simularOperacion(p, "RECALCULAR_COSTO", 0, { markupDefault: 30 }).cambia).toBe(false);
    expect(simularOperacion(p, "MARKUP", 30, { markupDefault: 30 }).cambia).toBe(false);
    expect(simularOperacion(p, "MARKUP", 40, { markupDefault: 30 }).cambia).toBe(true);
  });

  it("un producto sin base no cambia con AUMENTO, pero sí acepta un markup", () => {
    const p = { precio_lista: 0, precio_fabrica: 0, precio_sin_iva: 5000, iva_porcentaje: 21 };
    expect(simularOperacion(p, "AUMENTO", 20, { markupDefault: 30 }).con_base).toBe(false);
    expect(simularOperacion(p, "AUMENTO", 20, { markupDefault: 30 }).precio_sin_iva).toBe(5000);
    expect(simularOperacion(p, "MARKUP", 40, { markupDefault: 30 }).cambia).toBe(true);
  });
});
