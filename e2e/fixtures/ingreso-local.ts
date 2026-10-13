import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

import type { Database } from "../../src/integrations/supabase/types";

if (typeof window !== "undefined") {
  throw new Error("El fixture de ingreso no puede cargarse en browser.");
}

const PROVEEDOR_ID = "e2140000-0000-4000-8000-000000000001";
const INGRESO_ID = "e2140000-0000-4000-8000-000000000002";
const ITEM_ID = "e2140000-0000-4000-8000-000000000003";
const CONFIRMACION_IDEMPOTENCY_KEY = "e2140000-0000-4000-8000-000000000004";
const MARCA = "T14-E2E-INGRESO-DETALLE";

export const PROVEEDOR_INGRESO_E2E = "T14 E2E PROVEEDOR INGRESO";
export const PRODUCTO_INGRESO_E2E = "T14 E2E producto del ingreso";
export const MOTIVO_CORRECCION_INGRESO_E2E = "El remito traía dos unidades, no cuatro.";

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
  // La corrección referencia al ingreso y su detalle referencia al movimiento
  // de stock. Se borra en el orden inverso al alta para que una corrida E2E
  // interrumpida no deje el fixture imposible de volver a preparar.
  const { data: correcciones, error: correccionesError } = await sb
    .from("ingreso_mercaderia_correcciones")
    .select("id")
    .eq("ingreso_id", INGRESO_ID);
  errorDe(correccionesError, "No se pudieron inspeccionar las correcciones E2E");
  const correccionIds = (correcciones ?? []).map(({ id }: { id: string }) => id);
  if (correccionIds.length > 0) {
    errorDe(
      (await sb.from("ingreso_mercaderia_correcciones").delete().in("id", correccionIds)).error,
      "No se pudieron limpiar las correcciones E2E",
    );
  }
  errorDe(
    (
      await sb
        .from("stock_movimientos")
        .delete()
        .in("referencia_id", [INGRESO_ID, ...correccionIds])
    ).error,
    "No se pudieron limpiar los movimientos del ingreso E2E",
  );
  const { error: ingresoError } = await sb
    .from("ingresos_mercaderia")
    .delete()
    .eq("id", INGRESO_ID);
  errorDe(ingresoError, "No se pudo limpiar el ingreso E2E");
  const { error: proveedorError } = await sb.from("proveedores").delete().eq("id", PROVEEDOR_ID);
  errorDe(proveedorError, "No se pudo limpiar el proveedor E2E");

  const [ingresos, items, proveedores, correccionesRestantes, movimientos] = await Promise.all([
    sb
      .from("ingresos_mercaderia")
      .select("id", { count: "exact", head: true })
      .eq("id", INGRESO_ID),
    sb
      .from("ingreso_mercaderia_items")
      .select("id", { count: "exact", head: true })
      .eq("id", ITEM_ID),
    sb.from("proveedores").select("id", { count: "exact", head: true }).eq("id", PROVEEDOR_ID),
    sb
      .from("ingreso_mercaderia_correcciones")
      .select("id", { count: "exact", head: true })
      .eq("ingreso_id", INGRESO_ID),
    sb
      .from("stock_movimientos")
      .select("id", { count: "exact", head: true })
      .in("referencia_id", [INGRESO_ID, ...correccionIds]),
  ]);
  errorDe(ingresos.error, "No se pudo verificar el cleanup del ingreso E2E");
  errorDe(items.error, "No se pudo verificar el cleanup del ítem E2E");
  errorDe(proveedores.error, "No se pudo verificar el cleanup del proveedor E2E");
  errorDe(correccionesRestantes.error, "No se pudo verificar el cleanup de las correcciones E2E");
  errorDe(movimientos.error, "No se pudo verificar el cleanup del kardex E2E");
  const residuos =
    (ingresos.count ?? 0) +
    (items.count ?? 0) +
    (proveedores.count ?? 0) +
    (correccionesRestantes.count ?? 0) +
    (movimientos.count ?? 0);
  if (residuos !== 0) {
    throw new Error(`El fixture de ingreso dejó ${residuos} residuo(s).`);
  }
}

