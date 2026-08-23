/** Server fn admin: crear usuario nuevo */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { normalizarSecciones } from "@/lib/secciones";
import { PASSWORD_MINIMO } from "@/lib/alta-usuario";

type RespuestaRpc = { data: unknown; error: { message?: string } | null };
export type ClienteCapacidadFiscal = {
  rpc(nombre: string, args: Record<string, unknown>): Promise<RespuestaRpc>;
};

export async function requireAdmin(
  supabase: ClienteCapacidadFiscal,
  userId: string,
): Promise<void> {
  const { data, error } = await supabase.rpc("is_admin", { _user_id: userId });
  if (error || data !== true) throw new Error("Solo admin");
}

export async function ejecutarSetPuedeFacturar(
  input: { actorId: string; user_id: string; value: boolean },
  supabase: ClienteCapacidadFiscal,
): Promise<{ ok: true }> {
  await requireAdmin(supabase, input.actorId);
  const { error } = await supabase.rpc("administrar_puede_facturar", {
    p_profile_id: input.user_id,
    p_puede_facturar: input.value,
  });
  if (error) throw new Error(error.message ?? "No se pudo actualizar la capacidad fiscal");
  return { ok: true };
}

export const setPuedeFacturar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ user_id: z.string().uuid(), value: z.boolean() }).strict().parse(d),
  )
  .handler(async ({ data, context }) =>
    ejecutarSetPuedeFacturar(
      { actorId: context.userId, ...data },
      context.supabase as unknown as ClienteCapacidadFiscal,
    ),
  );

