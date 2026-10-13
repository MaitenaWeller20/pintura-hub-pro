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
const CLIENTE_PERIODO_ID = "e2130000-0000-4000-8000-000000000016";
const CLIENTE_AJUSTE_ID = "e2130000-0000-4000-8000-000000000017";
const CLIENTE_IDS = [
  CLIENTE_COMPRADOR_ID,
  CLIENTE_OTRO_ID,
  CLIENTE_COLA_ID,
  CLIENTE_PERIODO_ID,
  CLIENTE_AJUSTE_ID,
];
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
const PRESUPUESTO_SIN_CAJA_ID = "e2130000-0000-4000-8000-000000000018";
const PRESUPUESTO_SIN_CAJA_ITEM_ID = "e2130000-0000-4000-8000-000000000019";
const PRESUPUESTO_IDENTIFICADO_ID = "e2130000-0000-4000-8000-000000000020";
const PRESUPUESTO_IDENTIFICADO_ITEM_ID = "e2130000-0000-4000-8000-000000000021";
const PRESUPUESTO_IDS = [PRESUPUESTO_ID, PRESUPUESTO_SIN_CAJA_ID, PRESUPUESTO_IDENTIFICADO_ID];
const CAJA_GENERAL_PAZ_ID = "e2130000-0000-4000-8000-000000000022";
const DESCRIPCION_COLOR = "Base 10 L (Código 1234)";
const FAVORITO_ID = "e2130000-0000-4000-8000-000000000006";
const CREDENCIAL_MOCK_ID = "e2130000-0000-4000-8000-000000000012";
const CREDENCIAL_GENERAL_PAZ_MOCK_ID = "e2130000-0000-4000-8000-000000000023";
const VENTA_APROBADA_ID = "e2130000-0000-4000-8000-000000000007";
const VENTA_NC_ID = "e2130000-0000-4000-8000-000000000008";
const ITEM_APROBADO_ID = "e2130000-0000-4000-8000-000000000009";
const ITEM_NC_ID = "e2130000-0000-4000-8000-000000000011";
const VENTA_NC_MANUAL_ORIGINAL_ID = "e2130000-0000-4000-8000-000000000013";
const ITEM_NC_MANUAL_ORIGINAL_ID = "e2130000-0000-4000-8000-000000000014";

const uuidVenta = (indice: number) => `e2131000-0000-4000-8000-${String(indice).padStart(12, "0")}`;

type SettingsRow = Pick<
  Database["public"]["Tables"]["settings"]["Row"],
  | "facturacion_receptor_v2_enabled"
  | "facturacion_legacy_writer_enabled"
  | "nota_credito_periodo_enabled"
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
  emisorGeneralPaz: EmisorGuardado;
  puntoVentaGeneralPaz: PuntoVentaGuardado;
  credencialGeneralPaz: CredencialGuardada | null;
  credencialGeneralPazCreada: boolean;
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
  clientePeriodoId: string;
  clienteAjusteId: string;
  documentoCola: string;
  productoId: string;
  presupuestoId: string;
  presupuestoSinCajaId: string;
  presupuestoIdentificadoId: string;
  consumidorFinalId: string;
  sucursalGeneralPazId: string;
  sucursalGeneralPazNombre: string;
  cajaGeneralPazId: string;
  descripcionColor: string;
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
let secuenciasVentaIniciales: Array<{
  id: string;
  sucursal_id: string;
  tipo: string;
  ultimo_numero: number;
}> | null = null;
let sucursalesSecuenciaFixture: string[] = [];

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

