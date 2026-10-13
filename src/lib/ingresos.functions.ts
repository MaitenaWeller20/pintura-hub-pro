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
import { TOPE_BUSQUEDA_PRODUCTOS } from "./postgrest";

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

const busquedaProductosIngresoSchema = z.object({
  proveedor_id: z.string().uuid(),
  texto: z.string().trim().min(1),
  codigo: z.string().trim().optional(),
});

export type ArgsRpcBusquedaProductosIngreso = {
  p_texto: string;
  p_codigo: string;
  p_limite: number;
  p_proveedor_id: string;
};

export type ProductoBusquedaIngreso = {
  id: string;
  codigo: string;
  nombre: string;
  activo: boolean;
  iva_porcentaje: number;
  score: number;
};

export function prepararBusquedaProductosIngreso(
  proveedorId: string,
  texto: string,
): z.infer<typeof busquedaProductosIngresoSchema> | null {
  const consulta = texto.trim();
  if (!proveedorId || consulta.length < 2) return null;
  return {
    proveedor_id: proveedorId,
    texto: consulta,
    codigo: consulta,
  };
}

export function crearServicioBusquedaProductosIngreso(deps: {
  buscar(args: ArgsRpcBusquedaProductosIngreso): Promise<ProductoBusquedaIngreso[]>;
}) {
  return {
    async buscar(rawInput: unknown): Promise<ProductoBusquedaIngreso[]> {
      const input = busquedaProductosIngresoSchema.parse(rawInput);
      return deps.buscar({
        p_texto: input.texto,
        p_codigo: input.codigo ?? input.texto,
        p_limite: TOPE_BUSQUEDA_PRODUCTOS,
        p_proveedor_id: input.proveedor_id,
      });
    },
  };
}

export const buscarProductosIngreso = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => busquedaProductosIngresoSchema.parse(d))
  .handler(({ data, context }) => {
    const servicio = crearServicioBusquedaProductosIngreso({
      async buscar(args) {
        const { data: rows, error } = await context.supabase.rpc(
          "buscar_productos_similares",
          args,
        );
        if (error) throw new Error(error.message);
        return rows ?? [];
      },
    });
    return servicio.buscar(data);
  });
