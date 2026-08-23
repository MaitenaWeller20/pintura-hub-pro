export type SesionCajaFixture = {
  id: string;
  abierta_por: string;
  cerrada_por: string | null;
};

export type ReferenciasCajaFixture = {
  ventas: number;
  venta_pagos: number;
  caja_movimientos: number;
  cobranzas_cta_cte: number;
  compras: number;
  proveedor_pagos: number;
};

export function exigirSesionesCajaPropiasSinReferencias(
  sesiones: SesionCajaFixture[],
  usuariosCreados: ReadonlySet<string>,
  referenciasPorSesion: Record<string, ReferenciasCajaFixture>,
): string[] {
  for (const sesion of sesiones) {
    if (!usuariosCreados.has(sesion.abierta_por)) {
      throw new Error(
        `El usuario E2E cerró la caja ajena ${sesion.id}; el fixture se niega a eliminarla.`,
      );
    }
    const referencias = referenciasPorSesion[sesion.id];
    if (!referencias) {
      throw new Error(`No se auditaron las referencias de la caja E2E ${sesion.id}.`);
    }
    const pendientes = Object.entries(referencias).filter(([, total]) => total !== 0);
    if (pendientes.length > 0) {
      throw new Error(
        `La caja E2E ${sesion.id} conserva referencias: ${pendientes
          .map(([tabla, total]) => `${tabla}=${total}`)
          .join(", ")}.`,
      );
    }
  }
  return sesiones.map(({ id }) => id);
}
