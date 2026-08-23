export type EstadoConfirmacionFiscal = {
  huellaConfirmacion: string | null;
  confirmaDatosManuales: boolean;
  requiereSegundaConfirmacion: boolean;
};

export type ControlSolicitudPreview = {
  secuencia: number;
  activa: number | null;
};

export function crearControlSolicitudPreview(): ControlSolicitudPreview {
  return { secuencia: 0, activa: null };
}

/** Lock sincrónico: dos eventos en el mismo render no pueden iniciar dos requests. */
export function iniciarSolicitudPreview(control: ControlSolicitudPreview): number | null {
  if (control.activa !== null) return null;
  control.secuencia += 1;
  control.activa = control.secuencia;
  return control.activa;
}

export function invalidarSolicitudPreview(control: ControlSolicitudPreview): void {
  control.secuencia += 1;
  control.activa = null;
}

export function esSolicitudPreviewActual(control: ControlSolicitudPreview, token: number): boolean {
  return control.activa === token;
}

export function finalizarSolicitudPreview(control: ControlSolicitudPreview, token: number): void {
  if (control.activa === token) control.activa = null;
}

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