async function cambiarCapacidadNcPeriodo(userId: string, value: boolean) {
  errorDe(
    (
      await (
        await adminConJwt()
      ).rpc("administrar_puede_emitir_nc_periodo", {
        p_profile_id: userId,
        p_habilitado: value,
      })
    ).error,
    "No se pudo preparar/restaurar la capacidad de NC por período E2E",
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
        sb.from("clientes").select("id", { count: "exact", head: true }).in("id", CLIENTE_IDS),
        "clientes E2E",
      ),
      contar(
        sb
          .from("presupuestos")
          .select("id", { count: "exact", head: true })
          .in("id", PRESUPUESTO_IDS),
        "presupuestos E2E",
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

async function ventasDeClientesPeriodo(): Promise<string[]> {
  const { data, error } = await admin()
    .from("ventas")
    .select("id")
    .in("cliente_id", [CLIENTE_PERIODO_ID, CLIENTE_AJUSTE_ID]);
  errorDe(error, "No se pudieron ubicar las NC por período E2E");
  return (data ?? []).map((row) => row.id);
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
  const ventaIds = [
    ...new Set([
      ...deterministicas,
      ...(await ventasDelProducto()),
      ...(await ventasDeClientesPeriodo()),
    ]),
  ];

  await intentarLimpieza(
    () =>
      exigirOperacion(
        sb
          .from("presupuestos")
          .update({ venta_id: null, estado: "ABIERTO" })
          .in("id", PRESUPUESTO_IDS),
        "No se pudieron desvincular los presupuestos E2E",
      ),
    errores,
  );
  if (ventaIds.length) {
    await intentarLimpieza(async () => {
      // El guard post-CAE bloquea correctamente a service_role. El fixture ya
      // validó que está conectado al PostgreSQL local exacto; el owner se usa
      // sólo para retirar sus propias filas determinísticas al cerrar la suite.
      const sql = conexionPostgresLocal();
      await sql.begin(async (transaccion) => {
        await transaccion`
          DELETE FROM public.cuenta_corriente_movimientos
           WHERE venta_id=ANY(${ventaIds}::uuid[])
        `;
        await transaccion`
          DELETE FROM public.stock_movimientos
           WHERE referencia_id=ANY(${ventaIds}::uuid[])
        `;
        await transaccion`
          DELETE FROM public.venta_pagos
           WHERE venta_id=ANY(${ventaIds}::uuid[])
        `;
        await transaccion`
          DELETE FROM public.venta_items
           WHERE venta_id=ANY(${ventaIds}::uuid[])
        `;
        await transaccion`
          DELETE FROM public.ventas
           WHERE id=ANY(${ventaIds}::uuid[])
        `;
      });
    }, errores);
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
          sb.from("receptores_fiscales").delete().in("cliente_comercial_id", CLIENTE_IDS),
          "No se pudieron limpiar los receptores del cliente E2E",
        ),
    ],
    [
      "los ítems del presupuesto E2E",
      () =>
        exigirOperacion(
          sb.from("presupuesto_items").delete().in("presupuesto_id", PRESUPUESTO_IDS),
          "No se pudieron limpiar los ítems del presupuesto E2E",
        ),
    ],
    [
      "el presupuesto E2E",
      () =>
        exigirOperacion(
          sb.from("presupuestos").delete().in("id", PRESUPUESTO_IDS),
          "No se pudieron limpiar los presupuestos E2E",
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
          sb.from("clientes").delete().in("id", CLIENTE_IDS),
          "No se pudieron limpiar los clientes E2E",
        ),
    ],
  ];
  for (const [, accion] of operaciones) {
    await intentarLimpieza(accion, errores);
  }
  exigirLimpiezaCompleta("Falló la limpieza de datos fiscales E2E", errores);
}

async function guardarSecuenciasVenta(sucursalIds: string[]): Promise<void> {
  if (secuenciasVentaIniciales !== null) {
    throw new Error("Ya había un snapshot de numeración comercial E2E pendiente de restaurar.");
  }
  sucursalesSecuenciaFixture = [...sucursalIds];
  secuenciasVentaIniciales = await conexionPostgresLocal()<
    Array<{ id: string; sucursal_id: string; tipo: string; ultimo_numero: number }>
  >`
    SELECT id::text, sucursal_id::text, tipo::text, ultimo_numero
      FROM public.comprobante_secuencias
     WHERE sucursal_id=ANY(${sucursalIds}::uuid[])
       AND tipo='VENTA'::public.tipo_comprobante
     ORDER BY sucursal_id
  `;
}

