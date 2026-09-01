import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { fmtMoney, fmtNum, fmtDateTime, tipoComprobanteLabel } from "@/lib/format";
import { fmtDocumento } from "@/lib/documento";
import {
  CBTE_INFO,
  CONDICION_IVA_LABEL,
  porcentajeDeIvaId,
  requiereLeyendaTransparencia,
  tituloDeCbteTipo,
  TIPOS_C,
  type CondicionIva,
} from "./codigos";
import { conIva, precioFinalConDescuento } from "./iva";

/**
 * El comprobante impreso.
 *
 * El PDF viejo era un listado de ítems con un total: servía para el mostrador
 * pero no como comprobante fiscal. Le faltaba casi todo lo que un comprobante
 * tiene que mostrar — condición de IVA del receptor (obligatoria desde la RG
 * 5616), domicilio del receptor, Ingresos Brutos e inicio de actividades del
 * emisor, condición de venta, el IVA desglosado por alícuota y el recuadro de la
 * letra. Esto lo reemplaza.
 *
 * DOS REGLAS QUE NO SE NEGOCIAN:
 *
 *   1. Todo sale del SNAPSHOT que se congeló al pedir el CAE, no de las tablas
 *      en vivo. Un comprobante ya emitido no puede cambiar porque después se
 *      corrigió la ficha del cliente.
 *
 *   2. Los importes se imprimen en VALOR ABSOLUTO. Internamente una nota de
 *      crédito guarda todo en negativo (así resta del libro y de la caja), pero
 *      el papel de una NC va en positivo: es lo que se le declaró a AFIP y lo que
 *      espera ver cualquiera que la lea.
 */

export interface ItemComprobante {
  codigo?: string | null;
  descripcion?: string | null;
  cantidad: number | string;
  precio_unitario_sin_iva: number | string;
  descuento_porcentaje?: number | string | null;
  iva_porcentaje?: number | string | null;
  subtotal_con_iva: number | string;
}

export interface EmisorImpreso {
  razon_social?: string | null;
  nombre_fantasia?: string | null;
  cuit?: string | null;
  domicilio_fiscal?: string | null;
  condicion_iva?: CondicionIva | null;
  ingresos_brutos?: string | null;
  inicio_actividades?: string | null;
}

export interface ReceptorImpreso {
  razon_social?: string | null;
  cuit_dni?: string | null;
  doc_tipo?: number | null;
  condicion_iva?: CondicionIva | null;
  domicilio?: string | null;
}

export interface DatosFiscalesImpresos {
  emisor: EmisorImpreso | null;
  receptor: ReceptorImpreso;
  condicion_venta?: string | null;
  totales?: {
    neto: number;
    iva: number;
    tributos: number;
    total: number;
    alicuotas: Array<{ Id: number; BaseImp: number; Importe: number }>;
  } | null;
  /** Las líneas tal como se declararon a AFIP. Si están, mandan sobre venta_items. */
  lineas?: ItemComprobante[] | null;
  /** La fecha congelada que se le declaró a AFIP. */
  fecha?: string | null;
  cae: string;
  cae_vencimiento?: string | null;
  punto_venta: number;
  numero: number;
  cbte_tipo: number;
  modo?: string | null;
  simulado?: boolean;
  sin_snapshot?: boolean;
  qr?: string | null;
}

export interface VentaImpresa {
  numero_comprobante?: string | null;
  tipo_comprobante: string;
  fecha: string | Date;
  condicion_venta?: string | null;
  subtotal_sin_iva: number | string;
  iva_total: number | string;
  percepciones?: number | string | null;
  total: number | string;
  cliente?: { razon_social?: string | null; cuit_dni?: string | null } | null;
  sucursal?: { nombre?: string | null; telefono?: string | null } | null;
}

const MARGEN = 14;
const ANCHO = 210;
const DERECHA = ANCHO - MARGEN; // 196
const MEDIO = ANCHO / 2; // 105
// El recuadro de la letra está centrado SOBRE el borde de la columna derecha, así
// que su mitad derecha invade esa columna. El texto arranca pasado el recuadro:
// sin este margen el "COD. NN" se encimaba con el título y se leía "COD. 06FACTURA".
const X_DERECHA = MEDIO + 12;

