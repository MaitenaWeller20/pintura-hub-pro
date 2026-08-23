import { describe, expect, it } from "vitest";
import {
  cargarContextoArcaCongelado,
  crearDependenciasEmisionFiscalServer,
  construirPreviewBorradorFiscalProvisional,
  construirSnapshotFiscalDesdeLectura,
  crearHuellaConfirmacionFiscal,
  esConflictoClaimFiscalServer,
  esConflictoSecuenciaFiscalServer,
  liberarClaimFiscalVerificado,
  observarUltimoNumeroFiscalLocal,
  previsualizarVentaFiscalExistente,
  proyectarReceptorFiscalConfirmado,
  type ConfirmacionFiscalPostBorrador,
} from "./emision.server";
import type { DependenciasEmisionFiscal, ReservaFiscalPersistida } from "./emision";
import { validarSnapshotFiscalV2 } from "./snapshot";

describe("liberación administrativa de claims", () => {
  function dependenciasLiberacion(
    estado: Record<string, unknown>,
    transicionar: DependenciasEmisionFiscal["transicionar"] = async () => ({
      venta_id: "71000000-0000-4000-8000-000000000001",
      afip_estado: "ERROR_CORREGIBLE",
      afip_fase: null,
      afip_claim_token: null,
      afip_numero: null,
      afip_version: 2,
    }),
  ): DependenciasEmisionFiscal {
    return {
      cargarEstadoParaLiberar: async () => estado as never,
      transicionar,
    } as unknown as DependenciasEmisionFiscal;
  }

  it.each([
    ["RESERVADO con número", "RESERVADO", 42, true],
    ["PREFLIGHT con identidad anómala", "PREFLIGHT", null, true],
  ])("rechaza %s antes de invocar la RPC", async (_caso, fase, numero, tieneIdentidad) => {
    let transiciones = 0;
    const deps = dependenciasLiberacion(
      {
        claimToken: "71000000-0000-4000-8000-000000000099",
        afipVersion: 2,
        afipEstado: "EMITIENDO",
        afipFase: fase,
        afipNumero: numero,
        tieneIdentidadReservada: tieneIdentidad,
      },
      async () => {
        transiciones += 1;
        throw new Error("La transición insegura no debía ejecutarse.");
      },
    );

    await expect(
      liberarClaimFiscalVerificado({
        ventaId: "71000000-0000-4000-8000-000000000001",
        deps,
      }),
    ).rejects.toThrow(/PREFLIGHT.*sin identidad|identidad.*reservada/i);
    expect(transiciones).toBe(0);
  });

  it("libera sólo un PREFLIGHT sin identidad y conserva el CAS de versión", async () => {
    const llamadas: Parameters<DependenciasEmisionFiscal["transicionar"]>[0][] = [];
    const deps = dependenciasLiberacion(
      {
        claimToken: "71000000-0000-4000-8000-000000000099",
        afipVersion: 7,
        afipEstado: "EMITIENDO",
        afipFase: "PREFLIGHT",
        afipNumero: null,
        tieneIdentidadReservada: false,
      },
      async (input) => {
        llamadas.push(input);
        return {
          venta_id: input.ventaId,
          afip_estado: "ERROR_CORREGIBLE",
          afip_fase: null,
          afip_claim_token: null,
          afip_numero: null,
          afip_version: 8,
        };
      },
    );

    await expect(
      liberarClaimFiscalVerificado({
        ventaId: "71000000-0000-4000-8000-000000000001",
        deps,
      }),
    ).resolves.toEqual({ estado: "LIBERADO" });
    expect(llamadas).toEqual([
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        accion: "LIBERAR",
        claimToken: "71000000-0000-4000-8000-000000000099",
        payload: {
          expected_version: 7,
          verificacion: { nunca_enviado: true, fuente: "log_intento" },
        },
      },
    ]);
  });

  it("falla cerrado si el adaptador no ofrece la lectura segura de PREFLIGHT", async () => {
    const deps = {
      cargarReservaPersistida: async () => ({
        claimToken: "71000000-0000-4000-8000-000000000099",
        afipVersion: 2,
      }),
      transicionar: async () => ({
        venta_id: "71000000-0000-4000-8000-000000000001",
        afip_estado: "ERROR_CORREGIBLE",
        afip_fase: null,
        afip_claim_token: null,
        afip_numero: null,
        afip_version: 3,
      }),
    } as unknown as DependenciasEmisionFiscal;

    await expect(
      liberarClaimFiscalVerificado({
        ventaId: "71000000-0000-4000-8000-000000000001",
        deps,
      }),
    ).rejects.toThrow(/lectura segura.*PREFLIGHT/i);
  });
});

