import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clasificarHallazgosNuevos, parsearHunksGit } from "./lint-no-new-debt-lib.mjs";

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
});
