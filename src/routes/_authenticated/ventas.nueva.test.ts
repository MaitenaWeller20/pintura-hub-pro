// @vitest-environment jsdom

import { createElement, type ComponentType } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotaCreditoPeriodoInput } from "@/lib/fiscal/nota-credito-periodo";

const SUCURSAL_ID = "10000000-0000-4000-8000-000000000001";
const CLIENTE_ID = "20000000-0000-4000-8000-000000000001";
const FACTURA_ID = "30000000-0000-4000-8000-000000000001";
const PRODUCTO_ID = "40000000-0000-4000-8000-000000000001";

const dobles = vi.hoisted(() => ({
  usuario: {
    isAdmin: true,
    sucursal: {
      id: "10000000-0000-4000-8000-000000000001",
      nombre: "Casa central",
    },
    facturacionV2Habilitada: true,
    facturacionLegacyHabilitada: false,
    puedeFacturar: true,
    notaCreditoPeriodoHabilitada: true,
    puedeEmitirNcPeriodo: true,
    puedeVenderSinStock: false,
  },
  navigate: vi.fn(),
  crearVenta: vi.fn(),
  crearPeriodo: vi.fn(),
  previsualizar: vi.fn(),
  emitir: vi.fn(),
  listarFavoritos: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  useNavigate: () => dobles.navigate,
}));

vi.mock("@tanstack/react-start", () => ({ useServerFn: (serverFn: unknown) => serverFn }));

vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({ data: dobles.usuario }),
}));

vi.mock("@/lib/ventas.functions", () => ({ crearVenta: dobles.crearVenta }));

vi.mock("@/lib/fiscal.functions", () => ({
  crearNotaCreditoPeriodoFiscal: dobles.crearPeriodo,
  previsualizarEmisionFiscal: dobles.previsualizar,
  emitirComprobantePostBorrador: dobles.emitir,
}));

vi.mock("@/lib/fiscal/cola.functions", () => ({
  listarReceptoresFiscales: dobles.listarFavoritos,
}));

vi.mock("@tanstack/react-query", async () => {
  const React = await import("react");
  return {
    useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      const clave = queryKey[0];
      if (clave === "condicion-emisor") return { data: "RESPONSABLE_INSCRIPTO" };
      if (clave === "sucs") {
        return { data: [{ id: SUCURSAL_ID, nombre: "Casa central", numero: 1 }] };
      }
      if (clave === "clientes-search") {
        return {
          data: [
            {
              id: CLIENTE_ID,
              razon_social: "Cliente Uno",
              cuit_dni: "30714199664",
              tipo: "RESPONSABLE_INSCRIPTO",
              condicion_cta_cte: false,
            },
          ],
        };
      }
      if (clave === "prods-catalogo") {
        return {
          data: [
            {
              id: PRODUCTO_ID,
              codigo: "P-1",
              nombre: "Producto Uno",
              precio_sin_iva: 100,
              iva_porcentaje: 21,
              stock_sucursal: [{ sucursal_id: SUCURSAL_ID, cantidad: 10 }],
            },
          ],
        };
      }
      if (clave === "settings-stock-negativo") return { data: false };
      if (clave === "facturas-cliente") {
        return {
          data: [
            {
              id: FACTURA_ID,
              numero_comprobante: "V-00001",
              fecha: "2026-07-15",
              subtotal_sin_iva: 100,
              iva_total: 21,
              percepciones: 0,
              total: 121,
              total_pagado: 121,
              condicion_venta: "CONTADO",
            },
          ],
        };
      }
      return { data: [] };
    },
    useMutation: ({
      mutationFn,
      onSuccess,
      onError,
    }: {
      mutationFn(value: unknown): Promise<unknown>;
      onSuccess?(value: unknown): void;
      onError?(cause: unknown): void;
    }) => {
      const [estado, setEstado] = React.useState({ isPending: false, variables: null as unknown });
      return {
        ...estado,
        mutate(value: unknown) {
          setEstado({ isPending: true, variables: value });
          void mutationFn(value)
            .then(onSuccess, onError)
            .finally(() => {
              setEstado({ isPending: false, variables: null });
            });
        },
      };
    },
  };
});