describe("clasificación de contención fiscal REST", () => {
  it("acepta PT409 sólo con el prefijo estable de versión", () => {
    expect(
      esConflictoClaimFiscalServer({
        code: "PT409",
        message: "EMISION_FISCAL_VERSION_CONFLICT: esperada 0, vigente 1",
      }),
    ).toBe(true);
    expect(
      esConflictoClaimFiscalServer({
        code: "PT409",
        message: "EMISION_FISCAL_SECUENCIA_OBSOLETA: observado 0, vigente 1",
      }),
    ).toBe(false);
    expect(esConflictoClaimFiscalServer({ code: "PT409", message: "otro conflicto" })).toBe(false);
    expect(
      esConflictoClaimFiscalServer({
        code: "P0001",
        message: "expected_version quedó obsoleto",
      }),
    ).toBe(false);
  });

  it("mantiene compatibilidad temporal con 40001 durante el rollout", () => {
    expect(esConflictoClaimFiscalServer({ code: "40001", message: "legacy" })).toBe(true);
  });

  it("clasifica sólo el PT409 estable de secuencia como reintento de RESERVAR", () => {
    expect(
      esConflictoSecuenciaFiscalServer({
        code: "PT409",
        message: "EMISION_FISCAL_SECUENCIA_OBSOLETA: observado 0, vigente 1",
      }),
    ).toBe(true);
    expect(
      esConflictoSecuenciaFiscalServer({
        code: "PT409",
        message: "EMISION_FISCAL_VERSION_CONFLICT: esperado 0, vigente 1",
      }),
    ).toBe(false);
    expect(
      esConflictoSecuenciaFiscalServer({
        code: "40001",
        message: "EMISION_FISCAL_SECUENCIA_OBSOLETA: legacy",
      }),
    ).toBe(false);
  });
});

describe("secuencia fiscal local autoritativa", () => {
  it("incluye una identidad reservada sin CAE y excluye números nulos", async () => {
    const filtrosNot: Array<[string, string, null]> = [];
    const consulta = {
      eq() {
        return this;
      },
      not(campo: string, operador: string, valor: null) {
        filtrosNot.push([campo, operador, valor]);
        return this;
      },
      order() {
        return this;
      },
      limit() {
        return this;
      },
      async maybeSingle() {
        return { data: { afip_numero: 913000 }, error: null };
      },
    };
    const admin = {
      from(tabla: string) {
        expect(tabla).toBe("ventas");
        return {
          select(columnas: string) {
            expect(columnas).toBe("afip_numero");
            return consulta;
          },
        };
      },
    };

    const numero = await observarUltimoNumeroFiscalLocal(admin as never, {
      emisorCuit: "30717322467",
      puntoVenta: 1,
      cbteTipo: 6,
      modo: "HOMOLOGACION",
      simulado: true,
    });

    expect(numero).toBe(913000);
    expect(filtrosNot).toEqual([["afip_numero", "is", null]]);
  });
});

describe("frontera pública de la preview", () => {
  it("una NC no filtra condicionIvaReceptorId desde el snapshot original", () => {
    const receptor = proyectarReceptorFiscalConfirmado({
      razonSocial: "Receptor original",
      domicilio: "Domicilio",
      tipoDocumento: "CUIT",
      numeroDocumento: "30714199664",
      docTipoArca: 80,
      docNroArca: "30714199664",
      condicionIva: "RESPONSABLE_INSCRIPTO",
      origen: "MANUAL",
      origenId: null,
      verificadoArcaAt: null,
      condicionIvaReceptorId: 1,
    });

    expect(receptor).toEqual({
      razonSocial: "Receptor original",
      domicilio: "Domicilio",
      tipoDocumento: "CUIT",
      numeroDocumento: "30714199664",
      docTipoArca: 80,
      docNroArca: "30714199664",
      condicionIva: "RESPONSABLE_INSCRIPTO",
      origen: "MANUAL",
      origenId: null,
      verificadoArcaAt: null,
    });
    expect(receptor).not.toHaveProperty("condicionIvaReceptorId");
  });
});

