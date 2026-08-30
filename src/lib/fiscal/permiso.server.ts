import { diasDesdeHoyAr } from "./fecha";
import { puedeVer } from "../secciones";

export type AccionFiscalAutorizada = "PREVISUALIZAR" | "EMITIR" | "CONCILIAR" | "LIBERAR";

export type EntradaPermisoFiscal = {
  venta: { id: string; sucursalId: string; diasAntiguedad: number };
  perfil: { activo: boolean; puedeFacturar: boolean; sucursalId: string | null } | null;
  esAdmin: boolean;
  accion: AccionFiscalAutorizada;
  confirmaVentaAntigua: boolean;
};

export type PermisoFiscal = { ventaId: string; sucursalId: string; esAdmin: boolean };

export type ContextoColaFiscal = {
  userId: string;
  esAdmin: boolean;
  sucursalId: string | null;
};

export type LecturasContextoColaFiscal = {
  consultarEsAdmin(userId: string): Promise<boolean>;
  cargarPerfil(
    userId: string,
  ): Promise<{ activo: boolean; puedeFacturar: boolean; sucursalId: string | null } | null>;
  cargarSucursal(
    sucursalId: string,
    userId: string,
  ): Promise<{ activa: boolean; asignada: boolean } | null>;
};

export type LecturasAdministradorFiscal = {
  consultarEsAdmin(userId: string): Promise<boolean>;
  cargarPerfil(userId: string): Promise<{ activo: boolean } | null>;
};

export type LecturasLecturaVenta = {
  cargarVentaVisible(ventaId: string): Promise<{ id: string; sucursalId: string } | null>;
  consultarEsAdmin(userId: string): Promise<boolean>;
  cargarPerfil(userId: string): Promise<{
    activo: boolean;
    sucursalId: string | null;
    secciones: string[] | null;
  } | null>;
};

function exigirPerfilActivo(
  perfil: { activo: boolean } | null,
): asserts perfil is { activo: boolean } {
  if (!perfil) throw new Error("No existe un perfil fiscal para el operador.");
  if (!perfil.activo) throw new Error("El perfil está inactivo y no puede operar fiscalmente.");
}

/** Autoriza configuración privilegiada sin abrir antes un cliente service-role. */
export async function autorizarAdministradorFiscal(input: {
  userId: string;
  lecturas: LecturasAdministradorFiscal;
}): Promise<{ userId: string; esAdmin: true }> {
  const [esAdmin, perfil] = await Promise.all([
    input.lecturas.consultarEsAdmin(input.userId),
    input.lecturas.cargarPerfil(input.userId),
  ]);
  exigirPerfilActivo(perfil);
  if (!esAdmin) throw new Error("Sólo un administrador puede operar la configuración fiscal.");
  return { userId: input.userId, esAdmin: true };
}

/**
 * Autoriza el detalle comercial con la misma fila que RLS deja ver al usuario.
 * No exige capacidad fiscal: abrir Ventas y emitir/previsualizar son permisos
 * independientes.
 */
export async function autorizarLecturaVenta(input: {
  userId: string;
  ventaId: string;
  lecturas: LecturasLecturaVenta;
}): Promise<PermisoFiscal> {
  const venta = await input.lecturas.cargarVentaVisible(input.ventaId);
  if (!venta) throw new Error("Venta no encontrada o no visible para el operador.");

  const [esAdmin, perfil] = await Promise.all([
    input.lecturas.consultarEsAdmin(input.userId),
    input.lecturas.cargarPerfil(input.userId),
  ]);
  exigirPerfilActivo(perfil);
  if (esAdmin) return { ventaId: venta.id, sucursalId: venta.sucursalId, esAdmin: true };

  if (!perfil.sucursalId || perfil.sucursalId !== venta.sucursalId) {
    throw new Error("La venta no pertenece a la sucursal activa del operador.");
  }
  if (!puedeVer("ventas", { isAdmin: false, secciones: perfil.secciones })) {
    throw new Error("El perfil no tiene habilitada la sección Ventas.");
  }
  return { ventaId: venta.id, sucursalId: venta.sucursalId, esAdmin: false };
}

