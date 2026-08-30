export type ErrorLecturaSegura = { message: string } | null;

type RespuestaAuditoria<T> = Promise<{ data: T | null; error: ErrorLecturaSegura }>;

export type OperadorAuditoriaRow = { nombre_completo: string | null; username: string };
export type ReintegroAuditoriaRow = {
  id: string;
  forma_pago: string;
  monto: number;
  orden: number;
};
export type StockAuditoriaRow = {
  id: string;
  cantidad: number;
  cantidad_anterior: number | null;
  cantidad_nueva: number | null;
  created_at: string;
  producto: { codigo: string; nombre: string } | Array<{ codigo: string; nombre: string }> | null;
};
export type CuentaAuditoriaRow = {
  id: string;
  tipo: string;
  estado: string;
  monto: number;
  descripcion: string | null;
  created_at: string;
};

export type AuditoriaPersistidaNotaCreditoPeriodo = {
  operador: { nombre: string; username: string } | null;
  reintegrosIntencion: Array<{ id: string; formaPago: string; monto: number; orden: number }>;
  movimientosStock: Array<{
    id: string;
    producto: string;
    cantidad: number;
    cantidadAnterior: number | null;
    cantidadNueva: number | null;
    createdAt: string;
  }>;
  movimientosCuentaCorriente: Array<{
    id: string;
    tipo: string;
    estado: string;
    monto: number;
    descripcion: string | null;
    createdAt: string;
  }>;
};

export async function cargarAuditoriaNotaCreditoPeriodo(deps: {
  cargarOperador(): RespuestaAuditoria<OperadorAuditoriaRow>;
  cargarReintegros(): RespuestaAuditoria<ReintegroAuditoriaRow[]>;
  cargarStock(): RespuestaAuditoria<StockAuditoriaRow[]>;
  cargarCuentaCorriente(): RespuestaAuditoria<CuentaAuditoriaRow[]>;
}): Promise<AuditoriaPersistidaNotaCreditoPeriodo> {
  const [operador, reintegros, stock, cuentaCorriente] = await Promise.all([
    deps.cargarOperador(),
    deps.cargarReintegros(),
    deps.cargarStock(),
    deps.cargarCuentaCorriente(),
  ]);
  if (
    operador.error ||
    !operador.data ||
    reintegros.error ||
    !reintegros.data ||
    stock.error ||
    !stock.data ||
    cuentaCorriente.error ||
    !cuentaCorriente.data
  ) {
    throw new Error("No se pudo reconstruir la auditoría de la nota de crédito.");
  }

  return {
    operador: {
      nombre: operador.data.nombre_completo?.trim() || operador.data.username,
      username: operador.data.username,
    },
    reintegrosIntencion: reintegros.data.map((row) => ({
      id: row.id,
      formaPago: row.forma_pago,
      monto: Number(row.monto),
      orden: row.orden,
    })),
    movimientosStock: stock.data.map((row) => {
      const producto = Array.isArray(row.producto) ? row.producto[0] : row.producto;
      return {
        id: row.id,
        producto: producto ? `${producto.codigo} · ${producto.nombre}` : "Producto persistido",
        cantidad: Number(row.cantidad),
        cantidadAnterior: row.cantidad_anterior == null ? null : Number(row.cantidad_anterior),
        cantidadNueva: row.cantidad_nueva == null ? null : Number(row.cantidad_nueva),
        createdAt: row.created_at,
      };
    }),
    movimientosCuentaCorriente: cuentaCorriente.data.map((row) => ({
      id: row.id,
      tipo: row.tipo,
      estado: row.estado,
      monto: Number(row.monto),
      descripcion: row.descripcion,
      createdAt: row.created_at,
    })),
  };
}
