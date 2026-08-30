import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ESLint } from "eslint";
import {
  clasificarHallazgosNuevos,
  normalizarResultados,
  parsearHunksGit,
} from "./lint-no-new-debt-lib.mjs";

const ejecutar = promisify(execFile);

export const ANCLA_DEUDA_LINT = "1b3bc2ceedf41e6506b26b4968b3243165e980bd";

async function git(raiz, args, opciones = {}) {
  const respuesta = await ejecutar("git", args, {
    cwd: raiz,
    encoding: opciones.encoding ?? "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return respuesta.stdout;
}

export function validarAnclaCi(valor, anclaEsperada = ANCLA_DEUDA_LINT) {
  if (valor && valor !== anclaEsperada) {
    throw new Error(
      `La ancla protegida de CI no coincide con la ancla del gate (${anclaEsperada}).`,
    );
  }
}

export async function exigirCheckoutLimpio(raiz) {
  const estado = await git(raiz, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  if (estado.length > 0) {
    const detalle = estado.replaceAll("\0", "\n").trim();
    throw new Error(
      "lint:no-new-debt sólo se ejecuta sobre un checkout completamente limpio " +
        `(staged, unstaged y untracked deben estar vacíos):\n${detalle}`,
    );
  }
}

async function asegurarAncla(raiz, baseSha) {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new Error("La ancla hardcodeada de lint no es un SHA completo válido.");
  }
  try {
    await git(raiz, ["cat-file", "-e", `${baseSha}^{commit}`]);
    await git(raiz, ["merge-base", "--is-ancestor", baseSha, "HEAD"]);
  } catch {
    throw new Error(`El commit base ${baseSha} no existe o no es ancestro de HEAD.`);
  }
}

async function materializarBase(raiz, baseSha, temporal) {
  const archivoTar = path.join(temporal, "base.tar");
  const directorioBase = path.join(temporal, "base");
  await mkdir(directorioBase);
  await git(raiz, ["archive", "--format=tar", `--output=${archivoTar}`, baseSha]);
  await ejecutar("tar", ["-xf", archivoTar, "-C", directorioBase], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  const modulosActuales = path.join(raiz, "node_modules");
  try {
    await access(modulosActuales);
    await symlink(modulosActuales, path.join(directorioBase, "node_modules"), "dir");
  } catch {
    // Los repositorios mínimos de las pruebas no necesitan dependencias externas.
  }
  return directorioBase;
}

function errorHallazgos(nuevos, baseSha) {
  const lineas = nuevos.map(
    (hallazgo) =>
      `- ${hallazgo.archivo}:${hallazgo.linea}:${hallazgo.columna} ` +
      `${hallazgo.regla}: ${hallazgo.mensaje}`,
  );
  return new Error(
    `ESLint detectó ${nuevos.length} hallazgo(s) nuevo(s) contra ${baseSha.slice(0, 12)}:\n` +
      lineas.join("\n"),
  );
}

export async function ejecutarGateLint({ raiz, baseSha = ANCLA_DEUDA_LINT }) {
  await exigirCheckoutLimpio(raiz);
  await asegurarAncla(raiz, baseSha);

  const temporal = await mkdtemp(path.join(tmpdir(), "lint-no-new-debt-base-"));
  let resultado;
  let errorPrincipal;
  try {
    const directorioBase = await materializarBase(raiz, baseSha, temporal);
    const eslintActual = new ESLint({ cwd: raiz });
    const eslintBase = new ESLint({ cwd: directorioBase });
    const actuales = normalizarResultados(await eslintActual.lintFiles(["."]), raiz);
    const base = normalizarResultados(await eslintBase.lintFiles(["."]), directorioBase);
    const salidaArchivos = await git(raiz, ["ls-tree", "-r", "--name-only", "-z", baseSha], {
      encoding: "buffer",
    });
    const archivosBase = new Set(salidaArchivos.toString("utf8").split("\0").filter(Boolean));

    const hunksPorArchivo = new Map();
    for (const archivo of new Set(actuales.map((hallazgo) => hallazgo.archivo))) {
      if (!archivosBase.has(archivo)) continue;
      const diff = await git(raiz, [
        "diff",
        "--unified=0",
        "--no-ext-diff",
        "--no-renames",
        baseSha,
        "HEAD",
        "--",
        archivo,
      ]);
      hunksPorArchivo.set(archivo, parsearHunksGit(diff));
    }

    const nuevos = clasificarHallazgosNuevos({ base, actuales, archivosBase, hunksPorArchivo });
    if (nuevos.length > 0) throw errorHallazgos(nuevos, baseSha);
    resultado = { actuales, base, nuevos };
  } catch (error) {
    errorPrincipal = error;
  } finally {
    await rm(temporal, { recursive: true, force: true });
  }

  await exigirCheckoutLimpio(raiz);
  if (errorPrincipal) throw errorPrincipal;
  return resultado;
}
