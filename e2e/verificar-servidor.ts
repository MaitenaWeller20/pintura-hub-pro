/**
 * Antes de correr nada: confirmar que en el puerto está NUESTRA app.
 *
 * `reuseExistingServer: true` hace que Playwright, si encuentra algo escuchando
 * en el puerto, lo dé por bueno y no levante el dev server. El 8080 es un puerto
 * muy popular: alcanza con que haya quedado corriendo cualquier otra cosa —pasó
 * con un `python -m http.server` de otro proyecto— para que las 100 pruebas
 * fallen todas en el login, con un timeout que no dice nada del motivo real.
 *
 * Esto lo convierte en un mensaje solo, claro, y antes de perder diez minutos.
 */
import type { FullConfig } from "@playwright/test";

export default async function verificarServidor(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) return;

  const url = `${baseURL}/auth`;
  let cuerpo = "";
  let estado = 0;
  try {
    const r = await fetch(url);
    estado = r.status;
    cuerpo = await r.text();
  } catch (e) {
    throw new Error(
      `No se pudo hablar con ${url}.\n` +
        `Levantá el entorno con: bun run dev  (y supabase start si hace falta)\n` +
        `Detalle: ${(e as Error).message}`,
    );
  }

  // El <title> lo pone la app; cualquier otro servidor no lo va a tener.
  const esNuestra = estado === 200 && /PinturaGest/i.test(cuerpo);
  if (!esNuestra) {
    throw new Error(
      `En ${baseURL} hay algo escuchando, pero NO es PinturaGest ` +
        `(GET /auth devolvió ${estado}).\n` +
        `Playwright lo estaba tomando por el dev server y todas las pruebas ` +
        `fallaban en el login sin decir por qué.\n\n` +
        `Mirá qué lo ocupa:  lsof -nP -iTCP:${new URL(baseURL).port} -sTCP:LISTEN\n` +
        `Después cerrá ese proceso, o cambiá PUERTO en playwright.config.ts.`,
    );
  }
}
