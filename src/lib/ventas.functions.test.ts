import { describe, expect, it, vi } from "vitest";
import { previewInputSchema } from "./fiscal.functions";
import {
  anulacionVentaInputSchema,
  conversionPresupuestoInputSchema,
  ejecutarCreacionNotaSegunFlags,
  ejecutarConversionPresupuestoSegunFlags,
  ejecutarConversionPresupuestoCerrada,
  ejecutarListadoComprobantesOriginalesSeguro,
  ejecutarListadoVentasSeguro,
  ejecutarLecturaOriginalFiscalAutorizada,
  normalizarConversion,
  ventaInputSchema,
} from "./ventas.functions";

const VENTA_BASE = {
  sucursal_id: "71000000-0000-4000-8000-000000000001",
  cliente_id: "72000000-0000-4000-8000-000000000001",
  tipo_comprobante: "VENTA",
  condicion_venta: "CONTADO",
  items: [
    {
      producto_id: "73000000-0000-4000-8000-000000000001",
      cantidad: 1,
      descuento_porcentaje: 0,
    },
  ],
  pagos: [{ forma_pago: "EFECTIVO", monto: 121, detalle: {} }],
  idempotency_key: "74000000-0000-4000-8000-000000000001",
} as const;

function textoProfundo(value: unknown, vistos = new Set<unknown>()): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || vistos.has(value)) return "";
  vistos.add(value);
  return Reflect.ownKeys(value)
    .flatMap((key) => [String(key), textoProfundo(Reflect.get(value, key), vistos)])
    .join(" ");
}

describe("entrada de venta neutral", () => {
  it("acepta VENTA de forma explícita sin abrir la enum a valores desconocidos", () => {
    expect(ventaInputSchema.parse(VENTA_BASE).tipo_comprobante).toBe("VENTA");
    expect(() =>
      ventaInputSchema.parse({ ...VENTA_BASE, tipo_comprobante: "FACTURA_LIBRE" }),
    ).toThrow();
  });

  it("normaliza sólo la descripción presente sin alterar los datos comerciales", () => {
    const parsed = ventaInputSchema.parse({
      ...VENTA_BASE,
      items: [
        {
          ...VENTA_BASE.items[0],
          descripcion: "  Base 10 L\t(Código 1234)  ",
          precio_unitario_sin_iva: 98.75,
          iva_porcentaje: 21,
        },
      ],
    });

    expect(parsed.items[0]).toEqual({
      producto_id: VENTA_BASE.items[0].producto_id,
      cantidad: 1,
      descuento_porcentaje: 0,
      descripcion: "Base 10 L (Código 1234)",
      precio_unitario_sin_iva: 98.75,
      iva_porcentaje: 21,
    });
    expect(ventaInputSchema.parse(VENTA_BASE).items[0]).not.toHaveProperty("descripcion");
  });

  it("rechaza una descripción presente vacía o mayor a 160 caracteres", () => {
    for (const descripcion of [" \t ", "x".repeat(161)]) {
      expect(() =>
        ventaInputSchema.parse({
          ...VENTA_BASE,
          items: [{ ...VENTA_BASE.items[0], descripcion }],
        }),
      ).toThrow();
    }
  });

  it("deja pasar el texto histórico de una NC vinculada para que V2 lo ignore", () => {
    const historica = `Factura histórica ${"x".repeat(180)}`;
    const parsed = ventaInputSchema.parse({
      ...VENTA_BASE,
      tipo_comprobante: "NOTA_CREDITO",
      cbte_asoc_id: "78000000-0000-4000-8000-000000000001",
      items: [{ ...VENTA_BASE.items[0], descripcion: historica }],
    });
    expect(parsed.items[0]?.descripcion).toBe(historica);
  });
});

