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
