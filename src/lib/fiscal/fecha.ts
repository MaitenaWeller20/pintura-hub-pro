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
  const partes = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
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
