// @vitest-environment jsdom

import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogoConvertirPresupuesto } from "./dialogo-convertir-presupuesto";

const PRESUPUESTO_ID = "10000000-0000-4000-8000-000000000001";
const CLIENTE_PRESUPUESTO_ID = "20000000-0000-4000-8000-000000000001";
const CLIENTE_EFECTIVO_ID = "20000000-0000-4000-8000-000000000002";
const CAJA_ID = "30000000-0000-4000-8000-000000000001";
const scrollIntoViewOriginal = Element.prototype.scrollIntoView;

const dobles = vi.hoisted(() => ({
  preflight: vi.fn(),
  convertir: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({ useServerFn: (serverFn: unknown) => serverFn }));
vi.mock("@/lib/presupuestos.functions", () => ({
  preflightConversionPresupuesto: dobles.preflight,
}));
vi.mock("@/lib/ventas.functions", () => ({
  convertirPresupuestoEnVenta: dobles.convertir,
}));
vi.mock("@/components/cliente-picker", () => ({
  ClientePicker: ({
    value,
    onChange,
    testId,
  }: {
    value: string;
    onChange(value: string): void;
    testId?: string;
  }) => (
    <button type="button" data-testid={testId} onClick={() => onChange(CLIENTE_PRESUPUESTO_ID)}>
      {value || "Elegí…"}
    </button>
  ),
}));
vi.mock("@/components/ventas/editor-pagos", () => ({
  EditorPagos: ({
    pagos,
    disabled,
    onChange,
  }: {
    pagos: unknown[];
    disabled?: boolean;
    onChange(value: unknown[]): void;
  }) => (
    <div data-testid="editor-pagos">
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          onChange(
            pagos.length === 0
              ? [
                  {
                    id: "pago-1",
                    forma_pago: "EFECTIVO",
                    monto: 121,
                    detalle: {},
                  },
                ]
              : [
                  ...pagos,
                  {
                    id: "pago-2",
                    forma_pago: "TRANSFERENCIA",
                    monto: 50,
                    detalle: {},
                  },
                ],
          )
        }
      >
        Agregar pago completo
      </button>
      <span>{pagos.length} pagos</span>
    </div>
  ),
}));

function diferida<T>() {
  let resolver!: (value: T) => void;
  let rechazar!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolver = resolve;
    rechazar = reject;
  });
  return { promise, resolver, rechazar };
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterAll(() => {
  Element.prototype.scrollIntoView = scrollIntoViewOriginal;
});

const PREFLIGHT_ABIERTO = {
  presupuestoId: PRESUPUESTO_ID,
  sucursalId: "40000000-0000-4000-8000-000000000001",
  sucursalNombre: "General Paz",
  caja: { id: CAJA_ID, abiertaDesde: "2026-08-30T14:35:00.000Z" },
};

function renderDialogo(
  cambios: Partial<React.ComponentProps<typeof DialogoConvertirPresupuesto>> = {},
  strict = false,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const props: React.ComponentProps<typeof DialogoConvertirPresupuesto> = {
    open: true,
    presupuesto: { id: PRESUPUESTO_ID, total: 121, cliente_id: null },
    facturacionV2Habilitada: true,
    facturacionLegacyHabilitada: false,
    puedeFacturar: true,
    onOpenChange: vi.fn(),
    onConvertida: vi.fn(),
    ...cambios,
  };
  const contenido = (
    <QueryClientProvider client={queryClient}>
      <DialogoConvertirPresupuesto {...props} />
    </QueryClientProvider>
  );
  render(strict ? <StrictMode>{contenido}</StrictMode> : contenido);
  return { ...props, queryClient };
}

async function prepararPago() {
  await screen.findByText(/Caja abierta desde .*30\/08\/2026.*11:35/);
  fireEvent.click(screen.getByRole("button", { name: "Agregar pago completo" }));
}

