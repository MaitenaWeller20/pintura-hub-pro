import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const validador = fileURLToPath(new URL("./validar-entorno-publico-build.mjs", import.meta.url));
const raizProyecto = fileURLToPath(new URL("../", import.meta.url));

function ejecutarValidador(overrides = {}) {
  const env = { ...process.env };
  for (const nombre of [
    "VERCEL",
    "VERCEL_ENV",
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
  ]) {
    delete env[nombre];
  }

  return spawnSync(process.execPath, [validador], {
    encoding: "utf8",
    env: { ...env, ...overrides },
  });
}

test("rechaza placeholders secretos antes de compilar el cliente", () => {
  const resultado = ejecutarValidador({
    VITE_SUPABASE_URL: "[SENSITIVE]",
    VITE_SUPABASE_PUBLISHABLE_KEY: "[SENSITIVE]",
  });

  assert.notEqual(resultado.status, 0);
  assert.match(resultado.stderr, /VITE_SUPABASE_URL.*placeholder/i);
  assert.match(resultado.stderr, /VITE_SUPABASE_PUBLISHABLE_KEY.*placeholder/i);
});

test("rechaza un deployment de Vercel sin configuración pública de Supabase", () => {
  const resultado = ejecutarValidador({ VERCEL: "1" });

  assert.notEqual(resultado.status, 0);
  assert.match(resultado.stderr, /VITE_SUPABASE_URL.*obligatoria/i);
  assert.match(resultado.stderr, /VITE_SUPABASE_PUBLISHABLE_KEY.*obligatoria/i);
});

test("acepta una URL HTTPS y una clave publicable reales", () => {
  const resultado = ejecutarValidador({
    VERCEL: "1",
    VITE_SUPABASE_URL: "https://proyecto.supabase.co",
    VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_prueba",
  });

  assert.equal(resultado.status, 0, resultado.stderr);
});

test("el comando build bloquea el artefacto antes de compilar placeholders", () => {
  const resultado = spawnSync("bun", ["run", "build"], {
    cwd: raizProyecto,
    encoding: "utf8",
    env: {
      ...process.env,
      NITRO_PRESET: "vercel",
      VERCEL: "1",
      VITE_SUPABASE_URL: "[SENSITIVE]",
      VITE_SUPABASE_PUBLISHABLE_KEY: "[SENSITIVE]",
    },
    timeout: 30_000,
  });
  const salida = `${resultado.stdout}\n${resultado.stderr}`;

  assert.notEqual(resultado.status, 0);
  assert.match(salida, /\[build-env\].*VITE_SUPABASE_URL/is);
  assert.doesNotMatch(salida, /building client environment/i);
});
