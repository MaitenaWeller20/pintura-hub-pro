import { describe, it, expect } from "vitest";
import {
  paginasDuplicadas,
  quitarPaginasDuplicadas,
  documentoInconsistente,
  riesgoEnvaseCantidad,
  normalizarTexto,
  validarArchivo,
  type LineaExtraida,
} from "./ingresos-ia";

const linea = (over: Partial<LineaExtraida>): LineaExtraida => ({
  linea: 1,
  pagina: 1,
  codigo_proveedor: "X",
  descripcion: "d",
  cantidad: 1,
  cantidad_raw: "1.00",
  descripcion_raw: "d",
  advertencia: null,
  ...over,
});

describe("paginasDuplicadas", () => {
  it("detecta una página repetida exacta (el caso real del PDF de Quimexur)", () => {
    const items = [
      linea({
        linea: 1,
        pagina: 1,
        codigo_proveedor: "A",
        descripcion_raw: "Prod A",
        cantidad_raw: "1.00",
      }),
      linea({
        linea: 2,
        pagina: 2,
        codigo_proveedor: "A",
        descripcion_raw: "Prod A",
        cantidad_raw: "1.00",
      }),
    ];
    expect([...paginasDuplicadas(items)]).toEqual([2]);
  });

  it("NO deduplica dos líneas iguales en la MISMA página (pueden ser legítimas)", () => {
    const items = [
      linea({
        linea: 1,
        pagina: 1,
        codigo_proveedor: "A",
        descripcion_raw: "Prod A",
        cantidad_raw: "1.00",
      }),
      linea({
        linea: 2,
        pagina: 1,
        codigo_proveedor: "A",
        descripcion_raw: "Prod A",
        cantidad_raw: "1.00",
      }),
    ];
    expect(paginasDuplicadas(items).size).toBe(0);
  });

  it("no marca páginas con distinto contenido", () => {
    const items = [
      linea({ linea: 1, pagina: 1, descripcion_raw: "Prod A", cantidad_raw: "1.00" }),
      linea({ linea: 2, pagina: 2, descripcion_raw: "Prod B", cantidad_raw: "3.00" }),
    ];
    expect(paginasDuplicadas(items).size).toBe(0);
  });

  it("quitarPaginasDuplicadas conserva la primera aparición", () => {
    const items = [
      linea({ linea: 1, pagina: 1, descripcion_raw: "Prod A", cantidad_raw: "1.00" }),
      linea({ linea: 2, pagina: 2, descripcion_raw: "Prod A", cantidad_raw: "1.00" }),
    ];
    const { items: out, paginasQuitadas } = quitarPaginasDuplicadas(items);
    expect(out).toHaveLength(1);
    expect(out[0].pagina).toBe(1);
    expect(paginasQuitadas).toEqual([2]);
  });
});

describe("documentoInconsistente", () => {
  it("bloquea si hay dos números de remito distintos", () => {
    const err = documentoInconsistente({
      numeros_remito_detectados: ["00054-00023918", "00054-00023934"],
      fechas_detectadas: [],
    });
    expect(err).toMatch(/números de remito distintos/);
  });

  it("bloquea si hay dos fechas distintas", () => {
    const err = documentoInconsistente({
      numeros_remito_detectados: ["A"],
      fechas_detectadas: ["2026-07-21", "2026-07-22"],
    });
    expect(err).toMatch(/fechas de remito distintas/);
  });

  it("acepta un documento consistente", () => {
    expect(
      documentoInconsistente({
        numeros_remito_detectados: ["00054-00023918", "00054 00023918"],
        fechas_detectadas: ["2026-07-21"],
      }),
    ).toBeNull();
  });
});

describe("riesgoEnvaseCantidad", () => {
  it("marca cuando la descripción tiene un número pegado a una unidad", () => {
    expect(riesgoEnvaesGuard("BASE TINT. ACRIL. EXT. TINTE 10 LT.")).toBe(true);
    expect(riesgoEnvaesGuard("Talento Latex Int-Ext Lavable 4L")).toBe(true);
    expect(riesgoEnvaesGuard("Aerosol AA 200 cc Negro Mate")).toBe(true);
  });

  it("no marca una descripción sin unidades", () => {
    expect(riesgoEnvaesGuard("Estopa GARIN Paquete")).toBe(false);
  });

  it("marca si el modelo ya dejó una advertencia", () => {
    expect(riesgoEnvaseCantidad({ descripcion_raw: "sin unidades", advertencia: "duda" })).toBe(
      true,
    );
  });
});

function riesgoEnvaesGuard(descripcion_raw: string): boolean {
  return riesgoEnvaseCantidad({ descripcion_raw, advertencia: null });
}

describe("normalizarTexto", () => {
  it("neutraliza formato pero mantiene los dígitos", () => {
    expect(normalizarTexto("00054-00023918")).toBe("0005400023918");
    expect(normalizarTexto("  00054 / 00023918 ")).toBe("0005400023918");
    expect(normalizarTexto("Ñoño Áéíóú")).toBe("NONOAEIOU");
  });
});

describe("validarArchivo", () => {
  it("acepta PDF e imágenes bajo el tope", () => {
    expect(validarArchivo("application/pdf", 1000)).toBeNull();
    expect(validarArchivo("image/jpeg", 1000)).toBeNull();
  });
  it("rechaza tipos no soportados", () => {
    expect(validarArchivo("text/plain", 1000)).toMatch(/no soportado/);
  });
  it("rechaza archivos > 10 MB", () => {
    expect(validarArchivo("application/pdf", 11 * 1024 * 1024)).toMatch(/máximo es 10 MB/);
  });
});
