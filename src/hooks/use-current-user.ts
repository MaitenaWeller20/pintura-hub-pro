/** Estado del usuario logueado: session, profile, role y sucursal. */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";

type PerfilAccesoFiscal = {
  activo: boolean;
  puede_facturar: boolean;
  puede_emitir_nc_periodo: boolean;
};

type PerfilUsuarioActual = ProfileWithRole["profile"] & {
  secciones: string[] | null;
  permite_venta_sin_stock: boolean;
};

export interface ProfileWithRole {
  user: User;
  profile: {
    id: string;
    username: string;
    nombre_completo: string | null;
    sucursal_id: string | null;
    activo: boolean;
    puede_facturar: boolean;
    puede_emitir_nc_periodo: boolean;
  };
  /** Qué secciones del menú ve. `null` = las de siempre. Ver src/lib/secciones.ts. */
  secciones: string[] | null;
  sucursal: { id: string; codigo: string; nombre: string; numero: string } | null;
  /**
   * En qué sucursales PUEDE trabajar. `sucursal` de arriba es en cuál está
   * trabajando ahora (la activa). Casi todos tienen una sola; quien tenga más
   * ve el selector para cambiarse. Ver la migración 20260813120000.
   */
  sucursalesHabilitadas: Array<{ id: string; nombre: string }>;
  role: "admin" | "empleado" | null;
  isAdmin: boolean;
  /**
   * Espejo de `puede_vender_sin_stock(uid)` en SQL: admin O el permiso del
   * perfil. La guarda de verdad la hace `crear_venta`; esto existe para poder
   * avisar ANTES de que alguien cargue una venta entera que va a ser rechazada.
   */
  puedeVenderSinStock: boolean;
  /** Capacidad por rol/perfil. La cola además exige `facturacionV2Habilitada`. */
  puedeFacturar: boolean;
  puedeEmitirNcPeriodo: boolean;
  facturacionV2Habilitada: boolean;
  facturacionLegacyHabilitada: boolean;
  notaCreditoPeriodoHabilitada: boolean;
}

/** El layout falla cerrado si PostgREST no puede confirmar un perfil activo. */
export function perfilHabilitaSesion(
  perfil: { activo?: unknown } | null | undefined,
  error: unknown,
): boolean {
  return error == null && perfil?.activo === true;
}

/** Prioridad canónica: cualquier asignación admin domina, sin depender del orden de PostgREST. */
export function resolverRolEfectivo(
  roles: readonly unknown[] | null | undefined,
): "admin" | "empleado" | null {
  if (!Array.isArray(roles)) return null;
  let esEmpleado = false;
  for (const value of roles) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const role = (value as Record<string, unknown>).role;
    if (role === "admin") return "admin";
    if (role === "empleado") esEmpleado = true;
  }
  return esEmpleado ? "empleado" : null;
}

export function resolverEstadoFiscalUsuario(input: {
  isAdmin: boolean;
  esEmpleado: boolean;
  puedeFacturarPerfil: boolean;
  puedeEmitirNcPeriodoPerfil: boolean;
  settings: unknown;
}): Pick<
  ProfileWithRole,
  | "puedeFacturar"
  | "puedeEmitirNcPeriodo"
  | "facturacionV2Habilitada"
  | "facturacionLegacyHabilitada"
  | "notaCreditoPeriodoHabilitada"
> {
  const rows = Array.isArray(input.settings) ? input.settings : [];
  const row = rows.length === 1 && typeof rows[0] === "object" && rows[0] ? rows[0] : null;
  const value = row as Record<string, unknown> | null;
  const v2 = value?.facturacion_receptor_v2_enabled;
  const legacy = value?.facturacion_legacy_writer_enabled;
  const ncPeriodo = value?.nota_credito_periodo_enabled;
  const flagsValidos =
    value?.id === true &&
    typeof v2 === "boolean" &&
    typeof legacy === "boolean" &&
    typeof ncPeriodo === "boolean" &&
    !(v2 && legacy);
  return {
    puedeFacturar: input.isAdmin || input.puedeFacturarPerfil,
    puedeEmitirNcPeriodo:
      input.isAdmin ||
      (input.esEmpleado && input.puedeFacturarPerfil && input.puedeEmitirNcPeriodoPerfil),
    facturacionV2Habilitada: flagsValidos ? v2 : false,
    facturacionLegacyHabilitada: flagsValidos ? legacy : false,
    notaCreditoPeriodoHabilitada: flagsValidos ? ncPeriodo : false,
  };
}