const abs = (n: number | string | null | undefined) => Math.abs(Number(n ?? 0)) || 0;
const money = (n: number | string | null | undefined) => fmtMoney(abs(n));

/**
 * Formatea una columna DATE de Postgres, que llega como 'YYYY-MM-DD' pelado.
 * NO sirve fmtDate acá: new Date('2026-08-20') se parsea como medianoche UTC y,
 * al mostrarla en hora de Argentina (UTC-3), retrocede al 19. El vencimiento del
 * CAE y el inicio de actividades son fechas sin hora: se parten y se dan vuelta.
 */
const fmtFechaSola = (s?: string | null) => (s ? s.split("-").reverse().join("/") : "—");

/** "0005-00000123" — el formato de numeración fiscal. */
export function numeroFiscal(puntoVenta: number, numero: number): string {
  return `${String(puntoVenta).padStart(5, "0")}-${String(numero).padStart(8, "0")}`;
}

/** "CUIT" / "DNI" / null según el DocTipo que se declaró. */
function etiquetaDoc(docTipo: number | null | undefined): string | null {
  if (docTipo === 80) return "CUIT";
  if (docTipo === 86) return "CUIL";
  if (docTipo === 96) return "DNI";
  return null;
}

const condicionVentaLabel = (c: string | null | undefined) =>
  c === "CTA_CTE" ? "Cuenta corriente" : c === "CONTADO" ? "Contado" : null;

/**
 * Arma el PDF. Devuelve el documento y el nombre de archivo sugerido.
 *
 * Si `fiscal` es null el comprobante todavía no tiene CAE (o es un documento
 * interno): se imprime la misma hoja pero sin recuadro de letra, sin bloque de
 * CAE y con la numeración interna, más una marca de que no es un comprobante
 * fiscal. Así un remito sigue siendo imprimible sin fingir que está autorizado.
 */
