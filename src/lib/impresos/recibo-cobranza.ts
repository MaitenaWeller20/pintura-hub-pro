import jsPDF from "jspdf";
import { fmtMoney, formaPagoLabel } from "@/lib/format";
import { MAXIMO_EN_LETRAS, montoEnLetras } from "@/lib/letras";
import { dibujarEncabezado } from "./encabezado";

export type ReciboCobranza = {
  numero: string;
  emitido_at: string;
  anulado: boolean;
  datos: {
    cobranza_id: string;
    fecha_cobro: string;
    monto: number;
    forma_pago: string;
    detalle: Record<string, unknown> | null;
    observaciones: string | null;
    cliente: { razon_social: string; cuit_dni: string | null; direccion: string | null };
    sucursal: { nombre: string; numero: string; direccion: string | null; telefono: string | null };
    emisor: {
      razon_social: string;
      cuit: string;
      domicilio_fiscal: string | null;
      condicion_iva: string | null;
      ingresos_brutos: string | null;
      inicio_actividades: string | null;
      logo: string | null;
    };
  };
};

const fechaHora = (fecha: string) =>
  new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(fecha));

const texto = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function generarReciboCobranzaPdf(recibo: ReciboCobranza) {
  const datos = recibo?.datos;
  const monto = Number(datos?.monto);
  if (
    !recibo?.numero ||
    !datos?.cobranza_id ||
    !datos.cliente?.razon_social ||
    !datos.emisor?.razon_social ||
    !datos.emisor?.cuit ||
    !Number.isFinite(monto) ||
    monto <= 0 ||
    monto > MAXIMO_EN_LETRAS
  ) {
    throw new Error("El recibo tiene datos incompletos. No se puede imprimir.");
  }

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let yEmisor = dibujarEncabezado(
    doc,
    {
      ...datos.sucursal,
      emisor: datos.emisor,
    },
    { x: 14, y: 19, ancho: 80 },
  );
  doc.setFontSize(8);
  const condicionIva =
    datos.emisor.condicion_iva === "RESPONSABLE_INSCRIPTO"
      ? "IVA Responsable Inscripto"
      : datos.emisor.condicion_iva === "MONOTRIBUTO"
        ? "Responsable Monotributo"
        : datos.emisor.condicion_iva?.replaceAll("_", " ");
  const datosEmisor = [
    condicionIva ? `Condición IVA: ${condicionIva}` : null,
    datos.emisor.ingresos_brutos ? `Ingresos Brutos: ${datos.emisor.ingresos_brutos}` : null,
    datos.emisor.inicio_actividades
      ? `Inicio de actividades: ${datos.emisor.inicio_actividades.split("-").reverse().join("/")}`
      : null,
  ];
  for (const linea of datosEmisor) {
    if (!linea) continue;
    doc.text(linea, 14, yEmisor);
    yEmisor += 4;
  }

  doc.setDrawColor(120);
  doc.rect(99, 14, 12, 14);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("X", 105, 24, { align: "center" });
  doc.rect(130, 14, 66, 35);
  doc.setFontSize(18);
  doc.text("RECIBO X", 163, 23, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`N° ${recibo.numero}`, 134, 32);
  doc.text(`Emitido: ${fechaHora(recibo.emitido_at)}`, 134, 39);
  doc.text(`Sucursal: ${datos.sucursal.nombre}`, 134, 45);

  const yLeyenda = Math.max(59, yEmisor + 5);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("DOCUMENTO NO VÁLIDO COMO FACTURA", 105, yLeyenda, { align: "center" });
  doc.setLineWidth(0.3);
  doc.line(14, yLeyenda + 4, 196, yLeyenda + 4);

  let y = yLeyenda + 13;
  doc.setFontSize(11);
  const cliente = doc.splitTextToSize(
    `Recibimos de: ${datos.cliente.razon_social}`,
    175,
  ) as string[];
  for (const linea of cliente) {
    doc.text(linea, 17, y);
    y += 6;
  }
  y += 2;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`CUIT/DNI: ${datos.cliente.cuit_dni || "—"}`, 17, y);
  y += 6;
  if (datos.cliente.direccion) {
    for (const linea of doc.splitTextToSize(
      `Domicilio: ${datos.cliente.direccion}`,
      175,
    ) as string[]) {
      doc.text(linea, 17, y);
      y += 5;
    }
    y += 2;
  }
  doc.text(`Fecha del cobro: ${fechaHora(datos.fecha_cobro)}`, 17, y);
  y += 12;

  doc.setDrawColor(170);
  doc.roundedRect(14, y - 6, 182, 29, 2, 2);
  doc.setFontSize(10);
  doc.text("En concepto de pago a cuenta corriente", 19, y + 1);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.text(fmtMoney(monto), 191, y + 2, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const letras = doc.splitTextToSize(`Son: ${montoEnLetras(monto)}.`, 170);
  doc.text(letras, 19, y + 11);
  y += 36;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Forma de cobro", 17, y);
  doc.text("Importe", 191, y, { align: "right" });
  doc.line(14, y + 3, 196, y + 3);
  y += 10;
  doc.setFont("helvetica", "normal");
  doc.text(formaPagoLabel[datos.forma_pago] ?? datos.forma_pago, 17, y);
  doc.text(fmtMoney(monto), 191, y, { align: "right" });
  y += 9;
  const detalle = datos.detalle ?? {};
  const referencia = [texto(detalle.banco), texto(detalle.numero)].filter(Boolean).join(" · ");
  for (const contenido of [
    referencia ? `Referencia: ${referencia}` : "",
    datos.observaciones ? `Observaciones: ${datos.observaciones}` : "",
  ]) {
    if (!contenido) continue;
    for (const linea of doc.splitTextToSize(contenido, 175) as string[]) {
      if (y > 255) {
        doc.addPage();
        y = 20;
      }
      doc.text(linea, 17, y);
      y += 5;
    }
    y += 4;
  }

  doc.setFontSize(8);
  doc.text(`Cobro registrado: ${datos.cobranza_id}`, 14, 271);
  doc.text("Este recibo acredita el cobro indicado y no reemplaza la factura.", 14, 278);
  if (recibo.anulado) {
    doc.setTextColor(185, 35, 35);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(34);
    doc.text("ANULADO", 105, 235, { align: "center" });
  }

  return { doc, nombre: `recibo-x-${recibo.numero}.pdf` };
}
