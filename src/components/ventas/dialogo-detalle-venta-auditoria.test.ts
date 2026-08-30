import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { crearSnapshotFiscalV3Fixture } from "@/lib/fiscal/snapshot-v3.test-fixture";
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
  fiscal: {
    periodoDesde: "2026-08-01",
    periodoHasta: "2026-08-15",
    modalidad: "DEVOLUCION_PRODUCTOS",
    motivo: "Productos dañados devueltos",
    receptor: { razonSocial: "Receptor Fiscal SA", documento: "30722222225", letra: "B" },
  },
  operador: { nombre: "Ana Operadora", username: "ana" },
  evidenciaAutorizacion: {
    origen: "EMISION",
    confirmadoAt: "2026-08-20T13:02:00.000Z",
  },
  reintegrosIntencion: [],
  pagosAplicados: [
    { id: "p-1", formaPago: "EFECTIVO", monto: -100, createdAt: "2026-08-20T13:03:00Z" },
    { id: "p-2", formaPago: "TARJETA", monto: -21, createdAt: "2026-08-20T13:03:01Z" },
  ],
  movimientosStock: [
    {
      id: "s-1",
      productoId: "71000000-0000-4000-8000-000000000501",
      etiquetaActual: "P-1 · Pintura interior",
      cantidad: 2,
      cantidadAnterior: 8,
      cantidadNueva: 10,
      createdAt: "2026-08-20T13:03:00Z",
    },
  ],
  movimientosCuentaCorriente: [],
};

