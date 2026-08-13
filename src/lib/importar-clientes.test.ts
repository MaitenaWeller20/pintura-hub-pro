import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  claveNombre,
  detectarColumnasCliente,
  procesarClientes,
  soloDigitos,
  type ClienteExistente,
  type ColumnasCliente,
} from "./importar-clientes";

const cols = (p: Partial<ColumnasCliente> = {}): ColumnasCliente => ({
  razon_social: "razon_social",
  cuit: "cuit",
  cta_cte: "cta_cte",
  domicilio: "domicilio",
  telefono: "telefono",
  ...p,
});

const fila = (p: Record<string, unknown> = {}) => ({
  razon_social: "",
  cuit: "",
  cta_cte: "",
  domicilio: "",
  telefono: "",
  ...p,
});

describe("detectarColumnasCliente", () => {
  it("reconoce el CSV del conversor de 3C", () => {
    const c = detectarColumnasCliente([
      "codigo",
      "razon_social",
      "cuit",
      "ingresos_brutos",
      "iva",
      "lista",
      "cta_cte",
      "zona",
      "provincia",
      "domicilio",
      "telefono",
      "estado",
    ]);
    expect(c).toEqual({
      razon_social: "razon_social",
      cuit: "cuit",
      cta_cte: "cta_cte",
      domicilio: "domicilio",
      telefono: "telefono",
    });
  });

  it("reconoce variantes de una planilla hecha a mano", () => {
    const c = detectarColumnasCliente(["Nombre", "CUIT/DNI", "Cta Cte", "Dirección", "Tel."]);
    expect(c.razon_social).toBe("Nombre");
    expect(c.cuit).toBe("CUIT/DNI");
    expect(c.cta_cte).toBe("Cta Cte");
    expect(c.domicilio).toBe("Dirección");
    expect(c.telefono).toBe("Tel.");
  });

  it("lo que no reconoce queda en null", () => {
    expect(detectarColumnasCliente(["aaa", "bbb"]).razon_social).toBeNull();
  });
});

describe("soloDigitos / claveNombre", () => {
  it("el CUIT se compara como lo compara la base", () => {
    // uq_clientes_cuit_dni_activo indexa regexp_replace(cuit_dni, '\D', '', 'g')
    expect(soloDigitos("30-12345678-9")).toBe("30123456789");
    expect(soloDigitos("30123456789")).toBe("30123456789");
    expect(soloDigitos("")).toBe("");
    expect(soloDigitos(null)).toBe("");
  });

  it("el nombre se compara sin acentos, mayúsculas ni dobles espacios", () => {
    expect(claveNombre("  JOSÉ   PÉREZ ")).toBe("jose perez");
    expect(claveNombre("Jose Perez")).toBe("jose perez");
  });
});

