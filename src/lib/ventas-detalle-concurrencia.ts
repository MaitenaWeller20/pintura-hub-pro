export type SolicitudDetalleVenta = number;

/**
 * Evita que una respuesta anterior pise el detalle elegido más recientemente.
 * Las requests pueden terminar fuera de orden; sólo la última conserva vigencia.
 */
export function crearSecuenciadorDetalleVenta() {
  let ultimaSolicitud = 0;

  return {
    iniciar(): SolicitudDetalleVenta {
      ultimaSolicitud += 1;
      return ultimaSolicitud;
    },
    esVigente(solicitud: SolicitudDetalleVenta): boolean {
      return solicitud === ultimaSolicitud;
    },
  };
}
