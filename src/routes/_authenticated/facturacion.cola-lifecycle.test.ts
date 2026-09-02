// @vitest-environment jsdom

import { createElement, type ComponentType, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crearHuellaConfirmacionFiscal } from "@/lib/fiscal/confirmacion";
import type { ColaFiscalFila } from "@/lib/fiscal/cola.functions";

const VENTA = "10000000-0000-4000-8000-000000000001";
const SUCURSAL = "30000000-0000-4000-8000-000000000001";
const MENSAJE_CAIDA_ARCA =
  "ARCA está caído y no pudimos verificar el CUIT. No se emitió ningún comprobante. Intentá nuevamente en otro momento.";

const dobles = vi.hoisted(() => {
  const router = {
    search: {
      tab: "pendientes",
      page: 1,
      venta: "10000000-0000-4000-8000-000000000001",
    } as Record<string, unknown>,
    listeners: new Set<() => void>(),
    navigate: vi.fn(),
  };
  router.navigate.mockImplementation(
    async (input: {
      search:
        | Record<string, unknown>
        | ((actual: Record<string, unknown>) => Record<string, unknown>);
    }) => {
      router.search =
        typeof input.search === "function" ? input.search(router.search) : input.search;
      for (const listener of router.listeners) listener();
    },
  );
  return {
    router,
    listarCola: vi.fn(),
    leerDetalleNcPeriodo: vi.fn(),
    listarFavoritos: vi.fn(),
    previsualizar: vi.fn(),
    emitir: vi.fn(),
    reconciliar: vi.fn(),
    liberar: vi.fn(),
    consultarIncidente: vi.fn(),
    leerVentaDetalle: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", async () => {
  const React = await import("react");
  return {
    createFileRoute: () => (options: Record<string, unknown>) => ({
      options,
      useSearch: () =>
        React.useSyncExternalStore(
          (listener) => {
            dobles.router.listeners.add(listener);
            return () => dobles.router.listeners.delete(listener);
          },
          () => dobles.router.search,
          () => dobles.router.search,
        ),
      useNavigate: () => dobles.router.navigate,
      useRouteContext: () => ({
        accesoFiscal: {
          facturacionV2Habilitada: true,
          isAdmin: true,
          puedeFacturar: true,
          notaCreditoPeriodoHabilitada: true,
          puedeEmitirNcPeriodo: true,
        },
      }),
    }),
    redirect: vi.fn(),
  };
});

vi.mock("@tanstack/react-start", () => ({ useServerFn: (serverFn: unknown) => serverFn }));

vi.mock("@/lib/fiscal/cola.functions", () => ({
  listarColaFiscal: dobles.listarCola,
  leerDetalleNcPeriodoFiscal: dobles.leerDetalleNcPeriodo,
  listarReceptoresFiscales: dobles.listarFavoritos,
}));

vi.mock("@/lib/fiscal.functions", () => ({
  previsualizarEmisionFiscal: dobles.previsualizar,
  emitirComprobante: dobles.emitir,
  reconciliarComprobante: dobles.reconciliar,
  liberarClaimFiscal: dobles.liberar,
  consultarIncidenteFiscal: dobles.consultarIncidente,
  detalleVentaFiscalSegura: dobles.leerVentaDetalle,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("@/components/fiscal/cola-fiscal-filtros", () => ({
  ColaFiscalFiltros: () => createElement("div", { "data-testid": "filtros-cola" }),
}));

vi.mock("@/components/ventas/dialogo-detalle-venta", () => ({
  DialogoDetalleVenta: ({ venta }: { venta: unknown }) =>
    createElement("div", { "data-testid": "detalle-comercial" }, venta ? "cargado" : "abriendo"),
}));

// Radix sólo transporta el contenido a un portal. La prueba mantiene reales
// el diálogo fiscal, sus controles, estados y callbacks.
vi.mock("@/components/ui/dialog", () => {
  const Grupo = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  const Contenido = ({
    children,
    closeDisabled: _closeDisabled,
    hideClose: _hideClose,
    onOpenAutoFocus: _onOpenAutoFocus,
    onCloseAutoFocus: _onCloseAutoFocus,
    ...props
  }: {
    children?: ReactNode;
    closeDisabled?: boolean;
    hideClose?: boolean;
    onOpenAutoFocus?: unknown;
    onCloseAutoFocus?: unknown;
  }) => createElement("div", props, children);
  return {
    Dialog: Grupo,
    DialogContent: Contenido,
    DialogDescription: Grupo,
    DialogFooter: Grupo,
    DialogHeader: Grupo,
    DialogTitle: Grupo,
  };
});

import { Route } from "./facturacion.cola";

const filaPendiente: ColaFiscalFila = {
  venta_id: VENTA,
  tipo_comprobante: "VENTA",
  numero_comprobante: "V-00001",
  fecha_comercial: "2026-08-26T15:00:00.000Z",
  fecha_fiscal: null,
  cliente_id: null,
  cliente_razon_social: "Consumidor final",
  documento_comercial: null,
  receptor_razon_social: null,
  receptor_tipo_documento: null,
  receptor_numero_documento: null,
  receptor_condicion_iva: null,
  emisor_id: null,
  emisor_razon_social: null,
  emisor_cuit: null,
  sucursal_id: SUCURSAL,
  sucursal_nombre: "Casa central",
  total: "121.00",
  total_pagado: "121.00",
  saldo: "0.00",
  afip_estado: "SIN_FACTURAR",
  afip_fase: null,
  afip_legacy_incompleto: false,
  reclamo_vencido: false,
  venta_antigua: false,
  afip_validez: null,
  afip_punto_venta: null,
  afip_cbte_tipo: null,
  afip_numero: null,
  cae: null,
  cae_vencimiento: null,
  periodo_asoc_desde: null,
  periodo_asoc_hasta: null,
  nc_periodo_modalidad: null,
  motivo_nota_credito: null,
  nc_resolucion: null,
  nc_efectos_aplicados_at: null,
  tab: "pendientes",
};

const filaMovida: ColaFiscalFila = {
  ...filaPendiente,
  afip_estado: "ERROR_CORREGIBLE",
  tab: "revisar",
};

const filaPeriodo: ColaFiscalFila = {
  ...filaPendiente,
  tipo_comprobante: "NOTA_CREDITO",
  numero_comprobante: "NC-00001",
  periodo_asoc_desde: "2026-07-01",
  periodo_asoc_hasta: "2026-07-31",
  nc_periodo_modalidad: "BONIFICACION_AJUSTE",
  motivo_nota_credito: "Bonificación comercial",
  nc_resolucion: "SALDO_FAVOR",
};

const receptor = {
  razonSocial: "Consumidor final",
  domicilio: null,
  tipoDocumento: "SIN_IDENTIFICAR",
  numeroDocumento: null,
  docTipoArca: 99,
  docNroArca: "0",
  condicionIva: "CONSUMIDOR_FINAL",
  origen: "CLIENTE_COMERCIAL",
  origenId: null,
  verificadoArcaAt: null,
} as const;

const confirmacion = {
  version: 1,
  importe: "121.00",
  emisorCuit: "30714199664",
  emisorRazonSocial: "EMISOR AUTORITATIVO S.A.",
  sucursalId: SUCURSAL,
  sucursalNombre: "Casa central",
  puntoVenta: 5,
  modo: "PRODUCCION",
  afipValidez: "PRODUCCION",
  letra: "B",
  cbteTipo: 6,
  fechaFiscal: "2026-08-26",
  pagado: "121.00",
  saldo: "0.00",
  cbteAsoc: null,
  receptor,
} as const;

const preview = {
  autoritativo: true,
  venta_id: VENTA,
  fecha_comercial: "2026-08-26T15:00:00.000Z",
  fecha_fiscal: "2026-08-26",
  total: "121.00",
  pagado: "121.00",
  saldo: "0.00",
  comprador: null,
  receptor,
  letra: "B",
  razon_letra: "Consumidor final corresponde a factura B.",
  emisor_cuit: "30714199664",
  emisor_razon_social: "EMISOR AUTORITATIVO S.A.",
  sucursal_id: SUCURSAL,
  sucursal_nombre: "Casa central",
  punto_venta: 5,
  modo: "PRODUCCION",
  afip_validez: "PRODUCCION",
  cbte_tipo: 6,
  cbte_asoc: null,
  demora_dias: 0,
  advertencia_demora: null,
  confirmacion_factura_a_permitida: true,
  confirmacion_autoritativa: confirmacion,
  huella_confirmacion: crearHuellaConfirmacionFiscal(confirmacion),
} as const;

function respuestaCola(filas: ColaFiscalFila[]) {
  return {
    filas,
    page: 1,
    pageSize: 25,
    total: filas.length,
    paginas: filas.length > 0 ? 1 : 0,
    conteos: {
      pendientes: filas.filter((fila) => fila.tab === "pendientes").length,
      revisar: filas.filter((fila) => fila.tab === "revisar").length,
      emitidas: 0,
      historial: 0,
    },
    filtrosDisponibles: { sucursales: [], emisores: [] },
  };
}

function paginaCola(): ComponentType {
  return (Route as unknown as { options: { component: ComponentType } }).options.component;
}

beforeEach(() => {
  dobles.router.search = { tab: "pendientes", page: 1, venta: VENTA };
  dobles.router.navigate.mockClear();
  let filasServidor = [filaPendiente];
  dobles.listarCola.mockReset().mockImplementation(async () => respuestaCola(filasServidor));
  dobles.listarFavoritos.mockReset().mockResolvedValue([]);
  dobles.leerDetalleNcPeriodo.mockReset().mockResolvedValue({
    neto: "100.00",
    iva: "21.00",
    total: "121.00",
    concepto: "Bonificación comercial",
    alicuotas: [{ base: "100.00", porcentaje: "21.00", iva: "21.00" }],
    reintegros: [],
  });
  dobles.previsualizar.mockReset().mockResolvedValue(preview);
  dobles.emitir.mockReset().mockImplementation(async () => {
    filasServidor = [filaMovida];
    return {
      estado: "ERROR_CORREGIBLE",
      codigo: "PADRON_ARCA_CAIDO",
      mensaje: "texto remoto que no debe mostrarse",
    };
  });
  dobles.reconciliar.mockReset();
  dobles.liberar.mockReset();
  dobles.consultarIncidente.mockReset();
});

afterEach(() => cleanup());

describe("ciclo montado del diálogo en la ruta de cola", () => {
  it("conserva el error al pasar de pendientes a revisar y navega recién al cerrar", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const PaginaCola = paginaCola();
    render(createElement(QueryClientProvider, { client: queryClient }, createElement(PaginaCola)));

    expect(await screen.findByTestId("dialogo-emision-fiscal")).toBeTruthy();

    const letraB = screen
      .getAllByRole("radio")
      .find(
        (control) =>
          control.getAttribute("name") === "letra-solicitada" &&
          control.getAttribute("value") === "B",
      );
    if (!letraB) throw new Error("No se encontró el selector real de factura B.");
    fireEvent.click(letraB);
    fireEvent.click(screen.getByRole("button", { name: "Revisar datos fiscales" }));
    fireEvent.click(await screen.findByRole("button", { name: "Emitir comprobante" }));

    expect(await screen.findByText(MENSAJE_CAIDA_ARCA)).toBeTruthy();
    expect(screen.getByTestId("dialogo-emision-fiscal")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Pendientes/i }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.queryByText("texto remoto que no debe mostrarse")).toBeNull();

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /A revisar/i }).textContent).toContain("1"),
    );
    expect(screen.getByTestId("dialogo-emision-fiscal")).toBeTruthy();
    expect(screen.getByText(MENSAJE_CAIDA_ARCA)).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Pendientes/i }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.queryByRole("button", { name: "Emitir comprobante" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByTestId("dialogo-emision-fiscal")).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /A revisar/i }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("dialogo-emision-fiscal")).toBeNull();
  });

  it("abre la NC por período desde la venta creada y muestra su detalle al aprobar", async () => {
    const filasServidor = [filaPeriodo];
    dobles.listarCola.mockImplementation(async () => respuestaCola(filasServidor));
    dobles.emitir.mockResolvedValue({
      estado: "APROBADO",
      cae: "12345678901234",
      numero: 12,
      recuperado: false,
      advertencias: [],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const PaginaCola = paginaCola();
    render(createElement(QueryClientProvider, { client: queryClient }, createElement(PaginaCola)));

    expect(await screen.findByTestId("dialogo-emision-fiscal")).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Revisar datos fiscales" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Revisar datos fiscales" }));
    expect(await screen.findByText("Neto autoritativo")).toBeTruthy();
    expect(screen.getByText("Saldo a favor planificado", { exact: false })).toBeTruthy();
    fireEvent.click(
      await screen.findByLabelText(
        "Confirmo que el período corresponde exactamente a las operaciones ajustadas.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Emitir comprobante" }));

    expect(await screen.findByTestId("detalle-comercial")).toBeTruthy();
    expect(dobles.router.navigate).toHaveBeenCalled();
  });

  it("bloquea la preview por período mientras carga el detalle autoritativo", async () => {
    dobles.listarCola.mockImplementation(async () => respuestaCola([filaPeriodo]));
    dobles.leerDetalleNcPeriodo.mockImplementation(() => new Promise(() => undefined));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const PaginaCola = paginaCola();
    render(createElement(QueryClientProvider, { client: queryClient }, createElement(PaginaCola)));

    expect(await screen.findByText("Cargando importes y liquidación autoritativos…")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Revisar datos fiscales" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("no permite continuar si falla el detalle y permite reintentarlo", async () => {
    dobles.listarCola.mockImplementation(async () => respuestaCola([filaPeriodo]));
    dobles.leerDetalleNcPeriodo
      .mockRejectedValueOnce(new Error("fallo de lectura"))
      .mockResolvedValueOnce({
        neto: "100.00",
        iva: "21.00",
        total: "121.00",
        concepto: "Bonificación comercial",
        alicuotas: [{ base: "100.00", porcentaje: "21.00", iva: "21.00" }],
        reintegros: [],
      });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const PaginaCola = paginaCola();
    render(createElement(QueryClientProvider, { client: queryClient }, createElement(PaginaCola)));

    expect(
      await screen.findByText(
        "No se pudo cargar el detalle fiscal autoritativo. No se puede continuar.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Revisar datos fiscales" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar detalle" }));
    await waitFor(() => expect(dobles.leerDetalleNcPeriodo).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Revisar datos fiscales" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });
});
