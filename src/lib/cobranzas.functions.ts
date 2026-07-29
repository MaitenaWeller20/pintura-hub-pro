/** Cobranza de cuenta corriente: registra el pago de un cliente sobre su deuda.
 *  - NO toca stock (la mercadería ya salió al emitir el remito / factura interna).
 *  - SÍ entra a la caja del día con su forma de pago.
 *  - IMPUTA contra los comprobantes abiertos del cliente, del más viejo al más
 *    nuevo (FIFO). Antes no lo hacía: el cobro quedaba en un libro paralelo que
 *    nunca tocaba ventas.total_pagado, así que la solapa "Cuentas corrientes" de
 *    Reportes mostraba deuda que no bajaba nunca aunque el cliente pagara todo.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const cobranzaSchema = z.object({
  cliente_id: z.string().uuid(),
  sucursal_id: z.string().uuid(),
  monto: z.number().positive(),
  forma_pago: z.enum([
    "EFECTIVO",
    "TRANSFERENCIA",
    "TARJETA_DEBITO",
    "TARJETA_CREDITO",
    "MERCADO_PAGO",
    "CHEQUE",
  ]),
  detalle: z.record(z.string(), z.any()).default({}),
  observaciones: z.string().optional().nullable(),
});

export const registrarCobranza = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cobranzaSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: r, error } = await supabase.rpc("registrar_cobranza", {
      p_cliente_id: data.cliente_id,
      p_sucursal_id: data.sucursal_id,
      p_monto: data.monto,
      p_forma_pago: data.forma_pago,
      p_detalle: data.detalle,
      p_observaciones: data.observaciones ?? undefined,
    });
    if (error) throw new Error(error.message);

    const row: any = Array.isArray(r) ? r[0] : r;
    return {
      id: row.cobranza_id as string,
      // Saldo del cliente después del cobro (negativo = saldo a favor).
      saldo: Number(row.saldo),
    };
  });
