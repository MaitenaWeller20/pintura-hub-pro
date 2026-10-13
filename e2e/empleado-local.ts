import {
  exigirSesionesCajaPropiasSinReferencias,
  type ReferenciasCajaFixture,
  type SesionCajaFixture,
} from "./fixtures/limpieza-caja";

export const EMAIL_EMPLEADO_E2E = "empleado@local.test";
export const EMAIL_ADMIN_E2E = "admin@local.test";
const CODIGOS_SUCURSALES_E2E = ["OHIGGINS", "GENERALPAZ"] as const;

type RolUsuarioLocalE2E = "admin" | "empleado";
type ConfiguracionUsuarioLocalE2E = {
  email: string;
  password: string;
  username: string;
  nombreCompleto: string;
  rol: RolUsuarioLocalE2E;
  asignarSucursales: boolean;
};

const EMPLEADO_E2E: ConfiguracionUsuarioLocalE2E = {
  email: EMAIL_EMPLEADO_E2E,
  password: "empleado1234",
  username: "empleado-e2e",
  nombreCompleto: "Empleado E2E",
  rol: "empleado",
  asignarSucursales: true,
};

const ADMIN_E2E: ConfiguracionUsuarioLocalE2E = {
  email: EMAIL_ADMIN_E2E,
  password: "admin1234",
  username: "admin-e2e",
  nombreCompleto: "Admin E2E",
  rol: "admin",
  asignarSucursales: false,
};

type UsuarioEmpleadoE2E = { id: string };
type SucursalEmpleadoE2E = { id: string; codigo: string };
type PerfilEmpleadoE2E = { activo: boolean; sucursalId: string | null };

export type EstadoEmpleadoLocalE2E = {
  usuario: UsuarioEmpleadoE2E | null;
  perfil: PerfilEmpleadoE2E | null;
  roles: string[];
  sucursales: SucursalEmpleadoE2E[];
  sucursalesAsignadas: string[];
};

export type RepositorioEmpleadoLocalE2E = {
  leerEstado(email: string): Promise<EstadoEmpleadoLocalE2E>;
  crearUsuario(email: string, password: string): Promise<UsuarioEmpleadoE2E>;
  crearPerfil(
    usuarioId: string,
    sucursalId: string,
    perfil: { username: string; nombreCompleto: string },
  ): Promise<void>;
  actualizarSucursalPerfil(usuarioId: string, sucursalId: string | null): Promise<void>;
  agregarRol(usuarioId: string, rol: RolUsuarioLocalE2E): Promise<void>;
  agregarSucursal(usuarioId: string, sucursalId: string): Promise<void>;
  quitarSucursal(usuarioId: string, sucursalId: string): Promise<void>;
  quitarRol(usuarioId: string, rol: RolUsuarioLocalE2E): Promise<void>;
  limpiarReferenciasUsuarioCreado(usuarioId: string): Promise<void>;
  eliminarPerfil(usuarioId: string): Promise<void>;
  eliminarUsuario(usuarioId: string): Promise<void>;
};

export type LimpiarEmpleadoLocalE2E = () => Promise<void>;

function requerirSucursales(estado: EstadoEmpleadoLocalE2E): SucursalEmpleadoE2E[] {
  const porCodigo = new Map(estado.sucursales.map((sucursal) => [sucursal.codigo, sucursal]));
  const faltantes = CODIGOS_SUCURSALES_E2E.filter((codigo) => !porCodigo.has(codigo));
  if (faltantes.length > 0) {
    throw new Error(`Faltan sucursales locales para E2E: ${faltantes.join(", ")}.`);
  }
  return CODIGOS_SUCURSALES_E2E.map((codigo) => porCodigo.get(codigo)!);
}

/**
 * Hace reproducible el E2E desde `supabase db reset` y devuelve un teardown exacto.
 * Si el usuario ya existía, sólo revierte las relaciones que esta corrida agregó.
 */
