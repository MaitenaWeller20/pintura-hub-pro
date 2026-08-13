/**
 * Server functions del ingreso de mercadería.
 *
 * Queda el buscador de productos, que corre server-side con el cliente
 * autenticado del usuario (respeta RLS). La suma de stock la hace la RPC
 * transaccional confirmar_ingreso_mercaderia, que se llama aparte desde el
 * cliente.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ---------------------------------------------------------------------------
// La extracción de remitos con IA se sacó el 29/07/2026.
//
// El cliente la bajó: "es un bardo lo de cargarlo con una foto, con un PDF; lo
// vamos a hacer a mano". La pantalla de ingresos ahora busca el producto en el
// catálogo y se pone la cantidad, con las mismas RPC de siempre.
//
// Lo que NO se perdió: `producto_codigos_proveedor` —la tabla que hace que el
// segundo remito del mismo proveedor venga resuelto— se sigue alimentando desde
// `confirmar_ingreso_mercaderia`, que guarda el código del proveedor que se
// carga a mano. Nunca dependió de la IA.
//
// Ver docs/superpowers/specs/2026-07-29-compras-plata-ingresos-mano-design.md §5.3
// ---------------------------------------------------------------------------

export const buscarProductosIngreso = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ texto: z.string().min(1), codigo: z.string().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase.rpc("buscar_productos_similares", {
      p_texto: data.texto,
      p_codigo: data.codigo || undefined,
      p_limite: 12,
    });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
