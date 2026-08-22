/** Server fns para crear, editar, aprobar y rechazar remitos internos. */
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
  .inputValidator((d: unknown) =>
    z.object({ remito_id: z.string().uuid(), motivo: z.string().min(1) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // R7: la autorización (sucursal destino o admin) y la guarda de estado viven en
    // la RPC transaccional rechazar_remito. Antes era un UPDATE suelto por PostgREST
    // que sólo chequeaba is_admin y no verificaba error ni filas afectadas.
    const { error } = await supabase.rpc("rechazar_remito", {
      p_remito_id: data.remito_id,
      p_motivo: data.motivo,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const editarRemito = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        remito_id: z.string().uuid(),
        sucursal_destino_id: z.string().uuid(),
        observaciones: z.string().max(2000).optional().nullable(),
        items: z
          .array(
            z.object({
              producto_id: z.string().uuid(),
              cantidad: z.number().positive().finite(),
            }),
          )
          .min(1)
          .max(500),
      })
      .superRefine((data, ctx) => {
        const vistos = new Set<string>();
        for (const item of data.items) {
          if (vistos.has(item.producto_id)) {
            ctx.addIssue({
              code: "custom",
              path: ["items"],
              message: "Un producto no puede repetirse en el mismo remito",
            });
            return;
          }
          vistos.add(item.producto_id);
        }
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // La RPC bloquea el encabezado, vuelve a comprobar PENDIENTE + sucursal de
    // origen y reemplaza encabezado e ítems en la misma transacción. Así una
    // aprobación concurrente no puede usar un detalle guardado a medias.
    const { error } = await supabase.rpc("editar_remito", {
      p_remito_id: data.remito_id,
      p_sucursal_destino_id: data.sucursal_destino_id,
      p_observaciones: data.observaciones?.trim() || "",
      p_items: data.items,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const crearRemito = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        sucursal_origen_id: z.string().uuid(),
        sucursal_destino_id: z.string().uuid(),
        observaciones: z.string().optional().nullable(),
        items: z
          .array(z.object({ producto_id: z.string().uuid(), cantidad: z.number().positive() }))
          .min(1),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    if (data.sucursal_origen_id === data.sucursal_destino_id)
      throw new Error("Origen y destino deben ser distintos");

    // R7b: el remito lo crea el ORIGEN (o un admin). Sin esto, un empleado del
    // destino podía crear un remito saliendo de otra sucursal y auto-aprobarlo.
    // La barrera autoritativa es la RLS de INSERT; acá damos un error claro.
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) {
      const { data: miSuc } = await supabase.rpc("current_sucursal_id");
      if (miSuc !== data.sucursal_origen_id)
        throw new Error("Sólo podés crear remitos que salgan de tu sucursal.");
    }

    // Numero
    const { data: numero } = await supabase.rpc("next_comprobante_numero", {
      _sucursal_id: data.sucursal_origen_id,
      _tipo: "REMITO" as const,
    });

    const { data: rem, error } = await supabase
      .from("remitos")
      .insert({
        numero: numero as unknown as string,
        sucursal_origen_id: data.sucursal_origen_id,
        sucursal_destino_id: data.sucursal_destino_id,
        observaciones: data.observaciones ?? null,
        creado_por: userId,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    const { error: iErr } = await supabase
      .from("remito_items")
      .insert(data.items.map((i) => ({ ...i, remito_id: rem.id })));
    if (iErr) throw new Error(iErr.message);

    return { id: rem.id, numero };
  });

/**
 * Conteo físico: carga muchas cantidades de una, en una transacción, con kardex.
 *
 * `contado_desde` es el momento en que se abrió el conteo en pantalla. Los
 * movimientos posteriores a esa hora se SUMAN a lo contado en vez de pisarse:
 * contar 10 a las 10:00, vender 2 a las 10:10 y guardar a las 10:30 tiene que
 * dejar 8. Ver §5.4 del spec del conteo físico.
 */
export const conteoFisico = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        sucursal_id: z.string().uuid(),
        motivo: z.string().min(1),
        // Lo genera el server (iniciar_conteo_stock → now()) y viaja opaco hasta
        // la RPC, que lo castea a timestamptz. PostgREST lo serializa con offset
        // (+00:00), que el .datetime() estricto de Zod rechaza; no lo re-validamos.
        contado_desde: z.string().min(1).nullable().optional(),
        idempotency_key: z.string().uuid(),
        items: z
          .array(
            z.object({
              producto_id: z.string().uuid(),
              // 0 es un valor válido y es el más importante del conteo:
              // "lo conté y no hay".
              cantidad: z.number().nonnegative().finite(),
            }),
          )
          .min(1)
          .max(2000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // La autorización real (admin) vive en la RPC, que es SECURITY DEFINER.
    const { data: res, error } = await supabase.rpc("ajustar_stock_masivo", {
      p_sucursal_id: data.sucursal_id,
      p_items: data.items,
      p_motivo: data.motivo,
      p_contado_desde: data.contado_desde ?? undefined,
      p_idempotency_key: data.idempotency_key,
    });
    if (error) throw new Error(error.message);
    return res as {
      conteo_id: string;
      ajustados: number;
      sin_cambio: number;
      con_movimientos: number;
      conflictos: number;
      repetido: boolean;
    };
  });

export const ajusteStock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        producto_id: z.string().uuid(),
        sucursal_id: z.string().uuid(),
        nueva_cantidad: z.number().nonnegative(),
        motivo: z.string().min(1),
      })
      .parse(d),
  )
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
