import jsPDF, { GState } from "jspdf";
import { fmtMoney, formaPagoLabel } from "@/lib/format";
import { MAXIMO_EN_LETRAS, montoEnLetras } from "@/lib/letras";
import logoCasaForma from "@/assets/casaforma-recibo.jpg?inline";

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
    cliente: { razon_social: string; cuit_dni: string | null; direccion: string | null; tipo?: string | null };
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
  const logoCasaFormaAplicable = datos.sucursal.nombre.toLowerCase().includes("casaforma");
  let hayLogo = false;
  for (const logo of [datos.emisor.logo?.trim(), logoCasaFormaAplicable ? logoCasaForma : null]) {
    if (!logo) continue;
    try {
      const imagen = doc.getImageProperties(logo);
      const escala = Math.min(43 / imagen.width, 20 / imagen.height);
      const ancho = imagen.width * escala;
      const alto = imagen.height * escala;
      doc.addImage(logo, imagen.fileType, 54.5 - ancho / 2, 10 + (20 - alto) / 2, ancho, alto);
      hayLogo = true;
      break;
    } catch {
      // Un logo inválido no puede impedir que salga el recibo.
    }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  let yEmisor = hayLogo ? 35 : 22;
  for (const linea of doc.splitTextToSize(datos.emisor.razon_social, 88) as string[]) {
    doc.text(linea, 55, yEmisor, { align: "center" });
    yEmisor += 4;
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  for (const valor of [
    datos.sucursal.direccion || datos.emisor.domicilio_fiscal,
    datos.emisor.domicilio_fiscal && datos.emisor.domicilio_fiscal !== datos.sucursal.direccion
      ? `Domicilio fiscal: ${datos.emisor.domicilio_fiscal}`
      : null,
    datos.sucursal.telefono,
  ]) {
    if (!valor) continue;
    for (const linea of doc.splitTextToSize(valor, 88) as string[]) {
      doc.text(linea, 55, yEmisor, { align: "center" });
      yEmisor += 3.5;
    }
  }
  const condicionIva =
    datos.emisor.condicion_iva === "RESPONSABLE_INSCRIPTO"
      ? "IVA Responsable Inscripto"
      : datos.emisor.condicion_iva === "MONOTRIBUTO"
        ? "Responsable Monotributo"
        : datos.emisor.condicion_iva?.replaceAll("_", " ");
  if (condicionIva) {
    doc.text(condicionIva, 55, yEmisor + 1, { align: "center" });
    yEmisor += 5;
  }

  doc.setDrawColor(90);
  doc.line(105, 10, 105, Math.max(58, yEmisor + 2));
  doc.rect(106, 10, 11, 12);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("X", 111.5, 18, { align: "center" });
  doc.roundedRect(120, 10, 76, 12, 2, 2);
  doc.setFontSize(13);
  doc.text("Recibo Cltes.", 158, 18, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.text(`Nro: ${recibo.numero}`, 121, 29);
  doc.text(`Fecha: ${fechaHora(recibo.emitido_at)}`, 121, 35);
  doc.text(`Lugar: ${datos.sucursal.nombre}`, 121, 41);
  doc.text(`CUIT: ${datos.emisor.cuit}`, 121, 47);
  if (datos.emisor.ingresos_brutos) doc.text(`Ing. Brutos: ${datos.emisor.ingresos_brutos}`, 121, 52);
  if (datos.emisor.inicio_actividades) {
    doc.text(`Inicio de activ.: ${datos.emisor.inicio_actividades.split("-").reverse().join("/")}`, 121, 57);
  }

  const yLeyenda = Math.max(61, yEmisor + 5, datos.emisor.inicio_actividades ? 62 : 57);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("DOCUMENTO NO VÁLIDO COMO FACTURA", 105, yLeyenda, { align: "center" });

  let y = yLeyenda + 8;
  doc.setFontSize(10);
  const cliente = doc.splitTextToSize(`Recibí de: ${datos.cliente.razon_social}`, 170) as string[];
  doc.setFontSize(8.5);
  const domicilio = doc.splitTextToSize(`Domicilio: ${datos.cliente.direccion || "No informado"}`, 170) as string[];
  const altoCliente = Math.max(28, 17 + (cliente.length + domicilio.length) * 4.5);
  doc.roundedRect(14, y, 182, altoCliente, 2, 2);
  let yCliente = y + 6;
  doc.setFontSize(10);
  for (const linea of cliente) {
    doc.text(linea, 18, yCliente);
    yCliente += 4.5;
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  for (const linea of domicilio) {
    doc.text(linea, 18, yCliente);
    yCliente += 4.5;
  }
  doc.text(`CUIT/DNI: ${datos.cliente.cuit_dni || "No informado"}`, 18, yCliente + 1);
  doc.text(`Fecha del cobro: ${fechaHora(datos.fecha_cobro)}`, 111, yCliente + 1);
  if (datos.cliente.tipo) {
    const condicionCliente = datos.cliente.tipo === "CONSUMIDOR_FINAL"
      ? "IVA Consumidor Final"
      : datos.cliente.tipo === "RESPONSABLE_INSCRIPTO"
        ? "IVA Responsable Inscripto"
        : datos.cliente.tipo === "MONOTRIBUTO"
          ? "Responsable Monotributo"
        : datos.cliente.tipo.replaceAll("_", " ");
    doc.text(`Cond. IVA: ${condicionCliente}`, 18, yCliente + 6);
  }
  y += altoCliente + 5;

  doc.setFillColor(225, 225, 225);
  doc.rect(14, y, 182, 8, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.text("Detalle de la cobranza", 18, y + 5.5);
  doc.text("Importe", 191, y + 5.5, { align: "right" });
  y += 8;
  doc.rect(14, y, 182, 12);
  doc.setFont("helvetica", "normal");
  doc.text("Pago a cuenta corriente (sin imputación por comprobante)", 18, y + 7);
  doc.text(fmtMoney(monto), 191, y + 7, { align: "right" });
  y += 19;

  doc.setFont("helvetica", "bold");
  doc.text("Total cobrado", 150, y, { align: "right" });
  doc.text(fmtMoney(monto), 191, y, { align: "right" });
  y += 9;

  const letras = doc.splitTextToSize(montoEnLetras(monto).toUpperCase(), 104) as string[];
  const altoLetras = Math.max(15, letras.length * 5 + 5);
  doc.setFont("helvetica", "normal");
  doc.text("Total cobrado en letras:", 14, y + 6);
  doc.roundedRect(82, y, 114, altoLetras, 2, 2);
  doc.text(letras, 86, y + 6);
  y += altoLetras + 9;

  const detalle = datos.detalle ?? {};
  const referencia = [texto(detalle.banco), texto(detalle.numero)].filter(Boolean).join(" · ");
  const formaPago = formaPagoLabel[datos.forma_pago] ?? datos.forma_pago;
  const formaCompleta = `${formaPago}${referencia ? ` - ${referencia}` : ""}`;
  const detalleEnObservaciones = (doc.splitTextToSize(formaCompleta, 145) as string[]).length > 3;
  const formas = doc.splitTextToSize(
    detalleEnObservaciones ? "Ver forma de cobro y referencia en observaciones" : formaCompleta,
    145,
  ) as string[];
  const altoForma = Math.max(9, formas.length * 4.5 + 3);
  if (y + 8 + altoForma + 15 > 260) {
    doc.addPage();
    y = 20;
  }
  doc.setFillColor(225, 225, 225);
  doc.rect(14, y, 182, 8, "FD");
  doc.setFont("helvetica", "bold");
  doc.text("Formas de cobro", 18, y + 5.5);
  doc.text("Importe", 191, y + 5.5, { align: "right" });
  y += 8;
  doc.rect(14, y, 182, altoForma);
  doc.setFont("helvetica", "normal");
  doc.text(formas, 18, y + 5.5);
  doc.text(fmtMoney(monto), 191, y + 5.5, { align: "right" });
  y += altoForma;
  doc.setFont("helvetica", "bold");
  doc.text("Total:", 150, y + 6, { align: "right" });
  doc.text(fmtMoney(monto), 191, y + 6, { align: "right" });
  y += 15;

  if (y > 255) {
    doc.addPage();
    y = 20;
  }
  doc.setFont("helvetica", "normal");
  doc.text("Observaciones:", 14, y);
  y += 6;
  for (const contenido of [
    detalleEnObservaciones ? `Detalle de forma de cobro: ${formaCompleta}` : null,
    datos.observaciones,
  ]) {
    if (!contenido) continue;
    for (const linea of doc.splitTextToSize(contenido, 176) as string[]) {
      if (y > 260) {
        doc.addPage();
        y = 20;
      }
      doc.text(linea, 17, y);
      y += 4.5;
    }
    y += 3;
  }

  doc.setFontSize(8);
  doc.text(`Cobro registrado: ${datos.cobranza_id}`, 14, 273);
  doc.text("Este recibo acredita el cobro indicado y no reemplaza la factura.", 14, 280);
  if (recibo.anulado) {
    for (let pagina = 1; pagina <= doc.getNumberOfPages(); pagina++) {
      doc.setPage(pagina);
      doc.setTextColor(185, 35, 35);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(34);
      doc.setGState(new GState({ opacity: 0.18 }));
      doc.text("ANULADO", 105, 235, { align: "center" });
      doc.setGState(new GState({ opacity: 1 }));
    }
  }

  return { doc, nombre: `recibo-x-${recibo.numero}.pdf` };
}
