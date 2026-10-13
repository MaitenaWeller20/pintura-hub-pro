export type EstadoIngresoMercaderia = "BORRADOR" | "CONFIRMADO" | "ANULADO";

export type LineaCorreccionIngreso = {
  itemId: string;
  descripcion: string;
  cantidadAnterior: number;
  cantidadNueva: number;
};

export type CambioCorreccionIngreso = LineaCorreccionIngreso & {
  delta: number;
};

const MAX_CANTIDAD = 999_999_999_999.99;

function cantidadValida(cantidad: number) {
  if (!Number.isFinite(cantidad) || cantidad < 0 || cantidad > MAX_CANTIDAD) return false;
  return Math.abs(cantidad * 100 - Math.round(cantidad * 100)) < 1e-7;
}

function normalizarCantidad(cantidad: number) {
  return Math.round(cantidad * 100) / 100;
}

export function puedeAbrirCorreccionIngreso(input: { isAdmin: boolean; estado: string }) {
  return input.isAdmin && input.estado === "CONFIRMADO";
}

export function calcularCambiosCorreccionIngreso(
  items: LineaCorreccionIngreso[],
): CambioCorreccionIngreso[] {
  return items.flatMap((item) => {
    if (!cantidadValida(item.cantidadNueva)) {
      throw new Error("La cantidad debe ser mayor o igual a cero y tener hasta dos decimales.");
    }
    if (!cantidadValida(item.cantidadAnterior)) {
      throw new Error("La cantidad registrada del producto no es válida.");
    }

    const cantidadAnterior = normalizarCantidad(item.cantidadAnterior);
    const cantidadNueva = normalizarCantidad(item.cantidadNueva);
    if (cantidadAnterior === cantidadNueva) return [];

    return [
      {
        ...item,
        cantidadAnterior,
        cantidadNueva,
        delta: normalizarCantidad(cantidadNueva - cantidadAnterior),
      },
    ];
  });
}

export function prepararSolicitudCorreccionIngreso(input: {
  ingresoId: string;
  idempotencyKey: string;
  motivo: string;
  items: LineaCorreccionIngreso[];
}) {
  const motivo = input.motivo.trim();
  if (!motivo) throw new Error("El motivo de la corrección es obligatorio.");
  if (motivo.length > 500) throw new Error("El motivo admite hasta 500 caracteres.");
  if (!input.idempotencyKey) throw new Error("Falta la clave de seguridad de la corrección.");

  const cambios = calcularCambiosCorreccionIngreso(input.items);
  if (cambios.length === 0) {
    throw new Error("Modificá al menos una cantidad antes de guardar el cambio.");
  }

  return {
    p_ingreso_id: input.ingresoId,
    p_items: cambios.map((cambio) => ({
      item_id: cambio.itemId,
      cantidad_nueva: cambio.cantidadNueva,
    })),
    p_motivo: motivo,
    p_idempotency_key: input.idempotencyKey,
  };
}