export const crearUsuario = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        email: z.string().email(),
        // 10, igual que el reset y que la pantalla. Hasta el 04/08/2026 acá decía 6:
        // el mínimo real dependía de por dónde entrara el pedido.
        password: z.string().min(PASSWORD_MINIMO, `Mínimo ${PASSWORD_MINIMO} caracteres`),
        username: z.string().min(2),
        nombre_completo: z.string(),
        role: z.enum(["admin", "empleado"]),
        // La sucursal en la que va a estar trabajando (la "activa").
        sucursal_id: z.string().uuid().nullable(),
        // En cuáles PUEDE trabajar. Vacío = sólo la de arriba. Ver la migración
        // 20260813120000_multi_sucursal_empleados.sql.
        sucursales_habilitadas: z.array(z.string().uuid()).default([]),
        permite_venta_sin_stock: z.boolean().default(false),
        // null = "las de siempre". Ver normalizarSecciones / la spec de permisos.
        secciones: z.array(z.string()).nullable().default(null),
      })
      .refine((u) => u.role !== "empleado" || u.sucursal_id !== null, {
        // La etiqueta del campo ya decía "*" para empleado, pero nada lo exigía, y
        // un empleado sin sucursal no tiene caja ni puede vender.
        path: ["sucursal_id"],
        message: "Un empleado necesita una sucursal: de ahí salen su caja y sus ventas.",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Solo admin");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const email = data.email.trim().toLowerCase();
    const username = data.username.trim();

    // ---- Los dos choques, ANTES de crear nada ---------------------------
    // El 04/08/2026 alguien intentó dar de alta un email que ya tenía cuenta
    // desde hacía tres semanas. Lo único que devolvía el sistema era el texto
    // en inglés de Supabase, así que quedaba como "no me deja crear usuarios".
    // listUsers pagina de a 50: buscar sólo en la primera página dejaría pasar
    // el duplicado en cuanto haya más usuarios que eso, y el choque volvería
    // —esta vez como el error en inglés— justo cuando ya nadie lo espera.
    let existente: { id: string } | undefined;
    for (let pagina = 1; pagina <= 40 && !existente; pagina++) {
      const { data: lote, error: eLista } = await supabaseAdmin.auth.admin.listUsers({
        page: pagina,
        perPage: 200,
      });
      if (eLista) throw new Error(`No se pudo revisar los usuarios existentes: ${eLista.message}`);
      const usuarios = lote?.users ?? [];
      existente = usuarios.find((u) => (u.email ?? "").toLowerCase() === email);
      if (usuarios.length < 200) break;
    }
    if (existente) {
      const { data: perf } = await supabaseAdmin
        .from("profiles")
        .select("username, activo")
        .eq("id", existente.id)
        .maybeSingle();
      const alias = perf?.username ? ` (entra como «${perf.username}»)` : "";
      const baja =
        perf && perf.activo === false
          ? " Está desactivado: activalo con el botón de encendido."
          : "";
      throw new Error(
        `Ya hay un usuario con el email ${email}${alias}. ` +
          `No hace falta crearlo de nuevo.${baja}` +
          (baja
            ? ""
            : " Si se olvidó la contraseña, cambiásela con el ícono de la llave en la lista."),
      );
    }

    // `profiles.username` es UNIQUE. Antes esto no se miraba: el alias repetido
    // hacía fallar el UPDATE del perfil en silencio, la pantalla decía "Usuario
    // creado" igual, y quedaba una cuenta a medio configurar.
    const { data: yaAlias } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle();
    if (yaAlias) {
      throw new Error(`Ya hay otro usuario con el alias «${username}». Elegí otro.`);
    }

    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: data.password,
      email_confirm: true,
      user_metadata: { username, nombre_completo: data.nombre_completo },
    });
    if (error || !created.user) throw new Error(error?.message ?? "No se pudo crear el usuario");
    const nuevoId = created.user.id;

    // ---- De acá en adelante, si algo falla se deshace ---------------------
    // Sin esto, un fallo después del createUser deja la cuenta en auth pero sin
    // perfil ni rol: no puede hacer nada, no se ve en la lista, y el segundo
    // intento choca con "ya existe" por un usuario que en realidad nunca se creó.
    const deshacer = async (motivo: string): Promise<never> => {
      await supabaseAdmin.auth.admin.deleteUser(nuevoId).catch(() => {});
      throw new Error(motivo);
    };

    // En qué sucursales puede trabajar. La activa va sí o sí: si no, el guard
    // de profiles la vería como "no habilitada" en cuanto quiera cambiarse.
    //
    // Va ANTES de guardar el perfil, y el orden importa: son dos operaciones
    // separadas (no hay transacción entre ellas), así que si primero se
    // escribiera la sucursal activa quedaría un rato apuntando a una sucursal
    // que todavía no está habilitada — el estado que justamente el guard existe
    // para impedir.
    const habilitadas = [
      ...new Set([
        ...(data.sucursales_habilitadas ?? []),
        ...(data.sucursal_id ? [data.sucursal_id] : []),
      ]),
    ];
    if (habilitadas.length > 0) {
      const { error: eSuc } = await supabaseAdmin
        .from("profile_sucursales")
        .insert(habilitadas.map((sucursal_id) => ({ profile_id: nuevoId, sucursal_id })));
      if (eSuc) await deshacer(`No se pudieron asignar las sucursales: ${eSuc.message}`);
    }

    const { error: ePerfil } = await supabaseAdmin
      .from("profiles")
      .update({
        username,
        nombre_completo: data.nombre_completo,
        sucursal_id: data.sucursal_id,
        permite_venta_sin_stock: data.permite_venta_sin_stock,
        secciones: normalizarSecciones(data.secciones),
      })
      .eq("id", nuevoId);
    if (ePerfil) await deshacer(`No se pudo guardar el perfil: ${ePerfil.message}`);

    const { error: eRol } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: nuevoId, role: data.role });
    if (eRol) await deshacer(`No se pudo asignar el rol: ${eRol.message}`);

    return { id: nuevoId };
  });

type ErrorOperacionUsuario = { message?: string } | null;

export type OperacionesToggleUsuario = {
  actualizarPerfil(
    userId: string,
    activo: boolean,
  ): Promise<{ data: { id: string } | null; error: ErrorOperacionUsuario }>;
  actualizarAuth(
    userId: string,
    banDuration: "none" | "876000h",
  ): Promise<{ error: ErrorOperacionUsuario }>;
};

function mensajeErrorUsuario(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  return fallback;
}

