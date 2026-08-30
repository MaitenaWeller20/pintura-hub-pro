import { describe, expect, it, vi } from "vitest";
import {
  confirmarCierreFiscalInmediato,
  camposExportacionReceptorFiscal,
  crearControlCreacionVenta,
  describirCaeLegacy,
  leerComprobanteAsociadoFiscal,
  leerReceptorFiscalCongelado,
  opcionesCierreVenta,
  puedeOfrecerEmisionLegacy,
  receptorFiscalDifiereDelComprador,
  registrarVentaSinFactura,
  requiereAdvertenciaAnulacionProduccion,
  resultadoColaDespuesDeEmision,
  resumirCierreVenta,
  textoBusquedaVenta,
  ventaCoincideBusqueda,
} from "./ventas-ui";

const FLAGS_V2 = {
  facturacionV2Habilitada: true,
  facturacionLegacyHabilitada: false,
} as const;

const FLAGS_LEGACY = {
  facturacionV2Habilitada: false,
  facturacionLegacyHabilitada: true,
} as const;

const FLAGS_MANTENIMIENTO = {
  facturacionV2Habilitada: false,
  facturacionLegacyHabilitada: false,
} as const;

describe("decisión de cierre de venta", () => {
  it("ofrece los dos cierres únicamente para la venta neutral con capacidad fiscal", () => {
    expect(
      opcionesCierreVenta({
        ...FLAGS_V2,
        puedeFacturar: true,
        tipoComprobante: "VENTA",
      }),
    ).toEqual({
      tipoPersistido: "VENTA",
      bloqueado: false,
      explicacion: null,
      acciones: [
        { id: "REGISTRAR_Y_FACTURAR", etiqueta: "Registrar venta y facturar" },
        { id: "REGISTRAR_SIN_FACTURAR", etiqueta: "Registrar sin facturar" },
      ],
    });

    for (const tipoComprobante of [
      "FACTURA_A",
      "FACTURA_B",
      "FACTURA_C",
      "REMITO",
      "REMITO_OBRA",
      "FAC_INTERNA_CTA_CTE",
      "NOTA_CREDITO",
      "NOTA_DEBITO",
    ] as const) {
      expect(
        opcionesCierreVenta({
          ...FLAGS_V2,
          puedeFacturar: true,
          tipoComprobante,
        }).acciones,
      ).toEqual([{ id: "REGISTRAR_UNICO", etiqueta: "Guardar" }]);
    }
  });

  it("una persona sin capacidad sólo registra y entiende por qué no puede emitir", () => {
    expect(
      opcionesCierreVenta({
        ...FLAGS_V2,
        puedeFacturar: false,
        tipoComprobante: "VENTA",
      }),
    ).toEqual({
      tipoPersistido: "VENTA",
      bloqueado: false,
      explicacion:
        "La venta quedará en la cola. Necesitás el permiso Puede facturar para emitirla.",
      acciones: [{ id: "REGISTRAR_SIN_FACTURAR", etiqueta: "Registrar sin facturar" }],
    });
  });

  it("mantiene el escritor y selector A/B legacy mientras sólo ese rollout está activo", () => {
    expect(
      opcionesCierreVenta({
        ...FLAGS_LEGACY,
        puedeFacturar: true,
        tipoComprobante: "FACTURA_A",
      }),
    ).toEqual({
      tipoPersistido: "FACTURA_A",
      bloqueado: false,
      explicacion: null,
      acciones: [{ id: "REGISTRAR_LEGACY", etiqueta: "Guardar" }],
    });
    expect(
      opcionesCierreVenta({
        ...FLAGS_LEGACY,
        puedeFacturar: true,
        tipoComprobante: "FACTURA_B",
      }).tipoPersistido,
    ).toBe("FACTURA_B");
  });

  it("frena una venta positiva antes de mutarla durante mantenimiento y deja operar internos/notas", () => {
    expect(
      opcionesCierreVenta({
        ...FLAGS_MANTENIMIENTO,
        puedeFacturar: true,
        tipoComprobante: "VENTA",
      }),
    ).toEqual({
      tipoPersistido: "VENTA",
      bloqueado: true,
      explicacion: "La facturación está en mantenimiento. No se registró la venta ni el cobro.",
      acciones: [],
    });
    expect(
      opcionesCierreVenta({
        ...FLAGS_MANTENIMIENTO,
        puedeFacturar: true,
        tipoComprobante: "REMITO",
      }).acciones,
    ).toEqual([{ id: "REGISTRAR_UNICO", etiqueta: "Guardar" }]);
  });

  it("rechaza el cuadrante inválido con ambos escritores activos", () => {
    expect(() =>
      opcionesCierreVenta({
        facturacionV2Habilitada: true,
        facturacionLegacyHabilitada: true,
        puedeFacturar: true,
        tipoComprobante: "VENTA",
      }),
    ).toThrow(/ambos escritores/i);
  });
});

