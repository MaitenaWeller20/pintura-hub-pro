// Helpers de formateo: moneda AR, fechas y números.
export const ARS = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const NUM = new Intl.NumberFormat("es-AR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const fmtMoney = (n: number | string | null | undefined) => {
  const v = typeof n === "string" ? parseFloat(n) : (n ?? 0);
  return ARS.format(isNaN(v) ? 0 : v);
};

export const fmtNum = (n: number | string | null | undefined) => {
  const v = typeof n === "string" ? parseFloat(n) : (n ?? 0);
  return NUM.format(isNaN(v) ? 0 : v);
};

const AR_TZ = "America/Argentina/Buenos_Aires";

export const fmtDate = (d: string | Date | null | undefined) => {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("es-AR", { timeZone: AR_TZ, day: "2-digit", month: "2-digit", year: "numeric" });
};

export const fmtDateTime = (d: string | Date | null | undefined) => {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleString("es-AR", {
    timeZone: AR_TZ,
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
};

export const formaPagoLabel: Record<string, string> = {
  EFECTIVO: "Efectivo",
  TRANSFERENCIA: "Transferencia",
  TARJETA_DEBITO: "Tarjeta Débito",
  TARJETA_CREDITO: "Tarjeta Crédito",
  MERCADO_PAGO: "Mercado Pago",
  CHEQUE: "Cheque",
  CTA_CTE: "Cuenta Corriente",
};

export const tipoComprobanteLabel: Record<string, string> = {
  FACTURA_A: "Factura A",
  FACTURA_B: "Factura B",
  NOTA_CREDITO: "Nota de Crédito",
  NOTA_DEBITO: "Nota de Débito",
  FACTURA_C: "Factura C",
  REMITO: "Remito interno",
  REMITO_OBRA: "Remito de Obra",
  FAC_INTERNA_CTA_CTE: "Factura interna",
};

export const tipoClienteLabel: Record<string, string> = {
  CONSUMIDOR_FINAL: "Consumidor Final",
  RESPONSABLE_INSCRIPTO: "Responsable Inscripto",
  MONOTRIBUTISTA: "Monotributista",
  EXENTO: "Exento",
};
