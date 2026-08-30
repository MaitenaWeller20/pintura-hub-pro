import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ESLint } from "eslint";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rutaBaseline = path.join(raiz, "scripts", "lint-debt-baseline.json");
const escribir = process.argv.includes("--write-baseline");

function entradasDeuda(resultados) {
  const agrupadas = new Map();
  for (const resultado of resultados) {
    const archivo = path.relative(raiz, resultado.filePath).split(path.sep).join("/");
    for (const mensaje of resultado.messages) {
      if (mensaje.severity === 0) continue;
      const entrada = {
        archivo,
        regla: mensaje.ruleId ?? "error-de-parseo",
        severidad: mensaje.severity,
        mensaje: mensaje.message,
      };
      const clave = JSON.stringify(entrada);
      const existente = agrupadas.get(clave);
      agrupadas.set(
        clave,
        existente
          ? { ...existente, cantidad: existente.cantidad + 1 }
          : {
              ...entrada,
              cantidad: 1,
            },
      );
    }
  }
  return [...agrupadas.values()].sort((a, b) =>
    `${a.archivo}\0${a.regla}\0${a.mensaje}`.localeCompare(
      `${b.archivo}\0${b.regla}\0${b.mensaje}`,
    ),
  );
}

const eslint = new ESLint({ cwd: raiz });
const actuales = entradasDeuda(await eslint.lintFiles([raiz]));
const totalActual = actuales.reduce((total, entrada) => total + entrada.cantidad, 0);

if (escribir) {
  const baseline = {
    formato: 1,
    alcance: "eslint . con src/integrations/supabase/types.ts excluido por ser generado",
    total: totalActual,
    entradas: actuales,
  };
  await writeFile(rutaBaseline, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(`Baseline de lint escrito: ${totalActual} hallazgos históricos agrupados.`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(rutaBaseline, "utf8"));
} catch {
  console.error("Falta scripts/lint-debt-baseline.json. Generalo y revisalo explícitamente.");
  process.exit(1);
}
if (baseline.formato !== 1 || !Array.isArray(baseline.entradas)) {
  console.error("El baseline de lint tiene un formato desconocido.");
  process.exit(1);
}

const permitidas = new Map(
  baseline.entradas.map(({ cantidad, ...entrada }) => [JSON.stringify(entrada), cantidad]),
);
const nuevas = actuales
  .map(({ cantidad, ...entrada }) => ({
    ...entrada,
    cantidad: Math.max(0, cantidad - (permitidas.get(JSON.stringify(entrada)) ?? 0)),
  }))
  .filter((entrada) => entrada.cantidad > 0);

if (nuevas.length > 0) {
  console.error("ESLint detectó deuda nueva fuera del baseline:");
  for (const entrada of nuevas) {
    console.error(`- ${entrada.archivo} ${entrada.regla} ×${entrada.cantidad}: ${entrada.mensaje}`);
  }
  process.exit(1);
}

console.log(
  `Sin deuda nueva de lint: ${totalActual} hallazgos actuales, ` +
    `${baseline.total} aceptados en el baseline histórico.`,
);