export async function prepararIngresoLocalE2E(input: {
  productoId: string;
  sucursalId: string;
  usuarioAdmin: { id: string; email: string; password: string };
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
          usuario_id: input.usuarioAdmin.id,
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
          cantidad: 4,
          origen_match: "MANUAL",
        })
      ).error,
      "No se pudo preparar el ítem del ingreso E2E",
    );

    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      throw new Error("El fixture de ingreso exige URL y anon key del Supabase local.");
    }
    const autenticado = createClient<Database>(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: WebSocket },
    });
    errorDe(
      (
        await autenticado.auth.signInWithPassword({
          email: input.usuarioAdmin.email,
          password: input.usuarioAdmin.password,
        })
      ).error,
      "No se pudo autenticar el admin para confirmar el ingreso E2E",
    );
    errorDe(
      (
        await autenticado.rpc("confirmar_ingreso_mercaderia", {
          p_ingreso_id: INGRESO_ID,
          p_idempotency_key: CONFIRMACION_IDEMPOTENCY_KEY,
        })
      ).error,
      "No se pudo confirmar el ingreso E2E",
    );
  } catch (error) {
    await limpiarIngresoLocalE2E();
    throw error;
  }
}

export async function leerEstadoIngresoLocalE2E(): Promise<{
  estado: string;
  cantidadItem: number;
  stock: number;
  correcciones: Array<{
    id: string;
    motivo: string;
    usuarioNombre: string;
    cantidadAnterior: number;
    cantidadNueva: number;
    diferencia: number;
    movimiento: {
      tipo: string;
      cantidad: number;
      cantidadAnterior: number;
      cantidadNueva: number;
    };
  }>;
}> {
  const sb = adminLocal();
  const [ingreso, item] = await Promise.all([
    sb.from("ingresos_mercaderia").select("estado,sucursal_id").eq("id", INGRESO_ID).single(),
    sb.from("ingreso_mercaderia_items").select("cantidad,producto_id").eq("id", ITEM_ID).single(),
  ]);
  errorDe(ingreso.error, "No se pudo leer el estado del ingreso E2E");
  errorDe(item.error, "No se pudo leer la cantidad vigente del ingreso E2E");

  const [stock, correcciones] = await Promise.all([
    sb
      .from("stock_sucursal")
      .select("cantidad")
      .eq("sucursal_id", ingreso.data.sucursal_id)
      .eq("producto_id", item.data.producto_id!)
      .single(),
    sb
      .from("ingreso_mercaderia_correcciones")
      .select("id,motivo,usuario_nombre,created_at")
      .eq("ingreso_id", INGRESO_ID)
      .order("created_at", { ascending: true }),
  ]);
  errorDe(stock.error, "No se pudo leer el stock del ingreso E2E");
  errorDe(correcciones.error, "No se pudo leer el historial del ingreso E2E");

  const historial = await Promise.all(
    (correcciones.data ?? []).map(async (correccion) => {
      const detalle = await sb
        .from("ingreso_mercaderia_correccion_items")
        .select("cantidad_anterior,cantidad_nueva,diferencia,stock_movimiento_id")
        .eq("correccion_id", correccion.id)
        .eq("ingreso_item_id", ITEM_ID)
        .single();
      errorDe(detalle.error, "No se pudo leer el detalle de la corrección E2E");
      const movimiento = await sb
        .from("stock_movimientos")
        .select("tipo,cantidad,cantidad_anterior,cantidad_nueva")
        .eq("id", detalle.data.stock_movimiento_id)
        .single();
      errorDe(movimiento.error, "No se pudo leer el movimiento de la corrección E2E");
      return {
        id: correccion.id as string,
        motivo: correccion.motivo as string,
        usuarioNombre: correccion.usuario_nombre as string,
        cantidadAnterior: Number(detalle.data.cantidad_anterior),
        cantidadNueva: Number(detalle.data.cantidad_nueva),
        diferencia: Number(detalle.data.diferencia),
        movimiento: {
          tipo: movimiento.data.tipo,
          cantidad: Number(movimiento.data.cantidad),
          cantidadAnterior: Number(movimiento.data.cantidad_anterior),
          cantidadNueva: Number(movimiento.data.cantidad_nueva),
        },
      };
    }),
  );

  return {
    estado: ingreso.data.estado,
    cantidadItem: Number(item.data.cantidad),
    stock: Number(stock.data.cantidad),
    correcciones: historial,
  };
}
