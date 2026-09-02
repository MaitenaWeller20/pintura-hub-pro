export const FORMAS_PAGO_CORREGIBLES = [
  "EFECTIVO",
  "TRANSFERENCIA",
  "TARJETA_DEBITO",
  "TARJETA_CREDITO",
  "MERCADO_PAGO",
  "CHEQUE",
] as const;

export type FormaPagoCorregible = (typeof FORMAS_PAGO_CORREGIBLES)[number];

export function validarCorreccionFormaPago({
  formaActual,
  formaNueva,
  motivo,
}: {
  formaActual: string;
  formaNueva: FormaPagoCorregible;
  motivo: string;
}): string | null {
  if (formaActual === formaNueva) {
    return "Elegí una forma de pago distinta de la actual.";
  }
  const motivoLimpio = motivo.trim();
  if (motivoLimpio.length < 5) {
    return "Escribí un motivo concreto para que la corrección quede auditada.";
  }
  if (motivoLimpio.length > 1000) {
    return "El motivo no puede superar los 1000 caracteres.";
  }
  return null;
}

const MENSAJES_CORRECCION_PAGO_USUARIO = new Set([
  "Iniciá sesión nuevamente para corregir la forma de pago.",
  "Sólo un administrador puede corregir la forma de pago.",
  "Elegí el pago que querés corregir.",
  "El pago seleccionado ya no existe.",
  "La venta seleccionada ya no existe.",
  "No se puede corregir un pago de una venta anulada.",
  "Sólo se puede corregir un pago con importe positivo.",
  "Cuenta corriente no es una forma de pago corregible.",
  "Elegí una forma de pago distinta de la actual.",
  "Escribí un motivo concreto para que la corrección quede auditada.",
  "El motivo no puede superar los 1000 caracteres.",
  "Otra persona corrigió este pago. Cerrá esta ventana, revisá los cambios y volvé a intentarlo.",
]);

export function mensajeErrorCorreccionFormaPago(error: unknown): string {
  const mensaje =
    error instanceof Error
      ? error.message.trim()
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message).trim()
        : "";
  if (MENSAJES_CORRECCION_PAGO_USUARIO.has(mensaje)) return mensaje;
  return "No pudimos corregir la forma de pago. No se guardó ningún cambio; actualizá la venta y volvé a intentar.";
}

type CorreccionCajaDesconocida = {
  campos_modificados?: unknown;
  valores_anteriores?: unknown;
  valores_nuevos?: unknown;
};

export type CorreccionFormaPagoCaja = {
  pagoId: string;
  ventaId: string;
  formaAnterior: string;
  formaNueva: string;
  monto: number;
};

function esRegistro(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leerPago(value: unknown) {
  if (!esRegistro(value) || !esRegistro(value.pago)) return null;
  const pago = value.pago;
  if (
    typeof pago.id !== "string" ||
    typeof pago.venta_id !== "string" ||
    typeof pago.forma_pago !== "string" ||
    typeof pago.monto !== "number" ||
    !Number.isFinite(pago.monto)
  ) {
    return null;
  }
  return pago as {
    id: string;
    venta_id: string;
    forma_pago: string;
    monto: number;
  };
}

export function leerCorreccionFormaPagoCaja(
  correccion: CorreccionCajaDesconocida,
): CorreccionFormaPagoCaja | null {
  if (
    !Array.isArray(correccion.campos_modificados) ||
    !correccion.campos_modificados.includes("forma_pago_venta")
  ) {
    return null;
  }
  const anterior = leerPago(correccion.valores_anteriores);
  const nuevo = leerPago(correccion.valores_nuevos);
  if (!anterior || !nuevo || anterior.id !== nuevo.id || anterior.venta_id !== nuevo.venta_id) {
    return null;
  }
  return {
    pagoId: nuevo.id,
    ventaId: nuevo.venta_id,
    formaAnterior: anterior.forma_pago,
    formaNueva: nuevo.forma_pago,
    monto: nuevo.monto,
  };
}
