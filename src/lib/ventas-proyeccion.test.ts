import { describe, expect, it } from "vitest";
import {
  COLUMNAS_VENTA_REPORTE,
  COLUMNAS_VENTA_SEGURAS,
  proyectarListadoVentasSeguro,
} from "./ventas-proyeccion";

describe("proyección de ventas para operadores", () => {
  it("no solicita el diagnóstico técnico fiscal ni comodines", () => {
    const columnas = COLUMNAS_VENTA_SEGURAS.split(",").map((columna) => columna.trim());

    expect(columnas).not.toContain("*");
    expect(columnas).not.toContain("afip_error");
    expect(columnas).not.toContain("afip_snapshot");
    expect(columnas).not.toContain("afip_snapshot_hash");
    expect(columnas).toContain("afip_estado");
    expect(columnas).toContain("afip_error_clase");
  });

  it("incluye sólo los campos inmutables necesarios para auditar una NC por período", () => {
    const columnas = COLUMNAS_VENTA_SEGURAS.split(",").map((columna) => columna.trim());

    expect(columnas).toEqual(
      expect.arrayContaining([
        "created_at",
        "usuario_id",
        "periodo_asoc_desde",
        "periodo_asoc_hasta",
        "nc_periodo_modalidad",
        "motivo_nota_credito",
        "nc_resolucion",
        "nc_efectos_aplicados_at",
        "afip_emitido_at",
        "afip_version",
      ]),
    );
    expect(columnas).not.toEqual(
      expect.arrayContaining([
        "afip_error",
        "afip_claim_token",
        "afip_claimed_at",
        "afip_snapshot",
        "afip_snapshot_hash",
        "idempotency_key",
        "nc_periodo_payload_hash",
        "idempotency_payload_hash",
        "anulacion_idempotency_key",
        "anulacion_idempotency_payload_hash",
      ]),
    );
  });

  it("mantiene reportes sobre una selección mínima sin evidencia fiscal", () => {
    const columnas = COLUMNAS_VENTA_REPORTE.split(",");
    expect(columnas).toEqual([
      "id",
      "numero_comprobante",
      "tipo_comprobante",
      "fecha",
      "subtotal_sin_iva",
      "iva_total",
      "total",
      "total_pagado",
    ]);
  });

  it("convierte evidencia server-only en una presentación cerrada y elimina extras", () => {
    const venta = Object.fromEntries(
      COLUMNAS_VENTA_SEGURAS.split(",").map((columna) => [columna, null]),
    ) as Record<string, unknown>;
    Object.assign(venta, {
      id: "81000000-0000-4000-8000-000000000001",
      numero_comprobante: "VTA-1",
      cliente: { razon_social: "Comprador", cuit_dni: "20111111112" },
      sucursal: { nombre: "Centro", codigo: "C", telefono: null },
      pagos: [],
      afip_snapshot: { secreto: true },
      idempotency_key: "no-sale",
    });
    const salida = proyectarListadoVentasSeguro(
      [venta],
      [
        {
          id: venta.id as string,
          afip_snapshot: {
            receptor: {
              razonSocial: "Receptor fiscal",
              tipoDocumento: "CUIT",
              numeroDocumento: "20999999991",
              condicionIva: "RESPONSABLE_INSCRIPTO",
              domicilio: "Fiscal 123",
            },
            cbtesAsoc: [],
          },
        },
      ],
    );

    expect(salida[0]).toMatchObject({
      id: venta.id,
      fiscalPresentacion: {
        receptor: { razonSocial: "Receptor fiscal", numeroDocumento: "20999999991" },
        comprobanteAsociado: null,
      },
    });
    expect(salida[0]).not.toHaveProperty("afip_snapshot");
    expect(salida[0]).not.toHaveProperty("afip_snapshot_hash");
    expect(salida[0]).not.toHaveProperty("idempotency_key");
  });
});