function preparacion(percepciones = "0.00") {
  return {
    lectura: {
      venta: {
        id: "71000000-0000-4000-8000-000000000001",
        sucursalId: "71000000-0000-4000-8000-000000000301",
        clienteId: null,
        fechaComercial: "2026-08-22T15:00:00.000Z",
        numeroComercial: "V-1",
        tipoComprobante: "VENTA",
        condicionVenta: "CONTADO",
        estado: "ACTIVA",
        subtotalSinIva: "0.15",
        ivaTotal: "0.03",
        percepciones,
        total: percepciones === "0.00" ? "0.18" : "0.20",
        totalPagado: "0.00",
        saldo: percepciones === "0.00" ? "0.18" : "0.20",
        afipEstado: "SIN_FACTURAR",
        afipFase: null,
        afipClaimToken: null,
        afipNumero: null,
        afipVersion: 0,
        afipEmisorCuit: null,
        afipPuntoVenta: null,
        afipCbteTipo: null,
        afipModo: null,
        afipSimulado: false,
        afipValidez: null,
        afipFechaComprobante: null,
        afipImpTotal: null,
        afipSnapshot: null,
        afipSnapshotHash: null,
        afipCbteAsocId: null,
        cae: null,
        caeVencimiento: null,
      },
      items: [
        {
          id: "71000000-0000-4000-8000-000000000011",
          productoId: null,
          codigo: "BORDE",
          descripcion: "Deriva binaria",
          cantidad: "7.25",
          precioUnitarioSinIva: "0.02",
          descuentoPorcentaje: "0.00",
          ivaPorcentaje: "21.00",
          subtotalNeto: "0.15",
          importeIva: "0.03",
          subtotalTotal: "0.18",
        },
      ],
    },
    contexto: {
      emisor: {
        cuit: "30714199664",
        condicion_iva: "RESPONSABLE_INSCRIPTO",
        arca_key_enc: "key",
        arca_cert_enc: "cert",
      },
      emisorImpreso: {
        razon_social: "EMISOR",
        nombre_fantasia: null,
        cuit: "30714199664",
        domicilio_fiscal: "Domicilio",
        condicion_iva: "RESPONSABLE_INSCRIPTO",
        ingresos_brutos: null,
        inicio_actividades: "2020-01-01",
        telefono: null,
      },
      pv: { numero: 5, modo: "HOMOLOGACION" },
      sucursal: {
        id: "71000000-0000-4000-8000-000000000301",
        nombre: "Sucursal",
        telefono: null,
        emisor_id: "71000000-0000-4000-8000-000000000201",
      },
      facturaA: { modalidad: "ESTANDAR_CONFIRMADA", revalidar_at: "2027-01-01" },
    },
    direccionSucursal: "Domicilio sucursal",
    receptor: {
      razonSocial: "Consumidor Final",
      domicilio: null,
      tipoDocumento: "SIN_IDENTIFICAR",
      numeroDocumento: null,
      docTipoArca: 99,
      docNroArca: "0",
      condicionIva: "CONSUMIDOR_FINAL",
      origen: "CLIENTE_COMERCIAL",
      origenId: null,
      verificadoArcaAt: null,
    },
    letra: "B",
    original: null,
  } as const;
}

describe("Snapshot desde lectura PostgreSQL exacta", () => {
  it("conserva el redondeo fixed-point 0.02 × 7.25 = 0.15 sin iva.ts", () => {
    const snapshot = construirSnapshotFiscalDesdeLectura({
      preparacion: preparacion() as never,
      numero: 1,
      fechaComprobante: "2026-08-22",
    });
    expect(snapshot.items[0].subtotalNeto).toBe("0.15");
    expect(snapshot.importeTotal).toBe("0.18");
    expect(validarSnapshotFiscalV2(snapshot)).toEqual(snapshot);
  });

  it("mantiene las percepciones como tributo sin inventar otros impuestos nacionales indirectos", () => {
    const snapshot = construirSnapshotFiscalDesdeLectura({
      preparacion: preparacion("0.02") as never,
      numero: 1,
      fechaComprobante: "2026-08-22",
    });
    expect(snapshot.tributos).toEqual([
      {
        id: 99,
        descripcion: "Percepciones",
        baseImponible: "0.15",
        alicuota: "0.00",
        importe: "0.02",
      },
    ]);
    expect(snapshot.importeTributos).toBe("0.02");
    expect(snapshot.otrosImpuestosNacionalesIndirectos).toBe("0.00");
  });
});

