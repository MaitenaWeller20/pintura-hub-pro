// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorNotaCreditoPeriodo } from "./editor-nota-credito-periodo";

const BASE_PROPS = {
  sucursalId: "00000000-0000-4000-8000-000000000001",
  clienteId: "00000000-0000-4000-8000-000000000002",
  clienteComercial: "Obra Norte",
  productos: [],
  onCrear: vi.fn(),
};

afterEach(cleanup);

describe("EditorNotaCreditoPeriodo", () => {
  it("inicia el período vacío y no permite crear sin motivo", () => {
    render(createElement(EditorNotaCreditoPeriodo, BASE_PROPS));

    expect((screen.getByLabelText("Desde") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Hasta") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));
    expect(screen.getByText("Indicá el motivo de la nota de crédito.")).not.toBeNull();
  });

  it("al cambiar a ajuste muestra concepto y oculta el selector de productos", () => {
    render(
      createElement(EditorNotaCreditoPeriodo, {
        ...BASE_PROPS,
        productos: [{ id: "p", descripcion: "Cerámica", precioSinIva: 100, ivaPorcentaje: 21 }],
      }),
    );

    fireEvent.click(screen.getByLabelText("Bonificación o ajuste"));
    expect(screen.getByLabelText("Concepto del ajuste")).not.toBeNull();
    expect(screen.queryByLabelText("Producto a devolver")).toBeNull();
  });
});
