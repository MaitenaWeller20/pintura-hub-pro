/** Server fns para remitos: aprobar / rechazar (mueve stock). */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const aprobarRemito = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ remito_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Verificar admin
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Sólo el administrador puede aprobar remitos");

    const { data: rem } = await supabase.from("remitos").select("*").eq("id", data.remito_id).single();
    if (!rem) throw new Error("Remito no encontrado");
    if (rem.estado !== "PENDIENTE") throw new Error("El remito ya fue procesado");

    const { data: items = [] } = await supabase.from("remito_items").select("*").eq("remito_id", rem.id);

    for (const it of items as any[]) {
      // Salida origen
      const { data: rowO } = await supabase.from("stock_sucursal").select("cantidad")
        .eq("producto_id", it.producto_id).eq("sucursal_id", rem.sucursal_origen_id).maybeSingle();
      const antO = Number(rowO?.cantidad ?? 0);
      const nvO = antO - Number(it.cantidad);
      await supabase.from("stock_sucursal").upsert({
        producto_id: it.producto_id, sucursal_id: rem.sucursal_origen_id, cantidad: nvO,
      }, { onConflict: "producto_id,sucursal_id" });
      await supabase.from("stock_movimientos").insert({
        producto_id: it.producto_id, sucursal_id: rem.sucursal_origen_id,
        tipo: "TRANSFERENCIA_OUT", cantidad: -Number(it.cantidad),
        cantidad_anterior: antO, cantidad_nueva: nvO,
        referencia_id: rem.id, usuario_id: userId, motivo: `Remito ${rem.numero}`,
      });

      // Entrada destino
      const { data: rowD } = await supabase.from("stock_sucursal").select("cantidad")
        .eq("producto_id", it.producto_id).eq("sucursal_id", rem.sucursal_destino_id).maybeSingle();
      const antD = Number(rowD?.cantidad ?? 0);
      const nvD = antD + Number(it.cantidad);
      await supabase.from("stock_sucursal").upsert({
        producto_id: it.producto_id, sucursal_id: rem.sucursal_destino_id, cantidad: nvD,
      }, { onConflict: "producto_id,sucursal_id" });
      await supabase.from("stock_movimientos").insert({
        producto_id: it.producto_id, sucursal_id: rem.sucursal_destino_id,
        tipo: "TRANSFERENCIA_IN", cantidad: Number(it.cantidad),
        cantidad_anterior: antD, cantidad_nueva: nvD,
        referencia_id: rem.id, usuario_id: userId, motivo: `Remito ${rem.numero}`,
      });
    }

    await supabase.from("remitos").update({
      estado: "APROBADO", aprobado_por: userId, fecha_aprobacion: new Date().toISOString(),
    }).eq("id", rem.id);

    return { ok: true };
  });

export const rechazarRemito = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ remito_id: z.string().uuid(), motivo: z.string().min(1) }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Sólo el administrador puede rechazar remitos");

    await supabase.from("remitos").update({
      estado: "RECHAZADO", aprobado_por: userId,
      fecha_aprobacion: new Date().toISOString(), motivo_rechazo: data.motivo,
    }).eq("id", data.remito_id).eq("estado", "PENDIENTE");
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

    const { data: row } = await supabase.from("stock_sucursal").select("cantidad")
      .eq("producto_id", data.producto_id).eq("sucursal_id", data.sucursal_id).maybeSingle();
    const anterior = Number(row?.cantidad ?? 0);

    await supabase.from("stock_sucursal").upsert({
      producto_id: data.producto_id, sucursal_id: data.sucursal_id, cantidad: data.nueva_cantidad,
    }, { onConflict: "producto_id,sucursal_id" });

    await supabase.from("stock_movimientos").insert({
      producto_id: data.producto_id, sucursal_id: data.sucursal_id,
      tipo: "AJUSTE", cantidad: data.nueva_cantidad - anterior,
      cantidad_anterior: anterior, cantidad_nueva: data.nueva_cantidad,
      usuario_id: userId, motivo: data.motivo,
    });

    return { ok: true };
  });