describe("preview autoritativa de una nota de crédito", () => {
  it("hereda los nombres fiscales congelados aunque el emisor y la sucursal vivos se renombren", async () => {
    const base = preparacion();
    const originalPreparacion = {
      ...base,
      contexto: {
        ...base.contexto,
        emisorImpreso: {
          ...base.contexto.emisorImpreso,
          razon_social: "EMISOR ORIGINAL CONGELADO",
        },
        sucursal: {
          ...base.contexto.sucursal,
          nombre: "SUCURSAL ORIGINAL CONGELADA",
        },
      },
    };
    const original = construirSnapshotFiscalDesdeLectura({
      preparacion: originalPreparacion as never,
      numero: 41,
      fechaComprobante: "2026-08-22",
    });

    const lecturaOriginal = {
      ...originalPreparacion.lectura,
      venta: {
        ...originalPreparacion.lectura.venta,
        afipEstado: "APROBADO",
        afipFase: "PERSISTIDO",
        afipSnapshot: original,
        afipSnapshotHash: original.hash,
        afipNumero: original.identidad.numero,
        afipEmisorCuit: original.identidad.emisorCuit,
        afipPuntoVenta: original.identidad.puntoVenta,
        afipCbteTipo: original.identidad.cbteTipo,
        afipModo: original.identidad.modo,
        afipSimulado: original.identidad.simulado,
        afipValidez: original.identidad.validez,
        afipFechaComprobante: original.fechaComprobante,
        afipImpTotal: original.importeTotal,
        cae: "75123456789012",
        caeVencimiento: "2026-09-01",
      },
    };

    const notaId = "71000000-0000-4000-8000-000000000002";
    const lecturaNota = {
      ...originalPreparacion.lectura,
      venta: {
        ...originalPreparacion.lectura.venta,
        id: notaId,
        numeroComercial: "NC-1",
        tipoComprobante: "NOTA_CREDITO",
        clienteId: null,
        afipCbteAsocId: original.venta.id,
      },
    };

    const emisorId = original.emisor.id;
    const sucursalId = original.sucursal.id;
    const admin = {
      async rpc(_nombre: string, argumentos: { p_venta_id: string }) {
        return {
          data: argumentos.p_venta_id === notaId ? lecturaNota : lecturaOriginal,
          error: null,
        };
      },
      from(tabla: string) {
        return {
          select(columnas: string) {
            const consulta = {
              eq() {
                return consulta;
              },
              async maybeSingle() {
                if (tabla === "sucursales" && columnas === "direccion") {
                  return { data: { direccion: "DOMICILIO VIVO" }, error: null };
                }
                if (tabla === "sucursales") {
                  return {
                    data: {
                      id: sucursalId,
                      nombre: "SUCURSAL RENOMBRADA EN VIVO",
                      telefono: "3510000000",
                      emisor_id: emisorId,
                      emisor: {
                        id: emisorId,
                        razon_social: "EMISOR RENOMBRADO EN VIVO",
                        nombre_fantasia: "Nombre vivo",
                        cuit: original.identidad.emisorCuit,
                        domicilio_fiscal: "DOMICILIO VIVO",
                        condicion_iva: "RESPONSABLE_INSCRIPTO",
                        ingresos_brutos: "123",
                        inicio_actividades: "2020-01-01",
                        factura_a_modalidad: "ESTANDAR_CONFIRMADA",
                        factura_a_revalidar_at: "2027-01-01",
                      },
                    },
                    error: null,
                  };
                }
                if (tabla === "puntos_venta") {
                  return {
                    data: {
                      sucursal_id: sucursalId,
                      emisor_id: emisorId,
                      numero: original.identidad.puntoVenta,
                      modo: original.identidad.modo,
                      activo: true,
                    },
                    error: null,
                  };
                }
                if (tabla === "credenciales_arca") {
                  return {
                    data: {
                      emisor_id: emisorId,
                      ambiente: original.identidad.modo,
                      arca_key_enc: "key",
                      arca_cert_enc: "cert",
                      habilitada: true,
                    },
                    error: null,
                  };
                }
                throw new Error(`Consulta inesperada a ${tabla}.`);
              },
            };
            return consulta;
          },
        };
      },
    };

    const dependencias = crearDependenciasEmisionFiscalServer({
      admin: admin as never,
      usuario: { from: () => Promise.reject(new Error("consulta inesperada")) } as never,
      ventaIdAutorizada: notaId,
      validarModalidadFacturaA: false,
    });
    const preparacionRuntime = await dependencias.prepararEmision({
      ventaId: notaId,
      receptor: { origen: "COMPROBANTE_ORIGINAL" },
    });
    expect(preparacionRuntime.confirmacionAutoritativa).toMatchObject({
      emisorRazonSocial: "EMISOR ORIGINAL CONGELADO",
      sucursalNombre: "SUCURSAL ORIGINAL CONGELADA",
    });

    const preview = await previsualizarVentaFiscalExistente({
      ventaId: notaId,
      receptor: { origen: "COMPROBANTE_ORIGINAL" },
      admin: admin as never,
      usuario: { from: () => Promise.reject(new Error("consulta inesperada")) } as never,
    });

    expect(preview.emisor_razon_social).toBe("EMISOR ORIGINAL CONGELADO");
    expect(preview.sucursal_nombre).toBe("SUCURSAL ORIGINAL CONGELADA");
    expect(preview.confirmacion_autoritativa).toMatchObject({
      emisorRazonSocial: "EMISOR ORIGINAL CONGELADO",
      sucursalNombre: "SUCURSAL ORIGINAL CONGELADA",
    });
    expect(preview.huella_confirmacion).toBe(
      crearHuellaConfirmacionFiscal({
        ...preview.confirmacion_autoritativa,
        emisorRazonSocial: "EMISOR ORIGINAL CONGELADO",
        sucursalNombre: "SUCURSAL ORIGINAL CONGELADA",
      }),
    );
  });
});

