import type { Letra } from "./codigos";
import type { ReceptorFiscalConfirmado } from "./receptor";
import { sha256HexUtf8 } from "./snapshot";

export type ConfirmacionFiscalPostBorrador = {
  version: 1;
  importe: string;
  emisorCuit: string;
  emisorRazonSocial: string;
  sucursalId: string;
  sucursalNombre: string;
  puntoVenta: number;
  modo: "PRODUCCION" | "HOMOLOGACION";
  afipValidez: "PRODUCCION" | "HOMOLOGACION" | "SIMULADA";
  letra: Letra;
  cbteTipo: number;
  fechaFiscal: string;
  pagado: string;
  saldo: string;
  cbteAsoc: {
    tipo: number;
    letra: Letra;
    puntoVenta: number;
    numero: number;
    fecha: string;
  } | null;
  receptor: ReceptorFiscalConfirmado;
};

export function copiarConfirmacionFiscal(
  confirmacion: ConfirmacionFiscalPostBorrador,
): ConfirmacionFiscalPostBorrador {
  return {
    version: 1,
    importe: confirmacion.importe,
    emisorCuit: confirmacion.emisorCuit,
    emisorRazonSocial: confirmacion.emisorRazonSocial,
    sucursalId: confirmacion.sucursalId,
    sucursalNombre: confirmacion.sucursalNombre,
    puntoVenta: confirmacion.puntoVenta,
    modo: confirmacion.modo,
    afipValidez: confirmacion.afipValidez,
    letra: confirmacion.letra,
    cbteTipo: confirmacion.cbteTipo,
    fechaFiscal: confirmacion.fechaFiscal,
    pagado: confirmacion.pagado,
    saldo: confirmacion.saldo,
    cbteAsoc: confirmacion.cbteAsoc
      ? {
          tipo: confirmacion.cbteAsoc.tipo,
          letra: confirmacion.cbteAsoc.letra,
          puntoVenta: confirmacion.cbteAsoc.puntoVenta,
          numero: confirmacion.cbteAsoc.numero,
          fecha: confirmacion.cbteAsoc.fecha,
        }
      : null,
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
