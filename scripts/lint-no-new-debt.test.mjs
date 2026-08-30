import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { clasificarHallazgosNuevos, parsearHunksGit } from "./lint-no-new-debt-lib.mjs";
import {
  ejecutarGateLint,
  exigirCheckoutLimpio,
  validarAnclaCi,
} from "./lint-no-new-debt-gate.mjs";

const ejecutar = promisify(execFile);
const temporales = [];

async function git(raiz, ...args) {
  return ejecutar("git", args, { cwd: raiz, encoding: "utf8" });
}

async function crearRepoMinimo() {
  const raiz = await mkdtemp(path.join(tmpdir(), "lint-no-new-debt-test-"));
  temporales.push(raiz);
  await git(raiz, "init", "--initial-branch=main");
  await git(raiz, "config", "user.email", "lint-test@local.invalid");
  await git(raiz, "config", "user.name", "Lint test");
  await mkdir(path.join(raiz, "scripts"), { recursive: true });
  await writeFile(path.join(raiz, "scripts", "lint-no-new-debt.mjs"), "const BASE = 'base';\n");
  await writeFile(path.join(raiz, "eslint.config.js"), "export default [];\n");
  await writeFile(path.join(raiz, "tracked.ts"), "export const valor = 1;\n");
  await git(raiz, "add", ".");
  await git(raiz, "commit", "-m", "base");
  return raiz;
}

afterEach(async () => {
  await Promise.all(temporales.splice(0).map((directorio) => rm(directorio, { recursive: true })));
});

const hallazgoBase = {
  archivo: "src/legacy.ts",
  linea: 3,
  columna: 7,
  lineaFin: 3,
  columnaFin: 10,
  regla: "@typescript-eslint/no-explicit-any",
  severidad: 2,
  mensaje: "Unexpected any. Specify a different type.",
};

describe("gate lint anclado al diff", () => {
  it("acepta una infracción histórica cuyo renglón sólo se desplazó", () => {
    const actual = { ...hallazgoBase, linea: 4, lineaFin: 4 };
    const hunks = parsearHunksGit("@@ -0,0 +1 @@\n+// encabezado\n");

    assert.deepEqual(
      clasificarHallazgosNuevos({
        base: [hallazgoBase],
        actuales: [actual],
        archivosBase: new Set([hallazgoBase.archivo]),
        hunksPorArchivo: new Map([[hallazgoBase.archivo, hunks]]),
      }),
      [],
    );
  });

  it("falla si una infracción vieja se elimina y otra idéntica aparece en otro renglón", () => {
    const reemplazo = { ...hallazgoBase, linea: 5, lineaFin: 5 };
    const hunks = parsearHunksGit(
      "@@ -3 +2,0 @@\n-const viejo: any = valor;\n@@ -5,0 +5 @@\n+const nuevo: any = valor;\n",
    );

    assert.deepEqual(
      clasificarHallazgosNuevos({
        base: [hallazgoBase],
        actuales: [reemplazo],
        archivosBase: new Set([hallazgoBase.archivo]),
        hunksPorArchivo: new Map([[hallazgoBase.archivo, hunks]]),
      }),
      [reemplazo],
    );
  });

  it("falla cerrado para una infracción en un archivo nuevo", () => {
    const nuevo = { ...hallazgoBase, archivo: "src/nuevo.ts", linea: 1, lineaFin: 1 };
    assert.deepEqual(
      clasificarHallazgosNuevos({
        base: [hallazgoBase],
        actuales: [nuevo],
        archivosBase: new Set([hallazgoBase.archivo]),
        hunksPorArchivo: new Map(),
      }),
      [nuevo],
    );
  });

  it("trata un rename como archivo nuevo y no compensa la infracción anterior", () => {
    const renombrado = { ...hallazgoBase, archivo: "src/renombrado.ts" };
    assert.deepEqual(
      clasificarHallazgosNuevos({
        base: [hallazgoBase],
        actuales: [renombrado],
        archivosBase: new Set([hallazgoBase.archivo]),
        hunksPorArchivo: new Map(),
      }),
      [renombrado],
    );
  });
});

describe("checkout fail-closed del gate", () => {
  it("rechaza el anchor del entrypoint modificado sin stage", async () => {
    const raiz = await crearRepoMinimo();
    await writeFile(path.join(raiz, "scripts", "lint-no-new-debt.mjs"), "const BASE = 'HEAD';\n");

    await assert.rejects(exigirCheckoutLimpio(raiz), /lint-no-new-debt\.mjs/);
  });

  it("rechaza eslint.config.js modificado y staged", async () => {
    const raiz = await crearRepoMinimo();
    await writeFile(path.join(raiz, "eslint.config.js"), "export default [{ rules: {} }];\n");
    await git(raiz, "add", "eslint.config.js");

    await assert.rejects(exigirCheckoutLimpio(raiz), /eslint\.config\.js/);
  });

  it("rechaza cualquier archivo untracked", async () => {
    const raiz = await crearRepoMinimo();
    await writeFile(path.join(raiz, "evasión-untracked.ts"), "const valor: any = 1;\n");

    await assert.rejects(exigirCheckoutLimpio(raiz), /evasión-untracked\.ts/);
  });

  it("rechaza un rename staged", async () => {
    const raiz = await crearRepoMinimo();
    await git(raiz, "mv", "tracked.ts", "movido.ts");

    await assert.rejects(exigirCheckoutLimpio(raiz), /tracked\.ts|movido\.ts/);
  });

  it("rechaza un anchor protegido de CI que no coincide con el hardcodeado", () => {
    assert.throws(
      () => validarAnclaCi("HEAD", "1b3bc2ceedf41e6506b26b4968b3243165e980bd"),
      /ancla protegida de CI no coincide/i,
    );
  });
});

describe("configuración ESLint aislada por commit", () => {
  it("detecta una regla nueva aunque la misma línea existiera bajo la config propia de la base", async () => {
    const raiz = await mkdtemp(path.join(tmpdir(), "lint-config-aislada-test-"));
    temporales.push(raiz);
    await git(raiz, "init", "--initial-branch=main");
    await git(raiz, "config", "user.email", "lint-test@local.invalid");
    await git(raiz, "config", "user.name", "Lint test");
    await writeFile(path.join(raiz, "package.json"), '{"type":"module"}\n');
    await writeFile(
      path.join(raiz, "eslint.config.js"),
      'export default [{ files: ["**/*.js"], rules: { "no-console": "off" } }];\n',
    );
    await writeFile(path.join(raiz, "app.js"), 'console.log("histórico");\n');
    await git(raiz, "add", ".");
    await git(raiz, "commit", "-m", "base con regla apagada");
    const { stdout: baseSha } = await git(raiz, "rev-parse", "HEAD");

    await writeFile(
      path.join(raiz, "eslint.config.js"),
      'export default [{ files: ["**/*.js"], rules: { "no-console": "error" } }];\n',
    );
    await git(raiz, "add", "eslint.config.js");
    await git(raiz, "commit", "-m", "activa regla");

    await assert.rejects(
      ejecutarGateLint({ raiz, baseSha: baseSha.trim() }),
      /1 hallazgo\(s\) nuevo\(s\).*no-console/s,
    );
  });
});
