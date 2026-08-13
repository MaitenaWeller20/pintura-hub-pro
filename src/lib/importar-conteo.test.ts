import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  TOPE_ITEMS,
  aCsv,
  detectarColumnas,
  procesarConteo,
  type Columnas,
  type ProductoCatalogo,
} from "./importar-conteo";

const cols = (p: Partial<Columnas> = {}): Columnas => ({
  codigo: "codigo",
  cantidad: "existencia",
  deposito: null,
  fecha: null,
  descripcion: null,
  ...p,
});

const opciones = (p = {}) => ({ negativosComoCero: false, archivoCompleto: false, ...p });

const CAT: ProductoCatalogo[] = [
  { producto_id: "p1", codigo: "1001-00100" },
  { producto_id: "p2", codigo: "1001-00500" },
  { producto_id: "p3", codigo: "101.01.001" },
];

describe("detectarColumnas", () => {
  it("reconoce el CSV que genera el conversor de PDF", () => {
    const c = detectarColumnas(["deposito", "fecha_snapshot", "codigo", "descripcion", "existencia"]);
    expect(c.codigo).toBe("codigo");
    expect(c.cantidad).toBe("existencia");
    expect(c.deposito).toBe("deposito");
    expect(c.fecha).toBe("fecha_snapshot");
  });

  it("reconoce variantes con acentos y mayúsculas", () => {
    const c = detectarColumnas(["Código", "CANTIDAD"]);
    expect(c.codigo).toBe("Código");
    expect(c.cantidad).toBe("CANTIDAD");
  });

  it("reconoce las cabeceras del reporte de 3C", () => {
    const c = detectarColumnas(["Cód. Articulo", "Descripción", "Existencia"]);
    expect(c.codigo).toBe("Cód. Articulo");
    expect(c.cantidad).toBe("Existencia");
  });

  it("no confunde 'Existencia' con 'Días s/ Existencia'", () => {
    // El reporte real trae las dos. Si gana la equivocada, se importa basura.
    const c = detectarColumnas(["Codigo", "Días s/ Existencia", "Existencia"]);
    expect(c.cantidad).toBe("Existencia");
  });

  it("lo que no reconoce queda en null (se elige a mano)", () => {
    const c = detectarColumnas(["columna A", "columna B"]);
    expect(c.codigo).toBeNull();
    expect(c.cantidad).toBeNull();
  });

  it("reconoce la descripción, que es lo que da el nombre al dar de alta", () => {
    expect(
      detectarColumnas(["deposito", "codigo", "descripcion", "existencia"]).descripcion,
    ).toBe("descripcion");
    expect(detectarColumnas(["Cód. Articulo", "Descripción", "Existencia"]).descripcion).toBe(
      "Descripción",
    );
  });

  // "Articulo" es sinónimo de CÓDIGO. Si además contara como descripción, un
  // reporte con una sola columna así se quedaría sin código y no se podría
  // cruzar nada: el conteo entero quedaría en "no encontrados".
  it("una sola columna «Articulo» va al código, no a la descripción", () => {
    const c = detectarColumnas(["Articulo", "Existencia"]);
    expect(c.codigo).toBe("Articulo");
    expect(c.descripcion).toBeNull();
  });
});

