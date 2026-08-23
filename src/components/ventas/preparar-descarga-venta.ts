type DependenciasDescarga<TVenta, TItem, TFiscal, TResultado> = {
  cargarFiscal(): Promise<TFiscal>;
  generar(venta: TVenta, items: TItem[], fiscal: TFiscal | null): TResultado | Promise<TResultado>;
};

type VentaConEvidenciaFiscal = {
  cae?: unknown;
  afip_estado?: unknown;
  afip_fase?: unknown;
  afip_snapshot?: unknown;
  afip_snapshot_hash?: unknown;
  afip_emisor_cuit?: unknown;
  afip_punto_venta?: unknown;
  afip_cbte_tipo?: unknown;
  afip_numero?: unknown;
  afip_modo?: unknown;
  afip_validez?: unknown;
  afip_fecha_comprobante?: unknown;
  afip_imp_total?: unknown;
};

/** Toda evidencia fiscal obliga a validar el comprobante legal; no se infiere por tipo comercial. */
export function requiereDatosFiscalesVenta(venta: VentaConEvidenciaFiscal): boolean {
  return (
    venta.afip_estado === "APROBADO" ||
    [
      venta.cae,
      venta.afip_fase,
      venta.afip_snapshot,
      venta.afip_snapshot_hash,
      venta.afip_emisor_cuit,
      venta.afip_punto_venta,
      venta.afip_cbte_tipo,
      venta.afip_numero,
      venta.afip_modo,
      venta.afip_validez,
      venta.afip_fecha_comprobante,
      venta.afip_imp_total,
    ].some((value) => value !== null && value !== undefined)
  );
}

/**
 * Decide entre una impresión fiscal y una impresión interna explícita.
 *
 * No captura la lectura fiscal: si faltan el snapshot o el QR, `generar` jamás se
 * ejecuta. Así un error legal no puede degradarse silenciosamente a un papel que
 * se parezca a una factura pero diga "documento interno".
 */
export async function prepararDescargaVenta<
  TVenta extends VentaConEvidenciaFiscal,
  TItem,
  TFiscal,
  TResultado,
>(
  input: { venta: TVenta; items: TItem[]; requiereDatosFiscales?: boolean },
  dependencias: DependenciasDescarga<TVenta, TItem, TFiscal, TResultado>,
): Promise<TResultado> {
  const fiscal = requiereDatosFiscalesVenta(input.venta) ? await dependencias.cargarFiscal() : null;
  return dependencias.generar(input.venta, input.items, fiscal);
}
