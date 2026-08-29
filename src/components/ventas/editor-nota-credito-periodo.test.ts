// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("inicia el período vacío y no permite crear sin motivo", async () => {
    render(createElement(EditorNotaCreditoPeriodo, BASE_PROPS));

    expect((screen.getByLabelText("Desde") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Hasta") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));
    expect(screen.getByText("Indicá la fecha inicial del período.")).not.toBeNull();
    expect(screen.getByLabelText("Desde").getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Desde")));
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

  it.each(["a", "ab", "abc", "abcd"])(
    "muestra un error humano para motivo de %s caracteres",
    (motivo) => {
      render(createElement(EditorNotaCreditoPeriodo, BASE_PROPS));

      fireEvent.click(screen.getByLabelText("Bonificación o ajuste"));
      fireEvent.click(screen.getByLabelText("Acreditar saldo a favor"));
      fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-07-01" } });
      fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-07-31" } });
      fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: motivo } });
      fireEvent.change(screen.getByLabelText("Concepto del ajuste"), {
        target: { value: "Ajuste" },
      });
      fireEvent.change(screen.getByLabelText("Importe neto"), { target: { value: "100" } });
      fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));

      expect(screen.getByText("El motivo debe tener al menos 5 caracteres.")).toBeTruthy();
      expect(screen.getByLabelText("Motivo").getAttribute("aria-invalid")).toBe("true");
    },
  );

  it("ubica cada error de período y ajuste junto al control correspondiente", async () => {
    render(createElement(EditorNotaCreditoPeriodo, BASE_PROPS));

    fireEvent.click(screen.getByLabelText("Bonificación o ajuste"));
    fireEvent.click(screen.getByLabelText("Acreditar saldo a favor"));
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-07-31" } });
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Bonificación julio" } });
    fireEvent.change(screen.getByLabelText("Concepto del ajuste"), { target: { value: "Ajuste" } });
    fireEvent.change(screen.getByLabelText("Importe neto"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));

    expect(
      screen.getByText("Indicá una fecha final válida y posterior o igual a la inicial."),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Hasta")));

    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-07-31" } });
    fireEvent.change(screen.getByLabelText("Concepto del ajuste"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));
    expect(screen.getByText("Indicá el concepto del ajuste.")).toBeTruthy();
    expect(screen.getByLabelText("Concepto del ajuste").getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(screen.getByLabelText("Concepto del ajuste"), { target: { value: "Ajuste" } });
    fireEvent.change(screen.getByLabelText("Importe neto"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));
    expect(screen.getByText("Cargá un importe positivo para el ajuste.")).toBeTruthy();
    expect(screen.getByLabelText("Importe neto").getAttribute("aria-invalid")).toBe("true");
  });

  it("asocia el error de reintegros al bloque de medios", () => {
    render(createElement(EditorNotaCreditoPeriodo, BASE_PROPS));

    fireEvent.click(screen.getByLabelText("Bonificación o ajuste"));
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-07-31" } });
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Bonificación julio" } });
    fireEvent.change(screen.getByLabelText("Concepto del ajuste"), { target: { value: "Ajuste" } });
    fireEvent.change(screen.getByLabelText("Importe neto"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));

    expect(
      screen.getByText("El reintegro debe distribuir el total exacto entre sus medios de pago."),
    ).toBeTruthy();
    expect(document.getElementById("nc-periodo-reintegros")?.getAttribute("aria-invalid")).toBe(
      "true",
    );
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

  it("reintenta exactamente el intento congelado después de un error ambiguo", async () => {
    const onCrear = vi
      .fn<(input: NotaCreditoPeriodoInput) => Promise<void>>()
      .mockRejectedValueOnce(new Error("La respuesta pudo perderse"))
      .mockResolvedValueOnce(undefined);
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
    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));
    await screen.findByText("La respuesta pudo perderse");

    const intentoOriginal = onCrear.mock.calls[0]?.[0];
    expect((screen.getByLabelText("Motivo") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Editar y crear un nuevo intento" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(onCrear).toHaveBeenCalledTimes(2));
    expect(onCrear.mock.calls[1]?.[0]).toEqual(intentoOriginal);
  });

  it("descarta explícitamente el intento fallido antes de crear otro payload", async () => {
    const onCrear = vi
      .fn<(input: NotaCreditoPeriodoInput) => Promise<void>>()
      .mockRejectedValueOnce(new Error("La respuesta pudo perderse"))
      .mockResolvedValueOnce(undefined);
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
    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));
    await screen.findByText("La respuesta pudo perderse");
    const intentoAnterior = onCrear.mock.calls[0]?.[0];

    fireEvent.click(screen.getByRole("button", { name: "Editar y crear un nuevo intento" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Bonificación agosto" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));
    await waitFor(() => expect(onCrear).toHaveBeenCalledTimes(2));

    expect(onCrear.mock.calls[1]?.[0]).toMatchObject({ motivo: "Bonificación agosto" });
    expect(onCrear.mock.calls[1]?.[0].idempotency_key).not.toBe(intentoAnterior?.idempotency_key);
  });
});