describe("procesarClientes", () => {
  it("mapea los campos que se decidió importar", () => {
    const r = procesarClientes(
      [
        fila({
          razon_social: "HOTEL SAVOY",
          cuit: "30-68754273-4",
          cta_cte: "S",
          domicilio: "JERONIMO LUIS DE CABRERA 201    Barrio",
          telefono: "351-4441122",
        }),
      ],
      cols(),
      [],
    );
    expect(r.aCrear).toEqual([
      {
        razon_social: "HOTEL SAVOY",
        // Se guarda normalizado aunque el archivo lo traiga con guiones: la
        // columna es canónica (sólo dígitos) y los guiones son de la vista.
        cuit_dni: "30687542734",
        condicion_cta_cte: true,
        // Los dobles espacios del PDF se colapsan.
        direccion: "JERONIMO LUIS DE CABRERA 201 Barrio",
        telefono: "351-4441122",
      },
    ]);
  });

  it("cta cte: sólo S es sí", () => {
    const r = procesarClientes(
      [
        fila({ razon_social: "A", cuit: "20-24331879-4", cta_cte: "S" }),
        fila({ razon_social: "B", cuit: "30-68754273-4", cta_cte: "N" }),
        fila({ razon_social: "C", cuit: "30-67757303-8", cta_cte: "" }),
        fila({ razon_social: "D", cuit: "30-71540452-0", cta_cte: "cualquiera" }),
      ],
      cols(),
      [],
    );
    expect(r.aCrear.map((c) => c.condicion_cta_cte)).toEqual([true, false, false, false]);
  });

  it("los campos vacíos entran como null, no como cadena vacía", () => {
    const r = procesarClientes([fila({ razon_social: "SOLO NOMBRE" })], cols(), []);
    expect(r.aCrear[0]).toMatchObject({ cuit_dni: null, direccion: null, telefono: null });
  });

  it("una fila sin nombre no crea nada", () => {
    const r = procesarClientes([fila({ cuit: "20-24331879-4" })], cols(), []);
    expect(r.aCrear).toEqual([]);
    expect(r.sinNombre).toBe(1);
  });

  // -------------------------------------------------------------------------
  // "Los que están repetidos hay que sacarlos" (Leo, 04/08).
  // -------------------------------------------------------------------------
  it("un CUIT repetido en el archivo saca a TODOS, no al segundo", () => {
    const r = procesarClientes(
      [
        fila({ razon_social: "SUCURSAL UNO", cuit: "30-70700414-9" }),
        fila({ razon_social: "SUCURSAL DOS", cuit: "30-70700414-9" }),
        fila({ razon_social: "OTRO", cuit: "20-11111111-2" }),
      ],
      cols(),
      [],
    );
    expect(r.aCrear.map((c) => c.razon_social)).toEqual(["OTRO"]);
    expect(r.cuitRepetido).toHaveLength(2);
  });

  it("detecta el repetido aunque esté escrito distinto", () => {
    // "30-71540452-0" y "30715404520" son el MISMO para el índice de la base.
    const r = procesarClientes(
      [
        fila({ razon_social: "A", cuit: "30-71540452-0" }),
        fila({ razon_social: "B", cuit: "30715404520" }),
      ],
      cols(),
      [],
    );
    expect(r.aCrear).toEqual([]);
    expect(r.cuitRepetido).toHaveLength(2);
  });

  it("un CUIT inválido se reporta como inválido, no como repetido", () => {
    // El orden importa: "arreglá este CUIT" es accionable; "está repetido" manda
    // a buscar un duplicado que no existe.
    const r = procesarClientes(
      [
        fila({ razon_social: "A", cuit: "30-12345678-9" }),
        fila({ razon_social: "B", cuit: "30123456789" }),
      ],
      cols(),
      [],
    );
    expect(r.cuitInvalido).toHaveLength(2);
    expect(r.cuitRepetido).toEqual([]);
  });

  it("no vuelve a crear a alguien que ya está por CUIT", () => {
    const enBase: ClienteExistente[] = [{ razon_social: "VIEJO", cuit_dni: "30-68754273-4" }];
    const r = procesarClientes(
      [fila({ razon_social: "HOTEL SAVOY", cuit: "30687542734" })],
      cols(),
      enBase,
    );
    expect(r.aCrear).toEqual([]);
    expect(r.yaExistenPorCuit).toEqual([{ cuit: "30687542734", razon_social: "HOTEL SAVOY" }]);
  });

  it("sin CUIT, no duplica a alguien que ya está por nombre", () => {
    const enBase: ClienteExistente[] = [{ razon_social: "José Pérez", cuit_dni: null }];
    const r = procesarClientes([fila({ razon_social: "JOSE PEREZ" })], cols(), enBase);
    expect(r.aCrear).toEqual([]);
    expect(r.yaExistenPorNombre).toEqual(["JOSE PEREZ"]);
  });

  it("sin CUIT, un nombre repetido en el archivo también se saca", () => {
    const r = procesarClientes(
      [fila({ razon_social: "JUAN PEREZ" }), fila({ razon_social: "juan perez" })],
      cols(),
      [],
    );
    expect(r.aCrear).toEqual([]);
    // Se listan las DOS grafías, igual que con los CUIT repetidos: la persona
    // tiene que ver exactamente qué filas quedaron afuera para arreglar el
    // archivo, y "JUAN PEREZ" a secas no le diría cuál de las dos revisar.
    expect(r.nombreRepetido).toEqual(["JUAN PEREZ", "juan perez"]);
  });

  it("dos filas del archivo con el mismo nombre y CUIT distinto SÍ entran", () => {
    // Dentro del archivo, el nombre sólo desempata cuando NO hay CUIT: con CUIT
    // manda el CUIT, porque son entidades distinguibles. El chequeo por nombre
    // contra la BASE es otra cosa (ahí el riesgo es duplicar algo ya cargado).
    const r = procesarClientes(
      [
        fila({ razon_social: "PINTURERIA SA", cuit: "20-12345678-6" }),
        fila({ razon_social: "PINTURERIA SA", cuit: "30-22222222-9" }),
      ],
      cols(),
      [],
    );
    expect(r.aCrear).toHaveLength(2);
  });

  it("NO duplica a un cliente que ya está sin CUIT si el archivo lo trae con CUIT", () => {
    // Éste es el caso más probable de la migración: alguien cargó "ACME" a mano
    // sin CUIT, y el archivo viejo lo trae con CUIT. Antes entraba como cliente
    // nuevo y la cuenta corriente quedaba partida entre dos fichas.
    const enBase: ClienteExistente[] = [{ razon_social: "ACME", cuit_dni: null }];
    const r = procesarClientes(
      [fila({ razon_social: "ACME", cuit: "30-71822393-4" })],
      cols(),
      enBase,
    );
    expect(r.aCrear).toEqual([]);
    expect(r.yaExistenPorNombre).toEqual(["ACME"]);
  });

  it("rechaza un CUIT inválido en vez de guardarlo", () => {
    const r = procesarClientes(
      [
        fila({ razon_social: "MAL LARGO", cuit: "3071822393" }),
        fila({ razon_social: "MAL DIGITO", cuit: "30-71822393-1" }),
        fila({ razon_social: "DNI OK", cuit: "24331879" }),
      ],
      cols(),
      [],
    );
    expect(r.cuitInvalido.map((c) => c.razon_social)).toEqual(["MAL LARGO", "MAL DIGITO"]);
    expect(r.aCrear.map((c) => c.razon_social)).toEqual(["DNI OK"]);
  });

  it("sin columnas elegidas no rompe", () => {
    const r = procesarClientes(
      [fila({ razon_social: "A" })],
      { razon_social: null, cuit: null, cta_cte: null, domicilio: null, telefono: null },
      [],
    );
    expect(r.aCrear).toEqual([]);
    expect(r.sinNombre).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Contra el archivo REAL (el que mandó la clienta, todavía incompleto).
// Se saltea si el CSV no está generado: el PDF no vive en el repo.
// ---------------------------------------------------------------------------
const CSV_REAL =
  "/tmp/claude-501/-Users-leolorenzo-Desktop-Leo-quimex/657490fe-62ab-43f4-8c19-0b9dbe4d8b75/scratchpad/clientes.csv";

describe.runIf(existsSync(CSV_REAL))("el archivo real de clientes", () => {
  const leer = () => {
    const lineas = readFileSync(CSV_REAL, "utf-8").replace(/\r/g, "").trim().split("\n");
    const heads = lineas[0].split(",");
    return lineas.slice(1).map((l) => {
      const partes: string[] = [];
      let actual = "";
      let comillas = false;
      for (const ch of l) {
        if (ch === '"') comillas = !comillas;
        else if (ch === "," && !comillas) {
          partes.push(actual);
          actual = "";
        } else actual += ch;
      }
      partes.push(actual);
      return Object.fromEntries(heads.map((h, i) => [h, partes[i] ?? ""]));
    });
  };

  it("detecta las columnas y saca los 33 CUIT repetidos", () => {
    const filas = leer();
    const c = detectarColumnasCliente(Object.keys(filas[0]));
    const r = procesarClientes(filas, c, []);

    expect(r.filasLeidas).toBe(1318);
    expect(r.sinNombre).toBe(0);
    // 33 CUIT aparecen más de una vez; se sacan TODAS sus apariciones.
    const cuitsRepes = new Set(r.cuitRepetido.map((x) => soloDigitos(x.cuit)));
    expect(cuitsRepes.size).toBe(33);
    // Nadie repetido se coló en lo que se va a crear.
    const creados = r.aCrear.map((c2) => soloDigitos(c2.cuit_dni)).filter(Boolean);
    expect(new Set(creados).size).toBe(creados.length);
    // Todo el archivo queda contabilizado en alguna categoría.
    // EXACTO, no "menor o igual": con <= una fila podría desaparecer y el test
    // seguiría verde, que es justo lo que la invariante existe para impedir.
    expect(
      r.aCrear.length +
        r.sinNombre +
        r.cuitRepetido.length +
        r.yaExistenPorCuit.length +
        r.yaExistenPorNombre.length +
        r.nombreRepetido.length +
        r.cuitInvalido.length,
    ).toBe(1318);
  });

  it("los que tienen cuenta corriente entran con el flag prendido", () => {
    const filas = leer();
    const c = detectarColumnasCliente(Object.keys(filas[0]));
    const r = procesarClientes(filas, c, []);
    expect(r.aCrear.filter((x) => x.condicion_cta_cte).length).toBeGreaterThan(150);
  });
});

// ---------------------------------------------------------------------------
// LA INVARIANTE: toda fila leída cae en exactamente una categoría.
//
// Sin esto, una fila puede desaparecer sin que nadie se entere — y eso ya pasó:
// `nombreRepetido` era un Set, así que dos filas con el nombre escrito IGUAL se
// salteaban las dos pero se listaba una sola. El resumen decía 1318 leídas y
// 1316 repartidas, y las 2 que faltaban no eran visibles en ningún lado.
// ---------------------------------------------------------------------------
const total = (r: ReturnType<typeof procesarClientes>) =>
  r.aCrear.length +
  r.sinNombre +
  r.cuitRepetido.length +
  r.yaExistenPorCuit.length +
  r.yaExistenPorNombre.length +
  r.nombreRepetido.length +
  r.cuitInvalido.length;

describe("el resumen siempre cierra", () => {
  it("con nombres repetidos escritos EXACTAMENTE igual", () => {
    const filas2 = [
      fila({ razon_social: "ACME" }),
      fila({ razon_social: "ACME" }),
      fila({ razon_social: "OTRO" }),
    ];
    const r = procesarClientes(filas2, cols(), []);
    expect(r.nombreRepetido).toEqual(["ACME", "ACME"]);
    expect(total(r)).toBe(3);
  });

  it("con una mezcla de todos los casos", () => {
    const filas2 = [
      fila({ razon_social: "NUEVO", cuit: "20-24331879-4" }),
      fila({ razon_social: "SIN NOMBRE EN BLANCO", cuit: "" }),
      fila({ razon_social: "", cuit: "30-68754273-4" }),
      fila({ razon_social: "REPE", cuit: "30-67757303-8" }),
      fila({ razon_social: "REPE OTRA", cuit: "30-67757303-8" }),
      fila({ razon_social: "YA ESTA", cuit: "30-71540452-0" }),
      fila({ razon_social: "IGUAL" }),
      fila({ razon_social: "IGUAL" }),
      fila({ razon_social: "EXISTE POR NOMBRE" }),
    ];
    const r = procesarClientes(filas2, cols(), [
      { razon_social: "OTRO", cuit_dni: "30-71540452-0" },
      { razon_social: "Existe Por Nombre", cuit_dni: null },
    ]);
    expect(total(r)).toBe(filas2.length);
  });

  it("con el archivo real, si está generado", () => {
    if (!existsSync(CSV_REAL)) return;
    const lineas = readFileSync(CSV_REAL, "utf-8").replace(/\r/g, "").trim().split("\n");
    const heads = lineas[0].split(",");
    const filas2 = lineas.slice(1).map((l) => {
      const p: string[] = [];
      let a = "",
        q = false;
      for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === "," && !q) {
          p.push(a);
          a = "";
        } else a += ch;
      }
      p.push(a);
      return Object.fromEntries(heads.map((h, i) => [h, p[i] ?? ""]));
    });
    const r = procesarClientes(filas2, detectarColumnasCliente(heads), []);
    expect(total(r)).toBe(r.filasLeidas);
  });
});
