export interface VentaParaAnular {
  id: string;
  tipo_comprobante: string;
  cae: string | null;
  afip_simulado?: boolean;
}

export function sePuedeAnularVenta(
  venta: VentaParaAnular,
  generadasPorAnulacion: ReadonlySet<string>,
): boolean {
  if (
    [
      "FACTURA_A",
      "FACTURA_B",
      "FACTURA_C",
      "REMITO",
      "REMITO_OBRA",
      "FAC_INTERNA_CTA_CTE",
    ].includes(venta.tipo_comprobante)
  ) {
    return true;
  }

  return (
    venta.tipo_comprobante === "NOTA_CREDITO" &&
    (!venta.cae || venta.afip_simulado === true) &&
    !generadasPorAnulacion.has(venta.id)
  );
}