beforeEach(() => {
  dobles.preflight.mockReset();
  dobles.convertir.mockReset();
  dobles.preflight.mockResolvedValue(PREFLIGHT_ABIERTO);
  dobles.convertir.mockResolvedValue({
    id: "50000000-0000-4000-8000-000000000001",
    numero: "GPZ-VTA-0001",
    cta_cte: false,
    clienteId: CLIENTE_EFECTIVO_ID,
  });
});

afterEach(() => cleanup());

describe("diálogo de conversión de presupuesto", () => {
  it("inicia un presupuesto anónimo como Consumidor final, sin picker ni cuenta corriente", async () => {
    renderDialogo();

    expect(
      screen
        .getByRole("radio", { name: "Consumidor final / sin cliente" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByTestId("conv-cliente")).toBeNull();
    expect(screen.queryByRole("option", { name: "Cuenta corriente" })).toBeNull();
    expect(screen.getByText("Contado")).toBeTruthy();
    await screen.findByText("Sucursal: General Paz");
  });

  it("mantiene el picker y el modo identificado cuando el presupuesto ya tiene cliente", async () => {
    renderDialogo({
      presupuesto: { id: PRESUPUESTO_ID, total: 121, cliente_id: CLIENTE_PRESUPUESTO_ID },
    });

    expect(
      screen.getByRole("radio", { name: "Cliente identificado" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByTestId("conv-cliente").textContent).toContain(CLIENTE_PRESUPUESTO_ID);
    await screen.findByText("Sucursal: General Paz");
  });

  it("muestra siempre la sucursal y bloquea ambas acciones mientras confirma caja", async () => {
    const pendiente = diferida<typeof PREFLIGHT_ABIERTO>();
    dobles.preflight.mockReturnValue(pendiente.promise);
    renderDialogo();

    expect(screen.getByText("Sucursal: Confirmando…")).toBeTruthy();
    expect(screen.getByText("Confirmando caja abierta…")).toBeTruthy();
    expect((screen.getByTestId("conv-confirmar") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("conv-y-facturar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("muestra la caja abierta y bloquea ambas acciones cuando no hay caja", async () => {
    const { caja: _caja, ...preflight } = PREFLIGHT_ABIERTO;
    dobles.preflight.mockResolvedValue({ ...preflight, caja: null });
    renderDialogo();

    expect(await screen.findByText("Sucursal: General Paz")).toBeTruthy();
    expect(screen.getByText("No hay caja abierta")).toBeTruthy();
    expect((screen.getByTestId("conv-confirmar") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("conv-y-facturar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("muestra un error seguro y bloquea ambas acciones si falla el preflight", async () => {
    dobles.preflight.mockRejectedValue(new Error("token=secreto; permiso interno"));
    renderDialogo();

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("No se pudo confirmar la sucursal y su caja");
    expect(alerta.textContent).not.toContain("secreto");
    expect((screen.getByTestId("conv-confirmar") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("conv-y-facturar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("envía null en V2 y comunica el cliente efectivo devuelto por el servidor", async () => {
    const props = renderDialogo();
    await prepararPago();

    fireEvent.click(screen.getByTestId("conv-confirmar"));

    await waitFor(() => expect(dobles.convertir).toHaveBeenCalledTimes(1));
    expect(dobles.convertir.mock.calls[0][0].data).toMatchObject({
      entrada: "V2",
      presupuesto_id: PRESUPUESTO_ID,
      cliente_id: null,
      condicion_venta: "CONTADO",
      pagos: [{ forma_pago: "EFECTIVO", monto: 121, detalle: {} }],
    });
    await waitFor(() =>
      expect(props.onConvertida).toHaveBeenCalledWith({
        ventaId: "50000000-0000-4000-8000-000000000001",
        clienteId: CLIENTE_EFECTIVO_ID,
        facturarAhora: false,
      }),
    );
  });

  it("conserva activo el callback efectivo bajo el ciclo de montaje estricto", async () => {
    const props = renderDialogo({}, true);
    await prepararPago();

    fireEvent.click(screen.getByTestId("conv-confirmar"));

    await waitFor(() => expect(props.onConvertida).toHaveBeenCalledTimes(1));
  });

  it("congela cierre y controles durante la mutación", async () => {
    const pendiente = diferida<{
      id: string;
      numero: string;
      cta_cte: boolean;
      clienteId: string;
    }>();
    dobles.convertir.mockReturnValue(pendiente.promise);
    const props = renderDialogo();
    await prepararPago();

    fireEvent.click(screen.getByTestId("conv-confirmar"));

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Cancelar" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(
      (
        screen.getByRole("radio", {
          name: "Consumidor final / sin cliente",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Agregar pago completo" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("ignora un resultado tardío después de desmontar el diálogo", async () => {
    const pendiente = diferida<{
      id: string;
      numero: string;
      cta_cte: boolean;
      clienteId: string;
    }>();
    dobles.convertir.mockReturnValue(pendiente.promise);
    const props = renderDialogo();
    await prepararPago();

    fireEvent.click(screen.getByTestId("conv-confirmar"));
    await waitFor(() => expect(dobles.convertir).toHaveBeenCalledTimes(1));
    cleanup();
    await act(async () => {
      pendiente.resolver({
        id: "50000000-0000-4000-8000-000000000001",
        numero: "GPZ-VTA-0001",
        cta_cte: false,
        clienteId: CLIENTE_EFECTIVO_ID,
      });
      await pendiente.promise;
    });

    expect(props.onConvertida).not.toHaveBeenCalled();
  });

  it("mantiene receptor, cliente, condición, pagos y cierre congelados tras un error ambiguo", async () => {
    dobles.convertir.mockRejectedValueOnce(new Error("Failed to fetch: conexión interrumpida"));
    const props = renderDialogo({
      presupuesto: { id: PRESUPUESTO_ID, total: 121, cliente_id: CLIENTE_EFECTIVO_ID },
    });
    await prepararPago();

    fireEvent.click(screen.getByTestId("conv-confirmar"));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("No se pudo confirmar si la venta se creó");
    expect(
      (screen.getByRole("radio", { name: "Consumidor final / sin cliente" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("conv-cliente").closest("fieldset") as HTMLFieldSetElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("combobox", { name: "Condición de venta" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Agregar pago completo" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Cancelar" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Cerrar" })).toBeNull();
    expect((screen.getByTestId("conv-confirmar") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("conv-y-facturar") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("reutiliza bytes y clave del intento ambiguo aunque se intenten editar cliente y pagos", async () => {
    dobles.convertir
      .mockRejectedValueOnce(new Error("Failed to fetch: conexión interrumpida"))
      .mockResolvedValueOnce({
        id: "50000000-0000-4000-8000-000000000001",
        numero: "GPZ-VTA-0001",
        cta_cte: false,
        clienteId: CLIENTE_EFECTIVO_ID,
      });
    renderDialogo({
      presupuesto: { id: PRESUPUESTO_ID, total: 121, cliente_id: CLIENTE_EFECTIVO_ID },
    });
    await prepararPago();

    const confirmar = screen.getByTestId("conv-confirmar");
    fireEvent.click(confirmar);
    fireEvent.click(confirmar);
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("No se pudo confirmar si la venta se creó");
    expect(dobles.convertir).toHaveBeenCalledTimes(1);
    const primerPayloadSerializado = JSON.stringify(dobles.convertir.mock.calls[0][0].data);
    const primeraClave = dobles.convertir.mock.calls[0][0].data.idempotency_key;

    fireEvent.click(screen.getByTestId("conv-cliente"));
    fireEvent.click(screen.getByRole("button", { name: "Agregar pago completo" }));
    expect(screen.getByText("1 pagos")).toBeTruthy();

    fireEvent.click(screen.getByTestId("conv-confirmar"));

    await waitFor(() => expect(dobles.convertir).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(dobles.convertir.mock.calls[1][0].data)).toBe(primerPayloadSerializado);
    expect(dobles.convertir.mock.calls[1][0].data.idempotency_key).toBe(primeraClave);
  });

  it("descarta un primer fallo determinístico y crea otro intento V2 con pagos, clave y acción nuevos", async () => {
    dobles.convertir
      .mockRejectedValueOnce(new Error("validación determinística"))
      .mockResolvedValueOnce({
        id: "50000000-0000-4000-8000-000000000001",
        numero: "GPZ-VTA-0001",
        cta_cte: false,
        clienteId: CLIENTE_EFECTIVO_ID,
      });
    const props = renderDialogo({
      presupuesto: { id: PRESUPUESTO_ID, total: 121, cliente_id: CLIENTE_EFECTIVO_ID },
    });
    await prepararPago();

    fireEvent.click(screen.getByTestId("conv-confirmar"));
    await screen.findByRole("alert");
    const primeraEntrada = dobles.convertir.mock.calls[0][0].data;

    fireEvent.click(screen.getByRole("button", { name: "Agregar pago completo" }));
    expect(screen.getByText("2 pagos")).toBeTruthy();
    fireEvent.click(screen.getByTestId("conv-y-facturar"));

    await waitFor(() => expect(dobles.convertir).toHaveBeenCalledTimes(2));
    const segundaEntrada = dobles.convertir.mock.calls[1][0].data;
    expect(segundaEntrada.idempotency_key).not.toBe(primeraEntrada.idempotency_key);
    expect(segundaEntrada.pagos).toEqual([
      { forma_pago: "EFECTIVO", monto: 121, detalle: {} },
      { forma_pago: "TRANSFERENCIA", monto: 50, detalle: {} },
    ]);
    expect(JSON.stringify(segundaEntrada)).not.toBe(JSON.stringify(primeraEntrada));
    await waitFor(() =>
      expect(props.onConvertida).toHaveBeenCalledWith({
        ventaId: "50000000-0000-4000-8000-000000000001",
        clienteId: CLIENTE_EFECTIVO_ID,
        facturarAhora: true,
      }),
    );
  });

  it("descarta un fallo determinístico legacy y usa comprobante y forma de pago corregidos", async () => {
    dobles.convertir
      .mockRejectedValueOnce(new Error("validación determinística"))
      .mockResolvedValueOnce({
        id: "50000000-0000-4000-8000-000000000001",
        numero: "GPZ-VTA-0001",
        cta_cte: false,
        clienteId: CLIENTE_EFECTIVO_ID,
      });
    renderDialogo({
      presupuesto: { id: PRESUPUESTO_ID, total: 121, cliente_id: CLIENTE_EFECTIVO_ID },
      facturacionV2Habilitada: false,
      facturacionLegacyHabilitada: true,
      puedeFacturar: false,
    });
    await screen.findByText(/Caja abierta desde .*30\/08\/2026.*11:35/);

    fireEvent.click(screen.getByTestId("conv-confirmar"));
    await screen.findByRole("alert");
    const primeraEntrada = dobles.convertir.mock.calls[0][0].data;

    fireEvent.click(screen.getAllByRole("combobox")[0]);
    fireEvent.click(await screen.findByRole("option", { name: "Factura A" }));
    fireEvent.click(screen.getByTestId("conv-forma-pago"));
    fireEvent.click(await screen.findByRole("option", { name: "Transferencia" }));
    fireEvent.click(screen.getByTestId("conv-confirmar"));

    await waitFor(() => expect(dobles.convertir).toHaveBeenCalledTimes(2));
    const segundaEntrada = dobles.convertir.mock.calls[1][0].data;
    expect(segundaEntrada.idempotency_key).not.toBe(primeraEntrada.idempotency_key);
    expect(segundaEntrada).toMatchObject({
      entrada: "LEGACY",
      tipo_comprobante: "FACTURA_A",
      pagos: [{ forma_pago: "TRANSFERENCIA", monto: 121, detalle: {} }],
    });
  });

  it("desbloquea tras un replay determinístico y el siguiente intento rota payload, clave y acción", async () => {
    dobles.convertir
      .mockRejectedValueOnce(new Error("Failed to fetch: conexión interrumpida"))
      .mockRejectedValueOnce(new Error("validación determinística"))
      .mockResolvedValueOnce({
        id: "50000000-0000-4000-8000-000000000001",
        numero: "GPZ-VTA-0001",
        cta_cte: false,
        clienteId: CLIENTE_EFECTIVO_ID,
      });
    const props = renderDialogo({
      presupuesto: { id: PRESUPUESTO_ID, total: 121, cliente_id: CLIENTE_EFECTIVO_ID },
    });
    await prepararPago();

    fireEvent.click(screen.getByTestId("conv-confirmar"));
    await screen.findByRole("alert");
    const primeraEntradaSerializada = JSON.stringify(dobles.convertir.mock.calls[0][0].data);
    const primeraClave = dobles.convertir.mock.calls[0][0].data.idempotency_key;

    fireEvent.click(screen.getByTestId("conv-confirmar"));
    await waitFor(() => expect(dobles.convertir).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(dobles.convertir.mock.calls[1][0].data)).toBe(primeraEntradaSerializada);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("No se pudo convertir"),
    );
    expect(
      (screen.getByRole("radio", { name: "Consumidor final / sin cliente" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect((screen.getByRole("button", { name: "Cancelar" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Agregar pago completo" }));
    expect(screen.getByText("2 pagos")).toBeTruthy();
    fireEvent.click(screen.getByTestId("conv-y-facturar"));

    await waitFor(() => expect(dobles.convertir).toHaveBeenCalledTimes(3));
    const terceraEntrada = dobles.convertir.mock.calls[2][0].data;
    expect(terceraEntrada.idempotency_key).not.toBe(primeraClave);
    expect(terceraEntrada.pagos).toHaveLength(2);
    await waitFor(() =>
      expect(props.onConvertida).toHaveBeenCalledWith({
        ventaId: "50000000-0000-4000-8000-000000000001",
        clienteId: CLIENTE_EFECTIVO_ID,
        facturarAhora: true,
      }),
    );
  });

  it("mantiene exacto y congelado cada replay ambiguo aunque el preflight pierda la caja", async () => {
    dobles.convertir
      .mockRejectedValueOnce(new Error("Failed to fetch: conexión interrumpida"))
      .mockRejectedValueOnce(new Error("timeout al confirmar"))
      .mockResolvedValueOnce({
        id: "50000000-0000-4000-8000-000000000001",
        numero: "GPZ-VTA-0001",
        cta_cte: false,
        clienteId: CLIENTE_EFECTIVO_ID,
      });
    const props = renderDialogo();
    await prepararPago();

    fireEvent.click(screen.getByTestId("conv-confirmar"));
    await screen.findByRole("alert");
    const entradaOriginal = JSON.stringify(dobles.convertir.mock.calls[0][0].data);

    act(() => {
      props.queryClient.setQueryData(["preflight-conversion-presupuesto", PRESUPUESTO_ID], {
        ...PREFLIGHT_ABIERTO,
        caja: null,
      });
    });
    await screen.findByText("No hay caja abierta");
    expect((screen.getByTestId("conv-confirmar") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("conv-confirmar"));
    await waitFor(() => expect(dobles.convertir).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(dobles.convertir.mock.calls[1][0].data)).toBe(entradaOriginal);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("No se pudo confirmar"),
    );
    expect(
      (screen.getByRole("button", { name: "Agregar pago completo" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Cerrar" })).toBeNull();

    fireEvent.click(screen.getByTestId("conv-confirmar"));
    await waitFor(() => expect(dobles.convertir).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(dobles.convertir.mock.calls[2][0].data)).toBe(entradaOriginal);
  });

  it("presenta el error RPC como guía humana segura con role alert", async () => {
    dobles.convertir.mockRejectedValue(
      new Error('duplicate key value violates constraint "ventas_idempotency_key_key"'),
    );
    renderDialogo();
    await prepararPago();

    fireEvent.click(screen.getByTestId("conv-confirmar"));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("No se pudo convertir el presupuesto");
    expect(alerta.textContent).not.toContain("constraint");
  });
});