describe("procesarConteo", () => {
  it("vuelca lo que coincide con el catálogo", () => {
    const r = procesarConteo(
      [
        { codigo: "1001-00100", existencia: "5" },
        { codigo: "1001-00500", existencia: "0" },
      ],
      cols(),
      CAT,
      opciones(),
    );
    expect(r.aVolcar).toEqual([
      { producto_id: "p1", codigo: "1001-00100", cantidad: 5 },
      { producto_id: "p2", codigo: "1001-00500", cantidad: 0 },
    ]);
    expect(r.noEncontrados).toEqual([]);
  });

  it("el CERO se vuelca: es 'lo conté y no hay', no 'no lo conté'", () => {
    const r = procesarConteo([{ codigo: "1001-00100", existencia: "0" }], cols(), CAT, opciones());
    expect(r.aVolcar).toHaveLength(1);
    expect(r.aVolcar[0].cantidad).toBe(0);
  });

  it("matchea ignorando espacios y mayúsculas", () => {
    const r = procesarConteo(
      [{ codigo: "  1001-00100  ", existencia: "3" }],
      cols(),
      CAT,
      opciones(),
    );
    expect(r.aVolcar).toHaveLength(1);
  });

  it("NO hace match flexible: 100100 no es 1001-00100", () => {
    // Aplastar guiones y puntos subiría los matches a costa de asignarle el
    // stock al producto equivocado, que es un error que no se ve.
    const r = procesarConteo([{ codigo: "100100", existencia: "3" }], cols(), CAT, opciones());
    expect(r.aVolcar).toEqual([]);
    expect(r.noEncontrados).toEqual([{ codigo: "100100", cantidad: "3", descripcion: "" }]);
  });

  it("lo que no está en el catálogo se reporta, no se pierde", () => {
    const r = procesarConteo([{ codigo: "9999-9", existencia: "7" }], cols(), CAT, opciones());
    expect(r.noEncontrados).toEqual([{ codigo: "9999-9", cantidad: "7", descripcion: "" }]);
    expect(r.aVolcar).toEqual([]);
  });

  // Sin el nombre no se los puede dar de alta, y dar de alta los que faltan es
  // la única forma de que su stock entre. El caso real: 647 códigos del
  // depósito que no existían como producto, HIDROMEX entero entre ellos.
  it("el no encontrado se lleva la descripción del archivo, para poder crearlo", () => {
    const r = procesarConteo(
      [{ codigo: "1001-00100", descripcion: "HIDROMEX x 1", existencia: "5" }],
      cols({ descripcion: "descripcion" }),
      [], // catálogo vacío: no existe todavía
      opciones(),
    );
    expect(r.noEncontrados).toEqual([
      { codigo: "1001-00100", cantidad: "5", descripcion: "HIDROMEX x 1" },
    ]);
  });

  it("sin columna de descripción queda vacía y no se inventa un nombre", () => {
    const r = procesarConteo(
      [{ codigo: "1001-00100", descripcion: "HIDROMEX x 1", existencia: "5" }],
      cols(), // descripcion: null
      [],
      opciones(),
    );
    expect(r.noEncontrados[0].descripcion).toBe("");
  });

  it("un código repetido NO se vuelca (ni suma ni pisa)", () => {
    // Dos filas del mismo código pueden ser "lo conté en dos estanterías" o "lo
    // pegué dos veces". No hay forma de distinguirlas; elegir mal duplica stock.
    const r = procesarConteo(
      [
        { codigo: "1001-00100", existencia: "5" },
        { codigo: "1001-00100", existencia: "3" },
        { codigo: "1001-00500", existencia: "1" },
      ],
      cols(),
      CAT,
      opciones(),
    );
    expect(r.repetidos).toEqual(["1001-00100"]);
    expect(r.aVolcar).toEqual([{ producto_id: "p2", codigo: "1001-00500", cantidad: 1 }]);
  });

  it("los repetidos se detectan aunque difieran en mayúsculas/espacios", () => {
    const r = procesarConteo(
      [
        { codigo: "101.01.001", existencia: "5" },
        { codigo: " 101.01.001 ", existencia: "3" },
      ],
      cols(),
      CAT,
      opciones(),
    );
    expect(r.repetidos).toHaveLength(1);
    expect(r.aVolcar).toEqual([]);
  });

  it("una cantidad ilegible se reporta aparte", () => {
    const r = procesarConteo(
      [
        { codigo: "1001-00100", existencia: "" },
        { codigo: "1001-00500", existencia: "s/d" },
      ],
      cols(),
      CAT,
      opciones(),
    );
    expect(r.ilegibles).toHaveLength(2);
    expect(r.aVolcar).toEqual([]);
  });

  it("acepta decimales (el archivo real trae un 0,5)", () => {
    const r = procesarConteo([{ codigo: "1001-00100", existencia: "0,5" }], cols(), CAT, opciones());
    expect(r.aVolcar[0].cantidad).toBe(0.5);
  });

  it("los negativos NO entran por defecto", () => {
    const r = procesarConteo([{ codigo: "1001-00100", existencia: "-2" }], cols(), CAT, opciones());
    expect(r.negativos).toEqual([{ codigo: "1001-00100", valor: -2 }]);
    expect(r.aVolcar).toEqual([]);
  });

  it("los negativos entran como 0 sólo si se pide explícitamente", () => {
    const r = procesarConteo(
      [{ codigo: "1001-00100", existencia: "-2" }],
      cols(),
      CAT,
      opciones({ negativosComoCero: true }),
    );
    expect(r.negativos).toHaveLength(1);
    expect(r.aVolcar).toEqual([{ producto_id: "p1", codigo: "1001-00100", cantidad: 0 }]);
  });

  it("la fila fantasma del reporte de 3C se ignora sin contarla como error", () => {
    // Código literal "-" y cantidad -202. No es un producto.
    const r = procesarConteo(
      [
        { codigo: "-", existencia: "-202" },
        { codigo: "1001-00100", existencia: "5" },
      ],
      cols(),
      CAT,
      opciones(),
    );
    expect(r.sinCodigo).toBe(1);
    expect(r.negativos).toEqual([]);
    expect(r.ilegibles).toEqual([]);
    expect(r.aVolcar).toHaveLength(1);
  });

  it("cuenta los del catálogo que no vinieron en el archivo", () => {
    const r = procesarConteo([{ codigo: "1001-00100", existencia: "5" }], cols(), CAT, opciones());
    expect(r.faltantesDelCatalogo).toBe(2);
    expect(r.aVolcar).toHaveLength(1); // no se tocan
  });

  it("en modo 'inventario completo' los que faltan se cuentan como 0", () => {
    const r = procesarConteo(
      [{ codigo: "1001-00100", existencia: "5" }],
      cols(),
      CAT,
      opciones({ archivoCompleto: true }),
    );
    expect(r.aVolcar).toHaveLength(3);
    expect(r.aVolcar.filter((i) => i.cantidad === 0).map((i) => i.producto_id).sort()).toEqual([
      "p2",
      "p3",
    ]);
  });

  // -------------------------------------------------------------------------
  // El bug que casi se va a producción: "inventario completo" ponía en 0 todo
  // lo que la pantalla promete NO TOCAR. El motivo era usar "se pudo volcar"
  // como si significara "vino en el archivo".
  // -------------------------------------------------------------------------
  it("'inventario completo' NO pisa lo que vino pero se salteó por repetido", () => {
    const r = procesarConteo(
      [
        { codigo: "1001-00100", existencia: "5" },
        { codigo: "1001-00500", existencia: "1" },
        { codigo: "1001-00500", existencia: "9" }, // repetido: no se vuelca
      ],
      cols(),
      CAT,
      opciones({ archivoCompleto: true }),
    );
    expect(r.repetidos).toEqual(["1001-00500"]);
    // p2 vino en el archivo: no puede terminar en 0.
    expect(r.aVolcar.find((i) => i.producto_id === "p2")).toBeUndefined();
    expect(r.aVolcar.map((i) => i.producto_id).sort()).toEqual(["p1", "p3"]);
  });

  it("'inventario completo' NO pisa lo que vino con la cantidad ilegible", () => {
    const r = procesarConteo(
      [
        { codigo: "1001-00100", existencia: "5" },
        { codigo: "1001-00500", existencia: "s/d" },
      ],
      cols(),
      CAT,
      opciones({ archivoCompleto: true }),
    );
    expect(r.ilegibles).toHaveLength(1);
    expect(r.aVolcar.find((i) => i.producto_id === "p2")).toBeUndefined();
  });

  it("'inventario completo' NO pisa un negativo cuando NO se pidió cargarlo como 0", () => {
    const r = procesarConteo(
      [
        { codigo: "1001-00100", existencia: "5" },
        { codigo: "1001-00500", existencia: "-3" },
      ],
      cols(),
      CAT,
      opciones({ archivoCompleto: true, negativosComoCero: false }),
    );
    expect(r.negativos).toHaveLength(1);
    expect(r.aVolcar.find((i) => i.producto_id === "p2")).toBeUndefined();
  });

  it("los que vinieron pero se saltearon NO cuentan como faltantes del catálogo", () => {
    const r = procesarConteo(
      [
        { codigo: "1001-00100", existencia: "5" },
        { codigo: "1001-00500", existencia: "s/d" },
      ],
      cols(),
      CAT,
      opciones(),
    );
    // Sólo p3 falta de verdad; p2 vino, sólo que ilegible.
    expect(r.faltantesDelCatalogo).toBe(1);
  });

  it("dos productos que sólo difieren en mayúsculas no reciben stock de nadie", () => {
    // La base garantiza `codigo UNIQUE` sensible a mayúsculas, así que 'ABC' y
    // 'abc' pueden coexistir. Con un índice case-insensitive uno pisaría al otro
    // y el stock iría al producto equivocado, en silencio.
    const cat = [
      { producto_id: "x1", codigo: "ABC" },
      { producto_id: "x2", codigo: "abc" },
      { producto_id: "x3", codigo: "ZZZ" },
    ];
    const r = procesarConteo(
      [
        { codigo: "abc", existencia: "9" },
        { codigo: "ZZZ", existencia: "2" },
      ],
      cols(),
      cat,
      opciones(),
    );
    expect(r.aVolcar).toEqual([{ producto_id: "x3", codigo: "ZZZ", cantidad: 2 }]);
    expect(r.noEncontrados).toEqual([{ codigo: "abc", cantidad: "9", descripcion: "" }]);
  });

  it("'inventario completo' no pisa lo que sí vino, ni siquiera si vino en 0", () => {
    const r = procesarConteo(
      [{ codigo: "1001-00100", existencia: "0" }],
      cols(),
      CAT,
      opciones({ archivoCompleto: true }),
    );
    expect(r.aVolcar.filter((i) => i.producto_id === "p1")).toHaveLength(1);
  });

  it("lee el depósito y la fecha del archivo", () => {
    const r = procesarConteo(
      [{ codigo: "1001-00100", existencia: "5", deposito: "O'HIGGINS", fecha: "2026-08-03T17:33:02" }],
      cols({ deposito: "deposito", fecha: "fecha" }),
      CAT,
      opciones(),
    );
    expect(r.deposito).toBe("O'HIGGINS");
    expect(r.fechaSnapshot).toBe("2026-08-03T17:33:02");
    expect(r.depositosMezclados).toBe(false);
  });

  it("detecta un archivo con depósitos mezclados", () => {
    // Subir dos depósitos juntos aplicaría cantidades de una sucursal a la otra.
    const r = procesarConteo(
      [
        { codigo: "1001-00100", existencia: "5", deposito: "O'HIGGINS" },
        { codigo: "1001-00500", existencia: "2", deposito: "GRAL PAZ" },
      ],
      cols({ deposito: "deposito" }),
      CAT,
      opciones(),
    );
    expect(r.depositosMezclados).toBe(true);
    expect(r.deposito).toBeNull();
  });

  it("avisa cuando se pasa del tope de la RPC", () => {
    const grande: ProductoCatalogo[] = Array.from({ length: TOPE_ITEMS + 1 }, (_, i) => ({
      producto_id: `p${i}`,
      codigo: `C${i}`,
    }));
    const filas = grande.map((p) => ({ codigo: p.codigo, existencia: "1" }));
    const r = procesarConteo(filas, cols(), grande, opciones());
    expect(r.aVolcar).toHaveLength(TOPE_ITEMS + 1);
    expect(r.excedeTope).toBe(true);
  });

  it("justo en el tope NO avisa", () => {
    const justo: ProductoCatalogo[] = Array.from({ length: TOPE_ITEMS }, (_, i) => ({
      producto_id: `p${i}`,
      codigo: `C${i}`,
    }));
    const r = procesarConteo(
      justo.map((p) => ({ codigo: p.codigo, existencia: "1" })),
      cols(),
      justo,
      opciones(),
    );
    expect(r.excedeTope).toBe(false);
  });

  it("sin columnas elegidas no rompe: todo queda sin código", () => {
    const r = procesarConteo(
      [{ a: "1", b: "2" }],
      { codigo: null, cantidad: null, deposito: null, fecha: null, descripcion: null },
      CAT,
      opciones(),
    );
    expect(r.sinCodigo).toBe(1);
    expect(r.aVolcar).toEqual([]);
  });
});