async function prepararUsuarioLocalE2E(
  repositorio: RepositorioEmpleadoLocalE2E,
  configuracion: ConfiguracionUsuarioLocalE2E,
): Promise<LimpiarEmpleadoLocalE2E> {
  let estado = await repositorio.leerEstado(configuracion.email);
  const sucursales = requerirSucursales(estado);
  let usuarioId = estado.usuario?.id ?? null;
  let usuarioCreado = false;
  let perfilCreado = false;
  let sucursalPerfilAnterior: string | null | undefined;
  let rolAgregado = false;
  const sucursalesAgregadas: string[] = [];
  let limpiado = false;

  const limpiar: LimpiarEmpleadoLocalE2E = async () => {
    if (limpiado) return;
    if (!usuarioId) {
      limpiado = true;
      return;
    }

    let etapa = "inicio";
    try {
      // La auditoría de cajas va antes de cualquier otra mutación: si el
      // usuario cerró una caja ajena o su caja conserva referencias
      // comerciales, el teardown se detiene sin borrar roles, perfil ni Auth.
      if (usuarioCreado) {
        etapa = "auditoría y limpieza de cajas propias";
        await repositorio.limpiarReferenciasUsuarioCreado(usuarioId);
      }

      // La base no deja quitar la sucursal activa. Primero se la despeja,
      // después se retiran exactamente las relaciones agregadas y recién al
      // final se restaura el valor original. Todos estos pasos son idempotentes
      // en el adaptador HTTP para que una falla posterior se pueda reintentar.
      if (sucursalesAgregadas.length > 0) {
        etapa = "despeje de sucursal activa";
        await repositorio.actualizarSucursalPerfil(usuarioId, null);
      }
      for (const sucursalId of [...sucursalesAgregadas].reverse()) {
        etapa = `retiro de sucursal ${sucursalId}`;
        await repositorio.quitarSucursal(usuarioId, sucursalId);
      }
      if (sucursalPerfilAnterior !== undefined) {
        etapa = "restauración de sucursal original";
        await repositorio.actualizarSucursalPerfil(usuarioId, sucursalPerfilAnterior ?? null);
      }
      if (rolAgregado) {
        etapa = `retiro del rol ${configuracion.rol}`;
        await repositorio.quitarRol(usuarioId, configuracion.rol);
      }
      if (perfilCreado) {
        etapa = "eliminación del perfil creado";
        await repositorio.eliminarPerfil(usuarioId);
      }
      if (usuarioCreado) {
        etapa = "eliminación del usuario Auth creado";
        await repositorio.eliminarUsuario(usuarioId);
      }
      limpiado = true;
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error);
      throw new AggregateError(
        [error],
        `No se pudo completar el cleanup local E2E en ${etapa}. Puede reintentarse sin repetir el bootstrap: ${detalle}`,
      );
    }
  };

  try {
    if (!usuarioId) {
      usuarioId = (await repositorio.crearUsuario(configuracion.email, configuracion.password)).id;
      usuarioCreado = true;
      // GoTrue puede disparar un trigger que crea `profiles` junto con auth.users.
      // Releer evita insertar el mismo PK y también toma cualquier relación que
      // el proyecto agregue automáticamente en el futuro.
      estado = await repositorio.leerEstado(configuracion.email);
      if (estado.usuario?.id !== usuarioId) {
        throw new Error("Auth creó el usuario E2E pero no pudo releer la misma identidad.");
      }
    }

    if (!estado.perfil) {
      await repositorio.crearPerfil(usuarioId, sucursales[0].id, {
        username: configuracion.username,
        nombreCompleto: configuracion.nombreCompleto,
      });
      perfilCreado = true;
      sucursalPerfilAnterior = null;
    } else {
      if (!estado.perfil.activo) throw new Error(`${configuracion.email} está inactivo.`);
      // Guardar siempre la sucursal original: los escenarios pueden cambiarla
      // a una relación agregada por este bootstrap. El teardown debe restaurar
      // la original antes de intentar retirar esa relación.
      sucursalPerfilAnterior = estado.perfil.sucursalId;
      if (!sucursales.some((sucursal) => sucursal.id === estado.perfil!.sucursalId)) {
        await repositorio.actualizarSucursalPerfil(usuarioId, sucursales[0].id);
      }
    }

    if (estado.roles.length === 0) {
      await repositorio.agregarRol(usuarioId, configuracion.rol);
      rolAgregado = true;
    } else if (
      !estado.roles.includes(configuracion.rol) ||
      estado.roles.some((rol) => rol !== configuracion.rol)
    ) {
      throw new Error(`${configuracion.email} existe con un rol distinto de ${configuracion.rol}.`);
    }

    if (configuracion.asignarSucursales) {
      const asignadas = new Set(estado.sucursalesAsignadas);
      for (const sucursal of sucursales) {
        if (asignadas.has(sucursal.id)) continue;
        await repositorio.agregarSucursal(usuarioId, sucursal.id);
        sucursalesAgregadas.push(sucursal.id);
      }
    }

    return limpiar;
  } catch (error) {
    try {
      await limpiar();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Falló el bootstrap y también su limpieza del empleado local E2E.",
      );
    }
    throw error;
  }
}

