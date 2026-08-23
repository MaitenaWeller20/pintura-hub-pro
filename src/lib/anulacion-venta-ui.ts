import { uuidv4 } from "./uuid";

export type IntentoAnulacion<T extends { id: string }> = {
  venta: T;
  idempotencyKey: string;
};

/** Una apertura representa un intento recuperable: sus reintentos conservan la clave. */
export function crearIntentoAnulacion<T extends { id: string }>(
  venta: T,
  generarClave: () => string = uuidv4,
): IntentoAnulacion<T> {
  return { venta, idempotencyKey: generarClave() };
}

export function solicitudAnulacion<T extends { id: string }>(intento: IntentoAnulacion<T>) {
  return {
    venta_id: intento.venta.id,
    idempotency_key: intento.idempotencyKey,
  };
}

type ReferenciaBloqueoAnulacion = { current: boolean };

/** Cierra la ventana entre un doble click y el próximo render de React. */
export function adquirirBloqueoAnulacion(bloqueo: ReferenciaBloqueoAnulacion): boolean {
  if (bloqueo.current) return false;
  bloqueo.current = true;
  return true;
}

export function liberarBloqueoAnulacion(bloqueo: ReferenciaBloqueoAnulacion): void {
  bloqueo.current = false;
}