describe("resumen y resultado fiscal", () => {
  it("factura el total comercial aunque ahora se cobre sólo una parte o quede en cuenta corriente", () => {
    expect(resumirCierreVenta({ total: 1_210, pagadoAhora: 210, esCtaCte: false })).toEqual({
      total: 1_210,
      pagadoAhora: 210,
      saldo: 1_000,
      esCtaCte: false,
      totalFiscal: 1_210,
    });
    expect(resumirCierreVenta({ total: 1_210, pagadoAhora: 0, esCtaCte: true })).toEqual({
      total: 1_210,
      pagadoAhora: 0,
      saldo: 1_210,
      esCtaCte: true,
      totalFiscal: 1_210,
    });
  });

  it.each([
    ["APROBADO", "factura_aprobada"],
    ["ERROR_CORREGIBLE", "venta_creada_factura_pendiente"],
    ["MANTENIMIENTO", "venta_creada_factura_pendiente"],
    ["RECONCILIAR", "venta_creada_requiere_revision"],
    ["BLOQUEADO", "venta_creada_requiere_revision"],
    ["EN_CURSO", "venta_creada_requiere_revision"],
    ["TRANSPORTE_INCIERTO", "venta_creada_requiere_revision"],
  ] as const)("mapea %s al resultado de cola exacto", (estado, resultado) => {
    expect(resultadoColaDespuesDeEmision(estado)).toBe(resultado);
  });
});

describe("receptor fiscal congelado en el listado", () => {
  const venta = {
    numero_comprobante: "V-0042",
    cliente: { razon_social: "COMPRADOR COMERCIAL", cuit_dni: "30111222333" },
    fiscalPresentacion: {
      receptor: {
        razonSocial: "RECEPTOR FISCAL CONGELADO",
        tipoDocumento: "CUIT",
        numeroDocumento: "30714199664",
        condicionIva: "RESPONSABLE_INSCRIPTO",
        domicilio: "Belgrano 500, Córdoba",
      },
      comprobanteAsociado: null,
    },
    afip_snapshot: {
      version: 2,
      receptor: {
        razonSocial: "RECEPTOR FISCAL CONGELADO",
        tipoDocumento: "CUIT",
        numeroDocumento: "30714199664",
        condicionIva: "RESPONSABLE_INSCRIPTO",
        domicilio: "Belgrano 500, Córdoba",
      },
    },
    // Un favorito vivo no puede alterar lo que muestra, busca ni exporta la venta emitida.
    receptor_fiscal: {
      razon_social: "FAVORITO VIVO MUTADO",
      numero_documento: "30504480917",
    },
  };

  it("lee exclusivamente el receptor copiado al snapshot y detecta comprador distinto", () => {
    expect(leerReceptorFiscalCongelado(venta.afip_snapshot)).toEqual({
      razonSocial: "RECEPTOR FISCAL CONGELADO",
      tipoDocumento: "CUIT",
      numeroDocumento: "30714199664",
      condicionIva: "RESPONSABLE_INSCRIPTO",
      domicilio: "Belgrano 500, Córdoba",
    });
    expect(receptorFiscalDifiereDelComprador(venta)).toBe(true);
  });

  it("consume la proyección fiscal cerrada aunque el browser no reciba el snapshot", () => {
    const { afip_snapshot: _omitido, ...ventaSinSnapshot } = venta;
    expect(receptorFiscalDifiereDelComprador(ventaSinSnapshot)).toBe(true);
    expect(textoBusquedaVenta(ventaSinSnapshot)).toContain("receptor fiscal congelado");
    expect(camposExportacionReceptorFiscal(ventaSinSnapshot)).toEqual({
      "Receptor fiscal": "RECEPTOR FISCAL CONGELADO",
      "Documento receptor fiscal": "CUIT 30714199664",
    });
  });

  it("incorpora receptor y documento congelados a búsqueda y exportación", () => {
    expect(textoBusquedaVenta(venta)).toContain("receptor fiscal congelado");
    expect(textoBusquedaVenta(venta)).toContain("30714199664");
    expect(textoBusquedaVenta(venta)).not.toContain("favorito vivo mutado");
    expect(camposExportacionReceptorFiscal(venta)).toEqual({
      "Receptor fiscal": "RECEPTOR FISCAL CONGELADO",
      "Documento receptor fiscal": "CUIT 30714199664",
    });
  });

  it("encuentra un CUIT congelado aunque la búsqueda use guiones", () => {
    expect(ventaCoincideBusqueda(venta, "30-71419966-4")).toBe(true);
    expect(ventaCoincideBusqueda(venta, "receptor fiscal")).toBe(true);
    expect(ventaCoincideBusqueda(venta, "favorito vivo mutado")).toBe(false);
  });

  it("no duplica al receptor cuando coincide con el comprador comercial", () => {
    expect(
      receptorFiscalDifiereDelComprador({
        ...venta,
        cliente: {
          razon_social: "Receptor Fiscal Congelado",
          cuit_dni: "30-71419966-4",
        },
      }),
    ).toBe(false);
  });
});