describe("aCsv", () => {
  it("escapa comas y comillas", () => {
    expect(aCsv([{ codigo: "A,1", nombre: 'dice "hola"' }])).toBe(
      'codigo,nombre\n"A,1","dice ""hola"""',
    );
  });
  it("vacío da vacío", () => {
    expect(aCsv([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Contra el archivo REAL de la clienta.
//
// Se saltea si el CSV no está generado (el PDF no vive en el repo). Cuando está,
// es la prueba que más vale: 1614 filas de verdad, con sus negativos, su decimal
// y su fila fantasma.
// ---------------------------------------------------------------------------
const CSV_REAL = "/tmp/claude-501/-Users-leolorenzo-Desktop-Leo-quimex/657490fe-62ab-43f4-8c19-0b9dbe4d8b75/scratchpad/ohiggins.csv";

describe.runIf(existsSync(CSV_REAL))("el archivo real de O'Higgins", () => {
  const leer = () => {
    // El CSV va con CRLF (lo que manda RFC 4180 y lo que espera Excel). Un
    // parser de verdad —el XLSX que usa la pantalla— se come el \r; este lector
    // de juguete no, así que lo saca a mano.
    const txt = readFileSync(CSV_REAL, "utf-8").replace(/\r/g, "").trim().split("\n");
    const heads = txt[0].split(",");
    return txt.slice(1).map((l) => {
      // El CSV del conversor no tiene comas dentro de los campos salvo comillas.
      const partes: string[] = [];
      let actual = "";
      let enComillas = false;
      for (const ch of l) {
        if (ch === '"') enComillas = !enComillas;
        else if (ch === "," && !enComillas) { partes.push(actual); actual = ""; }
        else actual += ch;
      }
      partes.push(actual);
      return Object.fromEntries(heads.map((h, i) => [h, partes[i] ?? ""]));
    });
  };

  it("detecta las columnas solo", () => {
    const filas = leer();
    const c = detectarColumnas(Object.keys(filas[0]));
    expect(c.codigo).toBe("codigo");
    expect(c.cantidad).toBe("existencia");
  });

  it("con el catálogo completo, la suma de lo volcado da el total del reporte", () => {
    const filas = leer();
    const c = detectarColumnas(Object.keys(filas[0]));
    // Catálogo ficticio que contiene TODOS los códigos del archivo: así lo que
    // se mide es el parseo, no el match.
    const catalogo = filas
      .map((f) => String(f[c.codigo!]))
      .filter((x) => x && x !== "-")
      .map((codigo, i) => ({ producto_id: `p${i}`, codigo }));
    const r = procesarConteo(filas, c, catalogo, opciones({ negativosComoCero: false }));

    expect(r.filasLeidas).toBe(1614);
    expect(r.sinCodigo).toBe(1); // la fila fantasma
    expect(r.repetidos).toEqual([]);
    expect(r.ilegibles).toEqual([]);
    expect(r.negativos.length).toBe(23); // 24 negativas menos la fantasma

    const suma = r.aVolcar.reduce((a, i) => a + i.cantidad, 0);
    const sumaNegativos = r.negativos.reduce((a, n) => a + n.valor, 0);
    // 4421.5 es el total que imprime el reporte; incluye la fila fantasma (-202)
    // y los negativos, que acá quedaron afuera.
    expect(Math.round((suma + sumaNegativos + -202) * 10) / 10).toBe(4421.5);
  });
});
