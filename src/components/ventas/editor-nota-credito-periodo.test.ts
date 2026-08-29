// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotaCreditoPeriodoInput } from "@/lib/fiscal/nota-credito-periodo";
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

  it("ofrece exactamente las alícuotas fiscales soportadas para un ajuste", () => {
    render(createElement(EditorNotaCreditoPeriodo, BASE_PROPS));

    fireEvent.click(screen.getByLabelText("Bonificación o ajuste"));
    fireEvent.click(screen.getByLabelText("IVA"));

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "0%",
      "2,5%",
      "5%",
      "10,5%",
      "21%",
      "27%",
    ]);
  });

  it("conserva una sola creación y la misma request id ante doble click", () => {
    const onCrear = vi.fn<(input: NotaCreditoPeriodoInput) => Promise<void>>(
      () => new Promise<void>(() => undefined),
    );
    render(createElement(EditorNotaCreditoPeriodo, { ...BASE_PROPS, onCrear }));

    fireEvent.click(screen.getByLabelText("Bonificación o ajuste"));
    fireEvent.click(screen.getByLabelText("Acreditar saldo a favor"));
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-07-31" } });
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Bonificación julio" } });
    fireEvent.change(screen.getByLabelText("Concepto del ajuste"), {
      target: { value: "Bonificación julio" },
    });
    fireEvent.change(screen.getByLabelText("Importe neto"), { target: { value: "100" } });

    const crear = screen.getByRole("button", { name: "Crear nota pendiente" });
    fireEvent.click(crear);
    fireEvent.click(crear);

    expect(onCrear).toHaveBeenCalledOnce();
    expect(onCrear.mock.calls[0][0].idempotency_key).toBeTruthy();
  });
});
