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
    estado: "SNAPSHOT_V3_VALIDADO",
    lifecycle: "APROBADO",
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

  function dependenciasSinCongelar(
    overrides: Record<string, unknown> = {},
  ): Parameters<typeof cargarAuditoriaNotaCreditoPeriodo>[0] {
    return {
      venta: {
        id: ventaBase.id,
        estado: "PENDIENTE_FISCAL",
        afipEstado: "SIN_FACTURAR",
        afipFase: null,
        afipVersion: 0,
        afipIntentos: 0,
        afipSnapshot: null,
        afipSnapshotHash: null,
        cae: null,
        caeVencimiento: null,
        afipEmisorCuit: null,
        afipPuntoVenta: null,
        afipCbteTipo: null,
        afipNumero: null,
        afipModo: null,
        afipValidez: null,
        afipFechaComprobante: null,
        afipEmitidoAt: null,
        afipImpTotal: null,
        afipSimulado: false,
        afipCbteAsocId: null,
        ncEfectosAplicadosAt: null,
        periodoDesde: "2026-08-01",
        periodoHasta: "2026-08-15",
        modalidad: "DEVOLUCION_PRODUCTOS",
        motivo: "Productos dañados devueltos",
        ...overrides,
      },
      cargarOperador: async () => ({
        data: { nombre_completo: "Ana", username: "ana" },
        error: null,
      }),
      cargarReintegros: async () => ({
        data: [{ id: "r-1", forma_pago: "EFECTIVO", monto: 121, orden: 0 }],
        error: null,
      }),
      cargarStock: async () => ({ data: [], error: null }),
      cargarCuentaCorriente: async () => ({ data: [], error: null }),
      cargarEvidenciaAutorizacion: async () => null,
    } as Parameters<typeof cargarAuditoriaNotaCreditoPeriodo>[0];
  }

  function dependenciasCongeladas(
    overrides: Record<string, unknown> = {},
    evidencia: { origen: "EMISION" | "RECUPERACION"; confirmadoAt: string } | null = null,
  ): Parameters<typeof cargarAuditoriaNotaCreditoPeriodo>[0] {
    return {
      venta: {
        id: ventaBase.id,
        estado: "PENDIENTE_FISCAL",
        afipEstado: "EMITIENDO",
        afipFase: "RESERVADO",
        afipVersion: 2,
        afipIntentos: 1,
        afipSnapshot: snapshotV3,
        afipSnapshotHash: snapshotV3.hash,
        cae: null,
        caeVencimiento: null,
        afipEmisorCuit: snapshotV3.identidad.emisorCuit,
        afipPuntoVenta: snapshotV3.identidad.puntoVenta,
        afipCbteTipo: snapshotV3.identidad.cbteTipo,
        afipNumero: snapshotV3.identidad.numero,
        afipModo: snapshotV3.identidad.modo,
        afipValidez: snapshotV3.identidad.validez,
        afipFechaComprobante: snapshotV3.fechaComprobante,
        afipEmitidoAt: null,
        afipImpTotal: Number(snapshotV3.importeTotal),
        afipSimulado: snapshotV3.identidad.simulado,
        afipCbteAsocId: null,
        ncEfectosAplicadosAt: null,
        periodoDesde: "2026-08-01",
        periodoHasta: "2026-08-15",
        modalidad: "DEVOLUCION_PRODUCTOS",
        motivo: "Productos dañados devueltos",
        ...overrides,
      },
      cargarOperador: async () => ({
        data: { nombre_completo: "Ana", username: "ana" },
        error: null,
      }),
      cargarReintegros: async () => ({ data: [], error: null }),
      cargarStock: async () => ({ data: [], error: null }),
      cargarCuentaCorriente: async () => ({ data: [], error: null }),
      cargarEvidenciaAutorizacion: async () => evidencia,
    } as Parameters<typeof cargarAuditoriaNotaCreditoPeriodo>[0];
  }

  it("reconstruye estrictamente la intención recién creada sin inventar identidad fiscal", async () => {
    const resultado = await cargarAuditoriaNotaCreditoPeriodo(dependenciasSinCongelar());

    expect(resultado.fiscal).toEqual({
      estado: "INTENCION_NO_CONGELADA",
      periodoDesde: "2026-08-01",
      periodoHasta: "2026-08-15",
      modalidad: "DEVOLUCION_PRODUCTOS",
      motivo: "Productos dañados devueltos",
    });
    expect(resultado.evidenciaAutorizacion).toBeNull();
  });

  it("acepta sólo la cancelación pre-reserva intacta como intención no congelada", async () => {
    const resultado = await cargarAuditoriaNotaCreditoPeriodo(
      dependenciasSinCongelar({
        estado: "ANULADA",
        afipEstado: "CANCELADO",
        afipVersion: 1,
      }),
    );

    expect(resultado.fiscal.estado).toBe("INTENCION_NO_CONGELADA");
    expect(resultado.evidenciaAutorizacion).toBeNull();
  });

  it.each([
    ["snapshot parcial", { afipSnapshot: {}, afipSnapshotHash: null }],
    ["snapshot v3 sin hash", { afipSnapshot: snapshotV3, afipSnapshotHash: null }],
    ["hash sin snapshot", { afipSnapshotHash: "a".repeat(64) }],
    ["identidad parcial", { afipNumero: 7 }],
    ["fase avanzada", { afipFase: "PREFLIGHT", afipIntentos: 1, afipVersion: 1 }],
    ["reserva sin snapshot", { afipFase: "RESERVADO", afipIntentos: 1, afipVersion: 2 }],
    [
      "request iniciado sin snapshot",
      { afipFase: "REQUEST_INICIADO", afipIntentos: 1, afipVersion: 3 },
    ],
    [
      "fila aprobada",
      {
        estado: "ACTIVA",
        afipEstado: "APROBADO",
        afipFase: "PERSISTIDO",
        afipVersion: 5,
        afipIntentos: 1,
        cae: "75123456789012",
      },
    ],
  ])("falla cerrado sin snapshot v3 ante %s", async (_caso, overrides) => {
    await expect(
      cargarAuditoriaNotaCreditoPeriodo(dependenciasSinCongelar(overrides)),
    ).rejects.toThrow("No se pudo validar la evidencia fiscal congelada de la nota de crédito.");
  });

  it("rotula la intención no congelada y omite receptor, letra, CAE y efectos", async () => {
    const persistida = await cargarAuditoriaNotaCreditoPeriodo(dependenciasSinCongelar());
    const html = renderToStaticMarkup(
      createElement(AuditoriaNotaCreditoPeriodo, {
        venta: {
          ...ventaBase,
          estado: "PENDIENTE_FISCAL",
          estado_pago: "PENDIENTE",
          cae: null,
          cae_vencimiento: null,
          afip_estado: "SIN_FACTURAR",
          afip_fase: null,
          afip_emitido_at: null,
          nc_efectos_aplicados_at: null,
        } as unknown as VentaDetalle,
        auditoria: { ...persistida, pagosAplicados: [] },
      }),
    );

    expect(html).toContain("Intención aún no congelada");
    expect(html).toContain("01/08/2026 a 15/08/2026");
    expect(html).toContain("Productos dañados devueltos");
    expect(html).toContain("EFECTIVO");
    expect(html).not.toMatch(
      /Receptor fiscal|Letra [ABC]|CAE|Autorización directa|Efectos aplicados/,
    );
    expect(html).toContain("Todavía no se aplicaron movimientos comerciales");
  });

  it.each([
    ["CUIT emisor", { afipEmisorCuit: "30714199665" }],
    ["punto de venta", { afipPuntoVenta: snapshotV3.identidad.puntoVenta + 1 }],
    ["tipo", { afipCbteTipo: snapshotV3.identidad.cbteTipo + 1 }],
    ["número", { afipNumero: snapshotV3.identidad.numero + 1 }],
    ["modo", { afipModo: "HOMOLOGACION" }],
    ["simulación", { afipSimulado: !snapshotV3.identidad.simulado }],
    ["validez", { afipValidez: "HOMOLOGACION" }],
    ["fecha", { afipFechaComprobante: "2026-08-23" }],
    ["total decimal", { afipImpTotal: 1360.01 }],
    ["asociación puntual", { afipCbteAsocId: "71000000-0000-4000-8000-000000000777" }],
  ])("falla cerrado si diverge %s entre snapshot y columnas", async (_caso, overrides) => {
    await expect(
      cargarAuditoriaNotaCreditoPeriodo(dependenciasCongeladas(overrides)),
    ).rejects.toThrow("No se pudo validar la evidencia fiscal congelada de la nota de crédito.");
  });

  it.each([
    ["RESERVADO", { afipEstado: "EMITIENDO", afipFase: "RESERVADO", afipVersion: 2 }],
    ["REQUEST_INICIADO", { afipEstado: "EMITIENDO", afipFase: "REQUEST_INICIADO", afipVersion: 3 }],
    [
      "RESPUESTA_RECIBIDA",
      { afipEstado: "EMITIENDO", afipFase: "RESPUESTA_RECIBIDA", afipVersion: 4 },
    ],
    [
      "RECONCILIANDO_REQUEST",
      { afipEstado: "RECONCILIAR", afipFase: "REQUEST_INICIADO", afipVersion: 4 },
    ],
    [
      "RECONCILIANDO_RESPUESTA",
      { afipEstado: "RECONCILIAR", afipFase: "RESPUESTA_RECIBIDA", afipVersion: 5 },
    ],
    ["BLOQUEADO_RESERVADO", { afipEstado: "BLOQUEADO", afipFase: "RESERVADO", afipVersion: 3 }],
    [
      "BLOQUEADO_REQUEST",
      { afipEstado: "BLOQUEADO", afipFase: "REQUEST_INICIADO", afipVersion: 4 },
    ],
    [
      "BLOQUEADO_RESPUESTA",
      { afipEstado: "BLOQUEADO", afipFase: "RESPUESTA_RECIBIDA", afipVersion: 5 },
    ],
    [
      "ERROR_CORREGIBLE_IDENTIDAD",
      { afipEstado: "ERROR_CORREGIBLE", afipFase: null, afipVersion: 3 },
    ],
  ])("acepta el lifecycle congelado real %s", async (lifecycle, overrides) => {
    const resultado = await cargarAuditoriaNotaCreditoPeriodo(dependenciasCongeladas(overrides));

    expect(resultado.fiscal).toMatchObject({ estado: "SNAPSHOT_V3_VALIDADO", lifecycle });
    expect(resultado.evidenciaAutorizacion).toBeNull();
  });

  it.each([
    ["PREFLIGHT con snapshot", { afipEstado: "EMITIENDO", afipFase: "PREFLIGHT" }],
    ["persistido sin aprobación", { afipEstado: "EMITIENDO", afipFase: "PERSISTIDO" }],
    ["aprobado antes de persistir", { afipEstado: "APROBADO", afipFase: "RESPUESTA_RECIBIDA" }],
    ["cancelado congelado", { afipEstado: "CANCELADO", afipFase: null }],
  ])("rechaza el lifecycle congelado incoherente %s", async (_caso, overrides) => {
    await expect(
      cargarAuditoriaNotaCreditoPeriodo(dependenciasCongeladas(overrides)),
    ).rejects.toThrow("No se pudo validar la evidencia fiscal congelada de la nota de crédito.");
  });

  it.each([
    ["CAE prematuro", { cae: "75123456789012" }],
    ["vencimiento prematuro", { caeVencimiento: "2026-08-30" }],
    ["emisión prematura", { afipEmitidoAt: "2026-08-20T13:02:00.000Z" }],
    ["efectos prematuros", { ncEfectosAplicadosAt: "2026-08-20T13:03:00.000Z" }],
  ])("rechaza %s antes de APROBADO/PERSISTIDO", async (_caso, overrides) => {
    await expect(
      cargarAuditoriaNotaCreditoPeriodo(dependenciasCongeladas(overrides)),
    ).rejects.toThrow("No se pudo validar la evidencia fiscal congelada de la nota de crédito.");
  });

  it("no carga ni afirma evidencia antes de la aprobación", async () => {
    const resultado = await cargarAuditoriaNotaCreditoPeriodo(
      dependenciasCongeladas(
        {},
        {
          origen: "EMISION",
          confirmadoAt: "2026-08-20T13:02:00.000Z",
        },
      ),
    );

    expect(resultado.evidenciaAutorizacion).toBeNull();
  });

  it.each([
    ["sin CAE", { cae: null }],
    ["CAE inválido", { cae: "ARCA-RAW" }],
    ["sin emisión", { afipEmitidoAt: null }],
    ["sin efectos", { ncEfectosAplicadosAt: null }],
  ])("falla cerrado APROBADO/PERSISTIDO %s", async (_caso, overrides) => {
    await expect(
      cargarAuditoriaNotaCreditoPeriodo(
        dependenciasCongeladas(
          {
            estado: "ACTIVA",
            afipEstado: "APROBADO",
            afipFase: "PERSISTIDO",
            afipVersion: 5,
            cae: "75123456789012",
            caeVencimiento: "2026-08-30",
            afipEmitidoAt: "2026-08-20T13:02:00.000Z",
            ncEfectosAplicadosAt: "2026-08-20T13:03:00.000Z",
            ...overrides,
          },
          { origen: "EMISION", confirmadoAt: "2026-08-20T13:02:00.000Z" },
        ),
      ),
    ).rejects.toThrow("No se pudo validar la evidencia fiscal congelada de la nota de crédito.");
  });

  it("deriva internamente que una aprobación exige evidencia segura", async () => {
    await expect(
      cargarAuditoriaNotaCreditoPeriodo(
        dependenciasCongeladas({
          estado: "ACTIVA",
          afipEstado: "APROBADO",
          afipFase: "PERSISTIDO",
          afipVersion: 5,
          cae: "75123456789012",
          caeVencimiento: "2026-08-30",
          afipEmitidoAt: "2026-08-20T13:02:00.000Z",
          ncEfectosAplicadosAt: "2026-08-20T13:03:00.000Z",
        }),
      ),
    ).rejects.toThrow("No se pudo validar la evidencia de autorización fiscal.");
  });

  it.each([
    ["EMISION", "2026-08-30"],
    ["RECUPERACION", null],
  ] as const)("acepta aprobación coherente por %s", async (origen, caeVencimiento) => {
    const resultado = await cargarAuditoriaNotaCreditoPeriodo(
      dependenciasCongeladas(
        {
          estado: "ACTIVA",
          afipEstado: "APROBADO",
          afipFase: "PERSISTIDO",
          afipVersion: 5,
          cae: "75123456789012",
          caeVencimiento,
          afipEmitidoAt: "2026-08-20T13:02:00.000Z",
          ncEfectosAplicadosAt: "2026-08-20T13:03:00.000Z",
        },
        { origen, confirmadoAt: "2026-08-20T13:02:00.000Z" },
      ),
    );

    expect(resultado.fiscal).toMatchObject({
      estado: "SNAPSHOT_V3_VALIDADO",
      lifecycle: "APROBADO",
    });
    expect(resultado.evidenciaAutorizacion?.origen).toBe(origen);
  });

  it("falla cerrado si falta cualquiera de las fuentes de movimientos", async () => {
    await expect(
      cargarAuditoriaNotaCreditoPeriodo({
        ...dependenciasCongeladas(),
        cargarStock: async () => ({ data: null, error: { message: "SQL secreto stock" } }),
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
      ...dependenciasCongeladas(),
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
    });

    expect(resultado.fiscal).toEqual({
      estado: "SNAPSHOT_V3_VALIDADO",
      lifecycle: "RESERVADO",
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
    expect(resultado.evidenciaAutorizacion).toBeNull();
  });

  it("falla cerrado si el hash externo no coincide con el snapshot v3", async () => {
    await expect(
      cargarAuditoriaNotaCreditoPeriodo(
        dependenciasCongeladas({ afipSnapshotHash: "f".repeat(64) }),
      ),
    ).rejects.toThrow("No se pudo validar la evidencia fiscal congelada de la nota de crédito.");
  });

  it("falla cerrado si el contenido v3 fue alterado aunque conserve el hash previo", async () => {
    const alterado = structuredClone(snapshotV3) as unknown as {
      notaCredito: { motivo: string };
    };
    alterado.notaCredito.motivo = "Motivo alterado después del hash";

    await expect(
      cargarAuditoriaNotaCreditoPeriodo(dependenciasCongeladas({ afipSnapshot: alterado })),
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
            estado: "SNAPSHOT_V3_VALIDADO",
            lifecycle: "APROBADO",
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
    if (auditoriaAplicada.fiscal.estado !== "SNAPSHOT_V3_VALIDADO") {
      throw new Error("Fixture fiscal inválido");
    }
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
          fiscal: { ...auditoriaAplicada.fiscal, lifecycle: "RESERVADO" },
          evidenciaAutorizacion: null,
          reintegrosIntencion: [{ id: "r-1", formaPago: "EFECTIVO", monto: 121, orden: 0 }],
          pagosAplicados: [],
          movimientosStock: [],
        },
      }),
    );

    expect(html).toContain("Intención pendiente antes del CAE");
    expect(html).toContain("EFECTIVO");
    expect(html).toContain("Todavía no se aplicaron movimientos comerciales");
    expect(html).not.toContain("Autorización directa confirmada");
    expect(html).not.toContain("Efectos aplicados el");
  });
});
