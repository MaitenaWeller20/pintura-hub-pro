import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { fmtDateTime, fmtMoney, formaPagoLabel, tipoComprobanteLabel } from "@/lib/format";

type CajaForma = {
  entra?: number;
  sale?: number;
  neto?: number;
};

type CierreCajaSesion = {
  abierta_en: string;
  cerrada_en: string | null;
  fondo_inicial: number;
  esperado?: Record<string, CajaForma> | null;
  contado?: Record<string, number> | null;
  diferencia?: Record<string, number> | null;
  total_esperado: number;
  total_contado: number;
  total_diferencia: number;
  efectivo_dejado?: number | null;
  notas?: string | null;
};

type VentaCierre = {
  numero_comprobante: string;
  tipo_comprobante: string;
  total: number;
  condicion_venta: string;
  cliente?: { razon_social: string } | null;
  pagos?: Array<{ forma_pago: string; monto: number }> | null;
};

type CobranzaCierre = {
  fecha: string;
  monto: number;
  forma_pago: string;
  detalle?: unknown;
  observaciones?: string | null;
  cliente?: { razon_social: string } | null;
};

export type DatosCierreCajaPdf = {
  sesion: CierreCajaSesion;
  sucursalNombre: string;
  ventas: VentaCierre[];
  cobranzas: CobranzaCierre[];
};

const redondearCentavos = (valor: number) =>
  Math.round((Number(valor) + Number.EPSILON) * 100) / 100;

export function calcularEfectivoCierre(esperado: number, contado: number, dejado: number) {
  const diferencia = redondearCentavos(contado - esperado);
  const retirado = redondearCentavos(contado - dejado);

  return {
    diferencia,
    retirado,
    dejadoValido: contado >= 0 && dejado >= 0 && retirado >= 0,
  };
}

function detalleCobranza(cobranza: CobranzaCierre) {
  const detalle =
    cobranza.detalle && typeof cobranza.detalle === "object" && !Array.isArray(cobranza.detalle)
      ? (cobranza.detalle as Record<string, unknown>)
      : {};
  const partes: string[] = [];

  if (detalle.banco) partes.push(`Banco: ${String(detalle.banco)}`);
  if (detalle.numero) partes.push(`N° ${String(detalle.numero)}`);
  if (detalle.firmante) partes.push(`Firmante: ${String(detalle.firmante)}`);
  if (detalle.fecha_cobro) partes.push(`Cobro: ${String(detalle.fecha_cobro)}`);
  if (cobranza.observaciones) partes.push(cobranza.observaciones);

  return partes.join(" - ") || "-";
}

function tituloSeccion(doc: jsPDF, titulo: string, yAnterior: number) {
  let y = yAnterior + 10;
  if (y > doc.internal.pageSize.getHeight() - 25) {
    doc.addPage();
    y = 16;
  }
  doc.setFontSize(10);
  doc.text(titulo, 14, y);
  return y + 3;
}

