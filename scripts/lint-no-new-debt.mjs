import { fileURLToPath } from "node:url";
import path from "node:path";
import { ANCLA_DEUDA_LINT, ejecutarGateLint, validarAnclaCi } from "./lint-no-new-debt-gate.mjs";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.length > 2) {
  console.error("El gate no admite opciones ni actualización de baseline.");
  process.exit(2);
}

try {
  validarAnclaCi(process.env.LINT_NO_NEW_DEBT_BASE_SHA);
  const { actuales, base } = await ejecutarGateLint({ raiz });
  console.log(
    `Sin deuda nueva de lint contra ${ANCLA_DEUDA_LINT.slice(0, 12)}: ` +
      `${actuales.length} hallazgos actuales, ${base.length} en la base con su configuración propia.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
