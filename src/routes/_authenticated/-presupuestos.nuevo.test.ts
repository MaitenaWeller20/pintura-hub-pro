// @vitest-environment jsdom

import { createElement, type ComponentType } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUCURSAL_ID = "10000000-0000-4000-8000-000000000001";
const PRODUCTO_ID = "40000000-0000-4000-8000-000000000001";

const dobles = vi.hoisted(() => ({ navigate: vi.fn(), rpc: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  useNavigate: () => dobles.navigate,
}));

vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({
    data: { isAdmin: false, sucursal: { id: SUCURSAL_ID, nombre: "Casa" } },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "buscar-prod-presupuesto") {
      return {
        data: [
          {
            id: PRODUCTO_ID,
            codigo: "P-1",
            nombre: "Producto Uno",
            precio_sin_iva: 100,
            iva_porcentaje: 21,
          },
        ],
        isFetching: false,
      };
    }
    return { data: [], isFetching: false };
  },
  useMutation: ({
    mutationFn,
    onSuccess,
  }: {
    mutationFn(): Promise<unknown>;
    onSuccess?(value: unknown): void;
  }) => ({
    isPending: false,
    mutate: () => void mutationFn().then(onSuccess),
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: dobles.rpc, from: vi.fn() },
}));

import { Route } from "./presupuestos.nuevo";

function paginaNuevaPresupuesto(): ComponentType {
  return (Route as unknown as { options: { component: ComponentType } }).options.component;
}

beforeEach(() => {
  dobles.navigate.mockReset();
  dobles.rpc.mockReset().mockResolvedValue({ data: [{ numero: "P-1" }], error: null });
});

afterEach(cleanup);

describe("ruta real de nuevo presupuesto", () => {
  it("envía la descripción personalizada de la línea al crear", async () => {
    render(createElement(paginaNuevaPresupuesto()));

    fireEvent.change(screen.getByTestId("buscar-producto-presup"), { target: { value: "P-1" } });
    fireEvent.click(await screen.findByRole("button", { name: /P-1.*Producto Uno/ }));

    const descripcion = screen.getByLabelText("Descripción de P-1") as HTMLInputElement;
    fireEvent.change(descripcion, { target: { value: "Base 10 L (Código 1234)" } });

    expect(descripcion.maxLength).toBe(160);
    expect(screen.getByText("Sólo cambia esta línea; no modifica el catálogo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(dobles.rpc).toHaveBeenCalledOnce());
    expect(dobles.rpc).toHaveBeenCalledWith(
      "crear_presupuesto",
      expect.objectContaining({
        p_items: [
          expect.objectContaining({
            producto_id: PRODUCTO_ID,
            descripcion: "Base 10 L (Código 1234)",
          }),
        ],
      }),
    );
  });
});