/** Autoriza lecturas operativas sin abrir un cliente privilegiado. */
export async function autorizarContextoColaFiscal(input: {
  userId: string;
  lecturas: LecturasContextoColaFiscal;
}): Promise<ContextoColaFiscal> {
  const [esAdmin, perfil] = await Promise.all([
    input.lecturas.consultarEsAdmin(input.userId),
    input.lecturas.cargarPerfil(input.userId),
  ]);
  exigirPerfilActivo(perfil);
  if (esAdmin) return { userId: input.userId, esAdmin: true, sucursalId: null };

  if (!perfil.puedeFacturar) {
    throw new Error("El perfil no tiene la capacidad fiscal puede_facturar.");
  }
  if (!perfil.sucursalId) throw new Error("El operador no tiene una sucursal activa.");

  const sucursal = await input.lecturas.cargarSucursal(perfil.sucursalId, input.userId);
  if (!sucursal?.activa) throw new Error("La sucursal activa del operador está inactiva.");
  if (!sucursal.asignada) throw new Error("La sucursal activa no está asignada al operador.");

  return {
    userId: input.userId,
    esAdmin: false,
    sucursalId: perfil.sucursalId,
  };
}

/** Regla pura usada antes de abrir service-role, claims o adaptadores ARCA. */
export function evaluarPermisoFiscal(input: EntradaPermisoFiscal): PermisoFiscal {
  exigirPerfilActivo(input.perfil);
  if (input.accion === "CONCILIAR" || input.accion === "LIBERAR") {
    if (!input.esAdmin) throw new Error("Esta operación fiscal exige un administrador.");
  }
  if (input.accion === "EMITIR" && input.venta.diasAntiguedad > 5) {
    if (!input.confirmaVentaAntigua) {
      throw new Error("La venta de más de cinco días se debe confirmar expresamente.");
    }
    if (!input.esAdmin) {
      throw new Error("Confirmar una venta de más de cinco días exige un administrador.");
    }
  }

  if (!input.esAdmin) {
    if (!input.perfil!.puedeFacturar)
      throw new Error("El perfil no tiene la capacidad fiscal puede_facturar.");
    if (!input.perfil!.sucursalId || input.perfil!.sucursalId !== input.venta.sucursalId) {
      throw new Error("La venta no pertenece a la sucursal activa del operador.");
    }
  }

  return { ventaId: input.venta.id, sucursalId: input.venta.sucursalId, esAdmin: input.esAdmin };
}

export type LecturasPermisoFiscal = {
  cargarVenta(ventaId: string): Promise<{ id: string; sucursalId: string; fecha: string } | null>;
  consultarEsAdmin(userId: string): Promise<boolean>;
  cargarPerfil(
    userId: string,
  ): Promise<{ activo: boolean; puedeFacturar: boolean; sucursalId: string | null } | null>;
  ahora(): Date;
};

function diasComercialesTranscurridos(fechaIso: string, ahora: Date): number {
  const fecha = new Date(fechaIso);
  if (!Number.isFinite(fecha.getTime()))
    throw new Error("La fecha comercial de la venta es inválida.");
  return Math.max(0, diasDesdeHoyAr(fecha, ahora));
}

export async function autorizarOperacionFiscal(input: {
  ventaId: string;
  userId: string;
  accion: AccionFiscalAutorizada;
  confirmaVentaAntigua: boolean;
  lecturas: LecturasPermisoFiscal;
}): Promise<PermisoFiscal> {
  const venta = await input.lecturas.cargarVenta(input.ventaId);
  if (!venta) throw new Error("Venta no encontrada o no visible para el operador.");
  const [esAdmin, perfil] = await Promise.all([
    input.lecturas.consultarEsAdmin(input.userId),
    input.lecturas.cargarPerfil(input.userId),
  ]);
  return evaluarPermisoFiscal({
    venta: {
      id: venta.id,
      sucursalId: venta.sucursalId,
      diasAntiguedad: diasComercialesTranscurridos(venta.fecha, input.lecturas.ahora()),
    },
    perfil,
    esAdmin,
    accion: input.accion,
    confirmaVentaAntigua: input.confirmaVentaAntigua,
  });
}