function reservaCongelada(): ReservaFiscalPersistida {
  const frozen = construirSnapshotFiscalDesdeLectura({
    preparacion: preparacion() as never,
    numero: 42,
    fechaComprobante: "2026-08-22",
  });
  return {
    ventaId: frozen.venta.id,
    claimToken: "81000000-0000-4000-8000-000000000001",
    afipVersion: 4,
    numero: frozen.identidad.numero,
    snapshot: frozen,
    payloadHash: frozen.hash,
    emisorCuit: frozen.identidad.emisorCuit,
    puntoVenta: frozen.identidad.puntoVenta,
    cbteTipo: frozen.identidad.cbteTipo,
    modo: frozen.identidad.modo,
  };
}

describe("credencial ARCA congelada después de reservar", () => {
  it("ignora la asignación viva editada y carga por snapshot.emisor.id + modo congelado", async () => {
    const reserva = reservaCongelada();
    const lecturas: string[] = [];

    const contexto = await cargarContextoArcaCongelado(reserva, {
      cargarEmisor: async (id) => {
        lecturas.push(`emisor:${id}`);
        return { id, cuit: "30714199664" };
      },
      cargarCredencial: async (emisorId, modo) => {
        lecturas.push(`credencial:${emisorId}:${modo}`);
        return {
          emisorId,
          ambiente: modo,
          arcaKeyEnc: "key-congelada",
          arcaCertEnc: "cert-congelado",
        };
      },
    });

    expect(lecturas).toEqual([
      "emisor:71000000-0000-4000-8000-000000000201",
      "credencial:71000000-0000-4000-8000-000000000201:HOMOLOGACION",
    ]);
    expect(contexto).toEqual({
      emisor: {
        cuit: "30714199664",
        arca_key_enc: "key-congelada",
        arca_cert_enc: "cert-congelado",
      },
      pv: { numero: 5, modo: "HOMOLOGACION" },
      cbteTipo: 6,
      numero: 42,
    });
  });

  it.each([
    ["emisor faltante", async () => null, async () => null],
    [
      "CUIT del emisor distinto",
      async (id: string) => ({ id, cuit: "30717322467" }),
      async () => null,
    ],
    ["credencial faltante", async (id: string) => ({ id, cuit: "30714199664" }), async () => null],
    [
      "credencial de otro ambiente",
      async (id: string) => ({ id, cuit: "30714199664" }),
      async (emisorId: string) => ({
        emisorId,
        ambiente: "PRODUCCION" as const,
        arcaKeyEnc: "key",
        arcaCertEnc: "cert",
      }),
    ],
  ])("falla cerrado ante %s", async (_caso, cargarEmisor, cargarCredencial) => {
    await expect(
      cargarContextoArcaCongelado(reservaCongelada(), {
        cargarEmisor,
        cargarCredencial,
      } as never),
    ).rejects.toThrow(/emisor|CUIT|credencial|ambiente/i);
  });

  it("rechaza una reserva cuya PV/tipo/número no coincide con el snapshot", async () => {
    const reserva = reservaCongelada();
    reserva.puntoVenta = 99;

    await expect(
      cargarContextoArcaCongelado(reserva, {
        cargarEmisor: async (id) => ({ id, cuit: "30714199664" }),
        cargarCredencial: async (emisorId, ambiente) => ({
          emisorId,
          ambiente,
          arcaKeyEnc: "key",
          arcaCertEnc: "cert",
        }),
      }),
    ).rejects.toThrow(/identidad.*congelada|reserva/i);
  });
});

