import { describe, expect, it, vi } from "vitest";

import {
  EMAIL_ADMIN_E2E,
  EMAIL_EMPLEADO_E2E,
  crearRepositorioEmpleadoLocalHttp,
  prepararAdminLocalE2E,
  prepararEmpleadoLocalE2E,
  type EstadoEmpleadoLocalE2E,
  type RepositorioEmpleadoLocalE2E,
} from "../../e2e/empleado-local";

function repositorioEnMemoria(estadoInicial: EstadoEmpleadoLocalE2E) {
  const estado = structuredClone(estadoInicial);
  const llamadas: string[] = [];
  const repo: RepositorioEmpleadoLocalE2E = {
    async leerEstado(email) {
      llamadas.push(`leer:${email}`);
      return structuredClone(estado);
    },
    async crearUsuario() {
      llamadas.push("crear-usuario");
      estado.usuario = { id: "usuario-e2e" };
      return { id: "usuario-e2e" };
    },
    async crearPerfil(usuarioId, sucursalId) {
      llamadas.push(`crear-perfil:${usuarioId}:${sucursalId}`);
      estado.perfil = { activo: true, sucursalId };
    },
    async actualizarSucursalPerfil(usuarioId, sucursalId) {
      llamadas.push(`actualizar-perfil:${usuarioId}:${sucursalId ?? "null"}`);
      if (!estado.perfil) throw new Error("perfil ausente");
      estado.perfil.sucursalId = sucursalId;
    },
    async agregarRol(usuarioId, rol) {
      llamadas.push(`agregar-rol:${usuarioId}:${rol}`);
      estado.roles.push(rol);
    },
    async agregarSucursal(usuarioId, sucursalId) {
      llamadas.push(`agregar-sucursal:${usuarioId}:${sucursalId}`);
      estado.sucursalesAsignadas.push(sucursalId);
    },
    async quitarSucursal(usuarioId, sucursalId) {
      llamadas.push(`quitar-sucursal:${usuarioId}:${sucursalId}`);
      if (estado.perfil?.sucursalId === sucursalId) {
        throw new Error("no se puede quitar la sucursal activa");
      }
      estado.sucursalesAsignadas = estado.sucursalesAsignadas.filter((id) => id !== sucursalId);
    },
    async quitarRol(usuarioId, rolObjetivo) {
      llamadas.push(`quitar-rol:${usuarioId}:${rolObjetivo}`);
      estado.roles = estado.roles.filter((rol) => rol !== rolObjetivo);
    },
    async limpiarReferenciasUsuarioCreado(usuarioId) {
      llamadas.push(`limpiar-referencias:${usuarioId}`);
    },
    async eliminarPerfil(usuarioId) {
      llamadas.push(`eliminar-perfil:${usuarioId}`);
      estado.perfil = null;
    },
    async eliminarUsuario(usuarioId) {
      llamadas.push(`eliminar-usuario:${usuarioId}`);
      estado.usuario = null;
    },
  };
  return { repo, estado, llamadas };
}

const SUCURSALES = [
  { id: "sucursal-ohiggins", codigo: "OHIGGINS" },
  { id: "sucursal-general-paz", codigo: "GENERALPAZ" },
];

function respuestaJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function crearFetchCajas(input: {
  sesiones: Array<{ id: string; abierta_por: string; cerrada_por: string | null }>;
  referencias?: Partial<Record<string, Record<string, number>>>;
}) {
  const sesiones = structuredClone(input.sesiones);
  const deletes: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
    const url = new URL(typeof request === "string" ? request : request.toString());
    const method = init?.method ?? "GET";

    if (url.pathname === "/rest/v1/caja_sesiones" && method === "GET") {
      const usuarioId = "usuario-e2e";
      return respuestaJson(
        sesiones.filter(
          (sesion) => sesion.abierta_por === usuarioId || sesion.cerrada_por === usuarioId,
        ),
      );
    }

    if (url.pathname === "/rest/v1/caja_sesiones" && method === "DELETE") {
      deletes.push(url.search);
      const ids = /in\.\(([^)]+)\)/.exec(url.searchParams.get("id") ?? "")?.[1]?.split(",") ?? [];
      for (const id of ids) {
        const indice = sesiones.findIndex((sesion) => sesion.id === id);
        if (indice >= 0) sesiones.splice(indice, 1);
      }
      return new Response(null, { status: 204 });
    }

    const tabla = url.pathname.replace("/rest/v1/", "");
    const sesionId = (url.searchParams.get("caja_sesion_id") ?? "").replace(/^eq\./, "");
    const cantidad = input.referencias?.[sesionId]?.[tabla] ?? 0;
    return respuestaJson(
      Array.from({ length: cantidad }, (_, index) => ({ id: `${tabla}-${index}` })),
    );
  });

  return { fetchImpl, sesiones, deletes };
}

