import type { ReceptorFormulario } from "./receptor-fiscal-form";

export type LetraSolicitada = "A" | "B";

export type EstadoConfirmacionFiscal = {
  letraSolicitada: LetraSolicitada | null;
  huellaConfirmacion: string | null;
  confirmaDatosManuales: boolean;
  requiereSegundaConfirmacion: boolean;
};

export type ControlSolicitudPreview = {
  secuencia: number;
  activa: number | null;
};

export function adaptarReceptorFormularioALetra(
  value: ReceptorFormulario,
  letraSolicitada: LetraSolicitada,
): ReceptorFormulario {
  if (value.origen !== "MANUAL") return value;
  if (letraSolicitada === "B") {
    return {
      ...value,
      condicion_iva:
        value.condicion_iva === "CONSUMIDOR_FINAL" || value.condicion_iva === "EXENTO"
          ? value.condicion_iva
          : "CONSUMIDOR_FINAL",
    };
  }

  const conservaCuit = value.tipo_documento === "CUIT";
  return {
    ...value,
    tipo_documento: "CUIT",
    numero_documento: conservaCuit ? value.numero_documento : "",
    condicion_iva:
      value.condicion_iva === "RESPONSABLE_INSCRIPTO" || value.condicion_iva === "MONOTRIBUTO"
        ? value.condicion_iva
        : "RESPONSABLE_INSCRIPTO",
    guardar_para_proximas: conservaCuit ? value.guardar_para_proximas : false,
  };
}

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

export function crearEstadoConfirmacionFiscal(
  letraSolicitada: LetraSolicitada | null = null,
): EstadoConfirmacionFiscal {
  return {
    letraSolicitada,
    huellaConfirmacion: null,
    confirmaDatosManuales: false,
    requiereSegundaConfirmacion: false,
  };
}

export function cambiarReceptorConfirmacion(
  estado: EstadoConfirmacionFiscal,
): EstadoConfirmacionFiscal {
  return crearEstadoConfirmacionFiscal(estado.letraSolicitada);
}

export function cambiarLetraConfirmacion(
  _estado: EstadoConfirmacionFiscal,
  letraSolicitada: LetraSolicitada,
  control: ControlSolicitudPreview,
): EstadoConfirmacionFiscal {
  invalidarSolicitudPreview(control);
  return crearEstadoConfirmacionFiscal(letraSolicitada);
}

export function registrarPreviewConfirmacion(
  estado: EstadoConfirmacionFiscal,
  huella: string,
): EstadoConfirmacionFiscal {
  return { ...estado, huellaConfirmacion: huella, requiereSegundaConfirmacion: false };
}

export function registrarReconfirmacion(
  estado: EstadoConfirmacionFiscal,
  huella: string,
): EstadoConfirmacionFiscal {
  return {
    letraSolicitada: estado.letraSolicitada,
    huellaConfirmacion: huella,
    confirmaDatosManuales: false,
    requiereSegundaConfirmacion: true,
  };
}