describe("preview provisional de borrador", () => {
  it("resuelve catálogo/receptor/contexto y devuelve todos los campos sin escribir", async () => {
    const resultado = await construirPreviewBorradorFiscalProvisional(
      {
        sucursalId: "71000000-0000-4000-8000-000000000301",
        clienteId: "71000000-0000-4000-8000-000000000401",
        fechaComercial: "2026-08-10T15:00:00.000Z",
        items: [
          {
            producto_id: "71000000-0000-4000-8000-000000000501",
            cantidad: 7.25,
            descuento_porcentaje: 0,
            precio_unitario_sin_iva: 0.02,
          },
        ],
        pagos: [{ forma_pago: "EFECTIVO", monto: 0.1, detalle: {} }],
        percepciones: 0.02,
        receptor: { origen: "CLIENTE_COMERCIAL" },
      },
      {
        cargarContexto: async () => preparacion().contexto as never,
        cargarCliente: async () => ({
          id: "71000000-0000-4000-8000-000000000401",
          razonSocial: "Consumidor Final",
          cuitDni: null,
          tipo: "CONSUMIDOR_FINAL",
          direccion: null,
        }),
        cargarProductos: async () => [
          {
            id: "71000000-0000-4000-8000-000000000501",
            activo: true,
            precioSinIva: 999,
            ivaPorcentaje: 21,
          },
        ],
        cargarFavorito: async () => null,
        ahora: () => new Date("2026-08-22T15:00:00.000Z"),
      },
    );

    expect(resultado).toMatchObject({
      autoritativo: false,
      requiere_reconfirmacion_post_creacion: true,
      comprador: "71000000-0000-4000-8000-000000000401",
      letra: "B",
      emisor_cuit: "30714199664",
      emisor_razon_social: "EMISOR",
      sucursal_id: "71000000-0000-4000-8000-000000000301",
      sucursal_nombre: "Sucursal",
      punto_venta: 5,
      modo: "HOMOLOGACION",
      cbte_tipo: 6,
      fecha_comercial: "2026-08-10T15:00:00.000Z",
      fecha_fiscal: "2026-08-22",
      demora_dias: 12,
      total: "0.20",
      pagado: "0.10",
      saldo: "0.10",
    });
    expect(resultado.receptor.tipoDocumento).toBe("SIN_IDENTIFICAR");
    expect(resultado.confirmacion_provisional).toMatchObject({
      version: 1,
      importe: "0.20",
      emisor_cuit: "30714199664",
      emisor_razon_social: "EMISOR",
      sucursal_id: "71000000-0000-4000-8000-000000000301",
      sucursal_nombre: "Sucursal",
      punto_venta: 5,
      letra: "B",
      cbte_tipo: 6,
      fecha_fiscal: "2026-08-22",
    });
  });

  it("falla cerrado si el catálogo no resuelve exactamente todos los productos", async () => {
    await expect(
      construirPreviewBorradorFiscalProvisional(
        {
          sucursalId: "71000000-0000-4000-8000-000000000301",
          clienteId: "71000000-0000-4000-8000-000000000401",
          fechaComercial: "2026-08-22T15:00:00.000Z",
          items: [
            {
              producto_id: "71000000-0000-4000-8000-000000000501",
              cantidad: 1,
              descuento_porcentaje: 0,
            },
          ],
          pagos: [],
          percepciones: 0,
          receptor: { origen: "CLIENTE_COMERCIAL" },
        },
        {
          cargarContexto: async () => preparacion().contexto as never,
          cargarCliente: async () => ({
            id: "71000000-0000-4000-8000-000000000401",
            razonSocial: "Consumidor Final",
            cuitDni: null,
            tipo: "CONSUMIDOR_FINAL",
            direccion: null,
          }),
          cargarProductos: async () => [],
          cargarFavorito: async () => null,
          ahora: () => new Date("2026-08-22T15:00:00.000Z"),
        },
      ),
    ).rejects.toThrow(/producto.*activo/i);
  });
});

