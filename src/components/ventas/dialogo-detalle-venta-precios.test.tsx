// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dobles = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#cuentas">{children}</a>,
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (serverFn: unknown) => serverFn,
}));

vi.mock("@/lib/fiscal.functions", () => ({
  datosFiscalesComprobante: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => {
  const item = {
    id: "f6000000-0000-0000-0000-000000000001",
    venta_id: "e6000000-0000-0000-0000-000000000001",
    producto_id: "d6000000-0000-0000-0000-000000000001",
    codigo: "P-1",
    descripcion: "Producto con descuento",
    cantidad: 1,
    precio_unitario_sin_iva: 100,
    precio_lista_sin_iva: 100,
    iva_porcentaje: 21,
    descuento_porcentaje: 10,
    subtotal_sin_iva: 90,
    iva_monto: 18.9,
    subtotal_con_iva: 108.9,
    created_at: "2026-09-04T12:00:00.000Z",
  };

  function consulta(tabla: string) {
    const resultado = () => ({
      data: tabla === "venta_items" ? [item] : [],
      error: null,
    });
    const builder: Record<string, unknown> = {};
    for (const metodo of ["select", "eq", "order"]) {
      builder[metodo] = () => builder;
    }
    builder.then = (resolve: (value: unknown) => unknown, reject: (cause: unknown) => unknown) =>
      Promise.resolve(resultado()).then(resolve, reject);
    return builder;
  }

  return {
    supabase: {
      from: (tabla: string) => consulta(tabla),
      rpc: dobles.rpc,
    },
  };
});

import { DialogoDetalleVenta, type VentaDetalle } from "./dialogo-detalle-venta";

const ventaRemito = {
  id: "e6000000-0000-0000-0000-000000000001",
  cliente_id: "c6000000-0000-0000-0000-000000000001",
  sucursal_id: "b6000000-0000-0000-0000-000000000001",
  usuario_id: "a6000000-0000-0000-0000-000000000001",
  numero_comprobante: "OHI-REM-0001",
  tipo_comprobante: "REMITO",
  fecha: "2026-09-04T12:00:00.000Z",
  created_at: "2026-09-04T12:00:00.000Z",
  condicion_venta: "CTA_CTE",
  subtotal_sin_iva: 90,
  iva_total: 18.9,
  percepciones: 0,
  total: 108.9,
  total_pagado: 0,
  estado: "ACTIVA",
  estado_pago: "PENDIENTE",
  observaciones: null,
  correccion_precios_version: 0,
  cae: null,
  cae_vencimiento: null,
  afip_estado: "NO_APLICA",
  afip_fase: null,
  afip_version: 0,
  afip_emisor_cuit: null,
  afip_punto_venta: null,
  afip_cbte_tipo: null,
  afip_numero: null,
  afip_modo: null,
  afip_validez: "NO_APLICA",
  afip_fecha_comprobante: null,
  afip_emitido_at: null,
  afip_imp_total: null,
  afip_simulado: false,
  afip_cbte_asoc_id: null,
  periodo_asoc_desde: null,
  periodo_asoc_hasta: null,
  nc_periodo_modalidad: null,
  motivo_nota_credito: null,
  nc_resolucion: null,
  nc_efectos_aplicados_at: null,
  afip_intentos: 0,
  cliente: { razon_social: "Cliente Uno", cuit_dni: "30714199664" },
  sucursal: { nombre: "O'Higgins", telefono: null },
  fiscalPresentacion: { receptor: null, comprobanteAsociado: null },
  auditoriaPeriodo: null,
} as unknown as VentaDetalle;

function renderDetalle(
  venta: VentaDetalle = ventaRemito,
  onVentaActualizada: () => Promise<void> | void = vi.fn(),
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DialogoDetalleVenta
        venta={venta}
        permitirDescarga={false}
        onClose={vi.fn()}
        onVentaActualizada={onVentaActualizada}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  dobles.rpc.mockReset().mockResolvedValue({
    data: [
      {
        venta_id: ventaRemito.id,
        subtotal_sin_iva: 190,
        iva_total: 39.9,
        percepciones: 0,
        total: 229.9,
        correccion_precios_version: 1,
      },
    ],
    error: null,
  });
});

afterEach(cleanup);

describe("precios finales y corrección de remitos grabados", () => {
  it("muestra precio final y descuento, y envía sólo precios al RPC protegido", async () => {
    const onVentaActualizada = vi.fn();
    renderDetalle(ventaRemito, onVentaActualizada);

    expect(await screen.findByText("Producto con descuento")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "P. unit. final" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Desc. %" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "IVA" })).toBeNull();
    expect(screen.getByText(/121,00/)).toBeTruthy();
    expect(screen.getByText("10%")).toBeTruthy();
    expect(screen.getByText("IVA incluido")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Corregir precios y descuentos" }));
    expect(screen.getByRole("dialog", { name: "Corregir precios del remito" })).toBeTruthy();

    const precio = screen.getByLabelText("Precio final de P-1") as HTMLInputElement;
    const descuento = screen.getByLabelText("Descuento de P-1") as HTMLInputElement;
    expect(precio.value).toBe("121");
    expect(descuento.value).toBe("10");
    fireEvent.change(precio, { target: { value: "242" } });
    fireEvent.change(descuento, { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Motivo de la corrección"), {
      target: { value: "Se acordó un precio nuevo con el cliente" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar corrección" }));

    await waitFor(() => expect(dobles.rpc).toHaveBeenCalledOnce());
    expect(dobles.rpc).toHaveBeenCalledWith("corregir_precios_remito", {
      p_venta_id: ventaRemito.id,
      p_items: [
        {
          item_id: "f6000000-0000-0000-0000-000000000001",
          precio_unitario_sin_iva: 200,
          descuento_porcentaje: 5,
        },
      ],
      p_motivo: "Se acordó un precio nuevo con el cliente",
      p_version_esperada: 0,
    });
    await waitFor(() => expect(onVentaActualizada).toHaveBeenCalledOnce());
  });

  it("no ofrece corrección de precios para una venta común", async () => {
    renderDetalle({
      ...ventaRemito,
      tipo_comprobante: "VENTA",
      condicion_venta: "CONTADO",
    } as VentaDetalle);

    expect(await screen.findByText("Producto con descuento")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Corregir precios y descuentos" })).toBeNull();
  });
});
