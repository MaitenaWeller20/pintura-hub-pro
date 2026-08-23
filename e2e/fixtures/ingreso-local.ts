import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

import type { Database } from "../../src/integrations/supabase/types";

if (typeof window !== "undefined") {
  throw new Error("El fixture de ingreso no puede cargarse en browser.");
}

const PROVEEDOR_ID = "e2140000-0000-4000-8000-000000000001";
const INGRESO_ID = "e2140000-0000-4000-8000-000000000002";
const ITEM_ID = "e2140000-0000-4000-8000-000000000003";
const MARCA = "T14-E2E-INGRESO-DETALLE";

export const PROVEEDOR_INGRESO_E2E = "T14 E2E PROVEEDOR INGRESO";
export const PRODUCTO_INGRESO_E2E = "T14 E2E producto del ingreso";

let cliente: SupabaseClient<Database> | null = null;

function adminLocal(): SupabaseClient<Database> {
  if (cliente) return cliente;
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("El fixture de ingreso exige URL y service-role del Supabase local.");
  }
  const parsed = new URL(url);
  if (!/^(127\.0\.0\.1|localhost)$/.test(parsed.hostname)) {
    throw new Error("El fixture de ingreso se negó a usar un Supabase que no es local.");
  }
  cliente = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });
  return cliente;
}

function errorDe(error: { message: string } | null, contexto: string): void {
  if (error) throw new Error(`${contexto}: ${error.message}`);
}

async function exigirPropiedadDelFixture(): Promise<void> {
  const sb = adminLocal();
  const [proveedor, ingreso] = await Promise.all([
    sb.from("proveedores").select("razon_social").eq("id", PROVEEDOR_ID).maybeSingle(),
    sb.from("ingresos_mercaderia").select("observaciones").eq("id", INGRESO_ID).maybeSingle(),
  ]);
  errorDe(proveedor.error, "No se pudo inspeccionar el proveedor E2E");
  errorDe(ingreso.error, "No se pudo inspeccionar el ingreso E2E");
  if (proveedor.data && proveedor.data.razon_social !== PROVEEDOR_INGRESO_E2E) {
    throw new Error("El ID reservado del proveedor E2E pertenece a otro registro.");
  }
  if (ingreso.data && ingreso.data.observaciones !== MARCA) {
    throw new Error("El ID reservado del ingreso E2E pertenece a otro registro.");
  }
}

export async function limpiarIngresoLocalE2E(): Promise<void> {
  await exigirPropiedadDelFixture();
  const sb = adminLocal();
  const { error: ingresoError } = await sb
    .from("ingresos_mercaderia")
    .delete()
    .eq("id", INGRESO_ID);
  errorDe(ingresoError, "No se pudo limpiar el ingreso E2E");
  const { error: proveedorError } = await sb.from("proveedores").delete().eq("id", PROVEEDOR_ID);
  errorDe(proveedorError, "No se pudo limpiar el proveedor E2E");

  const [ingresos, items, proveedores] = await Promise.all([
    sb
      .from("ingresos_mercaderia")
      .select("id", { count: "exact", head: true })
      .eq("id", INGRESO_ID),
    sb
      .from("ingreso_mercaderia_items")
      .select("id", { count: "exact", head: true })
      .eq("id", ITEM_ID),
    sb.from("proveedores").select("id", { count: "exact", head: true }).eq("id", PROVEEDOR_ID),
  ]);
  errorDe(ingresos.error, "No se pudo verificar el cleanup del ingreso E2E");
  errorDe(items.error, "No se pudo verificar el cleanup del ítem E2E");
  errorDe(proveedores.error, "No se pudo verificar el cleanup del proveedor E2E");
  const residuos = (ingresos.count ?? 0) + (items.count ?? 0) + (proveedores.count ?? 0);
  if (residuos !== 0) {
    throw new Error(`El fixture de ingreso dejó ${residuos} residuo(s).`);
  }
}

export async function prepararIngresoLocalE2E(input: {
  productoId: string;
  sucursalId: string;
  usuarioId: string;
}): Promise<void> {
  await limpiarIngresoLocalE2E();
  const sb = adminLocal();
  errorDe(
    (
      await sb.from("proveedores").insert({
        id: PROVEEDOR_ID,
        razon_social: PROVEEDOR_INGRESO_E2E,
        activo: true,
      })
    ).error,
    "No se pudo preparar el proveedor E2E",
  );
  try {
    errorDe(
      (
        await sb.from("ingresos_mercaderia").insert({
          id: INGRESO_ID,
          proveedor_id: PROVEEDOR_ID,
          sucursal_id: input.sucursalId,
          usuario_id: input.usuarioId,
          numero_remito_proveedor: "T14-E2E-001",
          fecha_remito: "2026-08-23",
          estado: "BORRADOR",
          extraccion_estado: "OK",
          observaciones: MARCA,
        })
      ).error,
      "No se pudo preparar el ingreso E2E",
    );
    errorDe(
      (
        await sb.from("ingreso_mercaderia_items").insert({
          id: ITEM_ID,
          ingreso_id: INGRESO_ID,
          linea: 1,
          producto_id: input.productoId,
          codigo: "T14-E2E-ING",
          descripcion: PRODUCTO_INGRESO_E2E,
          cantidad: 2,
          origen_match: "MANUAL",
        })
      ).error,
      "No se pudo preparar el ítem del ingreso E2E",
    );
  } catch (error) {
    await limpiarIngresoLocalE2E();
    throw error;
  }
}
