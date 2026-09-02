/**
 * Ventas: creación y anulación.
 *
 * La lógica vive en dos funciones de Postgres (crear_venta / anular_venta), no acá.
 * La razón es la atomicidad: esto antes eran 4 llamadas sueltas a la base
 * (venta -> items -> pagos -> stock) sin transacción, así que un fallo a mitad de
 * camino dejaba datos a medio escribir. Y el stock se descontaba leyendo-y-
 * escribiendo desde JS, lo que permite que dos cajas vendan la misma última lata.
 *
 * Dentro de la función de Postgres todo eso es una única transacción, el descuento
 * de stock es atómico con guarda anti-negativo, y los precios se resuelven contra
 * el catálogo en vez de confiar en lo que manda el navegador.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  cargarFlagsFacturacionDesdeSupabase,
  decidirEscritorFiscal,
  type FlagsFacturacion,
} from "./fiscal/feature.server";

const itemSchema = z
  .object({
    // R5: producto_id puede faltar en una línea de CONCEPTO LIBRE (recargo/interés
    // de una Nota de Débito). En ese caso se exige descripción y precio. La RPC sólo
    // acepta líneas sin producto en NOTA_DEBITO.
    producto_id: z.string().uuid().nullable().optional(),
    cantidad: z.number().nonnegative(),
    descuento_porcentaje: z.number().min(0).max(100).default(0),
    // Opcional: el cajero puede pisar el precio de lista (es una necesidad real del
    // mostrador, se negocia en el momento). Si no viene, la base usa el del catálogo.
    // Si viene, se guardan los dos y la diferencia queda auditada.
    precio_unitario_sin_iva: z.number().nonnegative().optional(),
    // Sólo para líneas de concepto libre (sin producto).
    descripcion: z.string().optional(),
    iva_porcentaje: z.number().min(0).max(100).optional(),
  })
  .refine((it) => !!it.producto_id || (!!it.descripcion && it.precio_unitario_sin_iva != null), {
    message: "Una línea sin producto necesita descripción y precio",
  });

const pagoSchema = z.object({
  forma_pago: z.enum([
    "EFECTIVO",
    "TRANSFERENCIA",
    "TARJETA_DEBITO",
    "TARJETA_CREDITO",
    "MERCADO_PAGO",
    "CHEQUE",
    "CTA_CTE",
  ]),
  monto: z.number().nonnegative(),
  detalle: z.record(z.string(), z.any()).default({}),
});

export const ventaInputSchema = z.object({
  sucursal_id: z.string().uuid(),
  // Nulo sólo en un remito de obra: ahí la obra ES el cliente y `crear_venta`
  // resuelve (o crea) su ficha a partir de `nombre_obra`. Para cualquier otro
  // comprobante la RPC rechaza el nulo, que es la barrera que vale.
  cliente_id: z.string().uuid().optional().nullable(),
  tipo_comprobante: z.enum([
    "VENTA",
    "FACTURA_A",
    "FACTURA_B",
    "FACTURA_C",
    "NOTA_CREDITO",
    "NOTA_DEBITO",
    "REMITO",
    "REMITO_OBRA",
    "FAC_INTERNA_CTA_CTE",
  ]),
  condicion_venta: z.enum(["CONTADO", "CTA_CTE"]),
  fecha: z.string().optional(),
  percepciones: z.number().nonnegative().default(0),
  observaciones: z.string().optional().nullable(),
  nombre_obra: z.string().optional().nullable(),
  // El comprobante que rectifica una nota de crédito/débito. Opcional acá y la
  // regla la pone crear_venta, que es la que puede consultar la base: la nota de
  // DÉBITO lo exige (es un recargo calculado sobre el total de esa factura), la
  // de CRÉDITO puede ir sin ninguno y entonces queda como documento interno que
  // no se manda a AFIP (ver esNotaInterna en fiscal/codigos.ts).
  cbte_asoc_id: z.string().uuid().optional().nullable(),
  // Clave de idempotencia generada al montar el formulario. Un doble-submit con la
  // misma key devuelve la venta ya creada en vez de duplicarla (defensa server-side).
  idempotency_key: z.string().uuid().optional(),
  items: z.array(itemSchema).min(0),
  pagos: z.array(pagoSchema).default([]),
});

export type VentaInput = z.infer<typeof ventaInputSchema>;
type ResultadoCreacionVenta = { id: string; numero: string; cta_cte: boolean };

export async function ejecutarCreacionNotaSegunFlags(
  input: Omit<VentaInput, "tipo_comprobante"> & {
    tipo_comprobante: "NOTA_CREDITO" | "NOTA_DEBITO";
  },
  deps: {
    cargarFlags(): Promise<FlagsFacturacion>;
    crearRegular(input: VentaInput): Promise<ResultadoCreacionVenta>;
    crearNotaCreditoTotal(
      originalId: string,
      idempotencyKey: string,
    ): Promise<ResultadoCreacionVenta>;
  },
): Promise<ResultadoCreacionVenta> {
  const flags = await deps.cargarFlags();
  if (flags.facturacion_receptor_v2_enabled && flags.facturacion_legacy_writer_enabled) {
    throw new Error("La configuración fiscal es inválida: ambos escritores están activos.");
  }
  // Sin asociación no hay emisión fiscal que enrutar: es una devolución
  // comercial interna y `crear_venta` resuelve stock, saldo/pago e idempotencia
  // en una sola transacción, incluso durante mantenimiento fiscal.
  if (input.tipo_comprobante === "NOTA_CREDITO" && !input.cbte_asoc_id) {
    return deps.crearRegular(input);
  }
  if (!flags.facturacion_receptor_v2_enabled && !flags.facturacion_legacy_writer_enabled) {
    throw new Error("La facturación está en mantenimiento. No se registró ningún comprobante.");
  }
  if (flags.facturacion_receptor_v2_enabled) {
    if (input.tipo_comprobante === "NOTA_DEBITO") {
      throw new Error("La nota de débito nueva queda fuera de alcance fiscal.");
    }
    if (!input.cbte_asoc_id) {
      throw new Error("La nota de crédito fiscal exige el comprobante original.");
    }
    if (!input.idempotency_key) {
      throw new Error("Falta la clave de idempotencia de la nota de crédito.");
    }
    return deps.crearNotaCreditoTotal(input.cbte_asoc_id, input.idempotency_key);
  }
  return deps.crearRegular(input);
}

function normalizarVentaCreada(value: unknown): ResultadoCreacionVenta {
  const row = Array.isArray(value) ? value[0] : value;
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("El servidor no devolvió el comprobante creado.");
  }
  const valueRow = row as Record<string, unknown>;
  const id = valueRow.venta_id ?? valueRow.nc_id;
  const numero = valueRow.numero ?? valueRow.nc_numero;
  if (typeof id !== "string" || typeof numero !== "string") {
    throw new Error("El servidor devolvió un comprobante incompleto.");
  }
  return { id, numero, cta_cte: valueRow.es_cta_cte === true };
}

export const crearVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ventaInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const crearRegular = async (input: VentaInput) => {
      const { data: result, error } = await supabase.rpc("crear_venta", {
        p_sucursal_id: input.sucursal_id,
        // El cast es por los tipos generados, no por la base: un parámetro `uuid`
        // admite NULL, pero el generador de tipos de Supabase lo declara `string`.
        p_cliente_id: (input.cliente_id ?? null) as unknown as string,
        p_tipo_comprobante: input.tipo_comprobante,
        p_condicion_venta: input.condicion_venta,
        p_items: input.items,
        p_pagos: input.pagos,
        p_percepciones: input.percepciones ?? 0,
        p_observaciones: input.observaciones ?? undefined,
        p_nombre_obra: input.nombre_obra ?? undefined,
        p_fecha: input.fecha ?? undefined,
        p_cbte_asoc_id: input.cbte_asoc_id ?? undefined,
        p_idempotency_key: input.idempotency_key ?? undefined,
      });
      if (error) throw new Error(error.message);
      return normalizarVentaCreada(result);
    };

    if (data.tipo_comprobante !== "NOTA_CREDITO" && data.tipo_comprobante !== "NOTA_DEBITO") {
      return crearRegular(data);
    }

    return ejecutarCreacionNotaSegunFlags(
      data as VentaInput & { tipo_comprobante: "NOTA_CREDITO" | "NOTA_DEBITO" },
      {
        cargarFlags: () => cargarFlagsFacturacionDesdeSupabase(supabase as never),
        crearRegular,
        async crearNotaCreditoTotal(originalId, idempotencyKey) {
          const { data: original, error: lecturaError } = await supabase
            .from("ventas")
            .select(
              "id,tipo_comprobante,estado,afip_estado,afip_fase,afip_validez,afip_modo,afip_simulado,afip_numero,afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_snapshot,afip_snapshot_hash,cae",
            )
            .eq("id", originalId)
            .maybeSingle();
          if (lecturaError || !original) {
            throw new Error("No se pudo leer el comprobante original.");
          }
          if (
            original.tipo_comprobante !== "VENTA" ||
            original.estado !== "ACTIVA" ||
            original.afip_estado !== "APROBADO" ||
            original.afip_fase !== "PERSISTIDO" ||
            original.afip_validez !== "PRODUCCION" ||
            original.afip_modo !== "PRODUCCION" ||
            original.afip_simulado ||
            !original.cae ||
            original.afip_numero == null ||
            !original.afip_emisor_cuit ||
            original.afip_punto_venta == null ||
            original.afip_cbte_tipo == null ||
            !original.afip_snapshot ||
            !original.afip_snapshot_hash
          ) {
            throw new Error(
              "La nota de crédito v2 exige una venta neutral aprobada con identidad fiscal real completa.",
            );
          }
          const { data: result, error } = await supabase.rpc("anular_venta", {
            p_venta_id: originalId,
            p_idempotency_key: idempotencyKey,
          });
          if (error) throw new Error(error.message);
          return normalizarVentaCreada(result);
        },
      },
    );
  });

const conversionBaseSchema = z.object({
  presupuesto_id: z.string().uuid(),
  cliente_id: z.string().uuid(),
  condicion_venta: z.enum(["CONTADO", "CTA_CTE"]),
  pagos: z.array(pagoSchema).default([]),
  idempotency_key: z.string().uuid(),
});

export const conversionPresupuestoInputSchema = z.discriminatedUnion("entrada", [
  conversionBaseSchema.extend({ entrada: z.literal("V2") }).strict(),
  conversionBaseSchema
    .extend({
      entrada: z.literal("LEGACY"),
      tipo_comprobante: z.enum(["FACTURA_A", "FACTURA_B"]),
    })
    .strict(),
]);

export type ConversionPresupuestoInput = z.infer<typeof conversionPresupuestoInputSchema>;
export type ConversionPresupuestoResultado = {
  id: string;
  numero: string;
  cta_cte: boolean;
};

const mantenimientoConversion = () => ({
  estado: "MANTENIMIENTO" as const,
  mensaje: "La facturación está temporalmente en mantenimiento. No se convirtió el presupuesto.",
});

export async function ejecutarConversionPresupuestoSegunFlags(
  input: ConversionPresupuestoInput,
  deps: {
    cargarFlags(): Promise<FlagsFacturacion>;
    convertirNeutral(
      input: Extract<ConversionPresupuestoInput, { entrada: "V2" }>,
    ): Promise<ConversionPresupuestoResultado>;
    convertirLegacy(
      input: Extract<ConversionPresupuestoInput, { entrada: "LEGACY" }>,
    ): Promise<ConversionPresupuestoResultado>;
  },
): Promise<ConversionPresupuestoResultado | ReturnType<typeof mantenimientoConversion>> {
  const escritor = decidirEscritorFiscal(await deps.cargarFlags(), input.entrada);
  if (escritor === "MANTENIMIENTO") return mantenimientoConversion();
  if (input.entrada === "V2") return deps.convertirNeutral(input);
  return deps.convertirLegacy(input);
}

function normalizarConversion(value: unknown): ConversionPresupuestoResultado {
  const row = Array.isArray(value) ? value[0] : value;
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("El servidor no devolvió la venta convertida.");
  }
  const record = row as Record<string, unknown>;
  if (
    typeof record.venta_id !== "string" ||
    typeof record.numero !== "string" ||
    typeof record.es_cta_cte !== "boolean"
  ) {
    throw new Error("El servidor devolvió una conversión incompleta.");
  }
  return { id: record.venta_id, numero: record.numero, cta_cte: record.es_cta_cte };
}

/** Fence server-side: flags autoritativos antes de cualquier RPC comercial. */
export const convertirPresupuestoEnVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => conversionPresupuestoInputSchema.parse(value))
  .handler(async ({ data, context }) =>
    ejecutarConversionPresupuestoSegunFlags(data, {
      cargarFlags: () => cargarFlagsFacturacionDesdeSupabase(context.supabase as never),
      async convertirNeutral(input) {
        const { data: result, error } = await context.supabase.rpc(
          "convertir_presupuesto_en_venta_neutral",
          {
            p_presupuesto_id: input.presupuesto_id,
            p_cliente_id: input.cliente_id,
            p_condicion_venta: input.condicion_venta,
            p_pagos: input.pagos,
            p_idempotency_key: input.idempotency_key,
          },
        );
        if (error) throw new Error(error.message);
        return normalizarConversion(result);
      },
      async convertirLegacy(input) {
        const { data: result, error } = await context.supabase.rpc(
          "convertir_presupuesto_en_venta",
          {
            p_presupuesto_id: input.presupuesto_id,
            p_cliente_id: input.cliente_id,
            p_tipo_comprobante: input.tipo_comprobante,
            p_condicion_venta: input.condicion_venta,
            p_pagos: input.pagos,
            p_idempotency_key: input.idempotency_key,
          },
        );
        if (error) throw new Error(error.message);
        return normalizarConversion(result);
      },
    }),
  );

export const anulacionVentaInputSchema = z
  .object({
    venta_id: z.string().uuid(),
    idempotency_key: z.string().uuid(),
  })
  .strict();

export type AnulacionVentaInput = z.infer<typeof anulacionVentaInputSchema>;

export const anularVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => anulacionVentaInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: r, error } = await supabase.rpc("anular_venta", {
      p_venta_id: data.venta_id,
      p_idempotency_key: data.idempotency_key,
    });

    if (error) throw new Error(error.message);

    const row: any = Array.isArray(r) ? r[0] : r;
    return { ok: true, nc_id: row.nc_id as string, nc_numero: row.nc_numero as string };
  });
