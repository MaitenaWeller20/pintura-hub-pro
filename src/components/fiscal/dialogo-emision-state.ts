export type EstadoConfirmacionFiscal = {
  huellaConfirmacion: string | null;
  confirmaDatosManuales: boolean;
  requiereSegundaConfirmacion: boolean;
};

export function crearEstadoConfirmacionFiscal(): EstadoConfirmacionFiscal {
  return {
    huellaConfirmacion: null,
    confirmaDatosManuales: false,
    requiereSegundaConfirmacion: false,
  };
}

export function cambiarReceptorConfirmacion(
  _estado: EstadoConfirmacionFiscal,
): EstadoConfirmacionFiscal {
  return crearEstadoConfirmacionFiscal();
}

export function registrarPreviewConfirmacion(
  estado: EstadoConfirmacionFiscal,
  huella: string,
): EstadoConfirmacionFiscal {
  return { ...estado, huellaConfirmacion: huella, requiereSegundaConfirmacion: false };
}

export function registrarReconfirmacion(
  _estado: EstadoConfirmacionFiscal,
  huella: string,
): EstadoConfirmacionFiscal {
  return {
    huellaConfirmacion: huella,
    confirmaDatosManuales: false,
    requiereSegundaConfirmacion: true,
  };
}
