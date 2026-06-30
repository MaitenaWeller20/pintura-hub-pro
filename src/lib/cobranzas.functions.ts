/** Cobranza de cuenta corriente: registra pago de un cliente sobre su deuda.
 *  - NO toca stock (los productos ya salieron al emitir el remito/factura interna).
 *  - SÍ aparece en la caja del día con su forma de pago.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const cobranzaSchema = z.object({
  cliente_id: z.string().uuid(),
  sucursal_id: z.string().uuid(),
  monto: z.number().positive(),
  forma_pago: z.enum(["EFECTIVO","TRANSFERENCIA","TARJETA_DEBITO","TARJETA_CREDITO","MERCADO_PAGO","CHEQUE"]),
  detalle: z.record(z.string(), z.any()).default({}),
  observaciones: z.string().optional().nullable(),
});

export const registrarCobranza = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cobranzaSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase.from("cobranzas_cta_cte").insert({
      cliente_id: data.cliente_id, sucursal_id: data.sucursal_id, usuario_id: userId,
      monto: data.monto, forma_pago: data.forma_pago,
      detalle: data.detalle, observaciones: data.observaciones ?? null,
    }).select().single();
    if (error) throw new Error(error.message);
    return { id: row.id };
  });

/** Aplica un nuevo % de markup a un set de productos (recalcula precio_sin_iva). */
export const aplicarMarkup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    producto_ids: z.array(z.string().uuid()).min(1),
    markup_porcentaje: z.number().min(0),
    setear_como_default: z.boolean().default(false),
    sobrescribir_individual: z.boolean().default(true),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Solo admin");

    const { data: prods } = await supabase.from("productos")
      .select("id, precio_fabrica, markup_porcentaje").in("id", data.producto_ids);
    const lista = (prods ?? []) as any[];

    for (const p of lista) {
      const fabrica = Number(p.precio_fabrica ?? 0);
      const nuevoPrecio = +(fabrica * (1 + data.markup_porcentaje / 100)).toFixed(2);
      const patch: any = { precio_sin_iva: nuevoPrecio };
      if (data.sobrescribir_individual) patch.markup_porcentaje = data.markup_porcentaje;
      await supabase.from("productos").update(patch).eq("id", p.id);
    }
    if (data.setear_como_default) {
      await supabase.from("settings").update({ markup_default_porcentaje: data.markup_porcentaje }).eq("id", true);
    }
    return { actualizados: lista.length };
  });