describe("evidencia y validez fiscal legacy", () => {
  it("presenta un CAE de homologacion como prueba sin validez legal", () => {
    expect(
      describirCaeLegacy({
        cae: "74123456789012",
        afip_validez: "HOMOLOGACION",
        afip_modo: "HOMOLOGACION",
        afip_simulado: false,
        afip_punto_venta: 5,
        afip_numero: 42,
      }),
    ).toEqual({
      tone: "warning",
      detalle: "homologación — sin validez legal",
      title: "CAE obtenido en homologación: es una prueba y no tiene validez legal.",
    });
  });

  it("la validez explícita manda sobre flags legacy contradictorios", () => {
    expect(
      describirCaeLegacy({
        cae: "74123456789012",
        afip_validez: "SIMULADA",
        afip_modo: "PRODUCCION",
        afip_simulado: false,
        afip_punto_venta: 5,
        afip_numero: 42,
      }),
    ).toMatchObject({ tone: "warning", detalle: "simulado — sin validez legal" });
  });

  it("sólo advierte que AFIP conserva validez cuando la emisión efectiva fue producción", () => {
    const base = { cae: "74123456789012", afip_simulado: false };
    expect(
      requiereAdvertenciaAnulacionProduccion({
        ...base,
        afip_validez: "PRODUCCION",
        afip_modo: "PRODUCCION",
      }),
    ).toBe(true);
    expect(
      requiereAdvertenciaAnulacionProduccion({
        ...base,
        afip_validez: "HOMOLOGACION",
        afip_modo: "HOMOLOGACION",
      }),
    ).toBe(false);
    expect(
      requiereAdvertenciaAnulacionProduccion({
        ...base,
        afip_validez: "SIMULADA",
        afip_modo: "PRODUCCION",
      }),
    ).toBe(false);
  });

  it("lee del snapshot la asociación fiscal exacta de una nota", () => {
    expect(
      leerComprobanteAsociadoFiscal({
        version: 2,
        cbtesAsoc: [
          {
            tipo: 1,
            puntoVenta: 5,
            numero: 913002,
            cuit: "30714199664",
            fecha: "2026-08-21",
          },
        ],
      }),
    ).toEqual({
      tipo: 1,
      puntoVenta: 5,
      numero: 913002,
      cuit: "30714199664",
      fecha: "2026-08-21",
      letra: "A",
      titulo: "Factura",
    });
  });

  it("rechaza asociaciones incompletas en lugar de inventar evidencia", () => {
    expect(
      leerComprobanteAsociadoFiscal({
        cbtesAsoc: [{ tipo: 1, puntoVenta: 5, numero: 0, fecha: "21/08/2026" }],
      }),
    ).toBeNull();
  });
});

describe("oferta de emisión legacy", () => {
  const hoy = new Date("2026-08-23T15:00:00.000Z");

  it("falla cerrado cuando el perfil no tiene capacidad fiscal", () => {
    expect(
      puedeOfrecerEmisionLegacy(
        {
          puedeFacturar: false,
          isAdmin: false,
          fecha: "2026-08-23T12:00:00.000Z",
        },
        hoy,
      ),
    ).toBe(false);
  });

  it("oculta una venta demorada a empleados y la conserva para administración", () => {
    const antigua = "2026-08-16T12:00:00.000Z";
    expect(
      puedeOfrecerEmisionLegacy({ puedeFacturar: true, isAdmin: false, fecha: antigua }, hoy),
    ).toBe(false);
    expect(
      puedeOfrecerEmisionLegacy({ puedeFacturar: true, isAdmin: true, fecha: antigua }, hoy),
    ).toBe(true);
  });

  it("permite a un perfil habilitado emitir una venta dentro de ventana", () => {
    expect(
      puedeOfrecerEmisionLegacy(
        {
          puedeFacturar: true,
          isAdmin: false,
          fecha: "2026-08-22T12:00:00.000Z",
        },
        hoy,
      ),
    ).toBe(true);
  });
});

