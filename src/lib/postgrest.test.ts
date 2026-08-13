import { describe, it, expect } from "vitest";
import { filtroIlikeOr, filtroProducto, ordenarProductosPorRelevancia } from "./postgrest";

describe("filtroIlikeOr", () => {
  it("arma el filtro con el valor entre comillas", () => {
    expect(filtroIlikeOr([{ campo: "nombre", valor: "latex" }])).toBe('nombre.ilike."%latex%"');
  });

  it("escapa los comodines de LIKE para que se busquen literales", () => {
    // Sin esto, "A_B" también devuelve "AXB": el _ es un comodín de SQL.
    // Van dos barras porque son dos escapados encadenados: escaparLike deja
    // `A\_B` y escaparPostgrest le duplica la barra. PostgREST desescapa una y
    // a Postgres le llega el patrón `%A\_B%`, o sea un guión bajo literal.
    expect(filtroIlikeOr([{ campo: "codigo", valor: "A_B" }])).toBe('codigo.ilike."%A\\\\_B%"');
  });

  it("escapa la barra invertida en los dos niveles", () => {
    // Primero para LIKE (\ -> \\) y después para la gramática de PostgREST
    // (cada \ vuelve a duplicarse): "A\B" termina como %A\\\\B%.
    expect(filtroIlikeOr([{ campo: "nombre", valor: "A\\B" }])).toBe('nombre.ilike."%A\\\\\\\\B%"');
  });

  it("escapa las comillas dobles", () => {
    expect(filtroIlikeOr([{ campo: "nombre", valor: 'CAÑO 3"' }])).toBe(
      'nombre.ilike."%CAÑO 3\\"%"',
    );
  });

  it("descarta los pares vacíos", () => {
    expect(
      filtroIlikeOr([
        { campo: "a", valor: "" },
        { campo: "b", valor: "x" },
      ]),
    ).toBe('b.ilike."%x%"');
  });
});

describe("filtroProducto", () => {
  it("busca por código y por nombre", () => {
    expect(filtroProducto("latex")).toBe('codigo.ilike."%latex%",nombre.ilike."%latex%"');
  });

  it("devuelve null si no hay nada que buscar", () => {
    expect(filtroProducto("   ")).toBeNull();
  });
});

describe("ordenarProductosPorRelevancia", () => {
  // El caso de Renzo: busca "blanco" entre 161 productos que lo contienen y el
  // que quiere queda sepultado porque el orden es por código.
  const catalogo = [
    { codigo: "107.01.013", nombre: "AEROSOL BLANCO MATE X440" },
    { codigo: "201.05.002", nombre: "SEMIBLANCO INTERIOR X20" },
    { codigo: "301.02.001", nombre: "BLANCO PROFESIONAL X4" },
    { codigo: "BLANCO-01", nombre: "PIGMENTO CONCENTRADO" },
    { codigo: "104.01.013", nombre: "LATEX BLANCO MATE X20" },
  ];

  it("primero el código que arranca con lo tipeado", () => {
    const r = ordenarProductosPorRelevancia(catalogo, "blanco");
    expect(r[0].codigo).toBe("BLANCO-01");
  });

  it("después el nombre que arranca con lo tipeado", () => {
    const r = ordenarProductosPorRelevancia(catalogo, "blanco");
    expect(r[1].nombre).toBe("BLANCO PROFESIONAL X4");
  });

  it("una palabra que arranca con lo tipeado gana contra el pegado adentro", () => {
    const r = ordenarProductosPorRelevancia(catalogo, "blanco");
    const arrancaPalabra = r.findIndex((p) => p.nombre === "LATEX BLANCO MATE X20");
    const enElMedio = r.findIndex((p) => p.nombre === "SEMIBLANCO INTERIOR X20");
    expect(arrancaPalabra).toBeLessThan(enElMedio);
  });

  it("dentro del mismo rango ordena por código, para que no baile entre búsquedas", () => {
    const r = ordenarProductosPorRelevancia(catalogo, "blanco");
    const mismoRango = r.filter((p) =>
      ["AEROSOL BLANCO MATE X440", "LATEX BLANCO MATE X20"].includes(p.nombre),
    );
    expect(mismoRango.map((p) => p.codigo)).toEqual(["104.01.013", "107.01.013"]);
  });

  it("no rompe con caracteres que son especiales en una regex", () => {
    const lista = [{ codigo: "1", nombre: "CAÑO 3+1" }];
    expect(() => ordenarProductosPorRelevancia(lista, "3+1")).not.toThrow();
    expect(ordenarProductosPorRelevancia(lista, "3+1")).toHaveLength(1);
  });

  it("sin consulta devuelve la lista igual", () => {
    expect(ordenarProductosPorRelevancia(catalogo, "  ")).toEqual(catalogo);
  });

  it("no modifica el array original (viene de react-query)", () => {
    const original = [...catalogo];
    ordenarProductosPorRelevancia(catalogo, "blanco");
    expect(catalogo).toEqual(original);
  });
});
