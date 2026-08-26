import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DialogoEmisionFiscal } from "./dialogo-emision-fiscal";
import * as estadoDialogo from "./dialogo-emision-state";
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

// Radix monta el contenido en un portal del navegador. Para esta prueba de
// componente sólo reemplazamos ese transporte: el contenido y sus controles
// siguen siendo los reales de DialogoEmisionFiscal.
vi.mock("@/components/ui/dialog", () => {
  const contenido = ({ children }: { children?: unknown }) => children;
  return {
    Dialog: contenido,
    DialogContent: contenido,
    DialogDescription: contenido,
    DialogFooter: contenido,
    DialogHeader: contenido,
    DialogTitle: contenido,
  };
});

type EstadoConLetra = ReturnType<typeof crearEstadoConfirmacionFiscal> & {
  letraSolicitada: "A" | "B" | null;
};

type CambiarLetraConfirmacion = (
  estado: EstadoConLetra,
  letra: "A" | "B",
  control: ReturnType<typeof crearControlSolicitudPreview>,
) => EstadoConLetra;

function renderDialogo(tipoComprobante = "VENTA"): string {
  return renderToStaticMarkup(
    createElement(DialogoEmisionFiscal, {
      open: true,
      contexto: {
        comprador: {
          razonSocial: "Comprador",
          documento: null,
          condicionIva: "CONSUMIDOR_FINAL",
        },
        emisor: { razonSocial: "Emisor", cuit: "30714199664" },
        sucursal: { nombre: "Casa central", puntoVenta: null, modo: null },
        tipoComprobante,
        receptorHeredado: {
          razonSocial: "Receptor original",
          tipoDocumento: "CUIT",
          numeroDocumento: "30714199664",
          condicionIva: "RESPONSABLE_INSCRIPTO",
          domicilio: "Sarmiento 123",
        },
      },
      favoritos: [],
      onOpenChange: vi.fn(),
      onPrevisualizar: vi.fn(),
      onConfirmar: vi.fn(),
    }),
  );
}

describe("estado seguro del diálogo fiscal", () => {
  it("nace sin letra para obligar al operador a elegir A o B", () => {
    expect(crearEstadoConfirmacionFiscal()).toHaveProperty("letraSolicitada", null);
  });

  it("cambiar de A a B invalida la preview en vuelo y la confirmación anterior", () => {
    const cambiarLetra = (
      estadoDialogo as typeof estadoDialogo & {
        cambiarLetraConfirmacion?: CambiarLetraConfirmacion;
      }
    ).cambiarLetraConfirmacion;
    expect(cambiarLetra).toBeTypeOf("function");
    if (!cambiarLetra) return;

    const control = crearControlSolicitudPreview();
    const conA = cambiarLetra(crearEstadoConfirmacionFiscal() as EstadoConLetra, "A", control);
    const solicitudA = iniciarSolicitudPreview(control);
    const confirmadaA = registrarPreviewConfirmacion(
      { ...conA, confirmaDatosManuales: true },
      "a".repeat(64),
    ) as EstadoConLetra;

    const conB = cambiarLetra(confirmadaA, "B", control);

    expect(esSolicitudPreviewActual(control, solicitudA!)).toBe(false);
    expect(conB).toEqual({
      letraSolicitada: "B",
      huellaConfirmacion: null,
      confirmaDatosManuales: false,
      requiereSegundaConfirmacion: false,
    });
  });

  it("editar el receptor invalida la preview y la confirmación manual", () => {
    const conPreview = registrarPreviewConfirmacion(
      crearEstadoConfirmacionFiscal(),
      "a".repeat(64),
    );
    expect(cambiarReceptorConfirmacion({ ...conPreview, confirmaDatosManuales: true })).toEqual({
      letraSolicitada: null,
      huellaConfirmacion: null,
      confirmaDatosManuales: false,
      requiereSegundaConfirmacion: false,
    });
  });

  it("una tupla autoritativa distinta limpia el ack y exige un segundo clic", () => {
    expect(registrarReconfirmacion(crearEstadoConfirmacionFiscal(), "b".repeat(64))).toEqual({
      letraSolicitada: null,
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

describe("selector de letra del diálogo compartido", () => {
  it("ofrece A y B sin preseleccionar ninguna y exige una elección", () => {
    const html = renderDialogo();
    const controlesLetra = html.match(/<input[^>]*name="letra-solicitada"[^>]*>/g) ?? [];

    expect(controlesLetra).toHaveLength(2);
    expect(controlesLetra.every((control) => control.includes('required=""'))).toBe(true);
    expect(controlesLetra.every((control) => !control.includes('checked=""'))).toBe(true);
    expect(html).toContain("Factura A");
    expect(html).toContain("Factura B");
  });

  it("no ofrece selector en una nota y mantiene visible el receptor original", () => {
    const html = renderDialogo("NOTA_CREDITO");

    expect(html).not.toContain('name="letra-solicitada"');
    expect(html).toContain("Las notas conservan el receptor del comprobante original.");
    expect(html).toContain("Receptor original");
  });
});
