import { diasDesdeHoyAr } from "./fecha";

export type AccionFiscalAutorizada = "PREVISUALIZAR" | "EMITIR" | "CONCILIAR" | "LIBERAR";

export type EntradaPermisoFiscal = {
  venta: { id: string; sucursalId: string; diasAntiguedad: number };
  perfil: { activo: boolean; puedeFacturar: boolean; sucursalId: string | null } | null;
  esAdmin: boolean;
  accion: AccionFiscalAutorizada;
  confirmaVentaAntigua: boolean;
};

export type PermisoFiscal = { ventaId: string; sucursalId: string; esAdmin: boolean };

/** Regla pura usada antes de abrir service-role, claims o adaptadores ARCA. */
export function evaluarPermisoFiscal(input: EntradaPermisoFiscal): PermisoFiscal {
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
    if (!input.perfil?.activo) throw new Error("El perfil está inactivo y no puede facturar.");
    if (!input.perfil.puedeFacturar)
      throw new Error("El perfil no tiene la capacidad fiscal puede_facturar.");
    if (!input.perfil.sucursalId || input.perfil.sucursalId !== input.venta.sucursalId) {
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
