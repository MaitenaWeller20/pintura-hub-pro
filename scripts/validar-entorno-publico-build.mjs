const NOMBRE_URL = "VITE_SUPABASE_URL";
const NOMBRE_CLAVE = "VITE_SUPABASE_PUBLISHABLE_KEY";
const PLACEHOLDER_SECRETO = /^\[(?:sensitive|redacted|secret)\]$/i;

const url = process.env[NOMBRE_URL]?.trim();
const clave = process.env[NOMBRE_CLAVE]?.trim();
const esDeploymentVercel = process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
const errores = [];

for (const [nombre, valor] of [
  [NOMBRE_URL, url],
  [NOMBRE_CLAVE, clave],
]) {
  if (valor && PLACEHOLDER_SECRETO.test(valor)) {
    errores.push(`${nombre} contiene un placeholder secreto y no puede compilarse.`);
  } else if (!valor && esDeploymentVercel) {
    errores.push(`${nombre} es obligatoria en deployments de Vercel.`);
  }
}

if (url && !PLACEHOLDER_SECRETO.test(url)) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errores.push(`${NOMBRE_URL} debe usar HTTP o HTTPS.`);
    }
  } catch {
    errores.push(`${NOMBRE_URL} debe ser una URL HTTP o HTTPS válida.`);
  }
}

if (errores.length > 0) {
  console.error(`[build-env] Build bloqueado:\n- ${errores.join("\n- ")}`);
  process.exitCode = 1;
}
