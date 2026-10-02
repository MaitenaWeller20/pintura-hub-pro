type ComprobanteFiscal = {
  tipo_comprobante: string;
  afip_cbte_asoc_id?: string | null;
  cae: string | null;
  afip_estado: string;
  afip_simulado: boolean;
  afip_modo?: string | null;
};

export type EstadoFacturacion = "FACTURADO" | "SIN_CAE" | "SIN_FACTURAR";

const TIPOS_FISCALES = new Set([
  "FACTURA_A",
  "FACTURA_B",
  "FACTURA_C",
  "NOTA_CREDITO",
  "NOTA_DEBITO",
]);

export function clasificarFacturacion(venta: ComprobanteFiscal): EstadoFacturacion {
  if (!TIPOS_FISCALES.has(venta.tipo_comprobante)) return "SIN_FACTURAR";
  if (
    (venta.tipo_comprobante === "NOTA_CREDITO" || venta.tipo_comprobante === "NOTA_DEBITO") &&
    !venta.afip_cbte_asoc_id
  ) {
    return "SIN_FACTURAR";
  }
  if (
    venta.afip_estado === "APROBADO" &&
    venta.cae?.trim() &&
    !venta.afip_simulado &&
    venta.afip_modo?.toUpperCase() !== "HOMOLOGACION"
  ) {
    return "FACTURADO";
  }
  return "SIN_CAE";
}

export function resumirVentas(
  ventas: (ComprobanteFiscal & { estado?: string; total: number; iva_total: number })[],
) {
  const ventasSinNC = ventas.filter(
    (venta) => venta.estado !== "ANULADA" && venta.tipo_comprobante !== "NOTA_CREDITO",
  );
  const vendido =
    ventasSinNC.reduce((total, venta) => total + Math.round(Number(venta.total) * 100), 0) / 100;
  const ivaConCae =
    ventas.reduce(
      (total, venta) =>
        total +
        (clasificarFacturacion(venta) === "FACTURADO"
          ? Math.round(Number(venta.iva_total) * 100)
          : 0),
      0,
    ) / 100;
  const notasCredito =
    ventas.reduce(
      (total, venta) =>
        total +
        (venta.estado !== "ANULADA" && venta.tipo_comprobante === "NOTA_CREDITO"
          ? Math.abs(Math.round(Number(venta.total) * 100))
          : 0),
      0,
    ) / 100;
  return {
    vendido,
    ivaConCae,
    notasCredito,
    cantidad: ventasSinNC.length,
    ticket: ventasSinNC.length ? vendido / ventasSinNC.length : 0,
  };
}

type Pago = { monto: number; forma_pago: string };
type PagoVenta = Pago & { venta: ComprobanteFiscal };

export function resumirCobros(pagos: PagoVenta[], cobranzas: Pago[]) {
  const centavos = {
    facturado: 0,
    sinCae: 0,
    sinFacturar: 0,
    cuentaCorriente: 0,
  };
  const porPagoCentavos: Record<string, number> = {};

  for (const pago of pagos) {
    const monto = Math.round(Number(pago.monto) * 100);
    const estado = clasificarFacturacion(pago.venta);
    if (estado === "FACTURADO") centavos.facturado += monto;
    else if (estado === "SIN_CAE") centavos.sinCae += monto;
    else centavos.sinFacturar += monto;
    porPagoCentavos[pago.forma_pago] = (porPagoCentavos[pago.forma_pago] ?? 0) + monto;
  }

  for (const cobranza of cobranzas) {
    const monto = Math.round(Number(cobranza.monto) * 100);
    centavos.cuentaCorriente += monto;
    porPagoCentavos[cobranza.forma_pago] = (porPagoCentavos[cobranza.forma_pago] ?? 0) + monto;
  }

  return {
    facturado: centavos.facturado / 100,
    sinCae: centavos.sinCae / 100,
    sinFacturar: centavos.sinFacturar / 100,
    cuentaCorriente: centavos.cuentaCorriente / 100,
    total: Object.values(centavos).reduce((a, n) => a + n, 0) / 100,
    porPago: Object.fromEntries(
      Object.entries(porPagoCentavos).map(([medio, monto]) => [medio, monto / 100]),
    ),
  };
}
