import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type PreflightConversionPresupuesto = {
  presupuestoId: string;
  sucursalId: string;
  sucursalNombre: string;
  caja: null | { id: string; abiertaDesde: string };
};

type DependenciasPreflightConversion = {
  cargarPresupuestoUsuario(presupuestoId: string): Promise<unknown>;
  cargarCajasUsuario(sucursalId: string, limite: number): Promise<unknown>;
};

function esRegistro(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nombreSucursal(value: unknown): string | null {
  const relacion = Array.isArray(value) ? value[0] : value;
  if (!esRegistro(relacion) || typeof relacion.nombre !== "string") return null;
  const nombre = relacion.nombre.trim();
  return nombre || null;
}

export async function ejecutarPreflightConversionPresupuesto(
  input: { presupuestoId: string },
  deps: DependenciasPreflightConversion,
): Promise<PreflightConversionPresupuesto> {
  let presupuesto: unknown;
  try {
    presupuesto = await deps.cargarPresupuestoUsuario(input.presupuestoId);
  } catch {
    throw new Error("No se pudo leer el presupuesto o no tenés acceso.");
  }
  if (
    !esRegistro(presupuesto) ||
    presupuesto.id !== input.presupuestoId ||
    typeof presupuesto.sucursal_id !== "string"
  ) {
    throw new Error("No se pudo leer el presupuesto o no tenés acceso.");
  }

  const sucursalNombre = nombreSucursal(presupuesto.sucursal);
  if (!sucursalNombre) throw new Error("El presupuesto no tiene una sucursal válida.");

  let cajas: unknown;
  try {
    cajas = await deps.cargarCajasUsuario(presupuesto.sucursal_id, 2);
  } catch {
    throw new Error("No se pudo confirmar la caja de la sucursal.");
  }
  if (!Array.isArray(cajas) || cajas.length > 1) {
    throw new Error("No se pudo confirmar la caja de la sucursal.");
  }

  const caja = cajas[0];
  if (caja === undefined) {
    return {
      presupuestoId: presupuesto.id,
      sucursalId: presupuesto.sucursal_id,
      sucursalNombre,
      caja: null,
    };
  }
  if (!esRegistro(caja) || typeof caja.id !== "string" || typeof caja.abierta_en !== "string") {
    throw new Error("No se pudo confirmar la caja de la sucursal.");
  }

  return {
    presupuestoId: presupuesto.id,
    sucursalId: presupuesto.sucursal_id,
    sucursalNombre,
    caja: { id: caja.id, abiertaDesde: caja.abierta_en },
  };
}

const preflightConversionInputSchema = z.object({ presupuesto_id: z.string().uuid() }).strict();

export const preflightConversionPresupuesto = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => preflightConversionInputSchema.parse(value))
  .handler(async ({ data, context }) =>
    ejecutarPreflightConversionPresupuesto(
      { presupuestoId: data.presupuesto_id },
      {
        async cargarPresupuestoUsuario(presupuestoId) {
          const { data: presupuesto, error } = await context.supabase
            .from("presupuestos")
            .select("id,sucursal_id,sucursal:sucursales(nombre)")
            .eq("id", presupuestoId)
            .maybeSingle();
          if (error) throw error;
          return presupuesto;
        },
        async cargarCajasUsuario(sucursalId, limite) {
          const { data: cajas, error } = await context.supabase
            .from("caja_sesiones")
            .select("id,abierta_en")
            .eq("sucursal_id", sucursalId)
            .eq("estado", "ABIERTA")
            .order("abierta_en", { ascending: false })
            .limit(limite);
          if (error) throw error;
          return cajas ?? [];
        },
      },
    ),
  );