export function generarComprobantePdf(
  venta: VentaImpresa,
  items: ItemComprobante[],
  fiscal: DatosFiscalesImpresos | null,
): { doc: jsPDF; nombre: string } {
  const doc = new jsPDF();
  const esC = fiscal ? TIPOS_C.has(fiscal.cbte_tipo) : false;
  const esInterno = !fiscal;
  const info = fiscal ? CBTE_INFO[fiscal.cbte_tipo] : null;
  const ALTO = doc.internal.pageSize.getHeight();

  // Las líneas congeladas al emitir ganan sobre las de la base: una reimpresión
  // tiene que salir idéntica al original entregado.
  const lineas = fiscal?.lineas?.length ? fiscal.lineas : items;

  /**
   * Reserva `alto` mm antes de dibujar un bloque. autoTable pagina la tabla sola,
   * pero lo que va DESPUÉS (totales, CAE, QR, leyendas) se dibuja en coordenadas
   * calculadas: con muchos ítems la tabla termina cerca del pie y esos bloques se
   * escribían fuera de la hoja — el comprobante salía sin el bloque de CAE.
   */
  const asegurarEspacio = (desde: number, alto: number): number => {
    if (desde + alto <= ALTO - 12) return desde;
    doc.addPage();
    return 20;
  };

  const numeroMostrar = fiscal
    ? numeroFiscal(fiscal.punto_venta, fiscal.numero)
    : (venta.numero_comprobante ?? "");

  // ---------------------------------------------------------------- encabezado
  const yBox = 22;
  const hBox = 40;
  doc.setDrawColor(120);
  doc.rect(MARGEN, yBox, DERECHA - MARGEN, hBox);

  // Recuadro de la letra, montado sobre el borde superior (como el PDF de ARCA).
  if (info) {
    doc.setFillColor(255, 255, 255);
    doc.rect(MEDIO - 8, yBox - 8, 16, 16, "FD");
    doc.setFontSize(22);
    doc.setFont("helvetica", "bold");
    doc.text(info.letra, MEDIO, yBox + 1, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.text(`COD. ${info.cod}`, MEDIO, yBox + 5.5, { align: "center" });
    // El divisor arranca debajo del recuadro para no cruzarlo.
    doc.line(MEDIO, yBox + 8, MEDIO, yBox + hBox);
  } else {
    doc.line(MEDIO, yBox, MEDIO, yBox + hBox);
  }

  const em = fiscal?.emisor ?? null;

  // --- Emisor (columna izquierda)
  let y = yBox + 6;
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.text(em?.razon_social ?? venta.sucursal?.nombre ?? "Comprobante", MARGEN + 3, y, {
    maxWidth: MEDIO - MARGEN - 14,
  });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  y += 5;
  if (em?.nombre_fantasia) {
    doc.text(em.nombre_fantasia, MARGEN + 3, y, { maxWidth: MEDIO - MARGEN - 14 });
    y += 4;
  }
  const lineasEmisor = [
    em?.domicilio_fiscal ? String(em.domicilio_fiscal) : null,
    em?.cuit ? `CUIT: ${em.cuit}` : null,
    em?.condicion_iva
      ? `Condición IVA: ${CONDICION_IVA_LABEL[em.condicion_iva] ?? em.condicion_iva}`
      : null,
    em?.ingresos_brutos ? `Ingresos Brutos: ${em.ingresos_brutos}` : null,
    em?.inicio_actividades ? `Inicio de actividades: ${fmtFechaSola(em.inicio_actividades)}` : null,
    // El contacto del local, SÓLO en documentos que no tienen CAE.
    //
    // Un comprobante autorizado se reimprime exactamente como salió, y eso sale
    // del snapshot: meterle un teléfono leído en vivo lo haría cambiar si mañana
    // cambia el número. Cuando el snapshot lleve el teléfono del emisor (está en
    // el backlog), sale de ahí y vale también para los que tienen CAE.
    !fiscal && venta.sucursal?.telefono
      ? `Sucursal ${venta.sucursal?.nombre ?? ""}: Cel ${venta.sucursal.telefono}`.trim()
      : null,
  ].filter(Boolean) as string[];
  for (const l of lineasEmisor) {
    doc.text(l, MARGEN + 3, y, { maxWidth: MEDIO - MARGEN - 14 });
    y += 4;
  }

  // --- Datos del comprobante (columna derecha)
  let yd = yBox + 6;
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text(
    fiscal
      ? tituloDeCbteTipo(fiscal.cbte_tipo)
      : (tipoComprobanteLabel[venta.tipo_comprobante] ?? "COMPROBANTE"),
    X_DERECHA,
    yd,
  );
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  yd += 6;
  doc.text(`N°: ${numeroMostrar}`, X_DERECHA, yd);
  yd += 4;
  doc.text(`Fecha de emisión: ${fmtDateTime(venta.fecha)}`, X_DERECHA, yd);
  yd += 4;
  if (fiscal) {
    doc.text(`Punto de venta: ${String(fiscal.punto_venta).padStart(5, "0")}`, X_DERECHA, yd);
    yd += 4;
  }
  doc.text("Concepto: Productos", X_DERECHA, yd);
  yd += 4;
  // El número interno del mostrador, cuando difiere del fiscal: es por el que la
  // clienta busca el comprobante en el sistema.
  if (fiscal && venta.numero_comprobante) {
    doc.setTextColor(120);
    doc.text(`Interno: ${venta.numero_comprobante}`, X_DERECHA, yd);
    doc.setTextColor(0);
  }

  // ------------------------------------------------------------------ receptor
  const yRec = yBox + hBox + 5;
  doc.rect(MARGEN, yRec, DERECHA - MARGEN, 20);
  const rec = fiscal?.receptor;
  const nombreRec = rec?.razon_social ?? venta.cliente?.razon_social ?? "Consumidor Final";
  const docRec = rec?.cuit_dni ?? venta.cliente?.cuit_dni ?? null;
  const etiqueta = etiquetaDoc(rec?.doc_tipo);

  doc.setFontSize(7.5);
  let yr = yRec + 5;
  doc.setFont("helvetica", "bold");
  doc.text(nombreRec, MARGEN + 3, yr, { maxWidth: 110 });
  doc.setFont("helvetica", "normal");
  // El documento se guarda en dígitos; en el comprobante se imprime con guiones.
  if (docRec && etiqueta) doc.text(`${etiqueta}: ${fmtDocumento(docRec)}`, X_DERECHA, yr);
  yr += 4.5;
  // RG 5616: la condición frente al IVA del receptor es obligatoria en el
  // comprobante. Es de las cosas que el contador mira primero.
  if (fiscal) {
    doc.text(
      `Condición IVA: ${rec?.condicion_iva ? (CONDICION_IVA_LABEL[rec.condicion_iva] ?? rec.condicion_iva) : "Consumidor Final"}`,
      MARGEN + 3,
      yr,
    );
  }
  const condVenta = condicionVentaLabel(fiscal?.condicion_venta ?? venta.condicion_venta);
  if (condVenta) doc.text(`Condición de venta: ${condVenta}`, X_DERECHA, yr);
  yr += 4.5;
  if (rec?.domicilio) doc.text(`Domicilio: ${rec.domicilio}`, MARGEN + 3, yr, { maxWidth: 170 });

  // --------------------------------------------------------------------- ítems
  // En clase C no se discrimina IVA (AFIP lo prohíbe), así que el papel tampoco
  // muestra ni la columna ni el desglose: sólo importes finales.
  const cabecera = esInterno
    ? ["Código", "Descripción", "Cant.", "Precio de lista", "Desc.", "Precio final", "Importe"]
    : esC
      ? ["Código", "Descripción", "Cant.", "P. unit.", "Desc.", "Importe"]
      : ["Código", "Descripción", "Cant.", "P. unit. s/IVA", "Desc.", "IVA", "Importe"];

  autoTable(doc, {
    startY: yRec + 25,
    head: [cabecera],
    body: lineas.map((i) => {
      const descuento = Math.min(Math.max(abs(i.descuento_porcentaje), 0), 100);
      const base = [
        i.codigo ?? "",
        i.descripcion ?? "",
        fmtNum(abs(i.cantidad)),
        money(i.precio_unitario_sin_iva),
        `${fmtNum(descuento)}%`,
      ];
      if (esInterno) {
        const precioLista = conIva(abs(i.precio_unitario_sin_iva), abs(i.iva_porcentaje));
        const precioFinal = precioFinalConDescuento(
          abs(i.precio_unitario_sin_iva),
          descuento,
          abs(i.iva_porcentaje),
        );
        return [
          i.codigo ?? "",
          i.descripcion ?? "",
          fmtNum(abs(i.cantidad)),
          money(precioLista),
          descuento > 0 ? `${fmtNum(descuento)}%` : "-",
          money(precioFinal),
          money(i.subtotal_con_iva),
        ];
      }
      return esC
        ? [...base, money(i.subtotal_con_iva)]
        : [...base, `${fmtNum(i.iva_porcentaje ?? 0)}%`, money(i.subtotal_con_iva)];
    }),
    styles: { fontSize: 7.5, cellPadding: 1.5 },
    headStyles: { fillColor: [240, 240, 240], textColor: 40, fontStyle: "bold" },
    columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" } },
    margin: { left: MARGEN, right: MARGEN },
  });

  // ------------------------------------------------------------------- totales
  // jspdf-autotable cuelga dónde terminó la tabla del documento, pero no lo
  // declara en los tipos de jsPDF.
  const finTabla = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  // El bloque de totales mide, como mucho, ~10 líneas de 4,5mm más el TOTAL.
  let yt = asegurarEspacio(finTabla + 6, 12 + (fiscal?.totales?.alicuotas?.length ?? 1) * 4.5);
  const xEtiqueta = 130;
  const linea = (etiqueta: string, valor: string, negrita = false) => {
    doc.setFont("helvetica", negrita ? "bold" : "normal");
    doc.text(etiqueta, xEtiqueta, yt);
    doc.text(valor, DERECHA, yt, { align: "right" });
    doc.setFont("helvetica", "normal");
    yt += 4.5;
  };

  doc.setFontSize(8);
  const t = fiscal?.totales;
  if (esInterno) {
    // Documento comercial: sólo importes finales, sin exponer el cálculo fiscal.
    linea("Subtotal", money(abs(t?.total ?? venta.total) - abs(t?.tributos ?? venta.percepciones)));
  } else if (esC) {
    // Clase C: importe final, sin neto ni IVA.
    linea("Subtotal", money(t?.total ?? venta.total));
  } else {
    linea("Neto gravado", money(t?.neto ?? venta.subtotal_sin_iva));
    if (t?.alicuotas?.length) {
      // El desglose real que se le declaró a AFIP.
      for (const a of t.alicuotas) {
        linea(`IVA ${fmtNum(porcentajeDeIvaId(a.Id))}% s/ ${money(a.BaseImp)}`, money(a.Importe));
      }
    } else {
      linea("IVA", money(venta.iva_total));
    }
  }
  const percepciones = abs(t?.tributos ?? venta.percepciones);
  if (percepciones > 0) linea("Percepciones y otros tributos", money(percepciones));

  doc.setDrawColor(120);
  doc.line(xEtiqueta, yt - 2, DERECHA, yt - 2);
  yt += 1;
  doc.setFontSize(11);
  linea("TOTAL", money(t?.total ?? venta.total), true);
  doc.setFontSize(8);

  // ------------------------------------------------------------------ CAE / QR
  if (fiscal?.cae) {
    // El bloque mide 28mm de QR. Es el que NO puede faltar en el papel.
    yt = asegurarEspacio(yt + 4, 30);
    if (fiscal.qr) doc.addImage(fiscal.qr, "PNG", MARGEN, yt, 28, 28);
    const xc = MARGEN + 32;
    doc.setFont("helvetica", "bold");
    doc.text("Comprobante Autorizado", xc, yt + 5);
    doc.setFont("helvetica", "normal");
    doc.text(`CAE N°: ${fiscal.cae}`, xc, yt + 10);
    doc.text(`Vto. CAE: ${fmtFechaSola(fiscal.cae_vencimiento)}`, xc, yt + 15);
    yt += 30;
  }

  // ------------------------------------------------------------------ leyendas
  const leyendas: string[] = [];
  if (
    fiscal &&
    requiereLeyendaTransparencia(fiscal.cbte_tipo, fiscal.receptor?.condicion_iva ?? null)
  ) {
    const ivaContenido = abs(fiscal.totales?.iva ?? venta.iva_total);
    leyendas.push(
      `Régimen de Transparencia Fiscal al Consumidor (Ley 27.743). IVA contenido: ${fmtMoney(ivaContenido)}.`,
    );
  }
  if (fiscal?.simulado) {
    leyendas.push(
      "COMPROBANTE SIMULADO — generado en modo de prueba, no se declaró a AFIP y no tiene validez legal.",
    );
  } else if (fiscal?.modo === "HOMOLOGACION") {
    leyendas.push("Comprobante emitido en homologación (prueba) — sin validez fiscal.");
  }
  if (fiscal?.sin_snapshot) {
    leyendas.push(
      "Reimpresión: este comprobante se emitió antes de que se guardaran los datos fiscales congelados, " +
        "así que el encabezado refleja los datos actuales del emisor y del cliente.",
    );
  }
  if (!fiscal) {
    leyendas.push("Documento interno - no es un comprobante fiscal y no se declaró a AFIP.");
  }

  if (leyendas.length) {
    yt += 2;
    doc.setFontSize(7);
    doc.setTextColor(90);
    for (const l of leyendas) {
      const partido = doc.splitTextToSize(l, DERECHA - MARGEN);
      // Cada leyenda se mide antes de escribirla: la de Transparencia Fiscal es
      // obligatoria y cortarla al pie de la hoja no es una opción.
      yt = asegurarEspacio(yt, partido.length * 3.4 + 1.5);
      doc.text(partido, MARGEN, yt);
      yt += partido.length * 3.4 + 1.5;
    }
    doc.setTextColor(0);
  }

  return { doc, nombre: `${numeroMostrar || "comprobante"}.pdf` };
}
