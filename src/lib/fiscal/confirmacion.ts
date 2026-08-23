import type { Letra } from "./codigos";
import type { ReceptorFiscalConfirmado } from "./receptor";
import { sha256HexUtf8 } from "./snapshot";

export type ConfirmacionFiscalPostBorrador = {
  version: 1;
  importe: string;
  emisorCuit: string;
  puntoVenta: number;
  modo: "PRODUCCION" | "HOMOLOGACION";
  letra: Letra;
  cbteTipo: number;
  fechaFiscal: string;
  receptor: ReceptorFiscalConfirmado;
};

export function copiarConfirmacionFiscal(
  confirmacion: ConfirmacionFiscalPostBorrador,
): ConfirmacionFiscalPostBorrador {
  return {
    version: 1,
    importe: confirmacion.importe,
    emisorCuit: confirmacion.emisorCuit,
    puntoVenta: confirmacion.puntoVenta,
    modo: confirmacion.modo,
    letra: confirmacion.letra,
    cbteTipo: confirmacion.cbteTipo,
    fechaFiscal: confirmacion.fechaFiscal,
    receptor: {
      razonSocial: confirmacion.receptor.razonSocial,
      domicilio: confirmacion.receptor.domicilio,
      tipoDocumento: confirmacion.receptor.tipoDocumento,
      numeroDocumento: confirmacion.receptor.numeroDocumento,
      docTipoArca: confirmacion.receptor.docTipoArca,
      docNroArca: confirmacion.receptor.docNroArca,
      condicionIva: confirmacion.receptor.condicionIva,
      origen: confirmacion.receptor.origen,
      origenId: confirmacion.receptor.origenId,
      verificadoArcaAt: confirmacion.receptor.verificadoArcaAt,
    },
  };
}

export function crearHuellaConfirmacionFiscal(
  confirmacion: ConfirmacionFiscalPostBorrador,
): string {
  return sha256HexUtf8(JSON.stringify(copiarConfirmacionFiscal(confirmacion)));
}

export function confirmacionesFiscalesIguales(
  izquierda: ConfirmacionFiscalPostBorrador,
  derecha: ConfirmacionFiscalPostBorrador,
): boolean {
  return (
    JSON.stringify(copiarConfirmacionFiscal(izquierda)) ===
    JSON.stringify(copiarConfirmacionFiscal(derecha))
  );
}

export function verificarHuellaConfirmacionFiscal(
  confirmacion: ConfirmacionFiscalPostBorrador,
  huella: string,
): boolean {
  return crearHuellaConfirmacionFiscal(confirmacion) === huella;
}
