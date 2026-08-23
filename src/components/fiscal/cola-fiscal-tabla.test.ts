import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ColaFiscalFila } from "@/lib/fiscal/cola.functions";
import { ColaFiscalTabla } from "./cola-fiscal-tabla";

const FILA: ColaFiscalFila = {
  venta_id: "11000000-0000-4000-8000-000000000005",
  tipo_comprobante: "VENTA",
  numero_comprobante: "V-00001",
  fecha_comercial: "2026-08-20T15:00:00+00:00",
  fecha_fiscal: null,
  cliente_id: null,
  cliente_razon_social: "Comprador",
  documento_comercial: "20123456789",
  receptor_razon_social: null,
  receptor_tipo_documento: null,
  receptor_numero_documento: null,
  receptor_condicion_iva: null,
  emisor_id: null,
  emisor_razon_social: null,
  emisor_cuit: null,
  sucursal_id: null,
  sucursal_nombre: null,
  total: "121.00",
  total_pagado: "121.00",
  saldo: "0.00",
  afip_estado: "SIN_FACTURAR",
  afip_fase: null,
  afip_legacy_incompleto: false,
  claim_vencido: false,
  venta_antigua: false,
  afip_validez: null,
  afip_punto_venta: null,
  afip_cbte_tipo: null,
  afip_numero: null,
  cae: null,
  cae_vencimiento: null,
  tab: "pendientes",
};

function render(accionesHabilitadas: boolean): string {
  return renderToStaticMarkup(
    createElement(ColaFiscalTabla, {
      filas: [FILA],
      esAdmin: false,
      loading: false,
      updating: true,
      accionesHabilitadas,
      onRetry: vi.fn(),
      onAccion: vi.fn(),
    }),
  );
}

function renderVentaAntigua(esAdmin: boolean): string {
  return renderToStaticMarkup(
    createElement(ColaFiscalTabla, {
      filas: [{ ...FILA, venta_antigua: true }],
      esAdmin,
      loading: false,
      updating: false,
      accionesHabilitadas: true,
      onRetry: vi.fn(),
      onAccion: vi.fn(),
    }),
  );
}

describe("interactividad de filas fiscales", () => {
  it("mantiene visibles pero inertes los datos placeholder", () => {
    const html = render(false);
    expect(html).toContain("Venta V-00001");
    expect(html).not.toContain("Venta V-V-00001");
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Facturar/s);
  });

  it("no inmoviliza acciones durante un polling de la misma clave", () => {
    const html = render(true);
    expect(html).toContain("Actualizando");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Facturar/s);
  });

  it("no ofrece la emisión demorada a un empleado y la conserva para admin", () => {
    expect(renderVentaAntigua(false)).toMatch(
      /<button[^>]*disabled=""[^>]*>.*Requiere administrador/s,
    );
    expect(renderVentaAntigua(true)).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Facturar/s);
  });
});
