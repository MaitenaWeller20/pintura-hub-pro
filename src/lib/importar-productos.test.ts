import { describe, it, expect } from "vitest";
import {
  FIELDS_TARGET,
  SINONIMOS,
  autoMapear,
  calcularFila,
  columnasDuplicadas,
  detectarFilaEncabezados,
  normalizar,
  numOr,
  parseNumAr,
  sugeridoSinMapear,
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

  // El bug del 29/07/2026: esta columna existía en la lista y el sistema la
  // ignoraba, así que la góndola quedaba por debajo del precio que sugiere el
  // propio proveedor.
  it("manda 'Sugerido al público C/IVA' al precio sugerido", () => {
    expect(autoMapear(LISTA_PLANA).precio_sugerido_publico).toBe(" Sugerido al público C/IVA ");
  });

  it("una columna 'PRECIO SUGERIDO AL PUBLICO' no se la queda precio_sin_iva", () => {
    const m = autoMapear(["CODIGO", "DESCRIPCION", "PRECIO SUGERIDO AL PUBLICO"]);
    expect(m.precio_sugerido_publico).toBe("PRECIO SUGERIDO AL PUBLICO");
    expect(m.precio_sin_iva).toBeUndefined();
  });

  // El sugerido se asume c/IVA y se divide por (1+iva). Si entrara una columna
  // NETA, se le sacaría el IVA a un número que ya era neto: −17% en silencio.
  it("una columna de sugerido SIN IVA no entra como sugerido", () => {
    for (const h of ["PVP S/IVA", "Precio sugerido s/IVA", "SUGERIDO SIN IVA"]) {
      const m = autoMapear(["CODIGO", "DESCRIPCION", h]);
      expect(m.precio_sugerido_publico).toBeUndefined();
    }
  });

  it("pero 'PVP' y 'PVP C/IVA' sí son el sugerido", () => {
    expect(autoMapear(["CODIGO", "DESCRIPCION", "PVP"]).precio_sugerido_publico).toBe("PVP");
    expect(autoMapear(["CODIGO", "DESCRIPCION", "PVP C/IVA"]).precio_sugerido_publico).toBe(
      "PVP C/IVA",
    );
  });
});