describe("creación comercial idempotente antes de emitir", () => {
  it("registrar sin factura crea una sola vez y devuelve la URL exacta sin pedir receptor ni ARCA", async () => {
    const control = crearControlCreacionVenta();
    const crearVenta = vi.fn(async (idempotencyKey: string) => {
      expect(idempotencyKey).toBe("71000000-0000-4000-8000-000000000001");
      return { id: "72000000-0000-4000-8000-000000000001" };
    });

    const [primera, dobleClick] = await Promise.all([
      registrarVentaSinFactura(control, "71000000-0000-4000-8000-000000000001", crearVenta),
      registrarVentaSinFactura(control, "71000000-0000-4000-8000-000000000001", crearVenta),
    ]);

    expect(crearVenta).toHaveBeenCalledTimes(1);
    expect(primera).toEqual({
      ventaId: "72000000-0000-4000-8000-000000000001",
      href: "/facturacion/cola?venta=72000000-0000-4000-8000-000000000001&resultado=venta_creada_factura_pendiente",
    });
    expect(dobleClick).toEqual(primera);
  });

  it("preview confirmada crea una vez, conserva el ID y la segunda confirmación sólo reenvía la nueva huella", async () => {
    const control = crearControlCreacionVenta();
    const crearVenta = vi.fn(async () => ({
      id: "72000000-0000-4000-8000-000000000002",
    }));
    const emitirPostBorrador = vi
      .fn()
      .mockResolvedValueOnce({
        estado: "RECONFIRMACION_REQUERIDA",
        huella_confirmacion: "b".repeat(64),
      })
      .mockResolvedValueOnce({ estado: "APROBADO", cae: "74111111111111" });

    const primera = await confirmarCierreFiscalInmediato(
      {
        control,
        idempotencyKey: "71000000-0000-4000-8000-000000000002",
        receptor: { origen: "CLIENTE_COMERCIAL" },
        letraSolicitada: "A",
        confirmaVentaAntigua: false,
        huellaConfirmacion: "a".repeat(64),
      },
      { crearVenta, emitirPostBorrador },
    );
    const segunda = await confirmarCierreFiscalInmediato(
      {
        control,
        idempotencyKey: "71000000-0000-4000-8000-000000000002",
        receptor: { origen: "CLIENTE_COMERCIAL" },
        letraSolicitada: "B",
        confirmaVentaAntigua: false,
        huellaConfirmacion: "b".repeat(64),
      },
      { crearVenta, emitirPostBorrador },
    );

    expect(primera).toMatchObject({ estado: "RECONFIRMACION_REQUERIDA" });
    expect(segunda).toMatchObject({ estado: "APROBADO" });
    expect(crearVenta).toHaveBeenCalledTimes(1);
    expect(emitirPostBorrador).toHaveBeenNthCalledWith(1, {
      ventaId: "72000000-0000-4000-8000-000000000002",
      receptor: { origen: "CLIENTE_COMERCIAL" },
      letraSolicitada: "A",
      confirmaVentaAntigua: false,
      huellaConfirmacion: "a".repeat(64),
    });
    expect(emitirPostBorrador).toHaveBeenNthCalledWith(2, {
      ventaId: "72000000-0000-4000-8000-000000000002",
      receptor: { origen: "CLIENTE_COMERCIAL" },
      letraSolicitada: "B",
      confirmaVentaAntigua: false,
      huellaConfirmacion: "b".repeat(64),
    });
  });

  it("ante respuesta perdida no afirma que la venta no existe, no emite y permite reintentar la misma clave", async () => {
    const control = crearControlCreacionVenta();
    const crearVenta = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce({ id: "72000000-0000-4000-8000-000000000003" });
    const emitirPostBorrador = vi.fn(async () => ({ estado: "APROBADO" }));
    const input = {
      control,
      idempotencyKey: "71000000-0000-4000-8000-000000000003",
      receptor: { origen: "CLIENTE_COMERCIAL" as const },
      letraSolicitada: "B" as const,
      confirmaVentaAntigua: false,
      huellaConfirmacion: "c".repeat(64),
    };

    const intento = confirmarCierreFiscalInmediato(input, { crearVenta, emitirPostBorrador });
    await expect(intento).rejects.toThrow(/no se pudo confirmar si la venta quedó registrada/i);
    await expect(intento).rejects.toThrow(/no repitas la venta ni el cobro/i);
    await expect(intento).rejects.toThrow(/cola de facturación/i);
    await expect(intento).rejects.not.toThrow(/venta no creada/i);
    expect(emitirPostBorrador).not.toHaveBeenCalled();

    await confirmarCierreFiscalInmediato(input, { crearVenta, emitirPostBorrador });
    expect(crearVenta).toHaveBeenCalledTimes(2);
    expect(emitirPostBorrador).toHaveBeenCalledTimes(1);
  });
});
