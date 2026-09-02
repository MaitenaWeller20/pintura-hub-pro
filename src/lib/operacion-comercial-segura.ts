export const MENSAJES_ERROR_OPERACION = {
  CAJA_NO_DISPONIBLE: "La caja de esta sucursal ya no está abierta. Abrila y volvé a intentar.",
  CLIENTE_INVALIDO: "El cliente no existe, está inactivo o no es válido para esta operación.",
  PRESUPUESTO_NO_EDITABLE:
    "El presupuesto ya no está abierto. Actualizá la pantalla antes de continuar.",
  PRESUPUESTO_SIN_ACCESO: "No se pudo leer el presupuesto o no tenés acceso.",
  CONFLICTO_REINTENTO:
    "La operación ya fue confirmada con otros datos. Actualizá la pantalla antes de continuar.",
  CONSUMIDOR_FINAL_INVALIDO:
    "No se pudo configurar Consumidor Final. Pedile a un administrador que revise el cliente genérico.",
  DATOS_INVALIDOS: "Revisá los datos ingresados y volvé a intentar.",
  MANTENIMIENTO: "La facturación está en mantenimiento. No se registró ningún cambio comercial.",
  ERROR_INTERNO: "No se pudo completar la operación. Volvé a intentar.",
} as const;

export type CodigoErrorOperacion = keyof typeof MENSAJES_ERROR_OPERACION;
export type ErrorOperacionSegura = Readonly<{
  codigo: CodigoErrorOperacion;
  mensaje: (typeof MENSAJES_ERROR_OPERACION)[CodigoErrorOperacion];
}>;
export type ResultadoOperacionSegura<T> =
  | Readonly<{ ok: true; valor: T }>
  | Readonly<{ ok: false; error: ErrorOperacionSegura }>;
export type AmbitoOperacionComercial =
  | "CREAR_PRESUPUESTO"
  | "EDITAR_PRESUPUESTO"
  | "CONVERTIR_PRESUPUESTO";

export function mensajeErrorOperacion<Codigo extends CodigoErrorOperacion>(
  codigo: Codigo,
): (typeof MENSAJES_ERROR_OPERACION)[Codigo] {
  return MENSAJES_ERROR_OPERACION[codigo];
}

function mensajeCausa(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

export function codigoSeguroParaError(cause: unknown): CodigoErrorOperacion {
  const mensaje = mensajeCausa(cause).toLocaleLowerCase("es");
  if (/presupuesto inexistente|presupuesto no encontrado|sin acceso|otra sucursal/.test(mensaje)) {
    return "PRESUPUESTO_SIN_ACCESO";
  }
  if (
    /ya fue convertido con otros datos|ya hay una venta cargada con la clave de este presupuesto/.test(
      mensaje,
    )
  ) {
    return "CONFLICTO_REINTENTO";
  }
  if (
    /ya (?:está|fue) (?:convertido|anulado)|presupuesto está anulado|presupuesto ya se convirti[oó]/.test(
      mensaje,
    )
  ) {
    return "PRESUPUESTO_NO_EDITABLE";
  }
  if (/consumidor final|cliente gen[eé]rico|candidato/.test(mensaje)) {
    return "CONSUMIDOR_FINAL_INVALIDO";
  }
  if (/cliente inexistente|cliente inactivo|identific[aá] un cliente/.test(mensaje)) {
    return "CLIENTE_INVALIDO";
  }
  if (/caja abierta|caja de la sucursal|caja prevalidada/.test(mensaje)) {
    return "CAJA_NO_DISPONIBLE";
  }
  if (/mantenimiento|ambos escritores|ningún escritor/.test(mensaje)) return "MANTENIMIENTO";
  if (
    /descripci[oó]n|cantidad inv[aá]lida|descuento inv[aá]lido|producto repetido|producto .*?(?:inexistente|inactivo|archivado|ya no existe)|presupuesto necesita al menos un producto|presupuesto no tiene productos|pagos?.*inv[aá]lid|formato inv[aá]lid|cambi[oó] el iva|venta al contado se cobra/.test(
      mensaje,
    )
  ) {
    return "DATOS_INVALIDOS";
  }
  return "ERROR_INTERNO";
}

function registrarPredeterminado(ambito: AmbitoOperacionComercial, cause: unknown): void {
  console.error(`[${ambito}] operación rechazada en servidor`, cause);
}

export async function ejecutarOperacionComercialSegura<T>(
  ambito: AmbitoOperacionComercial,
  ejecutar: () => Promise<T>,
  registrar: (ambito: AmbitoOperacionComercial, cause: unknown) => void = registrarPredeterminado,
): Promise<ResultadoOperacionSegura<T>> {
  try {
    return { ok: true, valor: await ejecutar() };
  } catch (cause) {
    registrar(ambito, cause);
    const codigo = codigoSeguroParaError(cause);
    return { ok: false, error: { codigo, mensaje: mensajeErrorOperacion(codigo) } };
  }
}
