type ErrorLecturaDetalle = { message: string };

type RespuestaLecturaDetalle<T> = {
  data: T[] | null;
  error: ErrorLecturaDetalle | null;
};

export async function cargarDetalleVentaCompleto<TItem, TPago>(input: {
  cargarItems(): Promise<RespuestaLecturaDetalle<TItem>>;
  cargarPagos(): Promise<RespuestaLecturaDetalle<TPago>>;
}): Promise<{ items: TItem[]; pagos: TPago[] }> {
  const [items, pagos] = await Promise.all([input.cargarItems(), input.cargarPagos()]);

  if (items.error) {
    throw new Error(`No se pudieron cargar los ítems de la venta: ${items.error.message}`);
  }
  if (!items.data) {
    throw new Error("No se pudieron cargar los ítems de la venta: respuesta incompleta");
  }
  if (pagos.error) {
    throw new Error(`No se pudieron cargar los pagos de la venta: ${pagos.error.message}`);
  }
  if (!pagos.data) {
    throw new Error("No se pudieron cargar los pagos de la venta: respuesta incompleta");
  }

  return { items: items.data, pagos: pagos.data };
}
