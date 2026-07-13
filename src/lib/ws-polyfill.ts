// Node 20 no trae WebSocket nativo, y @supabase/supabase-js (a través de
// realtime-js) lo exige al construir el cliente en el servidor —incluso cuando
// no usamos Realtime—. Sin esto, TODA server function que crea un cliente de
// Supabase revienta con "Node.js 20 detected without native WebSocket support",
// tanto en el dev server local como en Vercel (que también corre Node 20).
//
// IMPORTANTE: se expone como función nombrada (no como side-effect de módulo) a
// propósito. `package.json` declara `"sideEffects": false`, así que un
// `import "./ws-polyfill"` a secas lo elimina el tree-shaking de Rollup. En
// cambio, una función importada y llamada nunca se descarta. Se llama dentro del
// factory de cada cliente, justo antes de `createClient`, para garantizar que el
// global exista sin importar el entry point (el build de Nitro no carga
// src/server.ts).
import { WebSocket as WsWebSocket } from "ws";

export function ensureNodeWebSocket(): void {
  const g = globalThis as { WebSocket?: unknown };
  if (typeof g.WebSocket === "undefined") {
    g.WebSocket = WsWebSocket;
  }
}
