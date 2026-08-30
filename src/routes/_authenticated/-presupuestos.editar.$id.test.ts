// @vitest-environment jsdom

import { createElement, type ComponentType } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PRESUPUESTO_ID = "10000000-0000-4000-8000-000000000001";
const PRODUCTO_ID = "20000000-0000-4000-8000-000000000001";
const DESCRIPCION = `Descripción histórica ${"😀".repeat(170)}`;

const dobles = vi.hoisted(() => ({
  navigate: vi.fn(),
  rpc: vi.fn(),
  editarPresupuesto: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ id: PRESUPUESTO_ID }),
  }),
  useNavigate: () => dobles.navigate,
  useParams: () => ({ id: PRESUPUESTO_ID }),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (serverFn: unknown) => serverFn,
}));
vi.mock("@/lib/presupuestos.functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/presupuestos.functions")>()),
  editarPresupuesto: dobles.editarPresupuesto,
}));

vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({
    data: {
      isAdmin: true,
      sucursal: { id: "sucursal-1", nombre: "Casa" },
      facturacionV2Habilitada: true,
      facturacionLegacyHabilitada: false,
      puedeFacturar: true,
    },
  }),
}));

const presupuesto = {
  id: PRESUPUESTO_ID,
  numero: "P-00001",
  estado: "ABIERTO",
  cliente_id: null,
  nombre_cliente: null,
  validez_hasta: null,
  observaciones: null,
  sucursal_id: "sucursal-1",
  sucursal: { nombre: "Casa" },
  total: 121,
  fecha: "2026-08-30",
  items: [
    {
      id: "item-1",
      producto_id: PRODUCTO_ID,
      codigo: "P-1",
      descripcion: DESCRIPCION,
      precio_lista_sin_iva: 100,
      precio_sin_iva: 100,
      iva_porcentaje: 21,
      cantidad: 1,
      descuento_porcentaje: 0,
      subtotal_con_iva: 121,
    },
  ],
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "presupuesto-editar") {
      return {
        data: {
          p: presupuesto,
          hoy: new Map([[PRODUCTO_ID, { precio_sin_iva: 125, iva_porcentaje: 21 }]]),
        },
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "presupuesto") return { data: presupuesto };
    if (queryKey[0] === "presupuesto-items") return { data: presupuesto.items };
    return { data: [], isLoading: false, error: null };
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
  useQueryClient: () => ({ invalidateQueries: dobles.invalidateQueries }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: dobles.rpc, from: vi.fn() },
}));

import { Route as RutaDetalle } from "./presupuestos.$id";
import { Route as RutaEditar } from "./presupuestos.editar.$id";

function componente(route: unknown): ComponentType {
  return (route as { options: { component: ComponentType } }).options.component;
}

beforeEach(() => {
  dobles.navigate.mockReset();
  dobles.invalidateQueries.mockReset();
  dobles.rpc.mockReset().mockResolvedValue({ data: [{ numero: "P-00001" }], error: null });
  dobles.editarPresupuesto.mockReset().mockResolvedValue({
    ok: true,
    valor: { presupuestoId: PRESUPUESTO_ID, numero: "P-00001", total: 242 },
  });
});

afterEach(cleanup);

describe("rutas reales de edición y detalle de presupuesto", () => {
  it("carga la descripción congelada y la preserva al cambiar cantidad o repreciar", async () => {
    render(createElement(componente(RutaEditar)));

    const descripcion = (await screen.findByLabelText("Descripción de P-1")) as HTMLInputElement;
    expect(descripcion.value).toBe(DESCRIPCION);
    expect(descripcion.hasAttribute("maxlength")).toBe(false);
    expect(descripcion.getAttribute("aria-invalid")).not.toBe("true");

    const fila = screen.getByTestId("fila-presupuesto");
    const [, cantidad] = within(fila).getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(cantidad, { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("repreciar"));

    expect((screen.getByLabelText("Descripción de P-1") as HTMLInputElement).value).toBe(
      DESCRIPCION,
    );
    fireEvent.click(screen.getByTestId("guardar-edicion"));

    await waitFor(() => expect(dobles.editarPresupuesto).toHaveBeenCalledOnce());
    expect(dobles.editarPresupuesto).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          p_items: [expect.objectContaining({ cantidad: 2 })],
          p_repreciar: true,
        }),
      }),
    );
    expect(dobles.editarPresupuesto.mock.calls[0]?.[0].data.p_items[0]).not.toHaveProperty(
      "descripcion",
    );
    expect(dobles.rpc).not.toHaveBeenCalled();
  });

  it("envía una edición personalizada y no el snapshot base", async () => {
    render(createElement(componente(RutaEditar)));
    const descripcion = (await screen.findByLabelText("Descripción de P-1")) as HTMLInputElement;
    fireEvent.change(descripcion, { target: { value: "  Base nueva  10 L " } });
    fireEvent.click(screen.getByTestId("guardar-edicion"));

    await waitFor(() => expect(dobles.editarPresupuesto).toHaveBeenCalledOnce());
    expect(dobles.editarPresupuesto.mock.calls[0]?.[0].data.p_items[0]).toMatchObject({
      descripcion: "Base nueva 10 L",
    });
  });

  it("muestra la descripción congelada en el detalle", () => {
    render(createElement(componente(RutaDetalle)));

    expect(screen.getByRole("columnheader", { name: "Descripción" })).toBeTruthy();
    expect(screen.getByText(DESCRIPCION)).toBeTruthy();
  });
});