describe("bootstrap del empleado local E2E", () => {
  it("crea y limpia el admin requerido por la suite desde un reset vacío", async () => {
    const { repo, estado, llamadas } = repositorioEnMemoria({
      usuario: null,
      perfil: null,
      roles: [],
      sucursales: SUCURSALES,
      sucursalesAsignadas: [],
    });

    const limpiar = await prepararAdminLocalE2E(repo);

    expect(estado.usuario).toEqual({ id: "usuario-e2e" });
    expect(estado.perfil).toEqual({ activo: true, sucursalId: "sucursal-ohiggins" });
    expect(estado.roles).toEqual(["admin"]);
    expect(estado.sucursalesAsignadas).toEqual([]);
    expect(llamadas[0]).toBe(`leer:${EMAIL_ADMIN_E2E}`);

    await limpiar();
    expect(estado.usuario).toBeNull();
    expect(estado.perfil).toBeNull();
    expect(estado.roles).toEqual([]);
    expect(estado.sucursalesAsignadas).toEqual([]);
    expect(llamadas.indexOf("limpiar-referencias:usuario-e2e")).toBeLessThan(
      llamadas.indexOf("eliminar-usuario:usuario-e2e"),
    );
  });

  it("crea el fixture faltante, lo asocia a ambas sucursales y lo limpia completo", async () => {
    const { repo, estado, llamadas } = repositorioEnMemoria({
      usuario: null,
      perfil: null,
      roles: [],
      sucursales: SUCURSALES,
      sucursalesAsignadas: [],
    });

    const limpiar = await prepararEmpleadoLocalE2E(repo);

    expect(estado.usuario).toEqual({ id: "usuario-e2e" });
    expect(estado.perfil).toEqual({ activo: true, sucursalId: "sucursal-ohiggins" });
    expect(estado.roles).toEqual(["empleado"]);
    expect(estado.sucursalesAsignadas).toEqual(["sucursal-ohiggins", "sucursal-general-paz"]);

    await limpiar();
    await limpiar();

    expect(estado.usuario).toBeNull();
    expect(estado.perfil).toBeNull();
    expect(estado.roles).toEqual([]);
    expect(estado.sucursalesAsignadas).toEqual([]);
    expect(llamadas.filter((llamada) => llamada === "eliminar-usuario:usuario-e2e")).toHaveLength(
      1,
    );
    expect(llamadas[0]).toBe(`leer:${EMAIL_EMPLEADO_E2E}`);
  });

  it("preserva un empleado local existente y revierte sólo la sucursal que agregó", async () => {
    const { repo, estado, llamadas } = repositorioEnMemoria({
      usuario: { id: "usuario-existente" },
      perfil: { activo: true, sucursalId: "sucursal-ohiggins" },
      roles: ["empleado"],
      sucursales: SUCURSALES,
      sucursalesAsignadas: ["sucursal-ohiggins"],
    });

    const limpiar = await prepararEmpleadoLocalE2E(repo);
    expect(estado.sucursalesAsignadas).toEqual(["sucursal-ohiggins", "sucursal-general-paz"]);

    await limpiar();

    expect(estado.usuario).toEqual({ id: "usuario-existente" });
    expect(estado.perfil).toEqual({ activo: true, sucursalId: "sucursal-ohiggins" });
    expect(estado.roles).toEqual(["empleado"]);
    expect(estado.sucursalesAsignadas).toEqual(["sucursal-ohiggins"]);
    expect(llamadas).not.toContain("eliminar-usuario:usuario-existente");
  });

  it("restaura la sucursal original aunque el E2E cambie la activa a la relación agregada", async () => {
    const { repo, estado } = repositorioEnMemoria({
      usuario: { id: "usuario-existente" },
      perfil: { activo: true, sucursalId: "sucursal-ohiggins" },
      roles: ["empleado"],
      sucursales: SUCURSALES,
      sucursalesAsignadas: ["sucursal-ohiggins"],
    });

    const limpiar = await prepararEmpleadoLocalE2E(repo);
    await repo.actualizarSucursalPerfil("usuario-existente", "sucursal-general-paz");

    await expect(limpiar()).resolves.toBeUndefined();
    expect(estado.perfil?.sucursalId).toBe("sucursal-ohiggins");
    expect(estado.sucursalesAsignadas).toEqual(["sucursal-ohiggins"]);
  });

  it("restaura exactamente un fixture previo cuya sucursal activa todavía no tenía relación", async () => {
    const { repo, estado } = repositorioEnMemoria({
      usuario: { id: "usuario-existente" },
      perfil: { activo: true, sucursalId: "sucursal-ohiggins" },
      roles: ["empleado"],
      sucursales: SUCURSALES,
      sucursalesAsignadas: [],
    });

    const limpiar = await prepararEmpleadoLocalE2E(repo);
    expect(estado.sucursalesAsignadas).toEqual(["sucursal-ohiggins", "sucursal-general-paz"]);

    await expect(limpiar()).resolves.toBeUndefined();
    expect(estado.perfil?.sucursalId).toBe("sucursal-ohiggins");
    expect(estado.sucursalesAsignadas).toEqual([]);
  });

  it("relee el perfil que crea automáticamente Auth antes de intentar insertarlo", async () => {
    const { repo, estado, llamadas } = repositorioEnMemoria({
      usuario: null,
      perfil: null,
      roles: [],
      sucursales: SUCURSALES,
      sucursalesAsignadas: [],
    });
    repo.crearUsuario = vi.fn(async () => {
      estado.usuario = { id: "usuario-e2e" };
      estado.perfil = { activo: true, sucursalId: null };
      return { id: "usuario-e2e" };
    });

    const limpiar = await prepararEmpleadoLocalE2E(repo);

    expect(llamadas.some((llamada) => llamada.startsWith("crear-perfil:"))).toBe(false);
    expect(estado.perfil?.sucursalId).toBe("sucursal-ohiggins");
    await limpiar();
  });

  it("limpia lo creado si el bootstrap falla a mitad", async () => {
    const { repo, estado } = repositorioEnMemoria({
      usuario: null,
      perfil: null,
      roles: [],
      sucursales: SUCURSALES,
      sucursalesAsignadas: [],
    });
    repo.agregarRol = vi.fn(async () => {
      throw new Error("falló el rol");
    });

    await expect(prepararEmpleadoLocalE2E(repo)).rejects.toThrow("falló el rol");
    expect(estado.usuario).toBeNull();
    expect(estado.perfil).toBeNull();
    expect(estado.sucursalesAsignadas).toEqual([]);
  });

  it("no avanza con borrados si una caja vinculada no supera la auditoría", async () => {
    const { repo, estado, llamadas } = repositorioEnMemoria({
      usuario: null,
      perfil: null,
      roles: [],
      sucursales: SUCURSALES,
      sucursalesAsignadas: [],
    });
    repo.limpiarReferenciasUsuarioCreado = vi.fn(async () => {
      throw new Error("la caja conserva ventas=1");
    });

    const limpiar = await prepararEmpleadoLocalE2E(repo);

    await expect(limpiar()).rejects.toThrow(/ventas=1/i);
    expect(estado.usuario).toEqual({ id: "usuario-e2e" });
    expect(estado.perfil).toEqual({ activo: true, sucursalId: "sucursal-ohiggins" });
    expect(estado.roles).toEqual(["empleado"]);
    expect(estado.sucursalesAsignadas).toEqual(["sucursal-ohiggins", "sucursal-general-paz"]);
    expect(llamadas).not.toContain("eliminar-usuario:usuario-e2e");
  });

  it("permite reintentar un cleanup fallido y deja cero residuos una sola vez completado", async () => {
    const { repo, estado, llamadas } = repositorioEnMemoria({
      usuario: null,
      perfil: null,
      roles: [],
      sucursales: SUCURSALES,
      sucursalesAsignadas: [],
    });
    let intentosReferencias = 0;
    repo.limpiarReferenciasUsuarioCreado = vi.fn(async () => {
      intentosReferencias += 1;
      if (intentosReferencias === 1) throw new Error("fallo transitorio al borrar caja");
    });

    const limpiar = await prepararEmpleadoLocalE2E(repo);
    await expect(limpiar()).rejects.toThrow(/fallo transitorio/i);
    await expect(limpiar()).resolves.toBeUndefined();
    await expect(limpiar()).resolves.toBeUndefined();

    expect(intentosReferencias).toBe(2);
    expect(estado.usuario).toBeNull();
    expect(estado.perfil).toBeNull();
    expect(estado.roles).toEqual([]);
    expect(estado.sucursalesAsignadas).toEqual([]);
    expect(llamadas.filter((llamada) => llamada === "eliminar-usuario:usuario-e2e")).toHaveLength(
      1,
    );
  });
});