export function prepararEmpleadoLocalE2E(
  repositorio: RepositorioEmpleadoLocalE2E,
): Promise<LimpiarEmpleadoLocalE2E> {
  return prepararUsuarioLocalE2E(repositorio, EMPLEADO_E2E);
}

export function prepararAdminLocalE2E(
  repositorio: RepositorioEmpleadoLocalE2E,
): Promise<LimpiarEmpleadoLocalE2E> {
  return prepararUsuarioLocalE2E(repositorio, ADMIN_E2E);
}

type EntornoSupabaseEmpleadoE2E = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

type AuthUsersResponse = { users?: Array<{ id: string; email?: string }> };

function validarUrlLocal(value: string | undefined): string {
  if (!value) throw new Error("Falta SUPABASE_URL para preparar el empleado local E2E.");
  const url = new URL(value);
  if (!/^(127\.0\.0\.1|localhost)$/.test(url.hostname)) {
    throw new Error("El bootstrap del empleado E2E sólo puede usar Supabase local.");
  }
  return url.toString().replace(/\/$/, "");
}

function parametros(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

/** Adaptador HTTP service-role, cercado a localhost por construcción. */
export function crearRepositorioEmpleadoLocalHttp(
  entorno: EntornoSupabaseEmpleadoE2E,
  fetchImpl: typeof fetch = fetch,
): RepositorioEmpleadoLocalE2E {
  const baseUrl = validarUrlLocal(entorno.SUPABASE_URL);
  const serviceRoleValue = entorno.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleValue) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY local para el E2E.");
  const serviceRole: string = serviceRoleValue;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    estadosIdempotentes: readonly number[] = [],
  ): Promise<T> {
    const respuesta = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        apikey: serviceRole,
        Authorization: `Bearer ${serviceRole}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const texto = await respuesta.text();
    if (estadosIdempotentes.includes(respuesta.status)) return undefined as T;
    if (!respuesta.ok) {
      throw new Error(`${method} ${path} -> ${respuesta.status}: ${texto.slice(0, 300)}`);
    }
    return (texto ? JSON.parse(texto) : undefined) as T;
  }

  async function listarSesionesCajaVinculadas(usuarioId: string): Promise<SesionCajaFixture[]> {
    return request<SesionCajaFixture[]>(
      "GET",
      `/rest/v1/caja_sesiones?${parametros({
        select: "id,abierta_por,cerrada_por",
        or: `(abierta_por.eq.${usuarioId},cerrada_por.eq.${usuarioId})`,
      })}`,
    );
  }

  async function contarReferenciasCaja(sesionId: string): Promise<ReferenciasCajaFixture> {
    const contar = async (tabla: keyof ReferenciasCajaFixture) =>
      (
        await request<Array<{ id: string }>>(
          "GET",
          `/rest/v1/${tabla}?${parametros({
            select: "id",
            caja_sesion_id: `eq.${sesionId}`,
          })}`,
        )
      ).length;
    const [ventas, venta_pagos, caja_movimientos, cobranzas_cta_cte, compras, proveedor_pagos] =
      await Promise.all([
        contar("ventas"),
        contar("venta_pagos"),
        contar("caja_movimientos"),
        contar("cobranzas_cta_cte"),
        contar("compras"),
        contar("proveedor_pagos"),
      ]);
    return {
      ventas,
      venta_pagos,
      caja_movimientos,
      cobranzas_cta_cte,
      compras,
      proveedor_pagos,
    };
  }

  return {
    async leerEstado(email) {
      const [auth, sucursales] = await Promise.all([
        request<AuthUsersResponse>("GET", "/auth/v1/admin/users?page=1&per_page=1000"),
        request<Array<{ id: string; codigo: string }>>(
          "GET",
          `/rest/v1/sucursales?${parametros({
            select: "id,codigo",
            codigo: "in.(OHIGGINS,GENERALPAZ)",
          })}`,
        ),
      ]);
      const encontrados = (auth.users ?? []).filter((usuario) => usuario.email === email);
      if (encontrados.length > 1) throw new Error(`Hay más de un auth user para ${email}.`);
      const usuario = encontrados[0] ? { id: encontrados[0].id } : null;
      if (!usuario) {
        return { usuario: null, perfil: null, roles: [], sucursales, sucursalesAsignadas: [] };
      }

      const filtroId = `eq.${usuario.id}`;
      const [perfiles, roles, asignaciones] = await Promise.all([
        request<Array<{ activo: boolean; sucursal_id: string | null }>>(
          "GET",
          `/rest/v1/profiles?${parametros({ select: "activo,sucursal_id", id: filtroId })}`,
        ),
        request<Array<{ role: string }>>(
          "GET",
          `/rest/v1/user_roles?${parametros({ select: "role", user_id: filtroId })}`,
        ),
        request<Array<{ sucursal_id: string }>>(
          "GET",
          `/rest/v1/profile_sucursales?${parametros({
            select: "sucursal_id",
            profile_id: filtroId,
          })}`,
        ),
      ]);
      if (perfiles.length > 1) throw new Error(`Hay más de un perfil para ${email}.`);
      return {
        usuario,
        perfil: perfiles[0]
          ? { activo: perfiles[0].activo, sucursalId: perfiles[0].sucursal_id }
          : null,
        roles: roles.map((fila) => fila.role),
        sucursales,
        sucursalesAsignadas: asignaciones.map((fila) => fila.sucursal_id),
      };
    },
    async crearUsuario(email, password) {
      return request<UsuarioEmpleadoE2E>("POST", "/auth/v1/admin/users", {
        email,
        password,
        email_confirm: true,
      });
    },
    async crearPerfil(usuarioId, sucursalId, perfil) {
      await request("POST", "/rest/v1/profiles", {
        id: usuarioId,
        username: perfil.username,
        nombre_completo: perfil.nombreCompleto,
        sucursal_id: sucursalId,
        activo: true,
      });
    },
    async actualizarSucursalPerfil(usuarioId, sucursalId) {
      await request("PATCH", `/rest/v1/profiles?${parametros({ id: `eq.${usuarioId}` })}`, {
        sucursal_id: sucursalId,
      });
    },
    async agregarRol(usuarioId, rol) {
      await request("POST", "/rest/v1/user_roles", { user_id: usuarioId, role: rol });
    },
    async agregarSucursal(usuarioId, sucursalId) {
      await request("POST", "/rest/v1/profile_sucursales", {
        profile_id: usuarioId,
        sucursal_id: sucursalId,
      });
    },
    async quitarSucursal(usuarioId, sucursalId) {
      await request(
        "DELETE",
        `/rest/v1/profile_sucursales?${parametros({
          profile_id: `eq.${usuarioId}`,
          sucursal_id: `eq.${sucursalId}`,
        })}`,
      );
    },
    async quitarRol(usuarioId, rol) {
      await request(
        "DELETE",
        `/rest/v1/user_roles?${parametros({ user_id: `eq.${usuarioId}`, role: `eq.${rol}` })}`,
      );
    },
    async limpiarReferenciasUsuarioCreado(usuarioId) {
      // Una venta/NC puede abrir automáticamente una caja para el usuario de
      // bootstrap. Se localizan también las que sólo cerró para detectar y
      // preservar cajas ajenas. Todas las referencias se auditan antes del
      // único DELETE; así una FK comercial no deja un cleanup parcial.
      const sesiones = await listarSesionesCajaVinculadas(usuarioId);
      const referenciasPorSesion: Record<string, ReferenciasCajaFixture> = {};
      await Promise.all(
        sesiones.map(async (sesion) => {
          referenciasPorSesion[sesion.id] = await contarReferenciasCaja(sesion.id);
        }),
      );
      const ids = exigirSesionesCajaPropiasSinReferencias(
        sesiones,
        new Set([usuarioId]),
        referenciasPorSesion,
      );
      if (ids.length === 0) return;
      await request(
        "DELETE",
        `/rest/v1/caja_sesiones?${parametros({
          id: `in.(${ids.join(",")})`,
          abierta_por: `eq.${usuarioId}`,
        })}`,
      );
      const restantes = await listarSesionesCajaVinculadas(usuarioId);
      if (restantes.length > 0) {
        throw new Error(
          `El cleanup dejó ${restantes.length} caja(s) vinculada(s) al usuario E2E ${usuarioId}.`,
        );
      }
    },
    async eliminarPerfil(usuarioId) {
      await request("DELETE", `/rest/v1/profiles?${parametros({ id: `eq.${usuarioId}` })}`);
    },
    async eliminarUsuario(usuarioId) {
      await request(
        "DELETE",
        `/auth/v1/admin/users/${encodeURIComponent(usuarioId)}`,
        undefined,
        [404],
      );
    },
  };
}