describe("borrador fiscal con descripción congelable", () => {
  const borrador = {
    origen: "BORRADOR" as const,
    sucursal_id: "71000000-0000-4000-8000-000000000001",
    cliente_id: "72000000-0000-4000-8000-000000000001",
    fecha_comercial: "2026-08-30T12:00:00.000Z",
    items: [
      {
        producto_id: "73000000-0000-4000-8000-000000000001",
        cantidad: 2,
        descuento_porcentaje: 5,
        precio_unitario_sin_iva: 98.75,
      },
    ],
    pagos: [],
    percepciones: 0,
    receptor: { origen: "CLIENTE_COMERCIAL" as const },
    letra_solicitada: "B" as const,
  };

  it("conserva normalizada la descripción presente sin usarla para los importes", () => {
    const parsed = previewInputSchema.parse({
      ...borrador,
      items: [{ ...borrador.items[0], descripcion: "  Base 10 L\n(Código 1234) " }],
    });
    if (parsed.origen !== "BORRADOR") throw new Error("fixture fiscal incorrecto");

    expect(parsed.items[0]).toEqual({
      ...borrador.items[0],
      descripcion: "Base 10 L (Código 1234)",
    });
    expect(previewInputSchema.parse(borrador)).toMatchObject({ items: borrador.items });
  });

  it("rechaza la descripción fiscal presente vacía o mayor a 160 caracteres", () => {
    for (const descripcion of ["\t ", "😀".repeat(161)]) {
      expect(() =>
        previewInputSchema.parse({
          ...borrador,
          items: [{ ...borrador.items[0], descripcion }],
        }),
      ).toThrow();
    }
  });
});

describe("anulación idempotente", () => {
  const ventaId = "75000000-0000-4000-8000-000000000001";
  const clave = "75000000-0000-4000-8000-000000000002";

  it("exige una clave UUID estable además de la venta", () => {
    expect(anulacionVentaInputSchema.parse({ venta_id: ventaId, idempotency_key: clave })).toEqual({
      venta_id: ventaId,
      idempotency_key: clave,
    });
    expect(() => anulacionVentaInputSchema.parse({ venta_id: ventaId })).toThrow();
    expect(() =>
      anulacionVentaInputSchema.parse({ venta_id: ventaId, idempotency_key: "otra" }),
    ).toThrow();
  });
});

