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
  iniciar(
    userId: string,
    activo: boolean,
    operacionId: string,
  ): Promise<{ data: unknown; error: ErrorOperacionUsuario }>;
  finalizar(
    userId: string,
    version: number,
    operacionId: string,
  ): Promise<{ data: unknown; error: ErrorOperacionUsuario }>;
  reclamarReconciliacion(
    userId: string,
    versionObservada: number,
    operacionId: string,
  ): Promise<{ data: unknown; error: ErrorOperacionUsuario }>;
  forzarCierreFailSafe(
    userId: string,
    operacionId: string,
  ): Promise<{ data: unknown; error: ErrorOperacionUsuario }>;
  actualizarAuth(
    userId: string,
    banDuration: "none" | "876000h",
  ): Promise<{ error: ErrorOperacionUsuario }>;
  leerAuthBloqueado(
    userId: string,
  ): Promise<{ bloqueado: boolean | null; error: ErrorOperacionUsuario }>;
  generarOperacionId(): string;
};

type EstadoToggleUsuario = {
  version: number;
  activoDeseado: boolean;
  pendiente: boolean;
  activoActual: boolean;
  operacionId: string;
  aplicada: boolean;
  supersedida: boolean;
  reclamada: boolean;
  forzada: boolean;
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
  input: { user_id: string; activo: boolean; operacion_id: string },
  operaciones: OperacionesToggleUsuario,
): Promise<{ ok: true }> {
  const parsearEstado = (data: unknown, fallback: string): EstadoToggleUsuario => {
    if (typeof data !== "object" || data === null) throw new Error(fallback);
    const value = data as Record<string, unknown>;
    if (
      typeof value.version !== "number" ||
      !Number.isSafeInteger(value.version) ||
      value.version < 0 ||
      typeof value.activo_deseado !== "boolean" ||
      typeof value.pendiente !== "boolean" ||
      typeof value.activo_actual !== "boolean" ||
      typeof value.operacion_id !== "string"
    ) {
      throw new Error(fallback);
    }
    return {
      version: value.version,
      activoDeseado: value.activo_deseado,
      pendiente: value.pendiente,
      activoActual: value.activo_actual,
      operacionId: value.operacion_id,
      aplicada: value.aplicada === true,
      supersedida: value.supersedida === true,
      reclamada: value.reclamada === true,
      forzada: value.forzada === true,
    };
  };

  const rpcConReintento = async (
    ejecutar: () => Promise<{ data: unknown; error: ErrorOperacionUsuario }>,
    fallback: string,
  ): Promise<EstadoToggleUsuario> => {
    let ultimoError: unknown = null;
    // Las RPC son idempotentes por operacion/version. Repetir una vez cubre el
    // timeout posterior al COMMIT sin crear una intención nueva.
    for (let intento = 0; intento < 2; intento += 1) {
      try {
        const { data, error } = await ejecutar();
        if (!error) return parsearEstado(data, fallback);
        ultimoError = error;
      } catch (error) {
        ultimoError = error;
      }
    }
    throw new Error(mensajeErrorUsuario(ultimoError, fallback));
  };

  const actualizarAuthValidado = async (banDuration: "none" | "876000h"): Promise<void> => {
    let ultimoError: unknown = null;
    // updateUserById con el mismo ban_duration es idempotente. Un segundo
    // intento resuelve el caso en que GoTrue aplicó el cambio pero se perdió la
    // respuesta.
    for (let intento = 0; intento < 2; intento += 1) {
      try {
        const { error } = await operaciones.actualizarAuth(input.user_id, banDuration);
        if (!error) return;
        ultimoError = error;
      } catch (error) {
        ultimoError = error;
      }
    }
    throw new Error(
      mensajeErrorUsuario(
        ultimoError,
        banDuration === "none"
          ? "No se pudo quitar el bloqueo de acceso"
          : "No se pudo bloquear el acceso",
      ),
    );
  };

  const leerAuthBloqueadoValidado = async (): Promise<boolean> => {
    let ultimoError: unknown = null;
    for (let intento = 0; intento < 2; intento += 1) {
      try {
        const { bloqueado, error } = await operaciones.leerAuthBloqueado(input.user_id);
        if (!error && typeof bloqueado === "boolean") return bloqueado;
        ultimoError = error;
      } catch (error) {
        ultimoError = error;
      }
    }
    throw new Error(
      mensajeErrorUsuario(ultimoError, "No se pudo verificar el bloqueo actual del usuario"),
    );
  };

  const imponerCierreFailSafe = async (causa: unknown): Promise<never> => {
    let dbCerrada = false;
    let authCerrado = false;
    let ultimoErrorCierre: unknown = null;

    // Esta RPC usa service_role y no vuelve a autorizar al actor original. Es
    // deliberado: si el admin fue desactivado mientras GoTrue estaba en vuelo,
    // el cierre de emergencia tiene que seguir disponible. Se reusa la misma
    // clave en el retry para cubrir un COMMIT cuya respuesta se perdió.
    for (let ronda = 0; ronda < 3 && !dbCerrada; ronda += 1) {
      let cierreId: string;
      try {
        cierreId = operaciones.generarOperacionId();
      } catch (error) {
        ultimoErrorCierre = error;
        break;
      }
      for (let intento = 0; intento < 2 && !dbCerrada; intento += 1) {
        try {
          const { data, error } = await operaciones.forzarCierreFailSafe(
            input.user_id,
            cierreId,
          );
          if (error) {
            ultimoErrorCierre = error;
            continue;
          }
          const cierre = parsearEstado(
            data,
            "No se pudo interpretar el cierre de emergencia del usuario",
          );
          estado = cierre;
          // Una operación concurrente puede superseder la clave del cierre,
          // pero mientras el estado vigente permanezca pending/profile=false
          // el acceso de PostgREST ya está cerrado de forma global.
          dbCerrada = cierre.pendiente && !cierre.activoActual;
        } catch (error) {
          ultimoErrorCierre = error;
        }
      }
    }

    // Bloquear también GoTrue evita depender únicamente del pre-request de DB
    // durante una incidencia. Si Auth no responde pero DB quedó cerrada, sigue
    // siendo fail-closed; si DB falló pero el ban entró, tampoco queda acceso.
    try {
      await actualizarAuthValidado("876000h");
      authCerrado = true;
    } catch (error) {
      ultimoErrorCierre = ultimoErrorCierre ?? error;
    }

    const motivo = mensajeErrorUsuario(causa, "No se pudo reconciliar el acceso del usuario");
    if (!dbCerrada && !authCerrado) {
      throw new Error(
        `${motivo}. Además falló el cierre de emergencia: ${mensajeErrorUsuario(
          ultimoErrorCierre,
          "requiere revisión administrativa inmediata",
        )}`,
      );
    }
    throw new Error(
      `${motivo}. El acceso quedó cerrado de forma preventiva y requiere reintento administrativo.`,
    );
  };

  let estado = await rpcConReintento(
    () => operaciones.iniciar(input.user_id, input.activo, input.operacion_id),
    "No se pudo iniciar el cambio de acceso",
  );
  if (
    !estado.supersedida &&
    (estado.operacionId !== input.operacion_id || estado.activoDeseado !== input.activo)
  ) {
    throw new Error("La transición de acceso no coincide con la operación solicitada");
  }

  // Estado DB y estado Auth forman un único protocolo aunque GoTrue sea una
  // llamada externa. Toda respuesta estable se contrasta con Auth; si difiere,
  // primero se reclama una versión CAS que vuelve a cerrar el perfil y recién
  // después se repara Auth. Así un retry histórico tampoco confía sólo en
  // `profiles.activo` ni puede dejar un usuario abierto con desired=false.
  let escriturasAuth = 0;
  for (let paso = 0; paso < 24 && escriturasAuth < 9; paso += 1) {
    if (!estado.pendiente) {
      if (estado.activoActual !== estado.activoDeseado) {
        return imponerCierreFailSafe(
          new Error("El acceso resuelto no coincide con la intención vigente"),
        );
      }
      let authBloqueado: boolean;
      try {
        authBloqueado = await leerAuthBloqueadoValidado();
      } catch (error) {
        return imponerCierreFailSafe(error);
      }
      if (authBloqueado === !estado.activoDeseado) {
        if (estado.activoDeseado === input.activo) return { ok: true };
        throw new Error(
          "La operación fue reemplazada por un cambio más nuevo; se conservó el estado más reciente.",
        );
      }

      const reconciliacionId = operaciones.generarOperacionId();
      try {
        estado = await rpcConReintento(
          () =>
            operaciones.reclamarReconciliacion(
              input.user_id,
              estado.version,
              reconciliacionId,
            ),
          "No se pudo reconciliar el cambio de acceso más reciente",
        );
      } catch (error) {
        return imponerCierreFailSafe(error);
      }
      continue;
    }

    const intentado = estado;
    await actualizarAuthValidado(intentado.activoDeseado ? "none" : "876000h");
    escriturasAuth += 1;
    try {
      estado = await rpcConReintento(
        () =>
          operaciones.finalizar(input.user_id, intentado.version, intentado.operacionId),
        "No se pudo finalizar el cambio de acceso",
      );
    } catch (errorFinalizar) {
      // `finalizar` pudo hacer COMMIT y perder ambas respuestas. Releer la RPC
      // idempotente original devuelve el CAS vigente sin crear otra intención.
      // Si sigue exactamente el mismo pending, el perfil ya está fail-closed y
      // se conserva el error real. Si avanzó, el loop repara el desired actual.
      let observado: EstadoToggleUsuario;
      try {
        observado = await rpcConReintento(
          () => operaciones.iniciar(input.user_id, input.activo, input.operacion_id),
          "No se pudo consultar el estado vigente después de finalizar",
        );
      } catch (errorRecuperacion) {
        return imponerCierreFailSafe(errorRecuperacion);
      }
      if (
        observado.pendiente &&
        observado.version === intentado.version &&
        observado.operacionId === intentado.operacionId
      ) {
        throw errorFinalizar;
      }
      estado = observado;
    }
  }

  return imponerCierreFailSafe(
    new Error(
      "La operación fue reemplazada varias veces. El acceso quedó cerrado y pendiente; reintentá la misma acción para reconciliarlo",
    ),
  );
}