describe("cleanup HTTP de cajas del bootstrap local", () => {
  const entorno = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-local",
  };

  it("rechaza una caja ajena que el usuario creado sólo cerró y no la borra", async () => {
    const { fetchImpl, sesiones, deletes } = crearFetchCajas({
      sesiones: [{ id: "caja-ajena", abierta_por: "usuario-real", cerrada_por: "usuario-e2e" }],
    });
    const repo = crearRepositorioEmpleadoLocalHttp(entorno, fetchImpl);

    await expect(repo.limpiarReferenciasUsuarioCreado("usuario-e2e")).rejects.toThrow(
      /caja ajena/i,
    );
    expect(sesiones).toHaveLength(1);
    expect(deletes).toEqual([]);
  });

  it("rechaza antes del DELETE una caja propia con referencias FK", async () => {
    const { fetchImpl, sesiones, deletes } = crearFetchCajas({
      sesiones: [{ id: "caja-con-venta", abierta_por: "usuario-e2e", cerrada_por: null }],
      referencias: { "caja-con-venta": { ventas: 1 } },
    });
    const repo = crearRepositorioEmpleadoLocalHttp(entorno, fetchImpl);

    await expect(repo.limpiarReferenciasUsuarioCreado("usuario-e2e")).rejects.toThrow(/ventas=1/i);
    expect(sesiones).toHaveLength(1);
    expect(deletes).toEqual([]);
  });

  it("borra sólo cajas propias sin referencias y verifica el estado final", async () => {
    const { fetchImpl, sesiones, deletes } = crearFetchCajas({
      sesiones: [{ id: "caja-propia", abierta_por: "usuario-e2e", cerrada_por: null }],
    });
    const repo = crearRepositorioEmpleadoLocalHttp(entorno, fetchImpl);

    await expect(repo.limpiarReferenciasUsuarioCreado("usuario-e2e")).resolves.toBeUndefined();
    expect(sesiones).toEqual([]);
    expect(deletes).toHaveLength(1);
  });

  it("considera idempotente borrar un usuario Auth que ya no existe", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      respuestaJson({ message: "User not found" }, 404),
    );
    const repo = crearRepositorioEmpleadoLocalHttp(entorno, fetchImpl);

    await expect(repo.eliminarUsuario("usuario-e2e")).resolves.toBeUndefined();
  });
});
