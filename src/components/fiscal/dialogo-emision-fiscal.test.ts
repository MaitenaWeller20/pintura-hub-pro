import { describe, expect, it } from "vitest";
import {
  cambiarReceptorConfirmacion,
  crearControlSolicitudPreview,
  crearEstadoConfirmacionFiscal,
  esSolicitudPreviewActual,
  finalizarSolicitudPreview,
  iniciarSolicitudPreview,
  invalidarSolicitudPreview,
  registrarPreviewConfirmacion,
  registrarReconfirmacion,
} from "./dialogo-emision-state";

describe("estado seguro del diálogo fiscal", () => {
  it("editar el receptor invalida la preview y la confirmación manual", () => {
    const conPreview = registrarPreviewConfirmacion(
      crearEstadoConfirmacionFiscal(),
      "a".repeat(64),
    );
    expect(cambiarReceptorConfirmacion({ ...conPreview, confirmaDatosManuales: true })).toEqual({
      huellaConfirmacion: null,
      confirmaDatosManuales: false,
      requiereSegundaConfirmacion: false,
    });
  });

  it("una tupla autoritativa distinta limpia el ack y exige un segundo clic", () => {
    expect(registrarReconfirmacion(crearEstadoConfirmacionFiscal(), "b".repeat(64))).toEqual({
      huellaConfirmacion: "b".repeat(64),
      confirmaDatosManuales: false,
      requiereSegundaConfirmacion: true,
    });
  });

  it("bloquea dos previews sincrónicas y descarta respuestas anteriores", () => {
    const control = crearControlSolicitudPreview();
    const primera = iniciarSolicitudPreview(control);
    const duplicada = iniciarSolicitudPreview(control);

    expect(primera).toBeTypeOf("number");
    expect(duplicada).toBeNull();

    invalidarSolicitudPreview(control);
    const actual = iniciarSolicitudPreview(control);
    expect(actual).toBeTypeOf("number");
    expect(esSolicitudPreviewActual(control, primera!)).toBe(false);
    expect(esSolicitudPreviewActual(control, actual!)).toBe(true);

    finalizarSolicitudPreview(control, primera!);
    expect(esSolicitudPreviewActual(control, actual!)).toBe(true);
    finalizarSolicitudPreview(control, actual!);
    expect(iniciarSolicitudPreview(control)).toBeTypeOf("number");
  });
});
