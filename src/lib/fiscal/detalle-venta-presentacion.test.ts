import { describe, expect, it } from "vitest";
import { crearSnapshotFiscalV3Fixture } from "./snapshot-v3.test-fixture";
import {
  ejecutarDetalleVentaFiscalPresentacion,
  proyectarDetalleVentaFiscalPresentacion,
  type DetalleVentaFiscalServidor,
} from "./detalle-venta-presentacion";

function clavesReservadas(value: unknown, ruta = "$", halladas: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => clavesReservadas(item, `${ruta}[${index}]`, halladas));
    return halladas;
  }
  if (typeof value !== "object" || value === null) return halladas;
  for (const [key, item] of Object.entries(value)) {
    if (/snapshot|hash|payload|raw|afip_error/i.test(key)) halladas.push(`${ruta}.${key}`);
    clavesReservadas(item, `${ruta}.${key}`, halladas);
  }
  return halladas;
}

describe("DTO cerrado del detalle fiscal", () => {
  it("autoriza con la sesión del usuario antes de abrir cualquier lectura privilegiada", async () => {
    const orden: string[] = [];

    await expect(
      ejecutarDetalleVentaFiscalPresentacion("71000000-0000-4000-8000-000000000001", {
        autorizar: async () => {
          orden.push("usuario");
          throw new Error("sin acceso");
        },
        cargarVenta: async () => {
          orden.push("admin-venta");
          throw new Error("no debe ejecutarse");
        },
        cargarAuditoriaPeriodo: async () => {
          orden.push("admin-auditoria");
          throw new Error("no debe ejecutarse");
        },
      }),
    ).rejects.toThrow("sin acceso");
    expect(orden).toEqual(["usuario"]);
  });

  it("deriva la evidencia inmutable en servidor y nunca serializa claves reservadas", () => {
    const snapshot = crearSnapshotFiscalV3Fixture({
      ventaId: "71000000-0000-4000-8000-000000000001",
      numero: 42,
      puntoVenta: 5,
    });
    const venta = {
      id: snapshot.venta.id,
      cliente_id: "71000000-0000-4000-8000-000000000002",
      sucursal_id: snapshot.sucursal.id,
      usuario_id: "71000000-0000-4000-8000-000000000003",
      numero_comprobante: snapshot.venta.numeroComercial,
      tipo_comprobante: "NOTA_CREDITO",
      fecha: snapshot.venta.fechaComercial,
      created_at: "2026-08-20T13:00:00.000Z",
      condicion_venta: "CONTADO",
      subtotal_sin_iva: -1000,
      iva_total: -360,
      percepciones: 0,
      total: -1360,
      total_pagado: -1360,
      estado: "ACTIVA",
      estado_pago: "PAGADO",
      observaciones: null,
      cae: "75123456789012",
      cae_vencimiento: "2026-08-30",
      afip_estado: "APROBADO",
      afip_fase: "PERSISTIDO",
      afip_version: 5,
      afip_snapshot: snapshot,
      afip_snapshot_hash: snapshot.hash,
      afip_emisor_cuit: snapshot.identidad.emisorCuit,
      afip_punto_venta: snapshot.identidad.puntoVenta,
      afip_cbte_tipo: snapshot.identidad.cbteTipo,
      afip_numero: snapshot.identidad.numero,
      afip_modo: snapshot.identidad.modo,
      afip_validez: snapshot.identidad.validez,
      afip_fecha_comprobante: snapshot.fechaComprobante,
      afip_emitido_at: "2026-08-20T13:01:00.000Z",
      afip_imp_total: Number(snapshot.importeTotal),
      afip_simulado: snapshot.identidad.simulado,
      afip_cbte_asoc_id: null,
      periodo_asoc_desde: snapshot.periodoAsoc.desde,
      periodo_asoc_hasta: snapshot.periodoAsoc.hasta,
      nc_periodo_modalidad: snapshot.notaCredito.modalidad,
      motivo_nota_credito: snapshot.notaCredito.motivo,
      nc_resolucion: "REINTEGRO",
      nc_efectos_aplicados_at: "2026-08-20T13:02:00.000Z",
      afip_error: "diagnóstico SQL prohibido",
      afip_error_clase: "DATABASE",
      afip_error_codigo: "42501",
      afip_intentos: 1,
      cliente: {
        razon_social: "Comprador vivo",
        cuit_dni: "30711111118",
        raw_payload: "prohibido",
      },
      sucursal: { nombre: "O'Higgins", telefono: "3510000000" },
    } as unknown as DetalleVentaFiscalServidor;
    const auditoriaPeriodo = {
      fiscal: {
        estado: "SNAPSHOT_V3_VALIDADO" as const,
        lifecycle: "APROBADO" as const,
        periodoDesde: snapshot.periodoAsoc.desde,
        periodoHasta: snapshot.periodoAsoc.hasta,
        modalidad: snapshot.notaCredito.modalidad,
        motivo: snapshot.notaCredito.motivo,
        receptor: {
          razonSocial: snapshot.receptor.razonSocial,
          documento: snapshot.receptor.numeroDocumento,
          letra: snapshot.letra,
        },
      },
      operador: { nombre: "Ana", username: "ana" },
      evidenciaAutorizacion: {
        origen: "EMISION" as const,
        confirmadoAt: "2026-08-20T13:01:00.000Z",
      },
      reintegrosIntencion: [
        {
          id: "71000000-0000-4000-8000-000000000010",
          formaPago: "EFECTIVO",
          monto: 1360,
          orden: 0,
          raw: "reintegro prohibido",
        },
      ],
      movimientosStock: [
        {
          id: "71000000-0000-4000-8000-000000000011",
          productoId: "71000000-0000-4000-8000-000000000012",
          etiquetaActual: "Pintura",
          cantidad: 1,
          cantidadAnterior: 5,
          cantidadNueva: 6,
          createdAt: "2026-08-20T13:02:00.000Z",
          snapshotHash: "movimiento prohibido",
        },
      ],
      movimientosCuentaCorriente: [
        {
          id: "71000000-0000-4000-8000-000000000013",
          tipo: "CREDITO",
          estado: "CONFIRMADO",
          monto: 1360,
          descripcion: "Ajuste",
          createdAt: "2026-08-20T13:02:00.000Z",
          payload: "cuenta corriente prohibida",
        },
      ],
      payload: "payload de auditoría prohibido",
    };
    const fiscalEsperado = structuredClone(auditoriaPeriodo.fiscal);
    Object.assign(auditoriaPeriodo.fiscal, { snapshot_hash: "hash interno prohibido" });
    Object.assign(auditoriaPeriodo.operador, { raw: "fila de operador prohibida" });
    Object.assign(auditoriaPeriodo.evidenciaAutorizacion, {
      intent_payload: "payload de intento prohibido",
    });

    const dto = proyectarDetalleVentaFiscalPresentacion(venta, auditoriaPeriodo);

    expect(dto.fiscalPresentacion).toEqual({
      receptor: {
        razonSocial: snapshot.receptor.razonSocial,
        tipoDocumento: snapshot.receptor.tipoDocumento,
        numeroDocumento: snapshot.receptor.numeroDocumento,
        condicionIva: snapshot.receptor.condicionIva,
        domicilio: snapshot.receptor.domicilio,
      },
      comprobanteAsociado: null,
    });
    expect(dto.auditoriaPeriodo?.fiscal).toEqual(fiscalEsperado);
    expect(clavesReservadas(dto)).toEqual([]);
    expect(JSON.stringify(dto)).not.toContain("diagnóstico SQL prohibido");
    expect(JSON.stringify(dto)).not.toContain("prohibido");
  });
});
