/** Server fns para eliminar/restaurar/activar productos (el borrado es híbrido:
 *  DELETE si no tiene historial ni stock, si no ARCHIVA). Toda la lógica y la
 *  validación admin viven en las RPC SECURITY DEFINER eliminar_productos /
 *  restaurar_productos / activar_productos. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export interface ResumenEliminacion {
  borrados: { id: string; codigo: string; nombre: string }[];
  archivados: { id: string; codigo: string; nombre: string }[];
  bloqueados: { id: string; codigo: string; nombre: string; motivo: string }[];
}

export const eliminarProductos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ ids: z.array(z.string().uuid()).min(1) }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: res, error } = await context.supabase.rpc("eliminar_productos", {
      p_ids: data.ids,
    });
    if (error) throw new Error(error.message);
    return res as unknown as ResumenEliminacion;
  });

export const restaurarProductos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ ids: z.array(z.string().uuid()).min(1) }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: n, error } = await context.supabase.rpc("restaurar_productos", {
      p_ids: data.ids,
    });
    if (error) throw new Error(error.message);
    return { restaurados: (n as number) ?? 0 };
  });

export interface ResumenActivacion {
  /** Cuántos quedaron prendidos. */
  activados: number;
  /** Cuántos se saltaron por no tener precio (se venderían a $0). */
  sin_precio: number;
  /** Cuántos se saltaron por estar archivados (esos se restauran, no se prenden). */
  archivados: number;
}

/**
 * Prender productos apagados. Los números salen de la BASE, no del snapshot de la
 * pantalla: entre que se dibujó la lista y se apretó el botón puede haber cambiado
 * cualquiera de las tres condiciones.
 */
export const activarProductos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ ids: z.array(z.string().uuid()).min(1) }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: res, error } = await context.supabase.rpc("activar_productos", {
      p_ids: data.ids,
    });
    if (error) throw new Error(error.message);
    return res as unknown as ResumenActivacion;
  });
