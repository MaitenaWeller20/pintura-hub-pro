// UUID v4 con fallback.
//
// `crypto.randomUUID()` sólo existe en "secure contexts": https y localhost.
// La clienta puede entrar a la app por IP de la red local (http://192.168.x.x),
// donde NO es un secure context y `crypto.randomUUID` es undefined. Sin fallback,
// cualquier flujo que genere una clave de idempotencia tira y no se puede
// guardar nada. `crypto.getRandomValues` sí está disponible en http.
export function uuidv4(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();

  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // versión 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante 10xx
  const hex: string[] = [];
  for (let i = 0; i < 256; i++) hex.push((i + 0x100).toString(16).slice(1));
  const b = bytes;
  return (
    hex[b[0]] +
    hex[b[1]] +
    hex[b[2]] +
    hex[b[3]] +
    "-" +
    hex[b[4]] +
    hex[b[5]] +
    "-" +
    hex[b[6]] +
    hex[b[7]] +
    "-" +
    hex[b[8]] +
    hex[b[9]] +
    "-" +
    hex[b[10]] +
    hex[b[11]] +
    hex[b[12]] +
    hex[b[13]] +
    hex[b[14]] +
    hex[b[15]]
  );
}
