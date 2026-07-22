/** Server fns para remitos: aprobar / rechazar (mueve stock). */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const aprobarRemito = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ remito_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // Toda la transferencia (validación admin + estado, descuento/ingreso de stock
    // con guarda de negativo y kardex por ambos lados, y el pase a APROBADO) es
    // atómica en la RPC aprobar_remito. Antes eran select→upsert sueltos por
    // PostgREST: lost-update, stock negativo posible y doble-aprobación.
    const { error } = await supabase.rpc("aprobar_remito", { p_remito_id: data.remito_id });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const rechazarRemito = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ remito_id: z.string().uuid(), motivo: z.string().min(1) }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // R7: la autorización (sucursal destino o admin) y la guarda de estado viven en
    // la RPC transaccional rechazar_remito. Antes era un UPDATE suelto por PostgREST
    // que sólo chequeaba is_admin y no verificaba error ni filas afectadas.
    const { error } = await supabase.rpc("rechazar_remito", {
      p_remito_id: data.remito_id, p_motivo: data.motivo,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const crearRemito = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    sucursal_origen_id: z.string().uuid(),
    sucursal_destino_id: z.string().uuid(),
    observaciones: z.string().optional().nullable(),
    items: z.array(z.object({ producto_id: z.string().uuid(), cantidad: z.number().positive() })).min(1),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    if (data.sucursal_origen_id === data.sucursal_destino_id)
      throw new Error("Origen y destino deben ser distintos");

    // Numero
    const { data: numero } = await supabase.rpc("next_comprobante_numero", {
      _sucursal_id: data.sucursal_origen_id, _tipo: "REMITO" as const,
    });

    const { data: rem, error } = await supabase.from("remitos").insert({
      numero: numero as unknown as string,
      sucursal_origen_id: data.sucursal_origen_id,
      sucursal_destino_id: data.sucursal_destino_id,
      observaciones: data.observaciones ?? null,
      creado_por: userId,
    }).select().single();
    if (error) throw new Error(error.message);

    const { error: iErr } = await supabase.from("remito_items").insert(
      data.items.map((i) => ({ ...i, remito_id: rem.id }))
    );
    if (iErr) throw new Error(iErr.message);

    return { id: rem.id, numero };
  });

export const ajusteStock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    producto_id: z.string().uuid(),
    sucursal_id: z.string().uuid(),
    nueva_cantidad: z.number().nonnegative(),
    motivo: z.string().min(1),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Sólo admin puede ajustar stock");

    // Ajuste atómico: la RPC bloquea la fila (FOR UPDATE) y escribe stock +
    // movimiento en una transacción. Antes eran 3 statements sueltos (lost-update
    // si una venta concurrente descontaba stock entre el read y el write).
    const { error } = await supabase.rpc("ajustar_stock", {
      p_producto_id: data.producto_id,
      p_sucursal_id: data.sucursal_id,
      p_nueva_cantidad: data.nueva_cantidad,
      p_motivo: data.motivo,
    });
    if (error) throw new Error(error.message);

    return { ok: true };
  });
