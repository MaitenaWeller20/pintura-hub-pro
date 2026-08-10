import { describe, it, expect } from "vitest";
import {
  activables,
  motivoNoActivar,
  puedeActivar,
  type ProductoActivable,
} from "./productos-activar";

let n = 0;
/** Un producto apagado con precio: el caso de la clienta. Cada test rompe UNA cosa. */
const apagado = (p: Partial<ProductoActivable> = {}): ProductoActivable => ({
  id: `id-${++n}`,
  activo: false,
  archivado: false,
  precio_sin_iva: 6573.34,
  ...p,
});

describe("motivoNoActivar", () => {
  it("no encuentra motivo en un apagado con precio", () => {
    expect(motivoNoActivar(apagado())).toBeNull();
    expect(puedeActivar(apagado())).toBe(true);
  });

  it.each([[0], [null], [undefined], ["0.00"]])(
    "sin precio (%s) no se puede prender, y lo dice",
    (precio) => {
      const m = motivoNoActivar(apagado({ precio_sin_iva: precio as never }));
      expect(m).toContain("precio");
      expect(m).toContain("$0");
    },
  );

  it("un archivado manda restaurar primero, aunque tenga precio", () => {
    expect(motivoNoActivar(apagado({ archivado: true }))).toContain("archivado");
  });

  // Los dos problemas juntos: el que hay que resolver primero es que está borrado.
  it("archivado y sin precio dice lo del archivado", () => {
    expect(motivoNoActivar(apagado({ archivado: true, precio_sin_iva: 0 }))).toContain("archivado");
  });

  // El precio llega como string desde PostgREST en algunos casos (numeric).
  it("acepta el precio como texto", () => {
    expect(puedeActivar(apagado({ precio_sin_iva: "1500.50" }))).toBe(true);
  });
});

describe("activables", () => {
  it("una selección vacía no prende nada y no muestra el botón", () => {
    expect(activables([])).toEqual({ prender: [], sinPrecio: 0, apagados: 0 });
  });

  it("prende los apagados con precio", () => {
    const a = apagado();
    const b = apagado();
    expect(activables([a, b]).prender).toEqual([a.id, b.id]);
  });

  it("cuenta aparte los que no tienen precio", () => {
    const con = apagado();
    const sin = apagado({ precio_sin_iva: 0 });
    const r = activables([con, sin]);
    expect(r.prender).toEqual([con.id]);
    expect(r.sinPrecio).toBe(1);
    expect(r.apagados).toBe(2);
  });

  // EL CASO QUE IMPORTA: tildar "todos" son 1104 productos y sólo 3 se prenden.
  // Un "1104 activados" sería mentira, y un "1101 sin precio" también: los que
  // ya estaban activos no son ni una cosa ni la otra.
  it("ignora los que ya están activos", () => {
    const apagadoConPrecio = apagado();
    const yaActivo = apagado({ activo: true });
    const activoSinPrecio = apagado({ activo: true, precio_sin_iva: 0 });
    const r = activables([apagadoConPrecio, yaActivo, activoSinPrecio]);
    expect(r.prender).toEqual([apagadoConPrecio.id]);
    expect(r.sinPrecio).toBe(0);
    expect(r.apagados).toBe(1);
  });

  // Archivar NO apaga (eliminar_productos toca `archivado` y deja `activo` como
  // estaba), así que un archivado apagado con precio es una fila que existe.
  it("no prende un archivado ni lo cuenta como sin precio", () => {
    const arch = apagado({ archivado: true });
    const r = activables([arch]);
    expect(r.prender).toEqual([]);
    expect(r.sinPrecio).toBe(0);
    expect(r.apagados).toBe(1);
  });

  it("el botón se muestra si hay algún apagado, aunque ninguno se pueda prender", () => {
    const r = activables([apagado({ precio_sin_iva: 0 })]);
    expect(r.apagados).toBe(1);
    expect(r.prender).toEqual([]);
  });
});

// El switch del diálogo y el botón masivo tienen que decidir igual. Que se
// desincronicen es el bug que ya pasó con la fórmula de precios copiada en cuatro
// lados, y acá se traduciría en "el botón no lo prende y el switch sí".
describe("el switch y el masivo no divergen", () => {
  const casos: ProductoActivable[] = [
    apagado(),
    apagado({ precio_sin_iva: 0 }),
    apagado({ precio_sin_iva: null }),
    apagado({ archivado: true }),
    apagado({ archivado: true, precio_sin_iva: 0 }),
  ];

  it.each(casos.map((p, i) => [i, p] as const))("caso %i", (_i, p) => {
    expect(activables([p]).prender.length === 1).toBe(puedeActivar(p));
  });
});
