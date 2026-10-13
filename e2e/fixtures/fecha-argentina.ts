const ZONA_ARGENTINA = "America/Argentina/Cordoba";

function partesFechaArgentina(ahora: Date): { year: string; month: string; day: string } {
  if (!(ahora instanceof Date) || !Number.isFinite(ahora.getTime())) {
    throw new Error("El reloj del fixture fiscal no es válido.");
  }
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: ZONA_ARGENTINA,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(ahora)
      .map((parte) => [parte.type, parte.value]),
  ) as Record<string, string>;
  return { year: partes.year, month: partes.month, day: partes.day };
}

export function sumarDiasFechaIso(fecha: string, dias: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!match || !Number.isInteger(dias)) throw new Error("La fecha del fixture no es válida.");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  date.setUTCDate(date.getUTCDate() + dias);
  return date.toISOString().slice(0, 10);
}

export function construirFechasFixtureArgentina(ahora = new Date()) {
  const { year, month, day } = partesFechaArgentina(ahora);
  const hoy = `${year}-${month}-${day}`;
  return {
    hoy,
    visible: `${day}/${month}/${year}`,
    vencimientoCae: sumarDiasFechaIso(hoy, 10),
    instante(hora: string): string {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
        throw new Error("La hora local del fixture no es válida.");
      }
      return new Date(`${hoy}T${hora}:00-03:00`).toISOString();
    },
  };
}
