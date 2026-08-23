type DependenciasDescarga<TVenta, TItem, TFiscal, TResultado> = {
  cargarFiscal(): Promise<TFiscal>;
  generar(venta: TVenta, items: TItem[], fiscal: TFiscal | null): TResultado | Promise<TResultado>;
};

/**
 * Decide entre una impresión fiscal y una impresión interna explícita.
 *
 * No captura la lectura fiscal: si faltan el snapshot o el QR, `generar` jamás se
 * ejecuta. Así un error legal no puede degradarse silenciosamente a un papel que
 * se parezca a una factura pero diga "documento interno".
 */
export async function prepararDescargaVenta<TVenta, TItem, TFiscal, TResultado>(
  input: { venta: TVenta; items: TItem[]; requiereDatosFiscales: boolean },
  dependencias: DependenciasDescarga<TVenta, TItem, TFiscal, TResultado>,
): Promise<TResultado> {
  const fiscal = input.requiereDatosFiscales ? await dependencias.cargarFiscal() : null;
  return dependencias.generar(input.venta, input.items, fiscal);
}
