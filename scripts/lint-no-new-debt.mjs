import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { ESLint } from "eslint";
import {
  clasificarHallazgosNuevos,
  normalizarResultados,
  parsearHunksGit,
} from "./lint-no-new-debt-lib.mjs";

const ejecutar = promisify(execFile);
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rutaConfig = path.join(raiz, "scripts", "lint-no-new-debt.config.json");

if (process.argv.length > 2) {
  console.error(
    "El baseline es un commit Git inmutable; este gate no admite opciones de escritura.",
  );
  process.exit(2);
}

const config = JSON.parse(await readFile(rutaConfig, "utf8"));
if (
  config.formato !== 2 ||
  typeof config.baseSha !== "string" ||
  !/^[0-9a-f]{40}$/.test(config.baseSha) ||
  typeof config.alcance !== "string"
) {
  console.error("scripts/lint-no-new-debt.config.json no define un ancla válida.");
  process.exit(2);
}

async function git(args, opciones = {}) {
  const respuesta = await ejecutar("git", args, {
    cwd: raiz,
    encoding: opciones.encoding ?? "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return respuesta.stdout;
}

try {
  await git(["cat-file", "-e", `${config.baseSha}^{commit}`]);
  await git(["merge-base", "--is-ancestor", config.baseSha, "HEAD"]);
} catch {
  console.error(`El commit base ${config.baseSha} no existe o no es ancestro de HEAD.`);
  process.exit(2);
}

const eslint = new ESLint({ cwd: raiz });
const actuales = normalizarResultados(await eslint.lintFiles([raiz]), raiz);
const salidaArchivos = await git(["ls-tree", "-r", "--name-only", "-z", config.baseSha], {
  encoding: "buffer",
});
const archivosBase = new Set(salidaArchivos.toString("utf8").split("\0").filter(Boolean));

const resultadosBase = [];
for (const archivo of archivosBase) {
  const rutaAbsoluta = path.join(raiz, archivo);
  if (await eslint.isPathIgnored(rutaAbsoluta)) continue;
  if (!(await eslint.calculateConfigForFile(rutaAbsoluta))) continue;
  const contenido = await git(["show", `${config.baseSha}:${archivo}`]);
  resultadosBase.push(
    ...(await eslint.lintText(contenido, { filePath: rutaAbsoluta, warnIgnored: false })),
  );
}
const base = normalizarResultados(resultadosBase, raiz);

const hunksPorArchivo = new Map();
for (const archivo of new Set(actuales.map((hallazgo) => hallazgo.archivo))) {
  if (!archivosBase.has(archivo)) continue;
  const diff = await git([
    "diff",
    "--unified=0",
    "--no-ext-diff",
    "--no-renames",
    config.baseSha,
    "--",
    archivo,
  ]);
  hunksPorArchivo.set(archivo, parsearHunksGit(diff));
}

const nuevos = clasificarHallazgosNuevos({ base, actuales, archivosBase, hunksPorArchivo });
if (nuevos.length > 0) {
  console.error(
    `ESLint detectó ${nuevos.length} hallazgo(s) nuevo(s) contra ${config.baseSha.slice(0, 12)}:`,
  );
  for (const hallazgo of nuevos) {
    console.error(
      `- ${hallazgo.archivo}:${hallazgo.linea}:${hallazgo.columna} ${hallazgo.regla}: ${hallazgo.mensaje}`,
    );
  }
  process.exit(1);
}

console.log(
  `Sin deuda nueva de lint contra ${config.baseSha.slice(0, 12)}: ` +
    `${actuales.length} hallazgos actuales, ${base.length} en la base comparable.`,
);