vi.mock("@/integrations/supabase/client", () => {
  function consulta(tabla: string) {
    const resultado = () => {
      if (tabla === "venta_items") {
        return {
          data: [
            {
              producto_id: PRODUCTO_ID,
              codigo: "P-1",
              descripcion: "Producto Uno",
              cantidad: 1,
              precio_unitario_sin_iva: 100,
              iva_porcentaje: 21,
              descuento_porcentaje: 0,
            },
          ],
          error: null,
        };
      }
      if (tabla === "venta_pagos") {
        return {
          data: [{ id: "pago-1", forma_pago: "EFECTIVO", monto: 121, detalle: {} }],
          error: null,
        };
      }
      return { data: [], error: null, count: 0 };
    };
    const builder: Record<string, unknown> = {};
    for (const metodo of [
      "select",
      "eq",
      "neq",
      "not",
      "in",
      "or",
      "order",
      "limit",
      "range",
      "maybeSingle",
    ]) {
      builder[metodo] = () => builder;
    }
    builder.then = (resolve: (value: unknown) => unknown, reject: (cause: unknown) => unknown) =>
      Promise.resolve(resultado()).then(resolve, reject);
    return builder;
  }
  return {
    supabase: {
      from: (tabla: string) => consulta(tabla),
      rpc: vi.fn(async () => ({ data: "RESPONSABLE_INSCRIPTO", error: null })),
    },
  };
});

import { Route } from "./ventas.nueva";

const scrollIntoViewOriginal = Element.prototype.scrollIntoView;

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterAll(() => {
  Element.prototype.scrollIntoView = scrollIntoViewOriginal;
});

function paginaNuevaVenta(): ComponentType {
  return (Route as unknown as { options: { component: ComponentType } }).options.component;
}

async function abrirSelect(label: string | RegExp, opcion: string | RegExp) {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.click(await screen.findByRole("option", { name: opcion }));
}

async function elegirCliente() {
  fireEvent.click(screen.getByRole("button", { name: "Buscar cliente…" }));
  fireEvent.click(await screen.findByRole("button", { name: /Cliente Uno/ }));
}

async function elegirNotaCredito() {
  await abrirSelect("Tipo comprobante *", "Nota de Crédito");
}

async function completarAjustePeriodo() {
  fireEvent.click(screen.getByLabelText("Sin factura puntual — asociar por período"));
  fireEvent.click(screen.getByLabelText("Bonificación o ajuste"));
  fireEvent.click(screen.getByLabelText("Acreditar saldo a favor"));
  fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-07-01" } });
  fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-07-31" } });
  fireEvent.change(screen.getByLabelText("Motivo"), {
    target: { value: "Bonificación comercial" },
  });
  fireEvent.change(screen.getByLabelText("Concepto del ajuste"), {
    target: { value: "Bonificación comercial" },
  });
  fireEvent.change(screen.getByLabelText("Importe neto"), { target: { value: "100" } });
}

function renderRuta() {
  const Pagina = paginaNuevaVenta();
  return render(createElement(Pagina));
}

