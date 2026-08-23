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

export const crearVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ventaInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: r, error } = await supabase.rpc("crear_venta", {
      p_sucursal_id: data.sucursal_id,
      // El cast es por los tipos generados, no por la base: un parámetro `uuid`
      // admite NULL, pero el generador de tipos de Supabase lo declara `string`
      // porque sólo marca opcional lo que tiene DEFAULT — y `p_cliente_id` no
      // puede tenerlo, ya que le siguen parámetros sin default. En un remito de
      // obra va NULL a propósito y `crear_venta` resuelve la ficha de la obra.
      p_cliente_id: (data.cliente_id ?? null) as unknown as string,
      p_tipo_comprobante: data.tipo_comprobante,
      p_condicion_venta: data.condicion_venta,
      p_items: data.items,
      p_pagos: data.pagos,
      p_percepciones: data.percepciones ?? 0,
      p_observaciones: data.observaciones ?? undefined,
      p_nombre_obra: data.nombre_obra ?? undefined,
      p_fecha: data.fecha ?? undefined,
      p_cbte_asoc_id: data.cbte_asoc_id ?? undefined,
      p_idempotency_key: data.idempotency_key ?? undefined,
    });

    if (error) throw new Error(error.message);

    const row: any = Array.isArray(r) ? r[0] : r;
    return {
      id: row.venta_id as string,
      numero: row.numero as string,
      cta_cte: row.es_cta_cte as boolean,
    };
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

export const anularVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ venta_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: r, error } = await supabase.rpc("anular_venta", {
      p_venta_id: data.venta_id,
    });

    if (error) throw new Error(error.message);

    const row: any = Array.isArray(r) ? r[0] : r;
    return { ok: true, nc_id: row.nc_id as string, nc_numero: row.nc_numero as string };
  });
