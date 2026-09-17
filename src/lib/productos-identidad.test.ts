import { describe, expect, it } from "vitest";
import {
  claveProductoProveedor,
  faltanteAltaProducto,
  mensajeErrorProducto,
  productoGuardadoParaProveedor,
} from "./productos-identidad";

describe("identidad de productos por proveedor", () => {
  it("distingue el mismo código cuando pertenece a proveedores distintos", () => {
    expect(claveProductoProveedor(" 105.01.38 ", "cop")).toBe("cop\u0000105.01.38");
    expect(claveProductoProveedor("105.01.38", "quimex")).toBe("quimex\u0000105.01.38");
  });

  it("elige el producto del proveedor seleccionado aunque otro use el mismo código", () => {
    const guardados = new Map([
      [claveProductoProveedor("105.01.38", "cop"), { nombre: "Marmoltex COP" }],
      [claveProductoProveedor("105.01.38", "quimex"), { nombre: "Marmoltex QUIMEX" }],
    ]);

    expect(productoGuardadoParaProveedor(guardados, "105.01.38", "quimex")).toEqual({
      nombre: "Marmoltex QUIMEX",
    });
  });

  it("exige código, nombre y proveedor al dar de alta", () => {
    expect(faltanteAltaProducto({ codigo: "", nombre: "Marmoltex", proveedorId: "cop" })).toBe(
      "Ingresá el código del producto.",
    );
    expect(faltanteAltaProducto({ codigo: "105", nombre: "", proveedorId: "cop" })).toBe(
      "Ingresá el nombre del producto.",
    );
    expect(faltanteAltaProducto({ codigo: "105", nombre: "Marmoltex", proveedorId: "" })).toBe(
      "Elegí el proveedor del producto.",
    );
    expect(
      faltanteAltaProducto({ codigo: "105", nombre: "Marmoltex", proveedorId: "quimex" }),
    ).toBeNull();
  });

  it("traduce sólo el choque de código y proveedor a un mensaje accionable", () => {
    expect(
      mensajeErrorProducto(
        {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "productos_proveedor_codigo_key"',
        },
        { codigo: "105.01.38", proveedorNombre: "QUIMEX" },
      ),
    ).toBe(
      "Ya existe un producto con el código 105.01.38 para QUIMEX. Buscalo y editá ese registro.",
    );

    expect(
      mensajeErrorProducto(
        { code: "23514", message: "precio inválido" },
        { codigo: "105.01.38", proveedorNombre: "QUIMEX" },
      ),
    ).toBe("precio inválido");
  });
});