describe("detalle auditado de NC por período", () => {
  const snapshotV3 = crearSnapshotFiscalV3Fixture({
    ventaId: "71000000-0000-4000-8000-000000000001",
    letra: "B",
  });

  it("falla cerrado si falta cualquiera de las fuentes de movimientos", async () => {
    await expect(
      cargarAuditoriaNotaCreditoPeriodo({
        venta: {
          id: ventaBase.id,
          afipSnapshot: snapshotV3,
          afipSnapshotHash: snapshotV3.hash,
          requiereEvidenciaAutorizacion: false,
        },
        cargarOperador: async () => ({
          data: { nombre_completo: "Ana", username: "ana" },
          error: null,
        }),
        cargarReintegros: async () => ({ data: [], error: null }),
        cargarStock: async () => ({ data: null, error: { message: "SQL secreto stock" } }),
        cargarCuentaCorriente: async () => ({ data: [], error: null }),
        cargarEvidenciaAutorizacion: async () => null,
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

  it("bloquea toda afirmación de efectos si falló la lectura de venta_pagos", () => {
    const html = renderToStaticMarkup(
      createElement(AuditoriaNotaCreditoPeriodo, {
        venta: ventaBase,
        auditoria: { ...auditoriaAplicada, pagosAplicados: [] },
        errorDetalle: new Error("SQL secreto venta_pagos"),
      }),
    );

    expect(html).toContain("No se pudo reconstruir la auditoría de la nota de crédito");
    expect(html).not.toContain("Sin reintegros de caja");
    expect(html).not.toContain("SQL secreto venta_pagos");
  });

  it("deriva período, modalidad, motivo, receptor y letra sólo del snapshot v3 validado", async () => {
    const resultado = await cargarAuditoriaNotaCreditoPeriodo({
      venta: {
        id: ventaBase.id,
        afipSnapshot: snapshotV3,
        afipSnapshotHash: snapshotV3.hash,
        requiereEvidenciaAutorizacion: true,
      },
      cargarOperador: async () => ({
        data: { nombre_completo: "Nombre actual", username: "usuario-actual" },
        error: null,
      }),
      cargarReintegros: async () => ({ data: [], error: null }),
      cargarStock: async () => ({
        data: [
          {
            id: "s-1",
            producto_id: "71000000-0000-4000-8000-000000000501",
            cantidad: 2,
            cantidad_anterior: 8,
            cantidad_nueva: 10,
            created_at: "2026-08-20T13:03:00Z",
            producto: { codigo: "COD-ACTUAL", nombre: "Nombre actual del producto" },
          },
        ],
        error: null,
      }),
      cargarCuentaCorriente: async () => ({ data: [], error: null }),
      cargarEvidenciaAutorizacion: async () => ({
        origen: "EMISION" as const,
        confirmadoAt: "2026-08-20T13:02:00.000Z",
      }),
    });

    expect(resultado.fiscal).toEqual({
      periodoDesde: "2026-08-01",
      periodoHasta: "2026-08-15",
      modalidad: "DEVOLUCION_PRODUCTOS",
      motivo: "Devolución de productos del período",
      receptor: {
        razonSocial: "CLIENTE FINAL",
        documento: "30123456",
        letra: "B",
      },
    });
    expect(resultado.movimientosStock[0]).toMatchObject({
      productoId: "71000000-0000-4000-8000-000000000501",
      etiquetaActual: "COD-ACTUAL · Nombre actual del producto",
    });
    expect(resultado.evidenciaAutorizacion).toEqual({
      origen: "EMISION",
      confirmadoAt: "2026-08-20T13:02:00.000Z",
    });
  });

  it("falla cerrado si el hash externo no coincide con el snapshot v3", async () => {
    await expect(
      cargarAuditoriaNotaCreditoPeriodo({
        venta: {
          id: ventaBase.id,
          afipSnapshot: snapshotV3,
          afipSnapshotHash: "f".repeat(64),
          requiereEvidenciaAutorizacion: false,
        },
        cargarOperador: async () => ({
          data: { nombre_completo: "Nombre actual", username: "usuario-actual" },
          error: null,
        }),
        cargarReintegros: async () => ({ data: [], error: null }),
        cargarStock: async () => ({ data: [], error: null }),
        cargarCuentaCorriente: async () => ({ data: [], error: null }),
        cargarEvidenciaAutorizacion: async () => null,
      }),
    ).rejects.toThrow("No se pudo validar la evidencia fiscal congelada de la nota de crédito.");
  });

  it("falla cerrado si el contenido v3 fue alterado aunque conserve el hash previo", async () => {
    const alterado = structuredClone(snapshotV3) as unknown as {
      notaCredito: { motivo: string };
    };
    alterado.notaCredito.motivo = "Motivo alterado después del hash";

    await expect(
      cargarAuditoriaNotaCreditoPeriodo({
        venta: {
          id: ventaBase.id,
          afipSnapshot: alterado,
          afipSnapshotHash: snapshotV3.hash,
          requiereEvidenciaAutorizacion: false,
        },
        cargarOperador: async () => ({
          data: { nombre_completo: "Nombre actual", username: "usuario-actual" },
          error: null,
        }),
        cargarReintegros: async () => ({ data: [], error: null }),
        cargarStock: async () => ({ data: [], error: null }),
        cargarCuentaCorriente: async () => ({ data: [], error: null }),
        cargarEvidenciaAutorizacion: async () => null,
      }),
    ).rejects.toThrow("No se pudo validar la evidencia fiscal congelada de la nota de crédito.");
  });

  it("rotula IDs persistidos como identidad y nombres relacionados como datos actuales", () => {
    const html = renderToStaticMarkup(
      createElement(AuditoriaNotaCreditoPeriodo, {
        venta: {
          ...ventaBase,
          periodo_asoc_desde: "1999-01-01",
          periodo_asoc_hasta: "1999-01-02",
          nc_periodo_modalidad: "BONIFICACION_AJUSTE",
          motivo_nota_credito: "Motivo live mutable",
        },
        auditoria: {
          ...auditoriaAplicada,
          fiscal: {
            periodoDesde: "2026-08-01",
            periodoHasta: "2026-08-15",
            modalidad: "DEVOLUCION_PRODUCTOS",
            motivo: "Devolución de productos del período",
            receptor: { razonSocial: "CLIENTE FINAL", documento: "30123456", letra: "B" },
          },
          evidenciaAutorizacion: {
            origen: "EMISION",
            confirmadoAt: "2026-08-20T13:02:00.000Z",
          },
          movimientosStock: [
            {
              ...auditoriaAplicada.movimientosStock[0],
              productoId: "71000000-0000-4000-8000-000000000501",
              etiquetaActual: "P-1 · Pintura interior actual",
            },
          ],
        },
      }),
    );

    expect(html).toContain("01/08/2026 a 15/08/2026");
    expect(html).not.toContain("01/01/1999");
    expect(html).not.toContain("Motivo live mutable");
    expect(html).toContain(`Operador ID</dt><dd>${ventaBase.usuario_id}`);
    expect(html).toContain("Nombre / usuario actual");
    expect(html).toContain(`Cliente comercial ID</dt><dd>${ventaBase.cliente_id}`);
    expect(html).toContain("Razón social / documento actual");
    expect(html).toContain("Producto ID");
    expect(html).toContain("Etiqueta actual");
  });

  it("distingue autorización directa de recuperación usando evidencia cerrada", () => {
    const directa = renderToStaticMarkup(
      createElement(AuditoriaNotaCreditoPeriodo, {
        venta: ventaBase,
        auditoria: {
          ...auditoriaAplicada,
          evidenciaAutorizacion: {
            origen: "EMISION",
            confirmadoAt: "2026-08-20T13:02:00.000Z",
          },
        },
      }),
    );
    const recuperada = renderToStaticMarkup(
      createElement(AuditoriaNotaCreditoPeriodo, {
        venta: ventaBase,
        auditoria: {
          ...auditoriaAplicada,
          evidenciaAutorizacion: {
            origen: "RECUPERACION",
            confirmadoAt: "2026-08-20T13:04:00.000Z",
          },
        },
      }),
    );

    expect(directa).toContain("Autorización directa confirmada");
    expect(directa).not.toContain("CAE recuperado por conciliación");
    expect(recuperada).toContain("CAE recuperado por conciliación");
    expect(recuperada).not.toContain("Autorización directa confirmada");
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