describe("chequeos del mapeo manual", () => {
  it("detecta la misma columna mapeada en dos campos (el caso del cliente)", () => {
    expect(
      columnasDuplicadas({
        codigo: "CÓDIGO",
        precio_lista: "PRECIO DE LISTA",
        precio_fabrica: "PRECIO DE LISTA",
      }),
    ).toEqual(["PRECIO DE LISTA"]);
  });

  it("no marca nada cuando el mapeo está bien", () => {
    expect(columnasDuplicadas(autoMapear(LISTA_PLANA))).toEqual([]);
  });

  it("ignora los campos sin mapear", () => {
    expect(columnasDuplicadas({ codigo: "A", nombre: "", precio_lista: "" })).toEqual([]);
  });

  it("avisa si el archivo trae el sugerido y quedó sin mapear", () => {
    const m = autoMapear(LISTA_PLANA);
    delete m.precio_sugerido_publico;
    expect(sugeridoSinMapear(LISTA_PLANA, m)).toBe(" Sugerido al público C/IVA ");
  });

  it("no avisa si está mapeado", () => {
    expect(sugeridoSinMapear(LISTA_PLANA, autoMapear(LISTA_PLANA))).toBeNull();
  });

  it("no avisa si el archivo no trae ninguna columna de sugerido", () => {
    const m = autoMapear(LISTA_ACTUALIZACION);
    expect(sugeridoSinMapear(LISTA_ACTUALIZACION, m)).toBeNull();
  });

  it("no propone una columna neta como sugerido", () => {
    expect(sugeridoSinMapear(["CODIGO", "PVP S/IVA"], { codigo: "CODIGO" })).toBeNull();
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

// La fila real de "LP N° 125 - Quimexur", producto 4000-00400. Es el producto con
// el que el cliente mostró que el sistema calculaba mal.
const FILA_REAL = {
  " CÓDIGO  ": "4000-00400",
  " DESCRIPCIÓN ": "*IMPER*POLIURETANICA MEMBRANA LIQUIDA",
  " ENV. ": 4,
  " PRECIO DE LISTA ": 30774.4,
  " Sugerido al público C/IVA ": 34370.6,
};
const PARAMS = { descuento: 42, markupDefault: 30 };

describe("calcularFila — de la planilla a la cadena de precios", () => {
  it("la fila real de Quimex: el precio de venta sale del sugerido", () => {
    const f = calcularFila(FILA_REAL, autoMapear(LISTA_PLANA), PARAMS);
    expect(f.codigo).toBe("4000-00400");
    expect(f.envase).toBe(4);
    expect(f.precio_lista).toBe(30774.4);
    expect(f.precio_fabrica).toBe(17849.15); // lista − 42%
    expect(f.costo_c_iva).toBe(21597.47); // lo que se le paga a Quimex
    expect(f.precio_sugerido_publico).toBe(34370.6);
    expect(f.precio_sin_iva).toBe(36927.09);
    expect(f.venta_c_iva).toBe(44681.78); // sugerido + 30%
    expect(f.origen).toBe("sugerido");
  });

  // EL BLOQUEANTE (review de Codex, §13.1 del spec): el importador escribe
  // precio_sin_iva en TODAS las filas. Si al no mapear la columna no se le pasara
  // el sugerido ya guardado, esta importación volvería a derivar el precio del
  // costo y pisaría el neto: la góndola bajaría de $44.681 a $28.076 sin que nadie
  // se entere. Omitir la columna del payload conserva el DATO, no el PRECIO.
  it("sin mapear el sugerido, usa el que ya está guardado y NO degrada el precio", () => {
    const mapping = autoMapear(LISTA_ACTUALIZACION); // esta solapa no trae el sugerido
    const fila = { ...FILA_REAL };

    const sinCatalogo = calcularFila(fila, mapping, PARAMS);
    expect(sinCatalogo.origen).toBe("costo"); // producto nuevo: no hay de dónde sacarlo

    const conCatalogo = calcularFila(fila, mapping, PARAMS, {
      precio_sugerido_publico: 34370.6,
      markup_porcentaje: null,
    });
    expect(conCatalogo.precio_sin_iva).toBe(36927.09);
    expect(conCatalogo.venta_c_iva).toBe(44681.78);
    expect(conCatalogo.origen).toBe("sugerido");
  });

  it("si el producto guardado no tiene sugerido, cae al cálculo por costo", () => {
    const f = calcularFila(FILA_REAL, autoMapear(LISTA_ACTUALIZACION), PARAMS, {
      precio_sugerido_publico: null,
      markup_porcentaje: null,
    });
    expect(f.precio_sin_iva).toBe(23203.9);
    expect(f.origen).toBe("costo");
  });

  // La protección tiene que ser por FILA, no por columna. Las listas de proveedor
  // no llenan el sugerido en todos los renglones, y un blanco no significa "este
  // producto ya no tiene precio sugerido": significa "acá no lo pusieron".
  // Tomarlo como borrado devolvía ese producto al cálculo por costo, −40% de un
  // plumazo, que es el bug que esta feature arregla.
  it("celda vacía con la columna mapeada: se conserva el sugerido guardado", () => {
    const f = calcularFila(
      { ...FILA_REAL, " Sugerido al público C/IVA ": "" },
      autoMapear(LISTA_PLANA),
      PARAMS,
      { precio_sugerido_publico: 34370.6, markup_porcentaje: null },
    );
    expect(f.precio_sugerido_publico).toBe(34370.6);
    expect(f.precio_sin_iva).toBe(36927.09);
    expect(f.origen).toBe("sugerido");
  });

  it("celda vacía y sin sugerido guardado: recién ahí va por costo", () => {
    const f = calcularFila(
      { ...FILA_REAL, " Sugerido al público C/IVA ": "" },
      autoMapear(LISTA_PLANA),
      PARAMS,
    );
    expect(f.precio_sugerido_publico).toBeNull();
    expect(f.origen).toBe("costo");
  });

  // Regresión propia: `normalizarIva` sólo entiende números, así que el IVA hay
  // que parsearlo con parseNumAr ANTES. Un "10,5" leído como 21 le deja al negocio
  // ~8,7% menos por unidad y declara una alícuota que no corresponde.
  it("un IVA en formato argentino ('10,5') no se pierde", () => {
    const mapping = { ...autoMapear(LISTA_PLANA), iva_porcentaje: "IVA" };
    const f = calcularFila({ ...FILA_REAL, IVA: "10,5" }, mapping, PARAMS);
    expect(f.iva_porcentaje).toBe(10.5);
    expect(f.precio_sin_iva).toBe(40436);
    expect(f.venta_c_iva).toBe(44681.78);
  });

  // Antes la importación recalculaba TODO con el markup default, así que a un
  // producto con markup propio le quedaba un precio que contradecía su markup.
  it("respeta el markup propio del producto", () => {
    const f = calcularFila(FILA_REAL, autoMapear(LISTA_PLANA), PARAMS, {
      precio_sugerido_publico: null,
      markup_porcentaje: 50,
    });
    expect(f.markup).toBe(50);
    expect(f.venta_c_iva).toBe(+(34370.6 * 1.5).toFixed(2));
  });

  it("un producto nuevo usa el markup default", () => {
    expect(calcularFila(FILA_REAL, autoMapear(LISTA_PLANA), PARAMS).markup).toBe(30);
  });

  // El caso de la captura del cliente: la columna de precio mapeada al % de IVA.
  // Ahora el IVA es un DIVISOR, así que un valor basura corrompería lo facturado.
  it("un IVA imposible no corrompe el neto", () => {
    const mapping = { ...autoMapear(LISTA_PLANA), iva_porcentaje: " Sugerido al público C/IVA " };
    const f = calcularFila(FILA_REAL, mapping, PARAMS);
    expect(f.iva_porcentaje).toBe(21);
    expect(f.precio_sin_iva).toBe(36927.09);
  });

  it("números en formato argentino", () => {
    const f = calcularFila(
      {
        ...FILA_REAL,
        " PRECIO DE LISTA ": "30.774,40",
        " Sugerido al público C/IVA ": "34.370,60",
      },
      autoMapear(LISTA_PLANA),
      PARAMS,
    );
    expect(f.precio_fabrica).toBe(17849.15);
    expect(f.venta_c_iva).toBe(44681.78);
  });
});

// Hallazgos del review del código con Codex (§14 del spec).
describe("robustez del mapeo (review Codex)", () => {
  it("una columna 'NETO' o 'sin impuestos' no entra como sugerido", () => {
    for (const h of ["PVP NETO", "Precio sugerido neto", "SUGERIDO SIN IMPUESTOS"]) {
      expect(autoMapear(["CODIGO", "DESCRIPCION", h]).precio_sugerido_publico).toBeUndefined();
    }
  });

  // Mapear la columna del sugerido a "IVA %" o a "Precio s/IVA" —que es lo que
  // hizo el cliente— es PEOR que no mapearla. También hay que avisarlo.
  it("avisa aunque la columna del sugerido esté mapeada a otro campo", () => {
    expect(
      sugeridoSinMapear(LISTA_PLANA, {
        codigo: " CÓDIGO  ",
        iva_porcentaje: " Sugerido al público C/IVA ",
      }),
    ).toBe(" Sugerido al público C/IVA ");
    expect(
      sugeridoSinMapear(LISTA_PLANA, {
        codigo: " CÓDIGO  ",
        precio_sin_iva: " Sugerido al público C/IVA ",
      }),
    ).toBe(" Sugerido al público C/IVA ");
  });
});
