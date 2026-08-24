import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import WebSocket from "ws";

import type { Database, Json } from "../../src/integrations/supabase/types";
import { crearSnapshotFiscalV2 } from "../../src/lib/fiscal/snapshot";
import {
  exigirCeroResiduosFixture,
  exigirSesionesCajaPropiasSinReferencias,
  type ReferenciasCajaFixture,
  type SesionCajaFixture,
} from "./limpieza-caja";
import { construirFechasFixtureArgentina } from "./fecha-argentina";

/**
 * Fixture Node-only. Nunca se importa desde `src/` ni se serializa al navegador.
 * Usa service-role exclusivamente contra 127.0.0.1/localhost y aborta ante otra URL.
 */
if (typeof window !== "undefined")
  throw new Error("El fixture fiscal no puede cargarse en browser.");

export const PREFIJO_FISCAL_E2E = "T13-E2E";
const EMAIL_SIN_CAPACIDAD = "t13-sin-capacidad@local.test";
const PASSWORD_SIN_CAPACIDAD = "t13-sin-capacidad-1234";
const EMAIL_ADMIN = "t13-admin@local.test";
const PASSWORD_ADMIN = "t13-admin-1234";
const EMAIL_EMPLEADO = "t13-empleado@local.test";
const PASSWORD_EMPLEADO = "t13-empleado-1234";
const CLIENTE_COMPRADOR_ID = "e2130000-0000-4000-8000-000000000001";
const CLIENTE_OTRO_ID = "e2130000-0000-4000-8000-000000000002";
const CLIENTE_COLA_ID = "e2130000-0000-4000-8000-000000000015";
const DOCUMENTO_COLA = "20-34567890-6";
const DOCUMENTO_COLA_DIGITOS = "20345678906";
const PRODUCTO_ID = "e2130000-0000-4000-8000-000000000003";
const PRODUCTOS_BUSQUEDA = Array.from({ length: 12 }, (_, index) => ({
  id: `e2134000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  codigo: `T13-AR-${String(index + 1).padStart(3, "0")}`,
  nombre: `${PREFIJO_FISCAL_E2E} artículo búsqueda ${String(index + 1).padStart(2, "0")}`,
}));
const PRODUCTO_IDS = [PRODUCTO_ID, ...PRODUCTOS_BUSQUEDA.map(({ id }) => id)];
const PRESUPUESTO_ID = "e2130000-0000-4000-8000-000000000004";
const PRESUPUESTO_ITEM_ID = "e2130000-0000-4000-8000-000000000005";
const FAVORITO_ID = "e2130000-0000-4000-8000-000000000006";
const CREDENCIAL_MOCK_ID = "e2130000-0000-4000-8000-000000000012";
const VENTA_APROBADA_ID = "e2130000-0000-4000-8000-000000000007";
const VENTA_NC_ID = "e2130000-0000-4000-8000-000000000008";
const ITEM_APROBADO_ID = "e2130000-0000-4000-8000-000000000009";
const ITEM_NC_ID = "e2130000-0000-4000-8000-000000000011";
const VENTA_NC_MANUAL_ORIGINAL_ID = "e2130000-0000-4000-8000-000000000013";
const ITEM_NC_MANUAL_ORIGINAL_ID = "e2130000-0000-4000-8000-000000000014";

const uuidVenta = (indice: number) => `e2131000-0000-4000-8000-${String(indice).padStart(12, "0")}`;

type SettingsRow = Pick<
  Database["public"]["Tables"]["settings"]["Row"],
  "facturacion_receptor_v2_enabled" | "facturacion_legacy_writer_enabled"
>;
type EmisorGuardado = Pick<
  Database["public"]["Tables"]["emisores"]["Row"],
  | "id"
  | "razon_social"
  | "nombre_fantasia"
  | "cuit"
  | "domicilio_fiscal"
  | "condicion_iva"
  | "ingresos_brutos"
  | "inicio_actividades"
  | "factura_a_modalidad"
  | "factura_a_revalidar_at"
>;
type PuntoVentaGuardado = Pick<
  Database["public"]["Tables"]["puntos_venta"]["Row"],
  "sucursal_id" | "numero" | "modo" | "activo"
>;
type CredencialGuardada = Database["public"]["Tables"]["credenciales_arca"]["Row"];

type Restauracion = {
  settings: SettingsRow;
  emisor: EmisorGuardado;
  puntoVenta: PuntoVentaGuardado;
  credencial: CredencialGuardada | null;
  credencialCreada: boolean;
};

export type FixtureFiscal = {
  sucursalPrincipalId: string;
  sucursalAlternaId: string;
  sucursalPrincipalNombre: string;
  emisorRazonSocial: string;
  emisorCuit: string;
  puntoVenta: number;
  fechaFiscal: string;
  fechaFiscalVisible: string;
  clienteCompradorId: string;
  documentoCola: string;
  productoId: string;
  presupuestoId: string;
  ventaPendienteId: string;
  ventaAntiguaId: string;
  ventaAprobadaId: string;
  ventaCanceladaId: string;
  notaCreditoId: string;
  ventaOriginalNotaCreditoId: string;
  usuarioAdmin: { email: string; password: string; id: string };
  usuarioEmpleado: { email: string; password: string; id: string };
  usuarioSinCapacidad: { email: string; password: string; id: string };
};

let cliente: SupabaseClient<Database> | null = null;
let clienteAdminJwt: SupabaseClient<Database> | null = null;
let postgresLocal: ReturnType<typeof postgres> | null = null;
let restauracion: Restauracion | null = null;
const usuariosCreados = new Set<string>();

function cargarVariablesLocales() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key || !anonKey) {
    throw new Error("Los E2E fiscales requieren URL, anon key y service-role del Supabase local.");
  }
  const parsed = new URL(url);
  if (!/^(127\.0\.0\.1|localhost)$/.test(parsed.hostname)) {
    throw new Error("El fixture fiscal se negó a usar un Supabase que no es local.");
  }
  return { url, key, anonKey };
}

function admin(): SupabaseClient<Database> {
  if (!cliente) {
    const { url, key } = cargarVariablesLocales();
    cliente = createClient<Database>(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: WebSocket },
    });
  }
  return cliente;
}

function conexionPostgresLocal(): ReturnType<typeof postgres> {
  if (postgresLocal) return postgresLocal;
  const raizProyecto = fileURLToPath(new URL("../..", import.meta.url));
  let estadoLocal: string;
  try {
    estadoLocal = execFileSync("supabase", ["status", "-o", "env"], {
      cwd: raizProyecto,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("No se pudo leer el estado del Supabase local para el cleanup E2E.");
  }
  const dbUrl = /^DB_URL="([^"]+)"$/m.exec(estadoLocal)?.[1];
  if (!dbUrl) throw new Error("Supabase local no informó su DB_URL para el cleanup E2E.");
  const parsed = new URL(dbUrl);
  const config = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8");
  const seccionDb = /\[db\]([\s\S]*?)(?:\n\[|$)/.exec(config)?.[1] ?? "";
  const puertoEsperado = /^port\s*=\s*(\d+)\s*$/m.exec(seccionDb)?.[1] ?? "54322";
  if (
    !/^(127\.0\.0\.1|localhost)$/.test(parsed.hostname) ||
    parsed.port !== puertoEsperado ||
    parsed.pathname !== "/postgres" ||
    parsed.username !== "postgres"
  ) {
    throw new Error("El fixture fiscal se negó a abrir una conexión PostgreSQL no local.");
  }
  postgresLocal = postgres(dbUrl, { max: 1, prepare: false });
  return postgresLocal;
}

async function cerrarPostgresLocal(): Promise<void> {
  const sql = postgresLocal;
  postgresLocal = null;
  if (sql) await sql.end({ timeout: 5 });
}

function errorDe(error: { message: string } | null, contexto: string) {
  if (error) throw new Error(`${contexto}: ${error.message}`);
}

type ResultadoConError = { error: { message: string } | null };

async function exigirOperacion(
  operacion: PromiseLike<ResultadoConError>,
  contexto: string,
): Promise<void> {
  errorDe((await operacion).error, contexto);
}

function mensajeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function intentarLimpieza(accion: () => Promise<void>, errores: string[]): Promise<void> {
  try {
    await accion();
  } catch (error) {
    errores.push(mensajeError(error));
  }
}

function exigirLimpiezaCompleta(contexto: string, errores: string[]): void {
  if (errores.length === 0) return;
  throw new Error(`${contexto} (${errores.length}):\n- ${errores.join("\n- ")}`);
}

async function usuariosLocales(): Promise<User[]> {
  const sb = admin();
  const usuarios: User[] = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 100 });
    errorDe(error, "No se pudieron listar los usuarios locales");
    usuarios.push(...data.users);
    if (data.users.length < 100) return usuarios;
  }
}

async function usuarioPorEmail(email: string): Promise<User | null> {
  return (await usuariosLocales()).find((user) => user.email === email) ?? null;
}

async function crearUsuarioEfimeroLocal(input: {
  email: string;
  password: string;
  username: string;
  nombre: string;
  role: "admin" | "empleado";
  sucursalId: string;
}): Promise<User> {
  const sb = admin();
  if (await usuarioPorEmail(input.email)) {
    throw new Error(`El usuario efímero ${input.email} debía estar ausente antes de crearlo.`);
  }
  const { data, error } = await sb.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  });
  errorDe(error, `No se pudo crear el usuario E2E ${input.email}`);
  const user = data.user;
  usuariosCreados.add(user.id);
  const { error: profileError } = await sb.from("profiles").upsert({
    id: user.id,
    username: input.username,
    nombre_completo: input.nombre,
    sucursal_id: input.sucursalId,
    activo: true,
  });
  errorDe(profileError, `No se pudo preparar el perfil E2E ${input.email}`);
  const { error: roleError } = await sb
    .from("user_roles")
    .upsert({ user_id: user.id, role: input.role }, { onConflict: "user_id,role" });
  errorDe(roleError, `No se pudo preparar el rol E2E ${input.email}`);
  const { error: branchError } = await sb
    .from("profile_sucursales")
    .upsert({ profile_id: user.id, sucursal_id: input.sucursalId });
  errorDe(branchError, `No se pudo asignar la sucursal E2E ${input.email}`);
  return user;
}

const crearUsuarioSinCapacidad = (sucursalId: string) =>
  crearUsuarioEfimeroLocal({
    email: EMAIL_SIN_CAPACIDAD,
    password: PASSWORD_SIN_CAPACIDAD,
    username: "t13-sin-capacidad",
    nombre: "T13 Sin capacidad fiscal",
    role: "empleado",
    sucursalId,
  });

async function adminConJwt(): Promise<SupabaseClient<Database>> {
  if (clienteAdminJwt) return clienteAdminJwt;
  const { url, anonKey } = cargarVariablesLocales();
  const autenticado = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });
  const { error } = await autenticado.auth.signInWithPassword({
    email: EMAIL_ADMIN,
    password: PASSWORD_ADMIN,
  });
  errorDe(error, "No se pudo autenticar el admin local del fixture");
  clienteAdminJwt = autenticado;
  return autenticado;
}

async function cambiarCapacidadFiscal(userId: string, value: boolean) {
  errorDe(
    (
      await (
        await adminConJwt()
      ).rpc("administrar_puede_facturar", {
        p_profile_id: userId,
        p_puede_facturar: value,
      })
    ).error,
    "No se pudo preparar/restaurar la capacidad fiscal E2E",
  );
}

async function eliminarUsuarioEfimeroPorEmail(email: string) {
  const existente = await usuarioPorEmail(email);
  if (!existente) return;
  await limpiarSesionesCajaUsuariosCreados([existente.id]);
  await exigirOperacion(
    admin().from("profiles").delete().eq("id", existente.id),
    `No se pudo limpiar el perfil efímero ${email}`,
  );
  errorDe(
    (await admin().auth.admin.deleteUser(existente.id)).error,
    `No se pudo limpiar el usuario efímero ${email}`,
  );
  usuariosCreados.delete(existente.id);
}

async function contarReferenciasCaja(sesionId: string): Promise<ReferenciasCajaFixture> {
  const sb = admin();
  const contar = async (
    operacion: PromiseLike<{ count: number | null; error: { message: string } | null }>,
    tabla: keyof ReferenciasCajaFixture,
  ) => {
    const { count, error } = await operacion;
    errorDe(error, `No se pudieron auditar referencias ${tabla} de la caja E2E`);
    return count ?? 0;
  };
  return {
    ventas: await contar(
      sb.from("ventas").select("id", { count: "exact", head: true }).eq("caja_sesion_id", sesionId),
      "ventas",
    ),
    venta_pagos: await contar(
      sb
        .from("venta_pagos")
        .select("id", { count: "exact", head: true })
        .eq("caja_sesion_id", sesionId),
      "venta_pagos",
    ),
    caja_movimientos: await contar(
      sb
        .from("caja_movimientos")
        .select("id", { count: "exact", head: true })
        .eq("caja_sesion_id", sesionId),
      "caja_movimientos",
    ),
    cobranzas_cta_cte: await contar(
      sb
        .from("cobranzas_cta_cte")
        .select("id", { count: "exact", head: true })
        .eq("caja_sesion_id", sesionId),
      "cobranzas_cta_cte",
    ),
    compras: await contar(
      sb
        .from("compras")
        .select("id", { count: "exact", head: true })
        .eq("caja_sesion_id", sesionId),
      "compras",
    ),
    proveedor_pagos: await contar(
      sb
        .from("proveedor_pagos")
        .select("id", { count: "exact", head: true })
        .eq("caja_sesion_id", sesionId),
      "proveedor_pagos",
    ),
  };
}

async function limpiarSesionesCajaUsuariosCreados(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const sb = admin();
  const [abiertas, cerradas] = await Promise.all([
    sb.from("caja_sesiones").select("id,abierta_por,cerrada_por").in("abierta_por", userIds),
    sb.from("caja_sesiones").select("id,abierta_por,cerrada_por").in("cerrada_por", userIds),
  ]);
  errorDe(abiertas.error, "No se pudieron localizar las cajas abiertas por usuarios E2E");
  errorDe(cerradas.error, "No se pudieron localizar las cajas cerradas por usuarios E2E");
  const sesiones = new Map<string, SesionCajaFixture>();
  for (const sesion of [...(abiertas.data ?? []), ...(cerradas.data ?? [])]) {
    sesiones.set(sesion.id, sesion);
  }
  const referenciasPorSesion: Record<string, ReferenciasCajaFixture> = {};
  for (const sesionId of sesiones.keys()) {
    referenciasPorSesion[sesionId] = await contarReferenciasCaja(sesionId);
  }
  const sesionIds = exigirSesionesCajaPropiasSinReferencias(
    [...sesiones.values()],
    new Set(userIds),
    referenciasPorSesion,
  );
  if (sesionIds.length > 0) {
    await exigirOperacion(
      sb.from("caja_sesiones").delete().in("id", sesionIds),
      "No se pudieron limpiar las cajas propias de usuarios E2E",
    );
  }
  const [abiertasRestantes, cerradasRestantes] = await Promise.all([
    sb
      .from("caja_sesiones")
      .select("id", { count: "exact", head: true })
      .in("abierta_por", userIds),
    sb
      .from("caja_sesiones")
      .select("id", { count: "exact", head: true })
      .in("cerrada_por", userIds),
  ]);
  errorDe(abiertasRestantes.error, "No se pudo verificar el cleanup de cajas abiertas E2E");
  errorDe(cerradasRestantes.error, "No se pudo verificar el cleanup de cajas cerradas E2E");
  if ((abiertasRestantes.count ?? 0) !== 0 || (cerradasRestantes.count ?? 0) !== 0) {
    throw new Error("El cleanup dejó sesiones de caja vinculadas a usuarios E2E.");
  }
}

async function limpiarUsuariosCreados() {
  const errores: string[] = [];
  const userIds = [...usuariosCreados];
  if (clienteAdminJwt) {
    const sesion = clienteAdminJwt;
    clienteAdminJwt = null;
    await intentarLimpieza(
      () => exigirOperacion(sesion.auth.signOut(), "No se pudo cerrar la sesión admin E2E"),
      errores,
    );
  }
  await intentarLimpieza(() => limpiarSesionesCajaUsuariosCreados(userIds), errores);
  if (errores.length > 0) {
    exigirLimpiezaCompleta("Falló la limpieza previa de cajas E2E", errores);
  }
  for (const userId of userIds) {
    // El perfil tiene una asignación de sucursal protegida por trigger. Borrar
    // primero el perfil deja que su cascade quite esa asignación antes de que
    // GoTrue intente borrar el usuario completo.
    const { error: profileError } = await admin().from("profiles").delete().eq("id", userId);
    if (profileError) {
      errores.push(
        `No se pudo limpiar el perfil del usuario E2E ${userId}: ${profileError.message}`,
      );
      continue;
    }
    const { error } = await admin().auth.admin.deleteUser(userId);
    if (error && !/not found/i.test(error.message)) {
      errores.push(
        `No se pudo limpiar el usuario Auth E2E ${userId}: ${error.name} ${error.status} ${error.message}`,
      );
      continue;
    }
    usuariosCreados.delete(userId);
  }
  await intentarLimpieza(async () => {
    const authRestantes = (await usuariosLocales()).filter(({ id }) => userIds.includes(id));
    if (authRestantes.length !== 0) {
      throw new Error(`El cleanup dejó ${authRestantes.length} usuario(s) Auth E2E.`);
    }
    const { count, error } = await admin()
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .in("id", userIds);
    errorDe(error, "No se pudo verificar el cleanup de perfiles E2E");
    if ((count ?? 0) !== 0) {
      throw new Error(`El cleanup dejó ${count} perfil(es) E2E.`);
    }
  }, errores);
  exigirLimpiezaCompleta("Falló la limpieza de usuarios E2E", errores);
}

async function auditarAusenciaFixtureFiscal(): Promise<void> {
  const sb = admin();
  const contar = async (
    operacion: PromiseLike<{ count: number | null; error: { message: string } | null }>,
    contexto: string,
  ): Promise<number> => {
    const { count, error } = await operacion;
    errorDe(error, `No se pudo auditar ${contexto}`);
    return count ?? 0;
  };
  const deterministicas = [
    VENTA_APROBADA_ID,
    VENTA_NC_ID,
    VENTA_NC_MANUAL_ORIGINAL_ID,
    ...Array.from({ length: 40 }, (_, index) => uuidVenta(index + 1)),
  ];
  const [ventas, itemsProducto, productos, clientes, presupuestos, favoritos, perfiles] =
    await Promise.all([
      contar(
        sb.from("ventas").select("id", { count: "exact", head: true }).in("id", deterministicas),
        "ventas determinísticas E2E",
      ),
      contar(
        sb
          .from("venta_items")
          .select("id", { count: "exact", head: true })
          .eq("producto_id", PRODUCTO_ID),
        "ítems comerciales E2E",
      ),
      contar(
        sb.from("productos").select("id", { count: "exact", head: true }).in("id", PRODUCTO_IDS),
        "productos E2E",
      ),
      contar(
        sb
          .from("clientes")
          .select("id", { count: "exact", head: true })
          .in("id", [CLIENTE_COMPRADOR_ID, CLIENTE_OTRO_ID, CLIENTE_COLA_ID]),
        "clientes E2E",
      ),
      contar(
        sb
          .from("presupuestos")
          .select("id", { count: "exact", head: true })
          .eq("id", PRESUPUESTO_ID),
        "presupuesto E2E",
      ),
      contar(
        sb
          .from("receptores_fiscales")
          .select("id", { count: "exact", head: true })
          .eq("id", FAVORITO_ID),
        "favorito E2E",
      ),
      contar(
        sb
          .from("profiles")
          .select("id", { count: "exact", head: true })
          .in("username", ["t13-admin", "t13-empleado", "t13-sin-capacidad"]),
        "perfiles descartables E2E",
      ),
    ]);
  const emails = new Set([EMAIL_ADMIN, EMAIL_EMPLEADO, EMAIL_SIN_CAPACIDAD]);
  const auth = (await usuariosLocales()).filter((usuario) =>
    emails.has(usuario.email ?? ""),
  ).length;
  exigirCeroResiduosFixture({
    ventas,
    itemsProducto,
    productos,
    clientes,
    presupuestos,
    favoritos,
    perfiles,
    auth,
  });
}

async function ventasDelProducto(): Promise<string[]> {
  const { data, error } = await admin()
    .from("venta_items")
    .select("venta_id")
    .eq("producto_id", PRODUCTO_ID);
  errorDe(error, "No se pudieron ubicar las ventas E2E");
  return [...new Set((data ?? []).map((row) => row.venta_id))];
}

async function limpiarDatos() {
  const sb = admin();
  const errores: string[] = [];
  const deterministicas = [
    VENTA_APROBADA_ID,
    VENTA_NC_ID,
    VENTA_NC_MANUAL_ORIGINAL_ID,
    ...Array.from({ length: 40 }, (_, index) => uuidVenta(index + 1)),
  ];
  const ventaIds = [...new Set([...deterministicas, ...(await ventasDelProducto())])];

  await intentarLimpieza(
    () =>
      exigirOperacion(
        sb
          .from("presupuestos")
          .update({ venta_id: null, estado: "ABIERTO" })
          .eq("id", PRESUPUESTO_ID),
        "No se pudo desvincular el presupuesto E2E",
      ),
    errores,
  );
  if (ventaIds.length) {
    await intentarLimpieza(
      () =>
        exigirOperacion(
          sb.from("cuenta_corriente_movimientos").delete().in("venta_id", ventaIds),
          "No se pudo limpiar la deuda E2E",
        ),
      errores,
    );
    await intentarLimpieza(
      () =>
        exigirOperacion(
          sb.from("stock_movimientos").delete().in("referencia_id", ventaIds),
          "No se pudieron limpiar los movimientos de stock por venta E2E",
        ),
      errores,
    );
    await intentarLimpieza(
      () =>
        exigirOperacion(
          sb.from("venta_pagos").delete().in("venta_id", ventaIds),
          "No se pudieron limpiar los pagos E2E",
        ),
      errores,
    );
    await intentarLimpieza(
      () =>
        exigirOperacion(
          sb.from("venta_items").delete().in("venta_id", ventaIds),
          "No se pudieron limpiar los ítems de venta E2E",
        ),
      errores,
    );
    await intentarLimpieza(
      () =>
        exigirOperacion(
          sb.from("ventas").delete().in("id", ventaIds),
          "No se pudieron limpiar las ventas E2E",
        ),
      errores,
    );
    await intentarLimpieza(async () => {
      const { count, error } = await sb
        .from("emision_fiscal_intentos")
        .select("id", { count: "exact", head: true })
        .in("venta_id", ventaIds);
      errorDe(error, "No se pudo verificar el cascade de intentos fiscales E2E");
      if ((count ?? 0) !== 0) {
        throw new Error(
          `El cascade fiscal dejó ${count} intento(s) E2E después de borrar sus ventas`,
        );
      }
    }, errores);
  }
  const operaciones: Array<[contexto: string, accion: () => Promise<void>]> = [
    [
      "el favorito E2E",
      () =>
        exigirOperacion(
          sb.from("receptores_fiscales").delete().eq("id", FAVORITO_ID),
          "No se pudo limpiar el favorito E2E",
        ),
    ],
    [
      "los receptores del cliente E2E",
      () =>
        exigirOperacion(
          sb
            .from("receptores_fiscales")
            .delete()
            .in("cliente_comercial_id", [CLIENTE_COMPRADOR_ID, CLIENTE_OTRO_ID, CLIENTE_COLA_ID]),
          "No se pudieron limpiar los receptores del cliente E2E",
        ),
    ],
    [
      "los ítems del presupuesto E2E",
      () =>
        exigirOperacion(
          sb.from("presupuesto_items").delete().eq("presupuesto_id", PRESUPUESTO_ID),
          "No se pudieron limpiar los ítems del presupuesto E2E",
        ),
    ],
    [
      "el presupuesto E2E",
      () =>
        exigirOperacion(
          sb.from("presupuestos").delete().eq("id", PRESUPUESTO_ID),
          "No se pudo limpiar el presupuesto E2E",
        ),
    ],
    [
      "el kardex E2E",
      () =>
        exigirOperacion(
          sb.from("stock_movimientos").delete().in("producto_id", PRODUCTO_IDS),
          "No se pudo limpiar el kardex E2E",
        ),
    ],
    [
      "el stock E2E",
      () =>
        exigirOperacion(
          sb.from("stock_sucursal").delete().in("producto_id", PRODUCTO_IDS),
          "No se pudo limpiar el stock E2E",
        ),
    ],
    [
      "el producto E2E",
      () =>
        exigirOperacion(
          sb.from("productos").delete().in("id", PRODUCTO_IDS),
          "No se pudieron limpiar los productos E2E",
        ),
    ],
    [
      "los clientes E2E",
      () =>
        exigirOperacion(
          sb
            .from("clientes")
            .delete()
            .in("id", [CLIENTE_COMPRADOR_ID, CLIENTE_OTRO_ID, CLIENTE_COLA_ID]),
          "No se pudieron limpiar los clientes E2E",
        ),
    ],
  ];
  for (const [, accion] of operaciones) {
    await intentarLimpieza(accion, errores);
  }
  exigirLimpiezaCompleta("Falló la limpieza de datos fiscales E2E", errores);
}

async function restaurarConfiguracion() {
  if (!restauracion) return;
  const sb = admin();
  const estado = restauracion;
  const errores: string[] = [];
  await intentarLimpieza(
    () =>
      exigirOperacion(
        sb.from("settings").update(estado.settings).eq("id", true),
        "No se pudieron restaurar los flags fiscales E2E",
      ),
    errores,
  );
  await intentarLimpieza(
    () =>
      exigirOperacion(
        sb
          .from("emisores")
          .update({
            razon_social: estado.emisor.razon_social,
            nombre_fantasia: estado.emisor.nombre_fantasia,
            cuit: estado.emisor.cuit,
            domicilio_fiscal: estado.emisor.domicilio_fiscal,
            condicion_iva: estado.emisor.condicion_iva,
            ingresos_brutos: estado.emisor.ingresos_brutos,
            inicio_actividades: estado.emisor.inicio_actividades,
            factura_a_modalidad: estado.emisor.factura_a_modalidad,
            factura_a_revalidar_at: estado.emisor.factura_a_revalidar_at,
          })
          .eq("id", estado.emisor.id),
        "No se pudo restaurar el emisor E2E",
      ),
    errores,
  );
  await intentarLimpieza(
    () =>
      exigirOperacion(
        sb
          .from("puntos_venta")
          .update({
            numero: estado.puntoVenta.numero,
            modo: estado.puntoVenta.modo,
            activo: estado.puntoVenta.activo,
          })
          .eq("sucursal_id", estado.puntoVenta.sucursal_id),
        "No se pudo restaurar el punto de venta E2E",
      ),
    errores,
  );
  if (estado.credencialCreada) {
    await intentarLimpieza(async () => {
      const sql = conexionPostgresLocal();
      await sql.begin(async (transaccion) => {
        await transaccion`
          DELETE FROM public.credenciales_arca
           WHERE id=${CREDENCIAL_MOCK_ID}::uuid
             AND emisor_id=${estado.emisor.id}::uuid
             AND ambiente='PRODUCCION'
             AND arca_key_enc='T13_TEST_ONLY_NO_NETWORK'
             AND arca_cert_enc='T13_TEST_ONLY_NO_NETWORK'
        `;
        const [verificacion] = await transaccion<{ total: number }[]>`
          SELECT count(*)::integer AS total
            FROM public.credenciales_arca
           WHERE id=${CREDENCIAL_MOCK_ID}::uuid
        `;
        if (verificacion.total !== 0) {
          throw new Error("La credencial mock E2E protegida no se eliminó por completo.");
        }
      });
    }, errores);
  } else if (estado.credencial) {
    await intentarLimpieza(
      () =>
        exigirOperacion(
          sb.from("credenciales_arca").upsert(estado.credencial!),
          "No se pudo restaurar la credencial E2E",
        ),
      errores,
    );
    await intentarLimpieza(async () => {
      const { data, error } = await sb
        .from("credenciales_arca")
        .select("*")
        .eq("id", estado.credencial!.id)
        .single();
      errorDe(error, "No se pudo verificar la credencial E2E restaurada");
      const esperado = estado.credencial as unknown as Record<string, unknown>;
      const obtenido = data as unknown as Record<string, unknown>;
      if (
        Object.keys(esperado).some(
          (key) => JSON.stringify(obtenido[key]) !== JSON.stringify(esperado[key]),
        )
      ) {
        throw new Error("La credencial E2E no coincide con su estado previo.");
      }
    }, errores);
  }
  await intentarLimpieza(async () => {
    const [settingsActual, emisorActual, puntoVentaActual] = await Promise.all([
      sb
        .from("settings")
        .select("facturacion_receptor_v2_enabled,facturacion_legacy_writer_enabled")
        .eq("id", true)
        .single(),
      sb
        .from("emisores")
        .select(
          "id,razon_social,nombre_fantasia,cuit,domicilio_fiscal,condicion_iva,ingresos_brutos,inicio_actividades,factura_a_modalidad,factura_a_revalidar_at",
        )
        .eq("id", estado.emisor.id)
        .single(),
      sb
        .from("puntos_venta")
        .select("sucursal_id,numero,modo,activo")
        .eq("sucursal_id", estado.puntoVenta.sucursal_id)
        .single(),
    ]);
    errorDe(settingsActual.error, "No se pudieron verificar los flags restaurados");
    errorDe(emisorActual.error, "No se pudo verificar el emisor restaurado");
    errorDe(puntoVentaActual.error, "No se pudo verificar el punto de venta restaurado");
    if (JSON.stringify(settingsActual.data) !== JSON.stringify(estado.settings)) {
      throw new Error("Los flags fiscales E2E no coinciden con su estado previo.");
    }
    if (JSON.stringify(emisorActual.data) !== JSON.stringify(estado.emisor)) {
      throw new Error("El emisor E2E no coincide con su estado previo.");
    }
    if (JSON.stringify(puntoVentaActual.data) !== JSON.stringify(estado.puntoVenta)) {
      throw new Error("El punto de venta E2E no coincide con su estado previo.");
    }
  }, errores);
  if (clienteAdminJwt) {
    const sesion = clienteAdminJwt;
    clienteAdminJwt = null;
    await intentarLimpieza(
      () => exigirOperacion(sesion.auth.signOut(), "No se pudo cerrar la sesión admin E2E"),
      errores,
    );
  }
  if (errores.length === 0) restauracion = null;
  exigirLimpiezaCompleta("Falló la restauración fiscal E2E", errores);
}

async function limpiarFixtureCompleto(): Promise<void> {
  const errores: string[] = [];
  await intentarLimpieza(limpiarDatos, errores);
  await intentarLimpieza(restaurarConfiguracion, errores);
  await intentarLimpieza(limpiarUsuariosCreados, errores);
  await intentarLimpieza(auditarAusenciaFixtureFiscal, errores);
  await intentarLimpieza(cerrarPostgresLocal, errores);
  exigirLimpiezaCompleta("Falló el cleanup integral del fixture fiscal E2E", errores);
}

async function guardarYPrepararConfiguracion() {
  const sb = admin();
  const [{ data: settings, error: settingsError }, { data: sucursales, error: sucursalesError }] =
    await Promise.all([
      sb
        .from("settings")
        .select("facturacion_receptor_v2_enabled,facturacion_legacy_writer_enabled")
        .eq("id", true)
        .single(),
      sb
        .from("sucursales")
        .select("id,nombre,direccion,telefono,emisor_id")
        .eq("activa", true)
        .order("numero")
        .limit(2),
    ]);
  errorDe(settingsError, "No se pudieron leer los flags fiscales");
  errorDe(sucursalesError, "No se pudieron leer dos sucursales locales");
  if (!sucursales || sucursales.length < 2) throw new Error("El E2E fiscal exige dos sucursales.");
  const principal = sucursales[0];
  for (const email of [EMAIL_ADMIN, EMAIL_EMPLEADO, EMAIL_SIN_CAPACIDAD]) {
    await eliminarUsuarioEfimeroPorEmail(email);
  }
  const adminUser = await crearUsuarioEfimeroLocal({
    email: EMAIL_ADMIN,
    password: PASSWORD_ADMIN,
    username: "t13-admin",
    nombre: "T13 Admin fiscal descartable",
    role: "admin",
    sucursalId: principal.id,
  });
  const empleado = await crearUsuarioEfimeroLocal({
    email: EMAIL_EMPLEADO,
    password: PASSWORD_EMPLEADO,
    username: "t13-empleado",
    nombre: "T13 Empleado fiscal descartable",
    role: "empleado",
    sucursalId: principal.id,
  });
  const { data: emisor, error: emisorError } = await sb
    .from("emisores")
    .select(
      "id,razon_social,nombre_fantasia,cuit,domicilio_fiscal,condicion_iva,ingresos_brutos,inicio_actividades,factura_a_modalidad,factura_a_revalidar_at",
    )
    .eq("id", principal.emisor_id)
    .single();
  errorDe(emisorError, "No se pudo leer el emisor local");
  const { data: pv, error: pvError } = await sb
    .from("puntos_venta")
    .select("sucursal_id,numero,modo,activo")
    .eq("sucursal_id", principal.id)
    .single();
  errorDe(pvError, "No se pudo leer el punto de venta local");
  const { data: credencial, error: credencialError } = await sb
    .from("credenciales_arca")
    .select("*")
    .eq("emisor_id", emisor.id)
    .eq("ambiente", "PRODUCCION")
    .maybeSingle();
  errorDe(credencialError, "No se pudo leer la credencial local");

  restauracion = {
    settings,
    emisor,
    puntoVenta: pv,
    credencial,
    credencialCreada: !credencial,
  };

  errorDe(
    (
      await sb
        .from("settings")
        .update({ facturacion_receptor_v2_enabled: true, facturacion_legacy_writer_enabled: false })
        .eq("id", true)
    ).error,
    "No se pudieron activar los flags E2E",
  );
  await cambiarCapacidadFiscal(empleado.id, true);
  errorDe(
    (
      await sb
        .from("emisores")
        .update({
          razon_social: emisor.razon_social || `${PREFIJO_FISCAL_E2E} EMISOR LOCAL`,
          cuit: emisor.cuit || "30714199664",
          domicilio_fiscal: emisor.domicilio_fiscal || "Domicilio fiscal local",
          condicion_iva: "RESPONSABLE_INSCRIPTO",
          inicio_actividades: emisor.inicio_actividades || "2020-01-01",
          factura_a_modalidad: "ESTANDAR_CONFIRMADA",
          factura_a_revalidar_at: "2099-12-31",
        })
        .eq("id", emisor.id)
    ).error,
    "No se pudo preparar Factura A local",
  );
  errorDe(
    (
      await sb
        .from("puntos_venta")
        .update({ modo: "PRODUCCION", activo: true })
        .eq("sucursal_id", principal.id)
    ).error,
    "No se pudo preparar el PV local",
  );
  const credencialPreparada = credencial
    ? await sb
        .from("credenciales_arca")
        .update({
          arca_key_enc: credencial.arca_key_enc ?? "T13_TEST_ONLY_NO_NETWORK",
          arca_cert_enc: credencial.arca_cert_enc ?? "T13_TEST_ONLY_NO_NETWORK",
          habilitada: true,
        })
        .eq("id", credencial.id)
    : await sb.from("credenciales_arca").insert({
        id: CREDENCIAL_MOCK_ID,
        emisor_id: emisor.id,
        ambiente: "PRODUCCION",
        arca_key_enc: "T13_TEST_ONLY_NO_NETWORK",
        arca_cert_enc: "T13_TEST_ONLY_NO_NETWORK",
        habilitada: true,
      });
  errorDe(credencialPreparada.error, "No se pudo preparar la credencial mock local");

  return {
    sb,
    settings,
    empleado,
    adminUser,
    sucursales,
    principal,
    emisor: {
      ...emisor,
      razon_social: emisor.razon_social || `${PREFIJO_FISCAL_E2E} EMISOR LOCAL`,
      cuit: emisor.cuit || "30714199664",
      domicilio_fiscal: emisor.domicilio_fiscal || "Domicilio fiscal local",
      condicion_iva: "RESPONSABLE_INSCRIPTO" as const,
      inicio_actividades: emisor.inicio_actividades || "2020-01-01",
      factura_a_modalidad: "ESTANDAR_CONFIRMADA" as const,
      factura_a_revalidar_at: "2099-12-31",
    },
    pv,
  };
}

export async function prepararFixturesFiscales(): Promise<FixtureFiscal> {
  await limpiarDatos();
  try {
    const { sb, empleado, adminUser, sucursales, principal, emisor, pv } =
      await guardarYPrepararConfiguracion();
    const sinCapacidad = await crearUsuarioSinCapacidad(principal.id);
    const fechas = construirFechasFixtureArgentina();
    const hoy = fechas.hoy;

    errorDe(
      (
        await sb.from("clientes").insert([
          {
            id: CLIENTE_COMPRADOR_ID,
            razon_social: `${PREFIJO_FISCAL_E2E} COMPRADOR COMERCIAL`,
            tipo: "CONSUMIDOR_FINAL",
            cuit_dni: null,
            direccion: "Domicilio comprador",
          },
          {
            id: CLIENTE_OTRO_ID,
            razon_social: `${PREFIJO_FISCAL_E2E} OTRO COMPRADOR`,
            tipo: "CONSUMIDOR_FINAL",
            cuit_dni: null,
          },
          {
            id: CLIENTE_COLA_ID,
            razon_social: `${PREFIJO_FISCAL_E2E} COMPRADOR PAGINACIÓN`,
            tipo: "CONSUMIDOR_FINAL",
            cuit_dni: DOCUMENTO_COLA_DIGITOS,
          },
        ])
      ).error,
      "No se pudieron crear los compradores E2E",
    );
    errorDe(
      (
        await sb.from("productos").insert([
          {
            id: PRODUCTO_ID,
            codigo: "T13-E2E-PROD",
            nombre: `${PREFIJO_FISCAL_E2E} Producto fiscal`,
            precio_sin_iva: 100,
            precio_lista: 121,
            precio_fabrica: 50,
            iva_porcentaje: 21,
            activo: true,
          },
          ...PRODUCTOS_BUSQUEDA.map((producto, index) => ({
            ...producto,
            precio_sin_iva: 10 + index,
            precio_lista: 12.1 + index,
            precio_fabrica: 5 + index,
            iva_porcentaje: 21,
            activo: true,
          })),
        ])
      ).error,
      "No se pudieron crear los productos E2E",
    );
    errorDe(
      (
        await sb.from("stock_sucursal").insert(
          sucursales.map((sucursal) => ({
            producto_id: PRODUCTO_ID,
            sucursal_id: sucursal.id,
            cantidad: 500,
          })),
        )
      ).error,
      "No se pudo preparar stock E2E",
    );
    errorDe(
      (
        await sb.from("presupuestos").insert({
          id: PRESUPUESTO_ID,
          numero: "P-T13-E2E-001",
          sucursal_id: principal.id,
          usuario_id: adminUser.id,
          cliente_id: CLIENTE_COMPRADOR_ID,
          nombre_cliente: `${PREFIJO_FISCAL_E2E} COMPRADOR COMERCIAL`,
          estado: "ABIERTO",
          subtotal_sin_iva: 100,
          iva_total: 21,
          total: 121,
          observaciones: "Fixture fiscal determinístico",
        })
      ).error,
      "No se pudo crear el presupuesto E2E",
    );
    errorDe(
      (
        await sb.from("presupuesto_items").insert({
          id: PRESUPUESTO_ITEM_ID,
          presupuesto_id: PRESUPUESTO_ID,
          producto_id: PRODUCTO_ID,
          codigo: "T13-E2E-PROD",
          descripcion: `${PREFIJO_FISCAL_E2E} Producto fiscal`,
          cantidad: 1,
          precio_lista_sin_iva: 100,
          precio_sin_iva: 100,
          descuento_porcentaje: 0,
          iva_porcentaje: 21,
          subtotal_sin_iva: 100,
          iva_monto: 21,
          subtotal_con_iva: 121,
        })
      ).error,
      "No se pudo crear el ítem de presupuesto E2E",
    );

    const pendientes = Array.from({ length: 28 }, (_, index) => ({
      id: uuidVenta(index + 1),
      sucursal_id: principal.id,
      cliente_id: CLIENTE_COLA_ID,
      usuario_id: empleado.id,
      numero_comprobante: `V-T13-E2E-${String(index + 1).padStart(3, "0")}`,
      tipo_comprobante: "VENTA" as const,
      condicion_venta: "CONTADO" as const,
      fecha: new Date(
        new Date(fechas.instante("12:00")).getTime() -
          (index === 27 ? 20 * 24 * 60 * 60_000 : index * 60_000),
      ).toISOString(),
      subtotal_sin_iva: 100,
      iva_total: 21,
      total: 121,
      total_pagado: 40,
      estado_pago: "PARCIAL" as const,
      afip_estado: "SIN_FACTURAR",
      afip_version: 0,
      idempotency_key: `e2133000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    errorDe(
      (await sb.from("ventas").insert(pendientes)).error,
      "No se pudo crear la página de cola E2E",
    );
    errorDe(
      (
        await sb.from("venta_items").insert({
          id: "e2130000-0000-4000-8000-000000000010",
          venta_id: uuidVenta(1),
          producto_id: null,
          codigo: "T13-COLA",
          descripcion: "Producto de venta pendiente E2E",
          cantidad: 1,
          precio_unitario_sin_iva: 100,
          precio_lista_sin_iva: 100,
          descuento_porcentaje: 0,
          iva_porcentaje: 21,
          subtotal_sin_iva: 100,
          iva_monto: 21,
          subtotal_con_iva: 121,
        })
      ).error,
      "No se pudo crear el ítem de la venta pendiente E2E",
    );
    errorDe(
      (
        await sb.from("ventas").insert([
          {
            id: uuidVenta(31),
            sucursal_id: principal.id,
            cliente_id: CLIENTE_COMPRADOR_ID,
            usuario_id: empleado.id,
            numero_comprobante: "V-T13-E2E-EMITIENDO",
            tipo_comprobante: "VENTA",
            fecha: fechas.instante("13:00"),
            total: 121,
            total_pagado: 0,
            afip_estado: "EMITIENDO",
            afip_fase: "PREFLIGHT",
            afip_version: 1,
            afip_claim_token: "e2132000-0000-4000-8000-000000000001",
            afip_claimed_at: "2020-01-01T00:00:00.000Z",
          },
          {
            id: uuidVenta(32),
            sucursal_id: principal.id,
            cliente_id: CLIENTE_COMPRADOR_ID,
            usuario_id: empleado.id,
            numero_comprobante: "V-T13-E2E-CORREGIBLE",
            tipo_comprobante: "VENTA",
            fecha: fechas.instante("12:00"),
            total: 121,
            total_pagado: 0,
            afip_estado: "ERROR_CORREGIBLE",
            afip_version: 0,
            afip_error: "Error corregible de fixture",
          },
          {
            id: uuidVenta(33),
            sucursal_id: principal.id,
            cliente_id: CLIENTE_COMPRADOR_ID,
            usuario_id: empleado.id,
            numero_comprobante: "V-T13-E2E-BLOQUEADO",
            tipo_comprobante: "VENTA",
            fecha: fechas.instante("11:00"),
            total: 121,
            total_pagado: 0,
            afip_estado: "BLOQUEADO",
            afip_version: 0,
          },
          {
            id: uuidVenta(34),
            sucursal_id: principal.id,
            cliente_id: CLIENTE_COMPRADOR_ID,
            usuario_id: empleado.id,
            numero_comprobante: "V-T13-E2E-CANCELADO",
            tipo_comprobante: "VENTA",
            fecha: fechas.instante("10:00"),
            total: 121,
            total_pagado: 0,
            afip_estado: "CANCELADO",
            afip_version: 0,
          },
          ...Array.from({ length: 3 }, (_, index) => ({
            id: uuidVenta(37 + index),
            sucursal_id: sucursales[1].id,
            cliente_id: CLIENTE_COMPRADOR_ID,
            usuario_id: adminUser.id,
            numero_comprobante: `V-T13-E2E-OTRA-${index + 1}`,
            tipo_comprobante: "VENTA" as const,
            fecha: fechas.instante(`0${7 - index}:00`),
            total: 121,
            total_pagado: 0,
            afip_estado: "SIN_FACTURAR",
            afip_version: 0,
          })),
        ])
      ).error,
      "No se pudieron crear los estados de cola E2E",
    );
    // Son filas históricas anteriores al corte v2. El writer legacy ya está
    // retirado y el trigger impide crearlas por la API; se suspende únicamente
    // ese guard dentro de una transacción PostgreSQL local para probar el drain.
    const sqlLocal = conexionPostgresLocal();
    await sqlLocal.begin(async (transaccion) => {
      await transaccion`
        ALTER TABLE public.ventas
        DISABLE TRIGGER trg_ventas_fiscales_legacy_retirado
      `;
      await transaccion`
        INSERT INTO public.ventas (
          id,
          sucursal_id,
          cliente_id,
          usuario_id,
          numero_comprobante,
          tipo_comprobante,
          fecha,
          total,
          total_pagado,
          afip_estado,
          afip_version
        ) VALUES
          (
            ${uuidVenta(35)}::uuid,
            ${principal.id}::uuid,
            ${CLIENTE_COMPRADOR_ID}::uuid,
            ${empleado.id}::uuid,
            'V-T13-E2E-LEGACY-PEND',
            'FACTURA_B'::public.tipo_comprobante,
            ${fechas.instante("09:00")}::timestamptz,
            121,
            121,
            'PENDIENTE',
            0
          ),
          (
            ${uuidVenta(36)}::uuid,
            ${principal.id}::uuid,
            ${CLIENTE_COMPRADOR_ID}::uuid,
            ${empleado.id}::uuid,
            'V-T13-E2E-LEGACY-ERROR',
            'FACTURA_B'::public.tipo_comprobante,
            ${fechas.instante("08:00")}::timestamptz,
            121,
            121,
            'ERROR',
            0
          )
      `;
      await transaccion`
        ALTER TABLE public.ventas
        ENABLE TRIGGER trg_ventas_fiscales_legacy_retirado
      `;
    });
    const hashReconciliar = "b".repeat(64);
    errorDe(
      (
        await sb.from("ventas").insert({
          id: uuidVenta(30),
          sucursal_id: principal.id,
          cliente_id: CLIENTE_COMPRADOR_ID,
          usuario_id: empleado.id,
          numero_comprobante: "V-T13-E2E-RECONCILIAR",
          tipo_comprobante: "VENTA",
          fecha: fechas.instante("13:30"),
          total: 121,
          total_pagado: 0,
          afip_estado: "RECONCILIAR",
          afip_fase: "REQUEST_INICIADO",
          afip_version: 2,
          afip_claim_token: "e2132000-0000-4000-8000-000000000030",
          afip_claimed_at: "2020-01-01T00:00:00.000Z",
          afip_numero: 913000,
          afip_emisor_cuit: emisor.cuit,
          afip_punto_venta: pv.numero,
          afip_cbte_tipo: 6,
          afip_modo: "HOMOLOGACION",
          afip_simulado: true,
          afip_validez: "SIMULADA",
          afip_fecha_comprobante: hoy,
          afip_imp_total: 121,
          afip_snapshot_hash: hashReconciliar,
          afip_snapshot: {
            version: 2,
            hash: hashReconciliar,
            fechaComprobante: hoy,
            identidad: {
              numero: 913000,
              emisorCuit: emisor.cuit,
              puntoVenta: pv.numero,
              cbteTipo: 6,
              modo: "HOMOLOGACION",
              simulado: true,
            },
          },
        })
      ).error,
      "No se pudo crear la incertidumbre fiscal E2E",
    );

    const snapshot = crearSnapshotFiscalV2({
      venta: {
        id: VENTA_APROBADA_ID,
        numeroComercial: "V-T13-E2E-APROBADA",
        tipoComprobante: "VENTA",
        condicionVenta: "CONTADO",
        fechaComercial: fechas.instante("12:00"),
      },
      items: [
        {
          id: ITEM_APROBADO_ID,
          productoId: null,
          codigo: "T13-PDF",
          descripcion: "Producto congelado al emitir",
          cantidad: "1.00",
          precioUnitarioSinIva: "100.00",
          descuentoPorcentaje: "0.00",
          ivaPorcentaje: "21.00",
          subtotalNeto: "100.00",
          importeIva: "21.00",
          subtotalTotal: "121.00",
        },
      ],
      emisor: {
        id: emisor.id,
        razonSocial: emisor.razon_social,
        nombreFantasia: emisor.nombre_fantasia,
        cuit: emisor.cuit!,
        domicilioFiscal: emisor.domicilio_fiscal!,
        condicionIva: "RESPONSABLE_INSCRIPTO",
        ingresosBrutos: emisor.ingresos_brutos,
        inicioActividades: emisor.inicio_actividades!,
        telefono: principal.telefono,
      },
      sucursal: {
        id: principal.id,
        nombre: principal.nombre,
        direccion: principal.direccion || "Domicilio sucursal local",
        telefono: principal.telefono,
      },
      receptor: {
        razonSocial: `${PREFIJO_FISCAL_E2E} RECEPTOR CONGELADO`,
        domicilio: "Domicilio fiscal receptor",
        tipoDocumento: "CUIT",
        numeroDocumento: "30714199664",
        docTipoArca: 80,
        docNroArca: "30714199664",
        condicionIva: "RESPONSABLE_INSCRIPTO",
        origen: "MANUAL",
        origenId: null,
        verificadoArcaAt: null,
        condicionIvaReceptorId: 1,
      },
      identidad: {
        numero: 913001,
        emisorCuit: emisor.cuit!,
        puntoVenta: pv.numero,
        cbteTipo: 1,
        modo: "PRODUCCION",
        simulado: false,
        validez: "PRODUCCION",
      },
      letra: "A",
      concepto: 1,
      fechaComprobante: hoy,
      importeNeto: "100.00",
      importeExento: "0.00",
      importeNoGravado: "0.00",
      importeIva: "21.00",
      importeTributos: "0.00",
      importeTotal: "121.00",
      alicuotasIva: [{ id: 5, baseImponible: "100.00", importe: "21.00" }],
      tributos: [],
      moneda: "PES",
      cotizacion: "1.000000",
      ivaContenido: "0.00",
      otrosImpuestosNacionalesIndirectos: "0.00",
      origen: "VENTA",
      comprobanteOriginalId: null,
      cbtesAsoc: [],
    });
    errorDe(
      (
        await sb.from("ventas").insert({
          id: VENTA_APROBADA_ID,
          sucursal_id: principal.id,
          cliente_id: CLIENTE_OTRO_ID,
          usuario_id: empleado.id,
          numero_comprobante: "V-T13-E2E-APROBADA",
          tipo_comprobante: "VENTA",
          condicion_venta: "CONTADO",
          fecha: fechas.instante("12:00"),
          subtotal_sin_iva: 100,
          iva_total: 21,
          total: 121,
          total_pagado: 121,
          estado_pago: "PAGADO",
          afip_estado: "APROBADO",
          afip_fase: "PERSISTIDO",
          afip_version: 2,
          afip_numero: 913001,
          afip_emisor_cuit: emisor.cuit,
          afip_punto_venta: pv.numero,
          afip_cbte_tipo: 1,
          afip_modo: "PRODUCCION",
          afip_simulado: false,
          afip_validez: "PRODUCCION",
          afip_fecha_comprobante: hoy,
          afip_imp_total: 121,
          afip_snapshot_hash: snapshot.hash,
          afip_snapshot: snapshot as unknown as Json,
          cae: "74111111113001",
          cae_vencimiento: fechas.vencimientoCae,
        })
      ).error,
      "No se pudo crear el comprobante aprobado E2E",
    );
    errorDe(
      (
        await sb.from("venta_items").insert({
          id: ITEM_APROBADO_ID,
          venta_id: VENTA_APROBADA_ID,
          producto_id: null,
          codigo: "T13-PDF",
          descripcion: "Producto congelado al emitir",
          cantidad: 1,
          precio_unitario_sin_iva: 100,
          precio_lista_sin_iva: 100,
          descuento_porcentaje: 0,
          iva_porcentaje: 21,
          subtotal_sin_iva: 100,
          iva_monto: 21,
          subtotal_con_iva: 121,
        })
      ).error,
      "No se pudo crear el ítem aprobado E2E",
    );
    errorDe(
      (
        await sb.from("ventas").insert({
          id: VENTA_NC_ID,
          sucursal_id: principal.id,
          cliente_id: CLIENTE_OTRO_ID,
          usuario_id: empleado.id,
          numero_comprobante: "NC-T13-E2E-PENDIENTE",
          tipo_comprobante: "NOTA_CREDITO",
          condicion_venta: "CONTADO",
          fecha: fechas.instante("13:00"),
          subtotal_sin_iva: -100,
          iva_total: -21,
          total: -121,
          total_pagado: -121,
          estado_pago: "PAGADO",
          afip_estado: "SIN_FACTURAR",
          afip_version: 0,
          afip_cbte_asoc_id: VENTA_APROBADA_ID,
        })
      ).error,
      "No se pudo crear la NC pendiente E2E",
    );
    errorDe(
      (
        await sb.from("venta_items").insert({
          id: ITEM_NC_ID,
          venta_id: VENTA_NC_ID,
          producto_id: null,
          codigo: "T13-PDF",
          descripcion: "Producto congelado al emitir",
          cantidad: 1,
          precio_unitario_sin_iva: 100,
          precio_lista_sin_iva: 100,
          descuento_porcentaje: 0,
          iva_porcentaje: 21,
          subtotal_sin_iva: -100,
          iva_monto: -21,
          subtotal_con_iva: -121,
        })
      ).error,
      "No se pudo crear el ítem de la NC pendiente E2E",
    );

    const snapshotOriginalNcManual = crearSnapshotFiscalV2({
      venta: {
        id: VENTA_NC_MANUAL_ORIGINAL_ID,
        numeroComercial: "V-T13-E2E-NC-ORIGINAL",
        tipoComprobante: "VENTA",
        condicionVenta: "CTA_CTE",
        fechaComercial: fechas.instante("14:00"),
      },
      items: [
        {
          id: ITEM_NC_MANUAL_ORIGINAL_ID,
          productoId: PRODUCTO_ID,
          codigo: "T13-E2E-PROD",
          descripcion: `${PREFIJO_FISCAL_E2E} Producto fiscal`,
          cantidad: "1.00",
          precioUnitarioSinIva: "100.00",
          descuentoPorcentaje: "0.00",
          ivaPorcentaje: "21.00",
          subtotalNeto: "100.00",
          importeIva: "21.00",
          subtotalTotal: "121.00",
        },
      ],
      emisor: snapshot.emisor,
      sucursal: snapshot.sucursal,
      receptor: {
        razonSocial: `${PREFIJO_FISCAL_E2E} RECEPTOR NC HEREDADO`,
        domicilio: "Domicilio receptor NC heredado",
        tipoDocumento: "CUIT",
        numeroDocumento: "30714199664",
        docTipoArca: 80,
        docNroArca: "30714199664",
        condicionIva: "RESPONSABLE_INSCRIPTO",
        origen: "MANUAL",
        origenId: null,
        verificadoArcaAt: null,
        condicionIvaReceptorId: 1,
      },
      identidad: {
        numero: 913002,
        emisorCuit: emisor.cuit!,
        puntoVenta: pv.numero,
        cbteTipo: 1,
        modo: "PRODUCCION",
        simulado: false,
        validez: "PRODUCCION",
      },
      letra: "A",
      concepto: 1,
      fechaComprobante: hoy,
      importeNeto: "100.00",
      importeExento: "0.00",
      importeNoGravado: "0.00",
      importeIva: "21.00",
      importeTributos: "0.00",
      importeTotal: "121.00",
      alicuotasIva: [{ id: 5, baseImponible: "100.00", importe: "21.00" }],
      tributos: [],
      moneda: "PES",
      cotizacion: "1.000000",
      ivaContenido: "0.00",
      otrosImpuestosNacionalesIndirectos: "0.00",
      origen: "VENTA",
      comprobanteOriginalId: null,
      cbtesAsoc: [],
    });
    errorDe(
      (
        await sb.from("ventas").insert({
          id: VENTA_NC_MANUAL_ORIGINAL_ID,
          sucursal_id: principal.id,
          cliente_id: CLIENTE_OTRO_ID,
          usuario_id: empleado.id,
          numero_comprobante: "V-T13-E2E-NC-ORIGINAL",
          tipo_comprobante: "VENTA",
          condicion_venta: "CTA_CTE",
          fecha: fechas.instante("14:00"),
          subtotal_sin_iva: 100,
          iva_total: 21,
          total: 121,
          total_pagado: 0,
          estado_pago: "PENDIENTE",
          afip_estado: "APROBADO",
          afip_fase: "PERSISTIDO",
          afip_version: 2,
          afip_numero: 913002,
          afip_emisor_cuit: emisor.cuit,
          afip_punto_venta: pv.numero,
          afip_cbte_tipo: 1,
          afip_modo: "PRODUCCION",
          afip_simulado: false,
          afip_validez: "PRODUCCION",
          afip_fecha_comprobante: hoy,
          afip_imp_total: 121,
          afip_snapshot_hash: snapshotOriginalNcManual.hash,
          afip_snapshot: snapshotOriginalNcManual as unknown as Json,
          cae: "74111111113002",
          cae_vencimiento: fechas.vencimientoCae,
        })
      ).error,
      "No se pudo crear la VENTA original para NC manual E2E",
    );
    errorDe(
      (
        await sb.from("venta_items").insert({
          id: ITEM_NC_MANUAL_ORIGINAL_ID,
          venta_id: VENTA_NC_MANUAL_ORIGINAL_ID,
          producto_id: PRODUCTO_ID,
          codigo: "T13-E2E-PROD",
          descripcion: `${PREFIJO_FISCAL_E2E} Producto fiscal`,
          cantidad: 1,
          precio_unitario_sin_iva: 100,
          precio_lista_sin_iva: 100,
          descuento_porcentaje: 0,
          iva_porcentaje: 21,
          subtotal_sin_iva: 100,
          iva_monto: 21,
          subtotal_con_iva: 121,
        })
      ).error,
      "No se pudo crear el ítem de la VENTA original para NC manual E2E",
    );
    errorDe(
      (
        await sb.from("receptores_fiscales").insert({
          id: FAVORITO_ID,
          sucursal_id: principal.id,
          creado_por: adminUser.id,
          cliente_comercial_id: CLIENTE_COMPRADOR_ID,
          tipo_documento: "CUIL",
          numero_documento: "20329642330",
          razon_social: `${PREFIJO_FISCAL_E2E} FAVORITO CUIL`,
          condicion_iva: "CONSUMIDOR_FINAL",
          domicilio: "Domicilio favorito",
          activo: true,
        })
      ).error,
      "No se pudo crear el receptor favorito E2E",
    );

    return {
      sucursalPrincipalId: principal.id,
      sucursalAlternaId: sucursales[1].id,
      sucursalPrincipalNombre: principal.nombre,
      emisorRazonSocial: emisor.razon_social,
      emisorCuit: emisor.cuit!,
      puntoVenta: pv.numero,
      fechaFiscal: fechas.hoy,
      fechaFiscalVisible: fechas.visible,
      clienteCompradorId: CLIENTE_COMPRADOR_ID,
      documentoCola: DOCUMENTO_COLA,
      productoId: PRODUCTO_ID,
      presupuestoId: PRESUPUESTO_ID,
      ventaPendienteId: uuidVenta(1),
      ventaAntiguaId: uuidVenta(28),
      ventaAprobadaId: VENTA_APROBADA_ID,
      ventaCanceladaId: uuidVenta(34),
      notaCreditoId: VENTA_NC_ID,
      ventaOriginalNotaCreditoId: VENTA_NC_MANUAL_ORIGINAL_ID,
      usuarioAdmin: { email: EMAIL_ADMIN, password: PASSWORD_ADMIN, id: adminUser.id },
      usuarioEmpleado: {
        email: EMAIL_EMPLEADO,
        password: PASSWORD_EMPLEADO,
        id: empleado.id,
      },
      usuarioSinCapacidad: {
        email: EMAIL_SIN_CAPACIDAD,
        password: PASSWORD_SIN_CAPACIDAD,
        id: sinCapacidad.id,
      },
    };
  } catch (error) {
    try {
      await limpiarFixtureCompleto();
    } catch (errorCleanup) {
      throw new Error(
        `Falló la preparación del fixture fiscal: ${mensajeError(error)}\n` +
          `También falló su cleanup: ${mensajeError(errorCleanup)}`,
      );
    }
    throw error;
  }
}

export async function limpiarFixturesFiscales(): Promise<void> {
  await limpiarFixtureCompleto();
}

export async function cantidadVentasDelProductoE2E(): Promise<number> {
  return (await ventasDelProducto()).length;
}

export async function leerEfectosVentaFixture(ventaId: string): Promise<{
  estadoFiscal: string | null;
  cae: string | null;
  numeroFiscal: number | null;
  ventas: number;
  items: number;
  pagos: number;
  stock: number;
  deuda: number;
  intentos: number;
}> {
  const sb = admin();
  const [venta, ventas, items, pagos, stock, deuda, intentos] = await Promise.all([
    sb.from("ventas").select("afip_estado,cae,afip_numero").eq("id", ventaId).single(),
    sb.from("ventas").select("id", { count: "exact", head: true }).eq("id", ventaId),
    sb.from("venta_items").select("id", { count: "exact", head: true }).eq("venta_id", ventaId),
    sb.from("venta_pagos").select("id", { count: "exact", head: true }).eq("venta_id", ventaId),
    sb
      .from("stock_movimientos")
      .select("id", { count: "exact", head: true })
      .eq("referencia_id", ventaId),
    sb
      .from("cuenta_corriente_movimientos")
      .select("id", { count: "exact", head: true })
      .eq("venta_id", ventaId),
    sb
      .from("emision_fiscal_intentos")
      .select("id", { count: "exact", head: true })
      .eq("venta_id", ventaId),
  ]);
  for (const [resultado, contexto] of [
    [venta, "venta"],
    [ventas, "conteo de ventas"],
    [items, "ítems comerciales"],
    [pagos, "pagos comerciales"],
    [stock, "movimientos de stock"],
    [deuda, "movimientos de deuda"],
    [intentos, "intentos fiscales"],
  ] as const) {
    errorDe(resultado.error, `No se pudo leer ${contexto} del fixture E2E`);
  }
  return {
    estadoFiscal: venta.data.afip_estado,
    cae: venta.data.cae,
    numeroFiscal: venta.data.afip_numero,
    ventas: ventas.count ?? 0,
    items: items.count ?? 0,
    pagos: pagos.count ?? 0,
    stock: stock.count ?? 0,
    deuda: deuda.count ?? 0,
    intentos: intentos.count ?? 0,
  };
}

export async function leerReversionNotaCreditoFixture(originalId: string): Promise<{
  original: { estado: string; venta_anulada_por: string | null };
  nota: {
    id: string;
    tipo_comprobante: string;
    estado: string;
    afip_estado: string;
    afip_cbte_asoc_id: string | null;
    total: number;
  } | null;
  itemsNota: number;
  pagosNota: number;
  movimientosStockOriginal: number;
  stockProducto: number;
}> {
  const sb = admin();
  const original = await sb
    .from("ventas")
    .select("estado,venta_anulada_por,sucursal_id")
    .eq("id", originalId)
    .single();
  errorDe(original.error, "No se pudo leer la VENTA original de la NC E2E");
  const [notas, movimientos, stock] = await Promise.all([
    sb
      .from("ventas")
      .select("id,tipo_comprobante,estado,afip_estado,afip_cbte_asoc_id,total")
      .eq("afip_cbte_asoc_id", originalId)
      .eq("tipo_comprobante", "NOTA_CREDITO"),
    sb
      .from("stock_movimientos")
      .select("id", { count: "exact", head: true })
      .eq("referencia_id", originalId),
    sb
      .from("stock_sucursal")
      .select("cantidad")
      .eq("producto_id", PRODUCTO_ID)
      .eq("sucursal_id", original.data.sucursal_id)
      .single(),
  ]);
  errorDe(notas.error, "No se pudo leer la NC total E2E");
  errorDe(movimientos.error, "No se pudieron leer movimientos de la NC total E2E");
  errorDe(stock.error, "No se pudo leer el stock de la NC total E2E");
  if ((notas.data ?? []).length > 1) throw new Error("La fixture encontró más de una NC activa.");
  const nota = notas.data?.[0] ?? null;
  const [items, pagos] = nota
    ? await Promise.all([
        sb.from("venta_items").select("id", { count: "exact", head: true }).eq("venta_id", nota.id),
        sb.from("venta_pagos").select("id", { count: "exact", head: true }).eq("venta_id", nota.id),
      ])
    : [
        { count: 0, error: null },
        { count: 0, error: null },
      ];
  errorDe(items.error, "No se pudieron contar los ítems de la NC total E2E");
  errorDe(pagos.error, "No se pudieron contar los pagos de la NC total E2E");
  return {
    original: {
      estado: original.data.estado,
      venta_anulada_por: original.data.venta_anulada_por,
    },
    nota: nota
      ? {
          ...nota,
          total: Number(nota.total),
        }
      : null,
    itemsNota: items.count ?? 0,
    pagosNota: pagos.count ?? 0,
    movimientosStockOriginal: movimientos.count ?? 0,
    stockProducto: Number(stock.data.cantidad),
  };
}

export async function configurarFlagsFacturacionFixture(input: {
  v2: boolean;
  legacy: boolean;
}): Promise<void> {
  if (input.v2 === input.legacy) {
    throw new Error("La fixture exige exactamente un writer fiscal activo.");
  }
  await exigirOperacion(
    admin()
      .from("settings")
      .update({
        facturacion_receptor_v2_enabled: input.v2,
        facturacion_legacy_writer_enabled: input.legacy,
      })
      .eq("id", true),
    "No se pudieron alternar los flags fiscales de la fixture",
  );
}

export async function leerHuellaComercialFixture(): Promise<Record<string, string>> {
  const sql = conexionPostgresLocal();
  const [row] = await sql<Record<string, string>[]>`
    SELECT
      count(*)::text AS ventas
      FROM public.ventas
  `;
  const [resto] = await sql<Record<string, string>[]>`
    SELECT
      (SELECT count(*) FROM public.venta_items)::text AS items,
      (SELECT count(*) FROM public.venta_pagos)::text AS pagos,
      (SELECT count(*) FROM public.stock_movimientos)::text AS stock,
      (SELECT count(*) FROM public.caja_movimientos)::text AS caja,
      (SELECT count(*) FROM public.cuenta_corriente_movimientos)::text AS deuda,
      (SELECT COALESCE(sum(ultimo_numero),0) FROM public.comprobante_secuencias)::text AS secuencia
  `;
  return { ...row, ...resto };
}

export async function leerPresupuestoFixture(): Promise<{
  estado: string;
  venta_id: string | null;
}> {
  const { data, error } = await admin()
    .from("presupuestos")
    .select("estado,venta_id")
    .eq("id", PRESUPUESTO_ID)
    .single();
  errorDe(error, "No se pudo leer el presupuesto E2E");
  return data;
}
