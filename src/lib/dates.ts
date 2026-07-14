// Helpers de fecha ancladas a la zona horaria de Argentina (UTC-3, sin DST),
// para que los rangos de reportes/pagos no se corran de día por UTC.
export const AR_TZ = "America/Argentina/Buenos_Aires";

// AR está fijo en UTC-3. Construimos el instante UTC del inicio de un día local.
function localDayStartUtc(iso: string): Date {
  // iso = "YYYY-MM-DD" (día local AR). 00:00 AR = 03:00 UTC del mismo día.
  return new Date(`${iso}T03:00:00.000Z`);
}

export function todayLocalISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AR_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // en-CA => "YYYY-MM-DD"
}

export function daysAgoLocalISO(n: number): string {
  const start = localDayStartUtc(todayLocalISO());
  start.setUTCDate(start.getUTCDate() - n);
  return start.toISOString().slice(0, 10);
}

// Rango half-open en UTC a partir de dos fechas locales "YYYY-MM-DD":
// [desde 00:00 local, hasta+1día 00:00 local).
export function rangeToUtc(fromISO: string, toISO: string): { gte: string; lt: string } {
  const gte = localDayStartUtc(fromISO);
  const lt = localDayStartUtc(toISO);
  lt.setUTCDate(lt.getUTCDate() + 1);
  return { gte: gte.toISOString(), lt: lt.toISOString() };
}
