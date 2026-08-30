import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AuditoriaNotaCreditoPeriodo,
  type DatosAuditoriaNotaCreditoPeriodo,
  type VentaDetalle,
} from "./dialogo-detalle-venta";
import { cargarAuditoriaNotaCreditoPeriodo } from "./dialogo-detalle-venta-auditoria";

const ventaBase = {
  id: "71000000-0000-4000-8000-000000000001",
  numero_comprobante: "OHI-NCIV-0007",
  tipo_comprobante: "NOTA_CREDITO",
  fecha: "2026-08-20T13:00:00.000Z",
  created_at: "2026-08-20T13:00:01.000Z",
  usuario_id: "71000000-0000-4000-8000-000000000099",
  cliente_id: "71000000-0000-4000-8000-000000000002",
  sucursal_id: "71000000-0000-4000-8000-000000000003",
  condicion_venta: "CONTADO",
  subtotal_sin_iva: -100,
  iva_total: -21,
  percepciones: 0,
  total: -121,
  total_pagado: -121,
  estado: "ACTIVA",
  estado_pago: "PAGADO",
  observaciones: null,
  cae: "75123456789012",
  cae_vencimiento: "2026-08-30",
  afip_estado: "APROBADO",
  afip_fase: "PERSISTIDO",
  afip_snapshot: null,
  afip_snapshot_hash: "a".repeat(64),
  afip_emisor_cuit: "30714199664",
  afip_punto_venta: 5,
  afip_cbte_tipo: 8,
  afip_numero: 7,
  afip_modo: "PRODUCCION",
  afip_validez: "PRODUCCION",
  afip_fecha_comprobante: "2026-08-20",
  afip_imp_total: 121,
  afip_simulado: false,
  afip_cbte_asoc_id: null,
  periodo_asoc_desde: "2026-08-01",
  periodo_asoc_hasta: "2026-08-15",
  nc_periodo_modalidad: "DEVOLUCION_PRODUCTOS",
  motivo_nota_credito: "Productos dañados devueltos",
  nc_resolucion: "REINTEGRO",
  nc_efectos_aplicados_at: "2026-08-20T13:03:00.000Z",
  afip_emitido_at: "2026-08-20T13:02:00.000Z",
  afip_error_clase: null,
  afip_error_codigo: null,
  afip_intentos: 1,
  cliente: { razon_social: "Comprador Comercial SRL", cuit_dni: "30711111118" },
  sucursal: { nombre: "O'Higgins" },
} as unknown as VentaDetalle;

const auditoriaAplicada: DatosAuditoriaNotaCreditoPeriodo = {
  operador: { nombre: "Ana Operadora", username: "ana" },
  receptorFiscal: { razonSocial: "Receptor Fiscal SA", documento: "30722222225", letra: "B" },
  reintegrosIntencion: [],
  pagosAplicados: [
    { id: "p-1", formaPago: "EFECTIVO", monto: -100, createdAt: "2026-08-20T13:03:00Z" },
    { id: "p-2", formaPago: "TARJETA", monto: -21, createdAt: "2026-08-20T13:03:01Z" },
  ],
  movimientosStock: [
    {
      id: "s-1",
      producto: "P-1 · Pintura interior",
      cantidad: 2,
      cantidadAnterior: 8,
      cantidadNueva: 10,
      createdAt: "2026-08-20T13:03:00Z",
    },
  ],
  movimientosCuentaCorriente: [],
};

describe("detalle auditado de NC por período", () => {
  it("falla cerrado si falta cualquiera de las fuentes de movimientos", async () => {
    await expect(
      cargarAuditoriaNotaCreditoPeriodo({
        cargarOperador: async () => ({
          data: { nombre_completo: "Ana", username: "ana" },
          error: null,
        }),
        cargarReintegros: async () => ({ data: [], error: null }),
        cargarStock: async () => ({ data: null, error: { message: "SQL secreto stock" } }),
        cargarCuentaCorriente: async () => ({ data: [], error: null }),
      }),
    ).rejects.toThrow("No se pudo reconstruir la auditoría de la nota de crédito.");
  });

  it("muestra fuentes persistidas y efectos exactos sin controles de mutación", () => {
    const html = renderToStaticMarkup(
      createElement(AuditoriaNotaCreditoPeriodo, {
        venta: ventaBase,
        auditoria: auditoriaAplicada,
      }),
    );

    expect(html).toContain("01/08/2026 a 15/08/2026");
    expect(html).toContain("Devolución de productos");
    expect(html).toContain("Productos dañados devueltos");
    expect(html).toContain("Reintegro");
    expect(html).toContain("Comprador Comercial SRL");
    expect(html).toContain("Receptor Fiscal SA");
    expect(html).toContain("Letra B");
    expect(html).toContain("Ana Operadora");
    expect(html).toContain("APROBADO");
    expect(html).toContain("PERSISTIDO");
    expect(html).toContain("75123456789012");
    expect(html).toContain("EFECTIVO");
    expect(html).toContain("TARJETA");
    expect(html).toContain("P-1 · Pintura interior");
    expect(html).toContain("8 → 10");
    expect(html).not.toMatch(/Editar|Eliminar|afip_snapshot_hash|payload|SOAP|SQL/i);
  });

  it("antes del CAE muestra la intención y aclara que aún no hay efectos", () => {
    const ventaPendiente = {
      ...ventaBase,
      estado: "PENDIENTE_FISCAL",
      estado_pago: "PENDIENTE",
      cae: null,
      afip_estado: "PENDIENTE",
      afip_fase: "PREFLIGHT",
      afip_emitido_at: null,
      nc_efectos_aplicados_at: null,
    } as unknown as VentaDetalle;
    const html = renderToStaticMarkup(
      createElement(AuditoriaNotaCreditoPeriodo, {
        venta: ventaPendiente,
        auditoria: {
          ...auditoriaAplicada,
          reintegrosIntencion: [{ id: "r-1", formaPago: "EFECTIVO", monto: 121, orden: 0 }],
          pagosAplicados: [],
          movimientosStock: [],
        },
      }),
    );

    expect(html).toContain("Intención pendiente antes del CAE");
    expect(html).toContain("EFECTIVO");
    expect(html).toContain("Todavía no se aplicaron movimientos comerciales");
    expect(html).not.toContain("Efectos aplicados el");
  });
});
