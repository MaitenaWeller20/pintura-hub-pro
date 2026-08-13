/**
 * Fechas fiscales en hora de Argentina.
 *
 * POR QUÉ ESTE ARCHIVO EXISTE: tanto lubricentro como MesaYa formatean la fecha
 * del comprobante con `d.toISOString().slice(0,10)`, que es UTC. Argentina es
 * UTC-3, así que una venta a las 21:30 del 31 de julio se le manda a AFIP con
 * fecha 1 de agosto: el comprobante cae en el período de IVA equivocado.
 *
 * Es un bug latente en los dos sistemas de referencia. Acá no lo repetimos.
 */

const TZ = "America/Argentina/Buenos_Aires";

/** Partes año/mes/día de una fecha, según el reloj de Buenos Aires. */
function partesEnBuenosAires(d: Date): { year: string; month: string; day: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const partes = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value])) as Record<
    string,
    string
  >;
  return { year: partes.year, month: partes.month, day: partes.day };
}

/** YYYYMMDD — el formato que espera AFIP en CbteFch / FchServDesde / etc. */
export function fmtFechaAfip(d: Date): string {
  const { year, month, day } = partesEnBuenosAires(d);
  return `${year}${month}${day}`;
}

/** YYYY-MM-DD — el formato que espera el QR de AFIP (RG 4892). */
export function fmtFechaIsoAr(d: Date): string {
  const { year, month, day } = partesEnBuenosAires(d);
  return `${year}-${month}-${day}`;
}

/**
 * Ventana de AFIP para CbteFch. WSFEv1 sólo acepta la fecha del comprobante
 * dentro de ±N días CORRIDOS respecto del día en que se pide el CAE:
 *   Concepto 1 (productos)                -> 5 días
 *   Concepto 2 y 3 (servicios / ambos)    -> 10 días
 * quimex vende productos (CONCEPTO_PRODUCTOS), así que la ventana es de 5.
 *
 * Importa porque la emisión es un botón manual y diferido: una venta que se
 * factura una semana después la rechaza AFIP, y para entonces ya no hay forma
 * de emitirla con su fecha real.
 */
export const VENTANA_AFIP_DIAS = 5;

/** Día calendario absoluto (en el reloj de Buenos Aires) como número entero. */
function diaAbsolutoAr(d: Date): number {
  const { year, month, day } = partesEnBuenosAires(d);
  return Math.floor(Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000);
}

/**
 * Días calendario entre la fecha de un comprobante y hoy, con el reloj de
 * Buenos Aires (el que usa AFIP). Positivo = el comprobante es del pasado;
 * negativo = está fechado a futuro. Se cuenta por día calendario, no por horas:
 * una venta de ayer a las 23:00 es 1 día, aunque hayan pasado 2 horas.
 */
export function diasDesdeHoyAr(fecha: Date, hoy: Date = new Date()): number {
  return diaAbsolutoAr(hoy) - diaAbsolutoAr(fecha);
}

/** Días que faltan para que la venta se caiga de la ventana de AFIP. 0 = último día. */
export function diasRestantesVentanaAfip(fecha: Date, hoy: Date = new Date()): number {
  return VENTANA_AFIP_DIAS - diasDesdeHoyAr(fecha, hoy);
}

/** ¿La fecha del comprobante quedó fuera de lo que AFIP acepta? */
export function fueraDeVentanaAfip(fecha: Date, hoy: Date = new Date()): boolean {
  return Math.abs(diasDesdeHoyAr(fecha, hoy)) > VENTANA_AFIP_DIAS;
}

/**
 * Parsea el YYYYMMDD que devuelve AFIP (p. ej. el vencimiento del CAE).
 * Devuelve null si no tiene exactamente 8 dígitos.
 */
export function parseFechaAfip(s: string | null | undefined): Date | null {
  if (!s || !/^\d{8}$/.test(s)) return null;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  // Mediodía UTC: cae en el mismo día calendario en cualquier huso de Argentina,
  // así que la fecha no se corre al convertirla.
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}