describe("cerco comercial de NC/ND", () => {
  const nota = (tipo: "NOTA_CREDITO" | "NOTA_DEBITO") =>
    ventaInputSchema.parse({
      ...VENTA_BASE,
      tipo_comprobante: tipo,
      cbte_asoc_id: "78000000-0000-4000-8000-000000000001",
    }) as ReturnType<typeof ventaInputSchema.parse> & {
      tipo_comprobante: "NOTA_CREDITO" | "NOTA_DEBITO";
    };

  it("en v2 una NC usa sólo la reversión total del original", async () => {
    const crearRegular = vi.fn();
    const crearNotaCreditoTotal = vi.fn(async () => ({
      id: "79000000-0000-4000-8000-000000000001",
      numero: "NCV-00000001",
      cta_cte: false,
    }));

    await expect(
      ejecutarCreacionNotaSegunFlags(nota("NOTA_CREDITO"), {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: false,
        }),
        crearRegular,
        crearNotaCreditoTotal,
      }),
    ).resolves.toMatchObject({ id: "79000000-0000-4000-8000-000000000001" });
    expect(crearNotaCreditoTotal).toHaveBeenCalledWith(
      "78000000-0000-4000-8000-000000000001",
      VENTA_BASE.idempotency_key,
    );
    expect(crearRegular).not.toHaveBeenCalled();
  });

  it("en v2 ignora una descripción histórica larga y llega a la reversión autoritativa", async () => {
    const crearRegular = vi.fn();
    const crearNotaCreditoTotal = vi.fn(async () => ({
      id: "79000000-0000-4000-8000-000000000001",
      numero: "NCV-00000001",
      cta_cte: false,
    }));
    const input = ventaInputSchema.parse({
      ...VENTA_BASE,
      tipo_comprobante: "NOTA_CREDITO",
      cbte_asoc_id: "78000000-0000-4000-8000-000000000001",
      items: [
        {
          ...VENTA_BASE.items[0],
          descripcion: `Descripción congelada ${"x".repeat(180)}`,
        },
      ],
    }) as ReturnType<typeof ventaInputSchema.parse> & { tipo_comprobante: "NOTA_CREDITO" };

    await ejecutarCreacionNotaSegunFlags(input, {
      cargarFlags: async () => ({
        facturacion_receptor_v2_enabled: true,
        facturacion_legacy_writer_enabled: false,
        nota_credito_periodo_enabled: false,
      }),
      crearRegular,
      crearNotaCreditoTotal,
    });
    expect(crearNotaCreditoTotal).toHaveBeenCalledOnce();
    expect(crearRegular).not.toHaveBeenCalled();
  });

  it("en v2 rechaza una NC sin clave estable antes de todo escritor", async () => {
    const crearRegular = vi.fn();
    const crearNotaCreditoTotal = vi.fn();
    const input = {
      ...nota("NOTA_CREDITO"),
      idempotency_key: undefined,
    };

    await expect(
      ejecutarCreacionNotaSegunFlags(input, {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: false,
        }),
        crearRegular,
        crearNotaCreditoTotal,
      }),
    ).rejects.toThrow("Falta la clave de idempotencia de la nota de crédito.");

    expect(crearNotaCreditoTotal).not.toHaveBeenCalled();
    expect(crearRegular).not.toHaveBeenCalled();
  });

  it("en v2 rechaza ND antes de todo escritor comercial", async () => {
    const cargarFlags = vi.fn(async () => ({
      facturacion_receptor_v2_enabled: true,
      facturacion_legacy_writer_enabled: false,
      nota_credito_periodo_enabled: false,
    }));
    const crearRegular = vi.fn();
    const crearNotaCreditoTotal = vi.fn();

    await expect(
      ejecutarCreacionNotaSegunFlags(nota("NOTA_DEBITO"), {
        cargarFlags,
        crearRegular,
        crearNotaCreditoTotal,
      }),
    ).rejects.toThrow(/nota de débito.*fuera de alcance/i);
    expect(crearRegular).not.toHaveBeenCalled();
    expect(crearNotaCreditoTotal).not.toHaveBeenCalled();
  });

  it("preserva la escritura de notas sólo en legacy y bloquea mantenimiento", async () => {
    const crearRegular = vi.fn(async () => ({ id: "legacy", numero: "NC-1", cta_cte: false }));
    const crearNotaCreditoTotal = vi.fn();
    const input = nota("NOTA_CREDITO");

    await ejecutarCreacionNotaSegunFlags(input, {
      cargarFlags: async () => ({
        facturacion_receptor_v2_enabled: false,
        facturacion_legacy_writer_enabled: true,
        nota_credito_periodo_enabled: false,
      }),
      crearRegular,
      crearNotaCreditoTotal,
    });
    expect(crearRegular).toHaveBeenCalledWith(input);

    await expect(
      ejecutarCreacionNotaSegunFlags(input, {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: false,
        }),
        crearRegular,
        crearNotaCreditoTotal,
      }),
    ).rejects.toThrow(/mantenimiento/i);
    expect(crearRegular).toHaveBeenCalledTimes(1);
    expect(crearNotaCreditoTotal).not.toHaveBeenCalled();
  });

  it("en v2 una NC sin asociación no cae en la creación interna legacy", async () => {
    const crearRegular = vi.fn();
    const crearNotaCreditoTotal = vi.fn();
    const input = { ...nota("NOTA_CREDITO"), cbte_asoc_id: null };

    await expect(
      ejecutarCreacionNotaSegunFlags(input, {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: true,
        }),
        crearRegular,
        crearNotaCreditoTotal,
      }),
    ).rejects.toThrow(/comprobante original/i);
    expect(crearRegular).not.toHaveBeenCalled();
    expect(crearNotaCreditoTotal).not.toHaveBeenCalled();
  });
});