export function generarCierreCajaPdf({
  sesion,
  sucursalNombre,
  ventas,
  cobranzas,
}: DatosCierreCajaPdf) {
  const doc = new jsPDF();
  const ancho = doc.internal.pageSize.getWidth();

  doc.setFontSize(14);
  doc.text("CASAFORMA", 14, 16);
  doc.setFontSize(11);
  doc.text("Cierre de caja", ancho / 2, 16, { align: "center" });
  doc.setFontSize(9);
  doc.text(`Sucursal: ${sucursalNombre}`, 14, 24);
  doc.text(`Abierta: ${fmtDateTime(sesion.abierta_en)}`, 14, 29);
  doc.text(`Cerrada: ${fmtDateTime(sesion.cerrada_en)}`, 14, 34);
  doc.text(`Fondo inicial: ${fmtMoney(sesion.fondo_inicial)}`, 14, 39);

  const esperado = sesion.esperado ?? {};
  const contado = sesion.contado ?? {};
  const diferencia = sesion.diferencia ?? {};
  const formas = Array.from(new Set([...Object.keys(esperado), ...Object.keys(contado)]));

  autoTable(doc, {
    startY: 44,
    head: [["Forma", "Esperado", "Contado", "Diferencia"]],
    body: formas.map((forma) => [
      formaPagoLabel[forma] ?? forma,
      fmtMoney(Number(esperado[forma]?.neto ?? 0)),
      fmtMoney(Number(contado[forma] ?? 0)),
      fmtMoney(Number(diferencia[forma] ?? 0)),
    ]),
    foot: [
      [
        "TOTAL",
        fmtMoney(sesion.total_esperado),
        fmtMoney(sesion.total_contado),
        fmtMoney(sesion.total_diferencia),
      ],
    ],
    styles: { fontSize: 8 },
    margin: { left: 14, right: 14 },
  });

  let y = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  const efectivoContado = Number(contado.EFECTIVO ?? 0);
  const efectivoDejado = Number(sesion.efectivo_dejado ?? 0);
  const { retirado } = calcularEfectivoCierre(
    Number(esperado.EFECTIVO?.neto ?? 0),
    efectivoContado,
    efectivoDejado,
  );

  doc.setFontSize(10);
  doc.text(`Efectivo contado antes de retirar: ${fmtMoney(efectivoContado)}`, 14, y);
  doc.text(`Efectivo retirado al cierre: ${fmtMoney(retirado)}`, 14, y + 6);
  doc.text(`Efectivo dejado para mañana: ${fmtMoney(efectivoDejado)}`, 14, y + 12);
  y += 12;

  if (sesion.notas) {
    doc.setFontSize(9);
    doc.text(`Observaciones: ${sesion.notas}`, 14, y + 6);
    y += 6;
  }

  if (ventas.length) {
    const inicioTabla = tituloSeccion(doc, "Ventas del turno", y);
    autoTable(doc, {
      startY: inicioTabla,
      head: [["Comprobante", "Tipo", "Cliente", "Total", "Forma de pago"]],
      body: ventas.map((venta) => [
        venta.numero_comprobante,
        tipoComprobanteLabel[venta.tipo_comprobante] ?? venta.tipo_comprobante,
        venta.cliente?.razon_social ?? "-",
        fmtMoney(venta.total),
        venta.pagos?.length
          ? venta.pagos.map((pago) => formaPagoLabel[pago.forma_pago] ?? pago.forma_pago).join(", ")
          : venta.condicion_venta === "CTA_CTE"
            ? "Cuenta Corriente"
            : "-",
      ]),
      styles: { fontSize: 8 },
      margin: { left: 14, right: 14 },
    });
    y = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  }

  if (cobranzas.length) {
    const inicioTabla = tituloSeccion(doc, "Cobranzas de cuenta corriente", y);
    autoTable(doc, {
      startY: inicioTabla,
      head: [["Fecha", "Cliente", "Importe", "Forma", "Detalle"]],
      body: cobranzas.map((cobranza) => [
        fmtDateTime(cobranza.fecha),
        cobranza.cliente?.razon_social ?? "-",
        fmtMoney(cobranza.monto),
        formaPagoLabel[cobranza.forma_pago] ?? cobranza.forma_pago,
        detalleCobranza(cobranza),
      ]),
      columnStyles: {
        0: { cellWidth: 28 },
        2: { cellWidth: 27, halign: "right" },
        3: { cellWidth: 22 },
        4: { cellWidth: 44 },
      },
      styles: { fontSize: 7.5, overflow: "linebreak" },
      margin: { left: 14, right: 14 },
    });
  }

  const paginas = doc.getNumberOfPages();
  for (let pagina = 1; pagina <= paginas; pagina += 1) {
    doc.setPage(pagina);
    doc.setFontSize(7);
    doc.setTextColor(100);
    doc.text(`Página ${pagina} de ${paginas}`, ancho - 14, doc.internal.pageSize.getHeight() - 8, {
      align: "right",
    });
    doc.setTextColor(0);
  }

  return doc;
}
