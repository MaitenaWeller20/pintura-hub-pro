import { describe, expect, it } from "vitest";
import {
  cambiarReceptorConfirmacion,
  crearEstadoConfirmacionFiscal,
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
});