describe("fachadas cerradas de lectura de ventas", () => {
  const original = {
    id: "78000000-0000-4000-8000-000000000001",
    numero_comprobante: "VTA-1",
    tipo_comprobante: "VENTA",
    fecha: "2026-08-28T12:00:00.000Z",
    subtotal_sin_iva: "100.00",
    iva_total: "21.00",
    percepciones: "0.00",
    total: "121.00",
    total_pagado: "121.00",
    condicion_venta: "CONTADO",
    afip_estado: "APROBADO",
    afip_fase: "PERSISTIDO",
    afip_validez: "PRODUCCION",
    afip_modo: "PRODUCCION",
    afip_simulado: false,
    afip_numero: 1,
    afip_emisor_cuit: "30711111118",
    afip_punto_venta: 997,
    afip_cbte_tipo: 6,
    cae: "CAE",
  };

  it("autoriza y carga por RLS antes de leer evidencia de listado en un único batch", async () => {
    const orden: string[] = [];
    const ventas = [{ id: original.id, cliente: null, sucursal: null, pagos: [] }];
    const resultado = await ejecutarListadoVentasSeguro(
      { sucursalId: "sucursal-inyectada", estadoPago: null },
      {
        autorizar: async () => {
          orden.push("autorizar");
          return { userId: "u", esAdmin: false, sucursalId: "sucursal-a" };
        },
        cargarVisibles: async (filtros) => {
          orden.push("rls");
          expect(filtros.sucursalId).toBe("sucursal-a");
          return ventas;
        },
        cargarEvidencias: async (ids) => {
          orden.push("admin-batch");
          expect(ids).toEqual([original.id]);
          return [{ id: original.id, afip_snapshot: null }];
        },
      },
    );
    expect(orden).toEqual(["autorizar", "rls", "admin-batch"]);
    expect(resultado[0]).not.toHaveProperty("afip_snapshot");
  });

  it("no abre admin cuando autorización o RLS fallan", async () => {
    const cargarEvidencias = vi.fn();
    await expect(
      ejecutarListadoVentasSeguro(
        { sucursalId: null, estadoPago: null },
        {
          autorizar: async () => {
            throw new Error("sin sección");
          },
          cargarVisibles: vi.fn(),
          cargarEvidencias,
        },
      ),
    ).rejects.toThrow("sin sección");
    expect(cargarEvidencias).not.toHaveBeenCalled();
  });

  it("devuelve sólo el booleano autoritativo al seleccionar originales v2", async () => {
    const resultado = await ejecutarListadoComprobantesOriginalesSeguro(
      { clienteId: "cliente", receptorV2: true },
      {
        autorizar: async () => ({ userId: "u", esAdmin: false, sucursalId: "sucursal-a" }),
        cargarVisibles: async () => [original],
        cargarEvidencias: async () => [
          {
            id: original.id,
            afip_snapshot: { hash: "a".repeat(64) },
            afip_snapshot_hash: "a".repeat(64),
          },
        ],
      },
    );
    expect(resultado).toEqual([{ ...original, tiene_snapshot_persistido: true }]);
    expect(resultado[0]).not.toHaveProperty("afip_snapshot");
    expect(resultado[0]).not.toHaveProperty("afip_snapshot_hash");
  });

  it("autoriza fiscalmente antes de la lectura exacta del original y cierra BOLA", async () => {
    const orden: string[] = [];
    const cargarExacta = vi.fn(async () => {
      orden.push("admin");
      return original;
    });
    await ejecutarLecturaOriginalFiscalAutorizada(original.id, {
      autorizar: async () => {
        orden.push("autorizar");
      },
      cargarExacta,
    });
    expect(orden).toEqual(["autorizar", "admin"]);

    cargarExacta.mockClear();
    await expect(
      ejecutarLecturaOriginalFiscalAutorizada("venta-ajena", {
        autorizar: async () => {
          throw new Error("no visible");
        },
        cargarExacta,
      }),
    ).rejects.toThrow("no visible");
    expect(cargarExacta).not.toHaveBeenCalled();
  });
});