export async function ejecutarToggleUsuarioActivo(
  input: { user_id: string; activo: boolean },
  operaciones: OperacionesToggleUsuario,
): Promise<{ ok: true }> {
  const actualizarPerfilValidado = async (activo: boolean): Promise<void> => {
    const { data, error } = await operaciones.actualizarPerfil(input.user_id, activo);
    if (error) {
      throw new Error(
        mensajeErrorUsuario(error, `No se pudo ${activo ? "reactivar" : "inactivar"} el perfil`),
      );
    }
    if (data?.id !== input.user_id) {
      throw new Error("El perfil del usuario no existe");
    }
  };

  const actualizarAuthValidado = async (banDuration: "none" | "876000h"): Promise<void> => {
    const { error } = await operaciones.actualizarAuth(input.user_id, banDuration);
    if (error) {
      throw new Error(
        mensajeErrorUsuario(
          error,
          banDuration === "none"
            ? "No se pudo quitar el bloqueo de acceso"
            : "No se pudo bloquear el acceso",
        ),
      );
    }
  };

  if (!input.activo) {
    // Fail-safe: cerrar primero la frontera de datos. Si luego falla el ban de
    // GoTrue, el pre-request y las RPC siguen viendo el perfil inactivo.
    await actualizarPerfilValidado(false);
    await actualizarAuthValidado("876000h");
    return { ok: true };
  }

  // Para reactivar, Auth se abre primero. Sólo publicamos el perfil como activo
  // si eso funcionó; si la segunda operación falla, restauramos el ban.
  await actualizarAuthValidado("none");
  try {
    await actualizarPerfilValidado(true);
  } catch (errorPerfil) {
    const mensajePerfil = mensajeErrorUsuario(errorPerfil, "No se pudo reactivar el perfil");
    try {
      await actualizarAuthValidado("876000h");
    } catch (errorReban) {
      const mensajeReban = mensajeErrorUsuario(errorReban, "No se pudo restaurar el bloqueo");
      throw new Error(`${mensajePerfil}. Además, no se pudo restaurar el bloqueo: ${mensajeReban}`);
    }
    throw new Error(mensajePerfil);
  }

  return { ok: true };
}

export const toggleUsuarioActivo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ user_id: z.string().uuid(), activo: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Solo admin");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return ejecutarToggleUsuarioActivo(data, {
      async actualizarPerfil(targetUserId, activo) {
        const { data: perfil, error } = await supabaseAdmin
          .from("profiles")
          .update({ activo })
          .eq("id", targetUserId)
          .select("id")
          .maybeSingle();
        return { data: perfil, error };
      },
      async actualizarAuth(targetUserId, banDuration) {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(targetUserId, {
          ban_duration: banDuration,
        });
        return { error };
      },
    });
  });

/** Server fn admin: habilita/deshabilita que un usuario venda productos sin stock (R6). */
export const setPermiteVentaSinStock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ user_id: z.string().uuid(), valor: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Solo admin");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ permite_venta_sin_stock: data.valor })
      .eq("id", data.user_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Server fn admin: qué secciones del menú ve un usuario.
 *
 * `null` = "las de siempre" (el menú de empleado por defecto). Array vacío =
 * ninguna. Se normaliza contra el catálogo antes de guardar: una key inventada o
 * una sección `soloAdmin` no llegan a la base, así que nadie tiene que
 * preguntarse después de dónde salió.
 *
 * Va por server function con service_role, y NO por un update directo desde el
 * cliente, porque `profiles` tiene policy de "editar mi propio perfil": el
 * trigger `guard_profiles_columnas` es el que impide el auto-otorgamiento, y
 * esto es el canal legítimo que lo saltea con el permiso ya verificado.
 */
export const setSeccionesUsuario = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        user_id: z.string().uuid(),
        secciones: z.array(z.string()).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Solo admin");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ secciones: normalizarSecciones(data.secciones) })
      .eq("id", data.user_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Cambia la contraseña de un usuario.
 *
 * Existe porque las 5 contraseñas originales estuvieron publicadas en la pantalla
 * de login (admin1234 / emp1234), así que están todas quemadas y hay que poder
 * rotarlas sin meterse en la base.
 */
export const resetearPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        user_id: z.string().uuid(),
        password: z.string().min(10, "Mínimo 10 caracteres"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Solo admin");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
