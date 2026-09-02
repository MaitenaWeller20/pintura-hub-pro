function identidad(hallazgo, linea = hallazgo.linea, lineaFin = hallazgo.lineaFin) {
  return JSON.stringify({
    archivo: hallazgo.archivo,
    linea,
    columna: hallazgo.columna,
    lineaFin,
    columnaFin: hallazgo.columnaFin,
    regla: hallazgo.regla,
    severidad: hallazgo.severidad,
    mensaje: hallazgo.mensaje,
  });
}

export function parsearHunksGit(diff) {
  const hunks = [];
  const patron = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (const match of diff.matchAll(patron)) {
    hunks.push({
      baseInicio: Number(match[1]),
      baseCantidad: match[2] === undefined ? 1 : Number(match[2]),
      actualInicio: Number(match[3]),
      actualCantidad: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}

function lineaBase(lineaActual, hunks) {
  let delta = 0;
  for (const hunk of hunks) {
    if (lineaActual < hunk.actualInicio) return lineaActual + delta;
    const finAgregado = hunk.actualInicio + hunk.actualCantidad;
    if (hunk.actualCantidad > 0 && lineaActual < finAgregado) return null;
    delta += hunk.baseCantidad - hunk.actualCantidad;
  }
  return lineaActual + delta;
}

function rangoBase(hallazgo, hunks) {
  const inicio = lineaBase(hallazgo.linea, hunks);
  const fin = lineaBase(hallazgo.lineaFin, hunks);
  if (inicio === null || fin === null) return null;
  for (let linea = hallazgo.linea; linea <= hallazgo.lineaFin; linea += 1) {
    if (lineaBase(linea, hunks) === null) return null;
  }
  return { inicio, fin };
}

export function clasificarHallazgosNuevos({ base, actuales, archivosBase, hunksPorArchivo }) {
  const disponibles = new Map();
  for (const hallazgo of base) {
    const clave = identidad(hallazgo);
    disponibles.set(clave, (disponibles.get(clave) ?? 0) + 1);
  }

  const nuevos = [];
  for (const hallazgo of actuales) {
    if (!archivosBase.has(hallazgo.archivo)) {
      nuevos.push(hallazgo);
      continue;
    }
    const rango = rangoBase(hallazgo, hunksPorArchivo.get(hallazgo.archivo) ?? []);
    if (!rango) {
      nuevos.push(hallazgo);
      continue;
    }
    const clave = identidad(hallazgo, rango.inicio, rango.fin);
    const cantidad = disponibles.get(clave) ?? 0;
    if (cantidad === 0) nuevos.push(hallazgo);
    else disponibles.set(clave, cantidad - 1);
  }
  return nuevos;
}

export function normalizarResultados(resultados, raiz) {
  const normalizados = [];
  for (const resultado of resultados) {
    const archivo = resultado.filePath
      .slice(raiz.length + 1)
      .split(/[/\\]/)
      .join("/");
    for (const mensaje of resultado.messages) {
      if (mensaje.severity === 0) continue;
      normalizados.push({
        archivo,
        linea: mensaje.line ?? 0,
        columna: mensaje.column ?? 0,
        lineaFin: mensaje.endLine ?? mensaje.line ?? 0,
        columnaFin: mensaje.endColumn ?? mensaje.column ?? 0,
        regla: mensaje.ruleId ?? "error-de-parseo",
        severidad: mensaje.severity,
        mensaje: mensaje.message,
      });
    }
  }
  return normalizados;
}