async function restaurarSecuenciasVenta(): Promise<void> {
  if (secuenciasVentaIniciales === null) return;
  const snapshot = secuenciasVentaIniciales;
  const sucursalIds = sucursalesSecuenciaFixture;
  await conexionPostgresLocal().begin(async (sql) => {
    await sql`
      DELETE FROM public.comprobante_secuencias
       WHERE sucursal_id=ANY(${sucursalIds}::uuid[])
         AND tipo='VENTA'::public.tipo_comprobante
    `;
    for (const row of snapshot) {
      await sql`
        INSERT INTO public.comprobante_secuencias(id,sucursal_id,tipo,ultimo_numero)
        VALUES (
          ${row.id}::uuid,
          ${row.sucursal_id}::uuid,
          ${row.tipo}::public.tipo_comprobante,
          ${row.ultimo_numero}
        )
      `;
    }
  });
  secuenciasVentaIniciales = null;
  sucursalesSecuenciaFixture = [];
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
  const configuraciones = [
    {
      emisor: estado.emisor,
      puntoVenta: estado.puntoVenta,
      credencial: estado.credencial,
      credencialCreada: estado.credencialCreada,
      credencialMockId: CREDENCIAL_MOCK_ID,
      etiqueta: "principal",
    },
    {
      emisor: estado.emisorGeneralPaz,
      puntoVenta: estado.puntoVentaGeneralPaz,
      credencial: estado.credencialGeneralPaz,
      credencialCreada: estado.credencialGeneralPazCreada,
      credencialMockId: CREDENCIAL_GENERAL_PAZ_MOCK_ID,
      etiqueta: "General Paz",
    },
  ];
  for (const configuracion of configuraciones) {
    await intentarLimpieza(
      () =>
        exigirOperacion(
          sb
            .from("emisores")
            .update({
              razon_social: configuracion.emisor.razon_social,
              nombre_fantasia: configuracion.emisor.nombre_fantasia,
              cuit: configuracion.emisor.cuit,
              domicilio_fiscal: configuracion.emisor.domicilio_fiscal,
              condicion_iva: configuracion.emisor.condicion_iva,
              ingresos_brutos: configuracion.emisor.ingresos_brutos,
              inicio_actividades: configuracion.emisor.inicio_actividades,
              factura_a_modalidad: configuracion.emisor.factura_a_modalidad,
              factura_a_revalidar_at: configuracion.emisor.factura_a_revalidar_at,
            })
            .eq("id", configuracion.emisor.id),
          `No se pudo restaurar el emisor ${configuracion.etiqueta} E2E`,
        ),
      errores,
    );
    await intentarLimpieza(
      () =>
        exigirOperacion(
          sb
            .from("puntos_venta")
            .update({
              numero: configuracion.puntoVenta.numero,
              modo: configuracion.puntoVenta.modo,
              activo: configuracion.puntoVenta.activo,
            })
            .eq("sucursal_id", configuracion.puntoVenta.sucursal_id),
          `No se pudo restaurar el punto de venta ${configuracion.etiqueta} E2E`,
        ),
      errores,
    );
    if (configuracion.credencialCreada) {
      await intentarLimpieza(async () => {
        const sql = conexionPostgresLocal();
        await sql.begin(async (transaccion) => {
          await transaccion`
            DELETE FROM public.credenciales_arca
             WHERE id=${configuracion.credencialMockId}::uuid
               AND emisor_id=${configuracion.emisor.id}::uuid
               AND ambiente='PRODUCCION'
               AND arca_key_enc='T13_TEST_ONLY_NO_NETWORK'
               AND arca_cert_enc='T13_TEST_ONLY_NO_NETWORK'
          `;
          const [verificacion] = await transaccion<{ total: number }[]>`
            SELECT count(*)::integer AS total
              FROM public.credenciales_arca
             WHERE id=${configuracion.credencialMockId}::uuid
          `;
          if (verificacion.total !== 0) {
            throw new Error(
              `La credencial mock ${configuracion.etiqueta} E2E no se eliminó por completo.`,
            );
          }
        });
      }, errores);
    } else if (configuracion.credencial) {
      await intentarLimpieza(
        () =>
          exigirOperacion(
            sb.from("credenciales_arca").upsert(configuracion.credencial!),
            `No se pudo restaurar la credencial ${configuracion.etiqueta} E2E`,
          ),
        errores,
      );
      await intentarLimpieza(async () => {
        const { data, error } = await sb
          .from("credenciales_arca")
          .select("*")
          .eq("id", configuracion.credencial!.id)
          .single();
        errorDe(error, `No se pudo verificar la credencial ${configuracion.etiqueta} restaurada`);
        const esperado = configuracion.credencial as unknown as Record<string, unknown>;
        const obtenido = data as unknown as Record<string, unknown>;
        if (
          Object.keys(esperado).some(
            (key) => JSON.stringify(obtenido[key]) !== JSON.stringify(esperado[key]),
          )
        ) {
          throw new Error(
            `La credencial ${configuracion.etiqueta} E2E no coincide con su estado previo.`,
          );
        }
      }, errores);
    }
  }
  await intentarLimpieza(async () => {
    const settingsActual = await sb
      .from("settings")
      .select(
        "facturacion_receptor_v2_enabled,facturacion_legacy_writer_enabled,nota_credito_periodo_enabled",
      )
      .eq("id", true)
      .single();
    errorDe(settingsActual.error, "No se pudieron verificar los flags restaurados");
    if (JSON.stringify(settingsActual.data) !== JSON.stringify(estado.settings)) {
      throw new Error("Los flags fiscales E2E no coinciden con su estado previo.");
    }
    for (const configuracion of configuraciones) {
      const [emisorActual, puntoVentaActual] = await Promise.all([
        sb
          .from("emisores")
          .select(
            "id,razon_social,nombre_fantasia,cuit,domicilio_fiscal,condicion_iva,ingresos_brutos,inicio_actividades,factura_a_modalidad,factura_a_revalidar_at",
          )
          .eq("id", configuracion.emisor.id)
          .single(),
        sb
          .from("puntos_venta")
          .select("sucursal_id,numero,modo,activo")
          .eq("sucursal_id", configuracion.puntoVenta.sucursal_id)
          .single(),
      ]);
      errorDe(emisorActual.error, `No se pudo verificar el emisor ${configuracion.etiqueta}`);
      errorDe(
        puntoVentaActual.error,
        `No se pudo verificar el punto de venta ${configuracion.etiqueta}`,
      );
      if (JSON.stringify(emisorActual.data) !== JSON.stringify(configuracion.emisor)) {
        throw new Error(`El emisor ${configuracion.etiqueta} no coincide con su estado previo.`);
      }
      if (JSON.stringify(puntoVentaActual.data) !== JSON.stringify(configuracion.puntoVenta)) {
        throw new Error(
          `El punto de venta ${configuracion.etiqueta} no coincide con su estado previo.`,
        );
      }
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
  await intentarLimpieza(restaurarSecuenciasVenta, errores);
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
        .select(
          "facturacion_receptor_v2_enabled,facturacion_legacy_writer_enabled,nota_credito_periodo_enabled",
        )
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
  const generalPaz = sucursales.find((sucursal) => /General Paz/i.test(sucursal.nombre));
  if (!generalPaz) throw new Error("El E2E de presupuestos exige la sucursal General Paz.");
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
  const { data: emisorGeneralPaz, error: emisorGeneralPazError } = await sb
    .from("emisores")
    .select(
      "id,razon_social,nombre_fantasia,cuit,domicilio_fiscal,condicion_iva,ingresos_brutos,inicio_actividades,factura_a_modalidad,factura_a_revalidar_at",
    )
    .eq("id", generalPaz.emisor_id)
    .single();
  errorDe(emisorGeneralPazError, "No se pudo leer el emisor de General Paz");
  const { data: pvGeneralPaz, error: pvGeneralPazError } = await sb
    .from("puntos_venta")
    .select("sucursal_id,numero,modo,activo")
    .eq("sucursal_id", generalPaz.id)
    .single();
  errorDe(pvGeneralPazError, "No se pudo leer el punto de venta de General Paz");
  const { data: credencialGeneralPaz, error: credencialGeneralPazError } = await sb
    .from("credenciales_arca")
    .select("*")
    .eq("emisor_id", emisorGeneralPaz.id)
    .eq("ambiente", "PRODUCCION")
    .maybeSingle();
  errorDe(credencialGeneralPazError, "No se pudo leer la credencial de General Paz");

  restauracion = {
    settings,
    emisor,
    puntoVenta: pv,
    credencial,
    credencialCreada: !credencial,
    emisorGeneralPaz,
    puntoVentaGeneralPaz: pvGeneralPaz,
    credencialGeneralPaz,
    credencialGeneralPazCreada: !credencialGeneralPaz,
  };

  errorDe(
    (
      await sb
        .from("settings")
        .update({
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
          nota_credito_periodo_enabled: true,
        })
        .eq("id", true)
    ).error,
    "No se pudieron activar los flags E2E",
  );
  await cambiarCapacidadFiscal(empleado.id, true);
  await cambiarCapacidadNcPeriodo(empleado.id, true);
  const configuraciones = [
    {
      sucursal: principal,
      emisor,
      credencial,
      credencialMockId: CREDENCIAL_MOCK_ID,
      etiqueta: "principal",
    },
    {
      sucursal: generalPaz,
      emisor: emisorGeneralPaz,
      credencial: credencialGeneralPaz,
      credencialMockId: CREDENCIAL_GENERAL_PAZ_MOCK_ID,
      etiqueta: "General Paz",
    },
  ];
  for (const configuracion of configuraciones) {
    errorDe(
      (
        await sb
          .from("emisores")
          .update({
            razon_social: configuracion.emisor.razon_social || `${PREFIJO_FISCAL_E2E} EMISOR LOCAL`,
            cuit: configuracion.emisor.cuit || "30714199664",
            domicilio_fiscal: configuracion.emisor.domicilio_fiscal || "Domicilio fiscal local",
            condicion_iva: "RESPONSABLE_INSCRIPTO",
            inicio_actividades: configuracion.emisor.inicio_actividades || "2020-01-01",
            factura_a_modalidad: "ESTANDAR_CONFIRMADA",
            factura_a_revalidar_at: "2099-12-31",
          })
          .eq("id", configuracion.emisor.id)
      ).error,
      `No se pudo preparar el emisor ${configuracion.etiqueta}`,
    );
    errorDe(
      (
        await sb
          .from("puntos_venta")
          .update({ modo: "PRODUCCION", activo: true })
          .eq("sucursal_id", configuracion.sucursal.id)
      ).error,
      `No se pudo preparar el PV ${configuracion.etiqueta}`,
    );
    const credencialPreparada = configuracion.credencial
      ? await sb
          .from("credenciales_arca")
          .update({
            arca_key_enc: configuracion.credencial.arca_key_enc ?? "T13_TEST_ONLY_NO_NETWORK",
            arca_cert_enc: configuracion.credencial.arca_cert_enc ?? "T13_TEST_ONLY_NO_NETWORK",
            habilitada: true,
            padron_validacion_activa: true,
            padron_probado_at: "2026-08-29T12:00:00.000Z",
          })
          .eq("id", configuracion.credencial.id)
      : await sb.from("credenciales_arca").insert({
          id: configuracion.credencialMockId,
          emisor_id: configuracion.emisor.id,
          ambiente: "PRODUCCION",
          arca_key_enc: "T13_TEST_ONLY_NO_NETWORK",
          arca_cert_enc: "T13_TEST_ONLY_NO_NETWORK",
          habilitada: true,
          padron_validacion_activa: true,
          padron_probado_at: "2026-08-29T12:00:00.000Z",
        });
    errorDe(
      credencialPreparada.error,
      `No se pudo preparar la credencial mock ${configuracion.etiqueta}`,
    );
  }

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
    const generalPaz = sucursales.find((sucursal) => /General Paz/i.test(sucursal.nombre));
    if (!generalPaz) throw new Error("El E2E de presupuestos exige la sucursal General Paz.");
    await guardarSecuenciasVenta([principal.id, generalPaz.id]);
    const sinCapacidad = await crearUsuarioSinCapacidad(principal.id);
    const fechas = construirFechasFixtureArgentina();
    const hoy = fechas.hoy;

    // El writer fiscal corre la transición privilegiada sin JWT y, por diseño,
    // no puede autoabrir una caja atribuyéndosela a un usuario. El recorrido de
    // reintegro necesita una sesión real previa, igual que la operación diaria.
    await conexionPostgresLocal()`
      INSERT INTO public.caja_sesiones(sucursal_id,estado,abierta_por,fondo_inicial)
      SELECT ${principal.id}::uuid,'ABIERTA',${adminUser.id}::uuid,0
       WHERE NOT EXISTS (
         SELECT 1 FROM public.caja_sesiones
          WHERE sucursal_id=${principal.id}::uuid AND estado='ABIERTA'
       )
    `;
    await conexionPostgresLocal()`
      INSERT INTO public.caja_sesiones(id,sucursal_id,estado,abierta_por,fondo_inicial)
      SELECT
        ${CAJA_GENERAL_PAZ_ID}::uuid,
        ${generalPaz.id}::uuid,
        'ABIERTA',
        ${adminUser.id}::uuid,
        0
       WHERE NOT EXISTS (
         SELECT 1 FROM public.caja_sesiones
          WHERE sucursal_id=${generalPaz.id}::uuid AND estado='ABIERTA'
       )
    `;

    errorDe(
      (
        await sb.from("clientes").insert([
          {
            id: CLIENTE_COMPRADOR_ID,
            razon_social: `${PREFIJO_FISCAL_E2E} COMPRADOR COMERCIAL`,
            tipo: "CONSUMIDOR_FINAL",
            cuit_dni: null,
            direccion: "Domicilio comprador",
            condicion_cta_cte: true,
          },
          {
            id: CLIENTE_OTRO_ID,
            razon_social: `${PREFIJO_FISCAL_E2E} OTRO COMPRADOR`,
            tipo: "CONSUMIDOR_FINAL",
            cuit_dni: null,
            condicion_cta_cte: false,
          },
          {
            id: CLIENTE_COLA_ID,
            razon_social: `${PREFIJO_FISCAL_E2E} COMPRADOR PAGINACIÓN`,
            tipo: "CONSUMIDOR_FINAL",
            cuit_dni: DOCUMENTO_COLA_DIGITOS,
            condicion_cta_cte: false,
          },
          {
            id: CLIENTE_PERIODO_ID,
            razon_social: `${PREFIJO_FISCAL_E2E} CLIENTE PERIODO RI`,
            tipo: "RESPONSABLE_INSCRIPTO",
            cuit_dni: "30714199664",
            direccion: "Domicilio cliente período",
            condicion_cta_cte: true,
          },
          {
            id: CLIENTE_AJUSTE_ID,
            razon_social: `${PREFIJO_FISCAL_E2E} CLIENTE AJUSTE`,
            tipo: "CONSUMIDOR_FINAL",
            cuit_dni: null,
            direccion: "Domicilio cliente ajuste",
            condicion_cta_cte: true,
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
        await sb.from("presupuestos").insert([
          {
            id: PRESUPUESTO_ID,
            numero: "P-T13-E2E-CF-COLOR",
            sucursal_id: generalPaz.id,
            usuario_id: adminUser.id,
            cliente_id: null,
            nombre_cliente: null,
            estado: "ABIERTO",
            subtotal_sin_iva: 100,
            iva_total: 21,
            total: 121,
            observaciones: "Conversión anónima con descripción de color",
          },
          {
            id: PRESUPUESTO_SIN_CAJA_ID,
            numero: "P-T13-E2E-SIN-CAJA",
            sucursal_id: generalPaz.id,
            usuario_id: adminUser.id,
            cliente_id: null,
            nombre_cliente: null,
            estado: "ABIERTO",
            subtotal_sin_iva: 100,
            iva_total: 21,
            total: 121,
            observaciones: "No debe convertir sin caja",
          },
          {
            id: PRESUPUESTO_IDENTIFICADO_ID,
            numero: "P-T13-E2E-IDENTIFICADO",
            sucursal_id: principal.id,
            usuario_id: adminUser.id,
            cliente_id: CLIENTE_COMPRADOR_ID,
            nombre_cliente: `${PREFIJO_FISCAL_E2E} COMPRADOR COMERCIAL`,
            estado: "ABIERTO",
            subtotal_sin_iva: 100,
            iva_total: 21,
            total: 121,
            observaciones: "Regresión de cuenta corriente identificada",
          },
        ])
      ).error,
      "No se pudieron crear los presupuestos E2E",
    );
    errorDe(
      (
        await sb.from("presupuesto_items").insert(
          [
            [PRESUPUESTO_ITEM_ID, PRESUPUESTO_ID],
            [PRESUPUESTO_SIN_CAJA_ITEM_ID, PRESUPUESTO_SIN_CAJA_ID],
            [PRESUPUESTO_IDENTIFICADO_ITEM_ID, PRESUPUESTO_IDENTIFICADO_ID],
          ].map(([id, presupuestoId]) => ({
            id,
            presupuesto_id: presupuestoId,
            producto_id: PRODUCTO_ID,
            codigo: "T13-E2E-PROD",
            descripcion: DESCRIPCION_COLOR,
            cantidad: 1,
            precio_lista_sin_iva: 100,
            precio_sin_iva: 100,
            descuento_porcentaje: 0,
            iva_porcentaje: 21,
            subtotal_sin_iva: 100,
            iva_monto: 21,
            subtotal_con_iva: 121,
          })),
        )
      ).error,
      "No se pudieron crear los ítems de presupuesto E2E",
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
    const itemReconciliarId = "e2130000-0000-4000-8000-000000000018";
    const snapshotReconciliar = crearSnapshotFiscalV2({
      venta: {
        id: uuidVenta(30),
        numeroComercial: "V-T13-E2E-RECONCILIAR",
        tipoComprobante: "VENTA",
        condicionVenta: "CONTADO",
        fechaComercial: fechas.instante("13:30"),
      },
      items: [
        {
          id: itemReconciliarId,
          productoId: null,
          codigo: "T13-RECONCILIAR",
          descripcion: "Producto congelado en incertidumbre E2E",
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
        razonSocial: `${PREFIJO_FISCAL_E2E} RECEPTOR EN CONCILIACIÓN`,
        domicilio: null,
        tipoDocumento: "SIN_IDENTIFICAR",
        numeroDocumento: null,
        docTipoArca: 99,
        docNroArca: "0",
        condicionIva: "CONSUMIDOR_FINAL",
        origen: "CLIENTE_COMERCIAL",
        origenId: CLIENTE_COMPRADOR_ID,
        verificadoArcaAt: null,
        condicionIvaReceptorId: 5,
      },
      identidad: {
        numero: 913000,
        emisorCuit: emisor.cuit!,
        puntoVenta: pv.numero,
        cbteTipo: 6,
        modo: "HOMOLOGACION",
        simulado: true,
        validez: "SIMULADA",
      },
      letra: "B",
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
      ivaContenido: "21.00",
      otrosImpuestosNacionalesIndirectos: "0.00",
      origen: "VENTA",
      comprobanteOriginalId: null,
      cbtesAsoc: [],
    });
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
          afip_snapshot_hash: snapshotReconciliar.hash,
          afip_snapshot: snapshotReconciliar as unknown as Json,
        })
      ).error,
      "No se pudo crear la incertidumbre fiscal E2E",
    );
    errorDe(
      (
        await sb.from("venta_items").insert({
          id: itemReconciliarId,
          venta_id: uuidVenta(30),
          producto_id: null,
          codigo: "T13-RECONCILIAR",
          descripcion: "Producto congelado en incertidumbre E2E",
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
      "No se pudo crear el ítem de la incertidumbre fiscal E2E",
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
    await sqlLocal`
      INSERT INTO public.venta_items(
        id,venta_id,producto_id,codigo,descripcion,cantidad,
        precio_unitario_sin_iva,precio_lista_sin_iva,descuento_porcentaje,
        iva_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
      ) VALUES (
        ${ITEM_APROBADO_ID}::uuid,${VENTA_APROBADA_ID}::uuid,NULL,'T13-PDF',
        'Producto congelado al emitir',1,100,100,0,21,100,21,121
      )
    `;
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
    await sqlLocal`
      UPDATE public.ventas
         SET estado='ANULADA', venta_anulada_por=${VENTA_NC_ID}::uuid
       WHERE id=${VENTA_APROBADA_ID}::uuid
    `;
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
    await sqlLocal`
      INSERT INTO public.venta_items(
        id,venta_id,producto_id,codigo,descripcion,cantidad,
        precio_unitario_sin_iva,precio_lista_sin_iva,descuento_porcentaje,
        iva_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
      ) VALUES (
        ${ITEM_NC_MANUAL_ORIGINAL_ID}::uuid,${VENTA_NC_MANUAL_ORIGINAL_ID}::uuid,
        ${PRODUCTO_ID}::uuid,'T13-E2E-PROD',${`${PREFIJO_FISCAL_E2E} Producto fiscal`},
        1,100,100,0,21,100,21,121
      )
    `;
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

    const { data: consumidorFinal, error: consumidorFinalError } = await sb
      .from("clientes")
      .select("id")
      .eq("activo", true)
      .eq("es_generico", true)
      .eq("tipo", "CONSUMIDOR_FINAL")
      .is("sucursal_habitual_id", null)
      .eq("es_obra", false)
      .single();
    errorDe(consumidorFinalError, "No se pudo resolver el Consumidor Final global E2E");

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
      clientePeriodoId: CLIENTE_PERIODO_ID,
      clienteAjusteId: CLIENTE_AJUSTE_ID,
      documentoCola: DOCUMENTO_COLA,
      productoId: PRODUCTO_ID,
      presupuestoId: PRESUPUESTO_ID,
      presupuestoSinCajaId: PRESUPUESTO_SIN_CAJA_ID,
      presupuestoIdentificadoId: PRESUPUESTO_IDENTIFICADO_ID,
      consumidorFinalId: consumidorFinal.id,
      sucursalGeneralPazId: generalPaz.id,
      sucursalGeneralPazNombre: generalPaz.nombre,
      cajaGeneralPazId: CAJA_GENERAL_PAZ_ID,
      descripcionColor: DESCRIPCION_COLOR,
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

export async function configurarFlagNcPeriodoFixture(habilitado: boolean): Promise<void> {
  await exigirOperacion(
    admin().from("settings").update({ nota_credito_periodo_enabled: habilitado }).eq("id", true),
    "No se pudo alternar el flag de NC por período de la fixture",
  );
}

export async function intentarNcPeriodoSinPermisoFixture(fixture: FixtureFiscal): Promise<{
  code: string | null;
  message: string;
}> {
  const { url, anonKey } = cargarVariablesLocales();
  const autenticado = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });
  try {
    errorDe(
      (
        await autenticado.auth.signInWithPassword({
          email: fixture.usuarioSinCapacidad.email,
          password: fixture.usuarioSinCapacidad.password,
        })
      ).error,
      "No se pudo autenticar el usuario sin permiso E2E",
    );
    const { error } = await autenticado.rpc("crear_nota_credito_periodo_fiscal", {
      p_sucursal_id: fixture.sucursalPrincipalId,
      p_cliente_id: fixture.clienteAjusteId,
      p_modalidad: "BONIFICACION_AJUSTE",
      p_periodo_desde: fixture.fechaFiscal,
      p_periodo_hasta: fixture.fechaFiscal,
      p_motivo: "Intento directo sin permiso E2E",
      p_resolucion: "SALDO_FAVOR",
      p_items: [
        {
          producto_id: null,
          descripcion: "Ajuste rechazado",
          cantidad: 1,
          precio_unitario_sin_iva: 10,
          iva_porcentaje: 21,
        },
      ],
      p_reintegros: [],
      p_idempotency_key: "e2135000-0000-4000-8000-000000000001",
    });
    if (!error) throw new Error("La RPC permitió crear una NC por período sin capacidad.");
    return { code: error.code ?? null, message: error.message };
  } finally {
    await autenticado.auth.signOut();
  }
}

export async function leerNotaCreditoPeriodoFixture(ventaId: string) {
  const sb = admin();
  const [venta, items, reintegros, pagos, stock, deuda, intentos] = await Promise.all([
    sb
      .from("ventas")
      .select(
        "id,cliente_id,afip_estado,afip_fase,afip_error_clase,afip_error_codigo,afip_error_fase,cae,afip_numero,afip_snapshot,nc_periodo_modalidad,nc_resolucion,nc_efectos_aplicados_at,total",
      )
      .eq("id", ventaId)
      .single(),
    sb
      .from("venta_items")
      .select("producto_id,descripcion,cantidad,subtotal_con_iva")
      .eq("venta_id", ventaId)
      .order("created_at"),
    sb
      .from("nota_credito_periodo_reintegros")
      .select("forma_pago,monto,orden")
      .eq("venta_id", ventaId)
      .order("orden"),
    sb.from("venta_pagos").select("forma_pago,monto").eq("venta_id", ventaId).order("forma_pago"),
    sb.from("stock_movimientos").select("producto_id,tipo,cantidad").eq("referencia_id", ventaId),
    sb.from("cuenta_corriente_movimientos").select("cliente_id,tipo,monto").eq("venta_id", ventaId),
    sb
      .from("emision_fiscal_intentos")
      .select("fase,resultado,numero_reservado,payload_hash,respuesta_resumen")
      .eq("venta_id", ventaId)
      .order("created_at"),
  ]);
  for (const [resultado, contexto] of [
    [venta, "cabecera de NC por período"],
    [items, "ítems de NC por período"],
    [reintegros, "intención de reintegros de NC por período"],
    [pagos, "pagos de NC por período"],
    [stock, "stock de NC por período"],
    [deuda, "cuenta corriente de NC por período"],
    [intentos, "intentos fiscales de NC por período"],
  ] as const) {
    errorDe(resultado.error, `No se pudo leer ${contexto} E2E`);
  }
  return {
    venta: venta.data,
    items: items.data ?? [],
    reintegros: reintegros.data ?? [],
    pagos: pagos.data ?? [],
    stock: stock.data ?? [],
    deuda: deuda.data ?? [],
    intentos: intentos.data ?? [],
  };
}

export async function leerCabeceraFiscalFixture(ventaId: string) {
  const { data, error } = await admin()
    .from("ventas")
    .select(
      "id,afip_estado,afip_fase,afip_numero,afip_cbte_tipo,afip_snapshot,afip_cbte_asoc_id,periodo_asoc_desde,periodo_asoc_hasta,cae,afip_error_clase,afip_error_codigo,afip_error_fase",
    )
    .eq("id", ventaId)
    .single();
  errorDe(error, "No se pudo leer la cabecera fiscal E2E");
  return data;
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

export async function leerConversionPresupuestoFixture(presupuestoId: string) {
  const sb = admin();
  const { data: presupuesto, error: presupuestoError } = await sb
    .from("presupuestos")
    .select("id,estado,cliente_id,sucursal_id,venta_id,conversion_payload_hash")
    .eq("id", presupuestoId)
    .single();
  errorDe(presupuestoError, "No se pudo leer la conversión del presupuesto E2E");
  if (!presupuesto.venta_id) {
    return {
      presupuesto,
      venta: null,
      descripcion: null,
      pagos: 0,
      montoPagado: 0,
      movimientosStock: 0,
      cantidadStockMovida: 0,
      movimientosCuentaCorriente: 0,
    };
  }
  const [venta, items, pagos, stock, deuda] = await Promise.all([
    sb
      .from("ventas")
      .select("id,cliente_id,sucursal_id,caja_sesion_id,condicion_venta,numero_comprobante")
      .eq("id", presupuesto.venta_id)
      .single(),
    sb.from("venta_items").select("descripcion").eq("venta_id", presupuesto.venta_id),
    sb.from("venta_pagos").select("monto,caja_sesion_id").eq("venta_id", presupuesto.venta_id),
    sb
      .from("stock_movimientos")
      .select("cantidad,sucursal_id")
      .eq("referencia_id", presupuesto.venta_id),
    sb.from("cuenta_corriente_movimientos").select("id").eq("venta_id", presupuesto.venta_id),
  ]);
  errorDe(venta.error, "No se pudo leer la venta convertida E2E");
  errorDe(items.error, "No se pudieron leer los ítems convertidos E2E");
  errorDe(pagos.error, "No se pudieron leer los pagos convertidos E2E");
  errorDe(stock.error, "No se pudo leer el movimiento de stock convertido E2E");
  errorDe(deuda.error, "No se pudo leer la deuda convertida E2E");
  return {
    presupuesto,
    venta: venta.data,
    descripcion: items.data?.[0]?.descripcion ?? null,
    pagos: pagos.data?.length ?? 0,
    montoPagado: (pagos.data ?? []).reduce((total, pago) => total + Number(pago.monto), 0),
    movimientosStock: stock.data?.length ?? 0,
    cantidadStockMovida: (stock.data ?? []).reduce(
      (total, movimiento) => total + Number(movimiento.cantidad),
      0,
    ),
    movimientosCuentaCorriente: deuda.data?.length ?? 0,
  };
}

export async function cerrarCajaGeneralPazFixture(fixture: FixtureFiscal): Promise<void> {
  const sb = await adminConJwt();
  const { data: caja, error: cajaError } = await sb
    .from("caja_sesiones")
    .select("id")
    .eq("sucursal_id", fixture.sucursalGeneralPazId)
    .eq("estado", "ABIERTA")
    .single();
  errorDe(cajaError, "No se pudo localizar la caja General Paz para cerrarla en E2E");
  if (caja.id !== fixture.cajaGeneralPazId) {
    throw new Error("La caja abierta de General Paz no es la sesión determinística del fixture.");
  }
  const { error } = await sb.rpc("cerrar_caja", {
    p_sesion_id: caja.id,
    p_contado: { EFECTIVO: 121 },
    p_notas: "Cierre E2E para probar conversión sin caja",
    p_efectivo_dejado: 0,
  });
  errorDe(error, "No se pudo cerrar la caja General Paz del fixture E2E");
}