const CONFIRMACION_BASE: ConfirmacionFiscalPostBorrador = {
  version: 1,
  importe: "0.20",
  emisorCuit: "30714199664",
  emisorRazonSocial: "EMISOR",
  sucursalId: "71000000-0000-4000-8000-000000000301",
  sucursalNombre: "Sucursal",
  puntoVenta: 5,
  modo: "HOMOLOGACION",
  letra: "B",
  cbteTipo: 6,
  fechaFiscal: "2026-08-22",
  receptor: {
    razonSocial: "Consumidor Final",
    domicilio: null,
    tipoDocumento: "SIN_IDENTIFICAR",
    numeroDocumento: null,
    docTipoArca: 99,
    docNroArca: "0",
    condicionIva: "CONSUMIDOR_FINAL",
    origen: "CLIENTE_COMERCIAL",
    origenId: null,
    verificadoArcaAt: null,
  },
};

function confirmacionesDistintas(): Array<[string, ConfirmacionFiscalPostBorrador]> {
  const cambiar = (
    nombre: string,
    mutar: (confirmacion: ConfirmacionFiscalPostBorrador) => void,
  ): [string, ConfirmacionFiscalPostBorrador] => {
    const confirmacion = structuredClone(CONFIRMACION_BASE);
    mutar(confirmacion);
    return [nombre, confirmacion];
  };
  return [
    cambiar("importe", (c) => (c.importe = "0.21")),
    cambiar("emisor CUIT", (c) => (c.emisorCuit = "30717322467")),
    cambiar("razón social del emisor", (c) => (c.emisorRazonSocial = "OTRO EMISOR")),
    cambiar("identidad de sucursal", (c) => {
      c.sucursalId = "71000000-0000-4000-8000-000000000302";
    }),
    cambiar("nombre de sucursal", (c) => (c.sucursalNombre = "Otra sucursal")),
    cambiar("punto de venta", (c) => (c.puntoVenta = 6)),
    cambiar("modo", (c) => (c.modo = "PRODUCCION")),
    cambiar("letra", (c) => (c.letra = "A")),
    cambiar("CbteTipo", (c) => (c.cbteTipo = 1)),
    cambiar("fecha fiscal", (c) => (c.fechaFiscal = "2026-08-23")),
    cambiar("receptor.razonSocial", (c) => (c.receptor.razonSocial = "Otro receptor")),
    cambiar("receptor.domicilio", (c) => (c.receptor.domicilio = "Otra calle")),
    cambiar("receptor.tipoDocumento", (c) => (c.receptor.tipoDocumento = "DNI")),
    cambiar("receptor.numeroDocumento", (c) => (c.receptor.numeroDocumento = "30111222")),
    cambiar("receptor.docTipoArca", (c) => (c.receptor.docTipoArca = 96)),
    cambiar("receptor.docNroArca", (c) => (c.receptor.docNroArca = "30111222")),
    cambiar("receptor.condicionIva", (c) => (c.receptor.condicionIva = "EXENTO")),
    cambiar("receptor.origen", (c) => (c.receptor.origen = "MANUAL")),
    cambiar("receptor.origenId", (c) => (c.receptor.origenId = "receptor-1")),
    cambiar("receptor.verificadoArcaAt", (c) => (c.receptor.verificadoArcaAt = "2026-08-22")),
  ];
}

describe("handshake post-creación del borrador", () => {
  it("produce SHA-256 canónico de la tupla completa", () => {
    expect(crearHuellaConfirmacionFiscal(CONFIRMACION_BASE)).toBe(
      "6ecf3ab99ba65e986269c2f0a56243c4087e4dfea9e95aedf3e0a3c73f08b19d",
    );
  });

  it.each(confirmacionesDistintas())("cambia la huella si cambia %s", (_campo, confirmacion) => {
    expect(crearHuellaConfirmacionFiscal(confirmacion)).not.toBe(
      crearHuellaConfirmacionFiscal(CONFIRMACION_BASE),
    );
  });
});
