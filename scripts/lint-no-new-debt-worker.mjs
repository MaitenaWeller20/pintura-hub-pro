import path from "node:path";
import { ESLint } from "eslint";
import { normalizarResultados } from "./lint-no-new-debt-lib.mjs";

if (process.argv.length < 3 || process.argv.length > 5) {
  throw new Error("El worker de lint recibió argumentos inválidos.");
}

const raiz = path.resolve(process.argv[2]);
const configExterna = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const excluirGenerado = process.argv[4] === "--excluir-tipos-generados";
const eslint = new ESLint({
  cwd: raiz,
  ...(configExterna ? { overrideConfigFile: configExterna } : {}),
  ...(excluirGenerado
    ? { overrideConfig: [{ ignores: ["src/integrations/supabase/types.ts"] }] }
    : {}),
});
const resultados = normalizarResultados(await eslint.lintFiles([raiz]), raiz);
process.stdout.write(JSON.stringify(resultados));
