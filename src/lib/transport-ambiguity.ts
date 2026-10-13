const NOMBRES_AMBIGUOS = new Set(["aborterror", "timeouterror"]);
const TIPOS_AMBIGUOS = new Set(["aborterror", "timeouterror"]);
const CODIGOS_AMBIGUOS = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETRESET",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ERR_NETWORK",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const MENSAJES_AMBIGUOS = new Set([
  "failed to fetch",
  "fetch failed",
  "load failed",
  "networkerror when attempting to fetch resource.",
]);
const ESTADOS_PROXY_AMBIGUOS = new Set([502, 503, 504]);
const MAX_PROFUNDIDAD_CAUSA = 6;

function registro(value: unknown): Record<PropertyKey, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<PropertyKey, unknown>)
    : null;
}

function textoExacto(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function numeroEstado(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  return null;
}

/** Sólo reconoce señales de transporte conocidas; nunca busca substrings de negocio. */
export function esFalloTransporteAmbiguo(cause: unknown): boolean {
  const pendientes: Array<{ value: unknown; profundidad: number }> = [
    { value: cause, profundidad: 0 },
  ];
  const vistos = new Set<object>();

  while (pendientes.length > 0) {
    const actual = pendientes.shift();
    if (!actual) break;
    const objeto = registro(actual.value);
    if (!objeto || vistos.has(objeto)) continue;
    vistos.add(objeto);

    const nombre = textoExacto(objeto.name);
    const tipo = textoExacto(objeto.type);
    const mensaje = textoExacto(objeto.message);
    const codigo = typeof objeto.code === "string" ? objeto.code.trim().toUpperCase() : null;
    if (nombre && NOMBRES_AMBIGUOS.has(nombre)) return true;
    if (tipo && TIPOS_AMBIGUOS.has(tipo)) return true;
    if (mensaje && MENSAJES_AMBIGUOS.has(mensaje)) return true;
    if (codigo && CODIGOS_AMBIGUOS.has(codigo)) return true;

    for (const campo of ["status", "statusCode"] as const) {
      const estado = numeroEstado(objeto[campo]);
      if (estado !== null && ESTADOS_PROXY_AMBIGUOS.has(estado)) return true;
    }

    if (actual.profundidad >= MAX_PROFUNDIDAD_CAUSA) continue;
    for (const campo of ["cause", "reason", "error", "response"] as const) {
      if (objeto[campo] !== undefined) {
        pendientes.push({ value: objeto[campo], profundidad: actual.profundidad + 1 });
      }
    }
  }
  return false;
}
