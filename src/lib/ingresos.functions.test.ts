import { describe, expect, it } from "vitest";
import {
  crearServicioBusquedaProductosIngreso,
  prepararBusquedaProductosIngreso,
  type ArgsRpcBusquedaProductosIngreso,
  type ProductoBusquedaIngreso,
} from "./ingresos.functions";

const PROVEEDOR_QM = "81000000-0000-4000-8000-000000000001";

describe("búsqueda de productos para un ingreso", () => {
  it("no busca hasta que haya un proveedor y al escribir manda ese proveedor", () => {
    expect(prepararBusquedaProductosIngreso("", "blanco satinado")).toBeNull();
    expect(prepararBusquedaProductosIngreso(PROVEEDOR_QM, " b ")).toBeNull();
    expect(prepararBusquedaProductosIngreso(PROVEEDOR_QM, "  blanco satinado  ")).toEqual({
      proveedor_id: PROVEEDOR_QM,
      texto: "blanco satinado",
      codigo: "blanco satinado",
    });
  });

  it("filtra en PostgreSQL antes del límite y permite hasta 500 coincidencias", async () => {
    const recibidos: ArgsRpcBusquedaProductosIngreso[] = [];
    const filas: ProductoBusquedaIngreso[] = [
      {
        id: "82000000-0000-4000-8000-000000000001",
        codigo: "QM-001",
        nombre: "BLANCO SATINADO",
        activo: true,
        iva_porcentaje: 21,
        score: 1,
      },
    ];
    const servicio = crearServicioBusquedaProductosIngreso({
      async buscar(args) {
        recibidos.push(args);
        return filas;
      },
    });

    await expect(
      servicio.buscar({
        proveedor_id: PROVEEDOR_QM,
        texto: "blanco satinado",
        codigo: "blanco satinado",
      }),
    ).resolves.toEqual(filas);
    expect(recibidos).toEqual([
      {
        p_texto: "blanco satinado",
        p_codigo: "blanco satinado",
        p_limite: 500,
        p_proveedor_id: PROVEEDOR_QM,
      },
    ]);
  });

  it("rechaza una llamada sin proveedor para no mezclar catálogos", async () => {
    const servicio = crearServicioBusquedaProductosIngreso({ buscar: async () => [] });
    await expect(
      servicio.buscar({ proveedor_id: "", texto: "blanco", codigo: "blanco" }),
    ).rejects.toThrow();
  });
});
