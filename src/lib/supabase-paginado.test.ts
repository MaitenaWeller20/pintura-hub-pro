import { describe, it, expect } from "vitest";
import { traerTodo } from "./supabase-paginado";

/** Simula PostgREST: una tabla de N filas que corta cada respuesta en `maxRows`. */
function tablaFalsa(total: number, maxRows = 1000, conCount = false) {
  const todas = Array.from({ length: total }, (_, i) => ({ id: i }));
  const llamadas: Array<[number, number]> = [];
  const traer = async (desde: number, hasta: number) => {
    llamadas.push([desde, hasta]);
    const pedidas = hasta - desde + 1;
    return {
      data: todas.slice(desde, desde + Math.min(pedidas, maxRows)),
      error: null,
      count: conCount ? total : undefined,
    };
  };
  return { traer, llamadas };
}

describe("traerTodo", () => {
  it("junta todas las páginas cuando el total supera el máximo de PostgREST", async () => {
    const { traer, llamadas } = tablaFalsa(1133);
    const { filas, truncado } = await traerTodo(traer);
    expect(filas).toHaveLength(1133);
    expect(truncado).toBe(false);
    expect(llamadas).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("una sola llamada cuando entra todo en una página", async () => {
    const { traer, llamadas } = tablaFalsa(42);
    const { filas } = await traerTodo(traer);
    expect(filas).toHaveLength(42);
    expect(llamadas).toHaveLength(1);
  });

  it("tabla vacía: una llamada y ninguna fila", async () => {
    const { traer, llamadas } = tablaFalsa(0);
    const { filas, truncado } = await traerTodo(traer);
    expect(filas).toEqual([]);
    expect(truncado).toBe(false);
    expect(llamadas).toHaveLength(1);
  });

  // El caso que se come a los ingenuos: el total es múltiplo exacto del tamaño
  // de página, así que la última página viene LLENA y hace falta una más para
  // saber que se terminó.
  it("total múltiplo exacto del tamaño de página: pide una página extra y no duplica", async () => {
    const { traer, llamadas } = tablaFalsa(2000);
    const { filas, truncado } = await traerTodo(traer);
    expect(filas).toHaveLength(2000);
    expect(truncado).toBe(false);
    expect(llamadas).toHaveLength(3);
    expect(new Set(filas.map((f) => f.id)).size).toBe(2000);
  });

  it("no saltea ni repite filas", async () => {
    const { traer } = tablaFalsa(2500);
    const { filas } = await traerTodo(traer);
    expect(filas.map((f) => f.id)).toEqual(Array.from({ length: 2500 }, (_, i) => i));
  });

  it("avisa cuando toca el tope de seguridad en vez de mentir que está completo", async () => {
    const { traer } = tablaFalsa(10_000);
    const { filas, truncado } = await traerTodo(traer, { tamanoPagina: 100, tope: 250 });
    expect(truncado).toBe(true);
    expect(filas.length).toBeGreaterThanOrEqual(250);
    expect(filas.length).toBeLessThan(10_000);
  });

  // El bug que reintroduciría el truncado silencioso: si el server recorta las
  // páginas por debajo del tamaño pedido (db-max-rows < TAMANO_PAGINA), el
  // conteo por offset se saltea filas. Con el count real, se detecta y se avisa.
  it("marca truncado si el server recorta las páginas por debajo de lo pedido", async () => {
    const { traer } = tablaFalsa(2266, 500, true); // pido 1000, el server da 500
    const { filas, truncado } = await traerTodo(traer, { tamanoPagina: 1000 });
    expect(truncado).toBe(true);
    expect(filas.length).toBeLessThan(2266);
  });

  it("con count real y páginas completas, junta todo y NO marca truncado", async () => {
    const { traer } = tablaFalsa(2266, 1000, true);
    const { filas, truncado } = await traerTodo(traer, { tamanoPagina: 1000 });
    expect(filas).toHaveLength(2266);
    expect(truncado).toBe(false);
  });

  it("propaga el error de PostgREST", async () => {
    const traer = async () => ({ data: null, error: { message: "permission denied" } });
    await expect(traerTodo(traer)).rejects.toThrow("permission denied");
  });

  it("respeta un tamaño de página a medida", async () => {
    const { traer, llamadas } = tablaFalsa(250, 100);
    const { filas } = await traerTodo(traer, { tamanoPagina: 100 });
    expect(filas).toHaveLength(250);
    expect(llamadas).toEqual([
      [0, 99],
      [100, 199],
      [200, 299],
    ]);
  });

  it("un tamaño de página inválido es un error de programación, no un bucle infinito", async () => {
    const { traer } = tablaFalsa(10);
    await expect(traerTodo(traer, { tamanoPagina: 0 })).rejects.toThrow(/mayor que cero/);
  });
});