export function resolverAccesoFiscalUsuario(input: {
  roles: readonly unknown[] | null | undefined;
  perfilActivo: boolean | null | undefined;
  puedeFacturarPerfil: boolean;
  puedeEmitirNcPeriodoPerfil: boolean;
  settings: unknown;
}) {
  if (input.perfilActivo !== true) {
    return {
      role: null,
      isAdmin: false,
      puedeFacturar: false,
      puedeEmitirNcPeriodo: false,
      facturacionV2Habilitada: false,
      facturacionLegacyHabilitada: false,
      notaCreditoPeriodoHabilitada: false,
    } as const;
  }
  const role = resolverRolEfectivo(input.roles);
  const isAdmin = role === "admin";
  return {
    role,
    isAdmin,
    ...resolverEstadoFiscalUsuario({
      isAdmin,
      esEmpleado: role === "empleado",
      puedeFacturarPerfil: input.puedeFacturarPerfil,
      puedeEmitirNcPeriodoPerfil: input.puedeEmitirNcPeriodoPerfil,
      settings: input.settings,
    }),
  };
}

/** Lectura corta para `beforeLoad`; ante flags inválidos la cola falla cerrado. */
export async function cargarAccesoFiscalActual() {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return null;
  const [{ data: roles }, { data: profileRaw }, { data: settings, error: settingsError }] =
    await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", auth.user.id),
      supabase
        .from("profiles")
        .select("activo,puede_facturar,puede_emitir_nc_periodo")
        .eq("id", auth.user.id)
        .maybeSingle(),
      supabase
        .from("settings")
        .select(
          "id,facturacion_receptor_v2_enabled,facturacion_legacy_writer_enabled,nota_credito_periodo_enabled",
        )
        .eq("id", true),
    ]);
  const profile = profileRaw as unknown as PerfilAccesoFiscal | null;
  const acceso = resolverAccesoFiscalUsuario({
    roles,
    perfilActivo: profile?.activo,
    puedeFacturarPerfil: profile?.puede_facturar === true,
    puedeEmitirNcPeriodoPerfil: profile?.puede_emitir_nc_periodo === true,
    settings: settingsError ? [] : settings,
  });
  return {
    user: auth.user,
    ...acceso,
  };
}

export function useCurrentUser() {
  const [data, setData] = useState<ProfileWithRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const load = async (user: User | null) => {
      if (!user) {
        if (mounted) {
          setData(null);
          setLoading(false);
        }
        return;
      }
      const [
        { data: profRaw },
        { data: roles },
        { data: settings, error: errorSettings },
        { data: habilitadas },
      ] = await Promise.all([
        supabase
          .from("profiles")
          .select(
            "id, username, nombre_completo, sucursal_id, activo, secciones, permite_venta_sin_stock, puede_facturar, puede_emitir_nc_periodo",
          )
          .eq("id", user.id)
          .maybeSingle(),
        supabase.from("user_roles").select("role").eq("user_id", user.id),
        supabase
          .from("settings")
          .select(
            "id,facturacion_receptor_v2_enabled,facturacion_legacy_writer_enabled,nota_credito_periodo_enabled",
          )
          .eq("id", true),
        supabase
          .from("profile_sucursales")
          .select("sucursal:sucursales(id, nombre)")
          .eq("profile_id", user.id),
      ]);
      const prof = profRaw as unknown as PerfilUsuarioActual | null;

      const sucursalesHabilitadas = (habilitadas ?? [])
        .map((h) => h.sucursal)
        .filter((sucursal): sucursal is { id: string; nombre: string } => sucursal !== null)
        .sort((a, b) => a.nombre.localeCompare(b.nombre));

      let sucursal = null;
      if (prof?.sucursal_id) {
        const { data: s } = await supabase
          .from("sucursales")
          .select("id, codigo, nombre, numero")
          .eq("id", prof.sucursal_id)
          .maybeSingle();
        sucursal = s ?? null;
      }
      const fiscal = resolverAccesoFiscalUsuario({
        roles,
        perfilActivo: prof?.activo,
        puedeFacturarPerfil: prof?.puede_facturar === true,
        puedeEmitirNcPeriodoPerfil: prof?.puede_emitir_nc_periodo === true,
        settings: errorSettings ? [] : settings,
      });
      if (mounted) {
        setData({
          user,
          profile: prof ?? {
            id: user.id,
            username: user.email ?? "",
            nombre_completo: null,
            sucursal_id: null,
            activo: false,
            puede_facturar: false,
            puede_emitir_nc_periodo: false,
          },
          secciones: prof?.secciones ?? null,
          sucursal,
          sucursalesHabilitadas,
          puedeVenderSinStock:
            prof?.activo === true && (fiscal.isAdmin || prof?.permite_venta_sin_stock === true),
          ...fiscal,
        });
        setLoading(false);
      }
    };

    supabase.auth.getUser().then(({ data: { user } }) => load(user));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        load(session?.user ?? null);
      }
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { data, loading };
}