beforeEach(() => {
  Object.assign(dobles.usuario, {
    facturacionV2Habilitada: true,
    notaCreditoPeriodoHabilitada: true,
    puedeEmitirNcPeriodo: true,
  });
  dobles.navigate.mockReset();
  dobles.crearVenta.mockReset().mockImplementation(() => new Promise(() => undefined));
  dobles.crearPeriodo.mockReset().mockImplementation(() => new Promise(() => undefined));
  dobles.previsualizar.mockReset();
  dobles.emitir.mockReset();
  dobles.listarFavoritos.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

describe("ruta real de Nueva venta para NC por período", () => {
  it.each([
    { flag: false, capacidad: false, visible: false },
    { flag: false, capacidad: true, visible: false },
    { flag: true, capacidad: false, visible: false },
    { flag: true, capacidad: true, visible: true },
  ])(
    "expone la opción sólo con flag=$flag y capacidad=$capacidad",
    async ({ flag, capacidad, visible }) => {
      dobles.usuario.notaCreditoPeriodoHabilitada = flag;
      dobles.usuario.puedeEmitirNcPeriodo = capacidad;
      renderRuta();

      await elegirNotaCredito();

      expect(screen.queryByLabelText("Sin factura puntual — asociar por período") !== null).toBe(
        visible,
      );
      expect(screen.getByLabelText(/Venta fiscal que revierte/)).toBeTruthy();
    },
  );

  it("mantiene la reversa vinculada heredada separada del editor por período", async () => {
    renderRuta();
    await elegirNotaCredito();
    await elegirCliente();
    await abrirSelect(/Venta fiscal que revierte/, /V-00001/);

    expect(await screen.findByText(/La nota es total: hereda receptor/)).toBeTruthy();
    expect(screen.queryByText("Asociación fiscal por período")).toBeNull();

    fireEvent.click(screen.getByLabelText("Sin factura puntual — asociar por período"));
    expect(screen.getByText("Asociación fiscal por período")).toBeTruthy();
    expect(screen.queryByLabelText(/Venta fiscal que revierte/)).toBeNull();
  });

  it("usa sólo crearVenta para una reversa vinculada", async () => {
    renderRuta();
    await elegirNotaCredito();
    await elegirCliente();
    await abrirSelect(/Venta fiscal que revierte/, /V-00001/);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Guardar" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(dobles.crearVenta).toHaveBeenCalledOnce());
    expect(dobles.crearPeriodo).not.toHaveBeenCalled();
  });

  it("usa sólo crearNotaCreditoPeriodoFiscal para una NC por período", async () => {
    renderRuta();
    await elegirNotaCredito();
    await elegirCliente();
    await completarAjustePeriodo();

    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));

    await waitFor(() => expect(dobles.crearPeriodo).toHaveBeenCalledOnce());
    expect(dobles.crearVenta).not.toHaveBeenCalled();
  });

  it("bloquea la ruta y sus writers externos durante ENVIANDO", async () => {
    renderRuta();
    await elegirNotaCredito();
    await elegirCliente();
    await completarAjustePeriodo();
    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));

    await waitFor(() => expect(dobles.crearPeriodo).toHaveBeenCalledOnce());
    expect((screen.getByRole("button", { name: /Volver/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText("Tipo comprobante *") as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Cliente Uno" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getAllByRole("combobox")[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Volver/ }));
    expect(dobles.navigate).not.toHaveBeenCalled();
    expect(dobles.crearVenta).not.toHaveBeenCalled();
  });

  it("mantiene AMBIGUO bloqueado hasta descartar y crea el nuevo intento con otra key", async () => {
    dobles.crearPeriodo
      .mockRejectedValueOnce(new Error("La respuesta pudo perderse"))
      .mockImplementationOnce(() => new Promise(() => undefined));
    renderRuta();
    await elegirNotaCredito();
    await elegirCliente();
    await completarAjustePeriodo();
    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));
    await screen.findByText("La respuesta pudo perderse");

    expect((screen.getByRole("button", { name: /Volver/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText("Tipo comprobante *") as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Cliente Uno" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getAllByRole("combobox")[0] as HTMLButtonElement).disabled).toBe(true);
    expect(dobles.crearVenta).not.toHaveBeenCalled();

    const primero = dobles.crearPeriodo.mock.calls[0]?.[0] as {
      data: NotaCreditoPeriodoInput;
    };
    fireEvent.click(screen.getByRole("button", { name: "Editar y crear un nuevo intento" }));
    expect((screen.getByRole("button", { name: /Volver/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByLabelText("Tipo comprobante *") as HTMLButtonElement).disabled).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Cliente Uno" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect((screen.getAllByRole("combobox")[0] as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Motivo"), {
      target: { value: "Bonificación comercial nueva" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear nota pendiente" }));
    await waitFor(() => expect(dobles.crearPeriodo).toHaveBeenCalledTimes(2));
    const segundo = dobles.crearPeriodo.mock.calls[1]?.[0] as {
      data: NotaCreditoPeriodoInput;
    };
    expect(segundo.data.idempotency_key).not.toBe(primero.data.idempotency_key);
    expect(dobles.crearVenta).not.toHaveBeenCalled();
  });
});