export const toggleUsuarioActivo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        user_id: z.string().uuid(),
        activo: z.boolean(),
        operacion_id: z.string().uuid(),
      })
      .strict()
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireAdmin(supabase as unknown as ClienteCapacidadFiscal, userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return ejecutarToggleUsuarioActivo(data, {
      async iniciar(targetUserId, activo, operacionId) {
        return supabaseAdmin.rpc("iniciar_transicion_usuario_activo", {
          p_actor_id: userId,
          p_profile_id: targetUserId,
          p_activo: activo,
          p_operacion_id: operacionId,
        });
      },
      async finalizar(targetUserId, version, operacionId) {
        return supabaseAdmin.rpc("finalizar_transicion_usuario_activo", {
          p_profile_id: targetUserId,
          p_version: version,
          p_operacion_id: operacionId,
        });
      },
      async reclamarReconciliacion(targetUserId, versionObservada, operacionId) {
        return supabaseAdmin.rpc("reclamar_reconciliacion_usuario_activo", {
          p_profile_id: targetUserId,
          p_version_observada: versionObservada,
          p_operacion_id: operacionId,
        });
      },
      async forzarCierreFailSafe(targetUserId, operacionId) {
        return supabaseAdmin.rpc("forzar_cierre_usuario_activo_fail_safe", {
          p_profile_id: targetUserId,
          p_operacion_id: operacionId,
        });
      },
      async actualizarAuth(targetUserId, banDuration) {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(targetUserId, {
          ban_duration: banDuration,
        });
        return { error };
      },
      async leerAuthBloqueado(targetUserId) {
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(targetUserId);
        const bannedUntil = data.user?.banned_until;
        return {
          bloqueado:
            !error && typeof bannedUntil === "string"
              ? Date.parse(bannedUntil) > Date.now()
              : error
                ? null
                : false,
          error,
        };
      },
      generarOperacionId: () => crypto.randomUUID(),
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
