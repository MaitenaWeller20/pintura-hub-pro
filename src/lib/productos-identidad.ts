type IdentidadProducto = {
  codigo: unknown;
  nombre: unknown;
  proveedorId: unknown;
};

type ErrorBase = { code?: string; message?: string } | null | undefined;

export function claveProductoProveedor(codigo: unknown, proveedorId: unknown): string {
  return `${String(proveedorId ?? "").trim()}\u0000${String(codigo ?? "").trim()}`;
}

export function productoGuardadoParaProveedor<T>(
  guardados: ReadonlyMap<string, T>,
  codigo: unknown,
  proveedorId: unknown,
): T | undefined {
  return (
    guardados.get(claveProductoProveedor(codigo, proveedorId)) ??
    guardados.get(claveProductoProveedor(codigo, null))
  );
}

export function faltanteAltaProducto(input: IdentidadProducto): string | null {
  if (!String(input.codigo ?? "").trim()) return "Ingresá el código del producto.";
  if (!String(input.nombre ?? "").trim()) return "Ingresá el nombre del producto.";
  if (!String(input.proveedorId ?? "").trim()) return "Elegí el proveedor del producto.";
  return null;
}

export function mensajeErrorProducto(
  error: ErrorBase,
  identidad: { codigo: unknown; proveedorNombre: unknown },
): string {
  const mensaje = error?.message ?? "";
  const esCodigoRepetidoDelProveedor =
    error?.code === "23505" && mensaje.includes("productos_proveedor_codigo_key");

  if (!esCodigoRepetidoDelProveedor) return mensaje || "No se pudo guardar el producto.";

  const codigo = String(identidad.codigo ?? "").trim();
  const proveedor = String(identidad.proveedorNombre ?? "").trim() || "ese proveedor";
  return `Ya existe un producto con el código ${codigo} para ${proveedor}. Buscalo y editá ese registro.`;
}