describe("fence del conversor de presupuesto", () => {
  const clienteEfectivo = "72000000-0000-4000-8000-000000000099";
  const inputV2 = {
    entrada: "V2" as const,
    presupuesto_id: "75000000-0000-4000-8000-000000000001",
    cliente_id: "72000000-0000-4000-8000-000000000001",
    condicion_venta: "CONTADO" as const,
    pagos: [{ forma_pago: "TRANSFERENCIA" as const, monto: 121, detalle: {} }],
    idempotency_key: "76000000-0000-4000-8000-000000000001",
  };
  const inputLegacy = {
    entrada: "LEGACY" as const,
    presupuesto_id: "75000000-0000-4000-8000-000000000001",
    cliente_id: "72000000-0000-4000-8000-000000000001",
    tipo_comprobante: "FACTURA_B" as const,
    condicion_venta: "CONTADO" as const,
    pagos: [{ forma_pago: "EFECTIVO" as const, monto: 121, detalle: {} }],
    idempotency_key: "76000000-0000-4000-8000-000000000001",
  };

  it("exige cliente_id en ambas entradas y sólo V2 admite null", () => {
    expect(conversionPresupuestoInputSchema.parse({ ...inputV2, cliente_id: null })).toMatchObject({
      entrada: "V2",
      cliente_id: null,
    });
    expect(() =>
      conversionPresupuestoInputSchema.parse({
        entrada: inputV2.entrada,
        presupuesto_id: inputV2.presupuesto_id,
        condicion_venta: inputV2.condicion_venta,
        pagos: inputV2.pagos,
        idempotency_key: inputV2.idempotency_key,
      }),
    ).toThrow();
    expect(() =>
      conversionPresupuestoInputSchema.parse({ ...inputLegacy, cliente_id: null }),
    ).toThrow();
    expect(() => {
      const { cliente_id: _omitido, ...sinCliente } = inputLegacy;
      return conversionPresupuestoInputSchema.parse(sinCliente);
    }).toThrow();
  });

  it("exige y mapea el cliente efectivo devuelto por PostgreSQL", () => {
    expect(
      normalizarConversion([
        {
          venta_id: "77000000-0000-4000-8000-000000000001",
          numero: "GPZ-VTA-0001",
          es_cta_cte: false,
          cliente_id: clienteEfectivo,
        },
      ]),
    ).toEqual({
      id: "77000000-0000-4000-8000-000000000001",
      numero: "GPZ-VTA-0001",
      cta_cte: false,
      clienteId: clienteEfectivo,
    });

    expect(() =>
      normalizarConversion({
        venta_id: "77000000-0000-4000-8000-000000000001",
        numero: "GPZ-VTA-0001",
        es_cta_cte: false,
      }),
    ).toThrow(/conversión incompleta/i);
  });

  it("v2 llama sólo al conversor neutral y conserva el ID devuelto", async () => {
    const convertirNeutral = vi.fn(async () => ({
      id: "77000000-0000-4000-8000-000000000001",
      numero: "VTA-00000001",
      cta_cte: false,
      clienteId: clienteEfectivo,
    }));
    const convertirLegacy = vi.fn();

    await expect(
      ejecutarConversionPresupuestoSegunFlags(inputV2, {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: false,
        }),
        convertirNeutral,
        convertirLegacy,
      }),
    ).resolves.toEqual({
      id: "77000000-0000-4000-8000-000000000001",
      numero: "VTA-00000001",
      cta_cte: false,
      clienteId: clienteEfectivo,
    });
    expect(convertirNeutral).toHaveBeenCalledTimes(1);
    expect(convertirLegacy).not.toHaveBeenCalled();
  });

  it("legacy llama sólo a la firma legacy con su A/B explícita", async () => {
    const convertirNeutral = vi.fn();
    const convertirLegacy = vi.fn(async () => ({
      id: "77000000-0000-4000-8000-000000000002",
      numero: "FB-00000001",
      cta_cte: false,
      clienteId: inputLegacy.cliente_id,
    }));

    await ejecutarConversionPresupuestoSegunFlags(inputLegacy, {
      cargarFlags: async () => ({
        facturacion_receptor_v2_enabled: false,
        facturacion_legacy_writer_enabled: true,
        nota_credito_periodo_enabled: false,
      }),
      convertirNeutral,
      convertirLegacy,
    });
    expect(convertirLegacy).toHaveBeenCalledTimes(1);
    expect(convertirNeutral).not.toHaveBeenCalled();
  });

  it("mantenimiento devuelve antes de cualquier mutación comercial", async () => {
    const convertirNeutral = vi.fn();
    const convertirLegacy = vi.fn();

    await expect(
      ejecutarConversionPresupuestoSegunFlags(inputV2, {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: false,
        }),
        convertirNeutral,
        convertirLegacy,
      }),
    ).resolves.toEqual({
      estado: "MANTENIMIENTO",
      mensaje:
        "La facturación está temporalmente en mantenimiento. No se convirtió el presupuesto.",
    });
    expect(convertirNeutral).not.toHaveBeenCalled();
    expect(convertirLegacy).not.toHaveBeenCalled();
  });

  it("un cliente de rollout equivocado no cruza al otro escritor", async () => {
    const deps = {
      cargarFlags: async () => ({
        facturacion_receptor_v2_enabled: true,
        facturacion_legacy_writer_enabled: false,
        nota_credito_periodo_enabled: false,
      }),
      convertirNeutral: vi.fn(),
      convertirLegacy: vi.fn(),
    };

    await expect(ejecutarConversionPresupuestoSegunFlags(inputLegacy, deps)).rejects.toThrow(
      /legacy.*drain|fuera del drain/i,
    );
    expect(deps.convertirNeutral).not.toHaveBeenCalled();
    expect(deps.convertirLegacy).not.toHaveBeenCalled();
  });

  it("la fachada server-facing devuelve sólo código/mensaje cerrados ante un error RPC crudo", async () => {
    const causa = {
      message: 'duplicate key violates constraint "ventas_idempotency_key_key"',
      code: "23505",
      details: "public.ventas",
      hint: "function convertir_presupuesto_en_venta_neutral",
      cause: new Error("token=secreto"),
    };
    const registrar = vi.fn();
    const resultado = await ejecutarConversionPresupuestoCerrada(
      inputV2,
      {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: false,
        }),
        convertirNeutral: async () => {
          throw causa;
        },
        convertirLegacy: vi.fn(),
      },
      registrar,
    );

    expect(registrar).toHaveBeenCalledWith("CONVERTIR_PRESUPUESTO", causa);
    expect(resultado).toMatchObject({ ok: false, error: { codigo: "ERROR_INTERNO" } });
    const salida = textoProfundo(resultado).toLowerCase();
    for (const token of [
      "constraint",
      "ventas_idempotency_key_key",
      "public.ventas",
      "convertir_presupuesto_en_venta_neutral",
      "23505",
      "secreto",
    ]) {
      expect(salida).not.toContain(token);
    }
  });

  it("la fachada server-facing representa mantenimiento con el mismo código cerrado", async () => {
    const convertirNeutral = vi.fn();
    const resultado = await ejecutarConversionPresupuestoCerrada(
      inputV2,
      {
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: false,
        }),
        convertirNeutral,
        convertirLegacy: vi.fn(),
      },
      vi.fn(),
    );

    expect(resultado).toMatchObject({ ok: false, error: { codigo: "MANTENIMIENTO" } });
    expect(convertirNeutral).not.toHaveBeenCalled();
  });
});
