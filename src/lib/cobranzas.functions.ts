/** El crédito del libro determina el saldo; la imputación solo documenta su destino. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { formasCobro } from "./format";

const cobranzaSchema = z.object({
  cliente_id: z.string().uuid(),
  sucursal_id: z.string().uuid(),
  monto: z.number().positive(),
  forma_pago: z.enum(formasCobro),
  detalle: z.record(z.string(), z.any()).default({}),
  observaciones: z.string().optional().nullable(),
  imputaciones: z.array(z.object({
    venta_id: z.string().uuid(),
    monto: z.number().positive().refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 0.000001),
  })).max(100).default([]),
});

export const registrarCobranza = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cobranzaSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const args = {
      p_cliente_id: data.cliente_id,
      p_sucursal_id: data.sucursal_id,
      p_monto: data.monto,
      p_forma_pago: data.forma_pago,
      p_detalle: data.detalle,
      p_observaciones: data.observaciones ?? null,
    };
    const { data: r, error } = data.imputaciones.length
      ? await supabase.rpc("registrar_cobranza_imputada", {
          ...args, p_imputaciones: data.imputaciones,
        })
      : await supabase.rpc("registrar_cobranza", args);
    if (error) throw new Error(error.message);

    const row: any = Array.isArray(r) ? r[0] : r;
    return {
      id: row.cobranza_id as string,
      // Saldo del cliente después del cobro (negativo = saldo a favor).
      saldo: Number(row.saldo),
    };
  });
