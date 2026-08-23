import { describe, expect, it, vi } from "vitest";

import {
  EMAIL_EMPLEADO_E2E,
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
    async agregarRol(usuarioId) {
      llamadas.push(`agregar-rol:${usuarioId}`);
      estado.roles.push("empleado");
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
    async quitarRol(usuarioId) {
      llamadas.push(`quitar-rol:${usuarioId}`);
      estado.roles = estado.roles.filter((rol) => rol !== "empleado");
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

describe("bootstrap del empleado local E2E", () => {
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
    expect(estado.sucursalesAsignadas).toEqual([
      "sucursal-ohiggins",
      "sucursal-general-paz",
    ]);

    await limpiar();
    await limpiar();

    expect(estado.usuario).toBeNull();
    expect(estado.perfil).toBeNull();
    expect(estado.roles).toEqual([]);
    expect(estado.sucursalesAsignadas).toEqual([]);
    expect(llamadas.filter((llamada) => llamada === "eliminar-usuario:usuario-e2e")).toHaveLength(1);
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
    expect(estado.sucursalesAsignadas).toEqual([
      "sucursal-ohiggins",
      "sucursal-general-paz",
    ]);

    await limpiar();

    expect(estado.usuario).toEqual({ id: "usuario-existente" });
    expect(estado.perfil).toEqual({ activo: true, sucursalId: "sucursal-ohiggins" });
    expect(estado.roles).toEqual(["empleado"]);
    expect(estado.sucursalesAsignadas).toEqual(["sucursal-ohiggins"]);
    expect(llamadas).not.toContain("eliminar-usuario:usuario-existente");
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
});
