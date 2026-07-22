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

const itemSchema = z.object({
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
}).refine(
  (it) => !!it.producto_id || (!!it.descripcion && it.precio_unitario_sin_iva != null),
  { message: "Una línea sin producto necesita descripción y precio" },
);

const pagoSchema = z.object({
  forma_pago: z.enum([
    "EFECTIVO", "TRANSFERENCIA", "TARJETA_DEBITO", "TARJETA_CREDITO",
    "MERCADO_PAGO", "CHEQUE", "CTA_CTE",
  ]),
  monto: z.number().nonnegative(),
  detalle: z.record(z.string(), z.any()).default({}),
});

const ventaSchema = z.object({
  sucursal_id: z.string().uuid(),
  cliente_id: z.string().uuid(),
  tipo_comprobante: z.enum([
    "FACTURA_A", "FACTURA_B", "FACTURA_C", "NOTA_CREDITO", "NOTA_DEBITO",
    "REMITO", "REMITO_OBRA", "FAC_INTERNA_CTA_CTE",
  ]),
  condicion_venta: z.enum(["CONTADO", "CTA_CTE"]),
  fecha: z.string().optional(),
  percepciones: z.number().nonnegative().default(0),
  observaciones: z.string().optional().nullable(),
  nombre_obra: z.string().optional().nullable(),
  // El comprobante que rectifica una nota de crédito/débito. AFIP lo exige
  // (CbtesAsoc): una nota sin comprobante asociado no se puede emitir.
  cbte_asoc_id: z.string().uuid().optional().nullable(),
  // Clave de idempotencia generada al montar el formulario. Un doble-submit con la
  // misma key devuelve la venta ya creada en vez de duplicarla (defensa server-side).
  idempotency_key: z.string().uuid().optional(),
  items: z.array(itemSchema).min(0),
  pagos: z.array(pagoSchema).default([]),
});

export const crearVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ventaSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: r, error } = await supabase.rpc("crear_venta", {
      p_sucursal_id: data.sucursal_id,
      p_cliente_id: data.cliente_id,
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
    return { id: row.venta_id as string, numero: row.numero as string, cta_cte: row.es_cta_cte as boolean };
  });

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
