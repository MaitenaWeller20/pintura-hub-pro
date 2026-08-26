// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogoEmisionFiscal } from "./dialogo-emision-fiscal";
import * as dialogoEmisionContract from "./dialogo-emision-contract";
import * as estadoDialogo from "./dialogo-emision-state";
import {
  cambiarReceptorConfirmacion,
  crearControlSolicitudPreview,
  crearEstadoConfirmacionFiscal,
  esSolicitudPreviewActual,
  finalizarSolicitudPreview,
  iniciarSolicitudPreview,
  invalidarHuellaConfirmacion,
  invalidarSolicitudPreview,
  registrarPreviewConfirmacion,
  registrarReconfirmacion,
} from "./dialogo-emision-state";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

type ManejarErrorCorregibleDialogo = (
  resultado: {
    estado: "ERROR_CORREGIBLE";
    codigo: "PADRON_ARCA_CAIDO";
    mensaje: string;
  },
  acciones: {
    invalidarPreview(): void;
    limpiarPreview(): void;
    limpiarHuella(): void;
    limpiarConfirmacionVentaAntigua(): void;
    mostrarError(mensaje: string): void;
  },
) => void;

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
        sucursal: {
          id: "71000000-0000-4000-8000-000000000301",
          nombre: "Casa central",
          puntoVenta: null,
          modo: null,
        },
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
      onConsultarCuit: vi.fn(),
      onConfirmar: vi.fn(),
    }),
  );
}

describe("estado seguro del diálogo fiscal", () => {
  it("iniciar una consulta nueva borra huella y reconfirmación sin alterar la declaración manual", () => {
    expect(
      invalidarHuellaConfirmacion({
        letraSolicitada: "B",
        huellaConfirmacion: "a".repeat(64),
        confirmaDatosManuales: true,
        requiereSegundaConfirmacion: true,
      }),
    ).toEqual({
      letraSolicitada: "B",
      huellaConfirmacion: null,
      confirmaDatosManuales: true,
      requiereSegundaConfirmacion: false,
    });
  });
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

  it("un error corregible invalida preview y huella y muestra el mensaje seguro", () => {
    const manejarError = (
      dialogoEmisionContract as typeof dialogoEmisionContract & {
        manejarErrorCorregibleDialogo?: ManejarErrorCorregibleDialogo;
      }
    ).manejarErrorCorregibleDialogo;
    expect(manejarError).toBeTypeOf("function");
    if (!manejarError) return;
    const invalidarPreview = vi.fn();
    const limpiarPreview = vi.fn();
    const limpiarHuella = vi.fn();
    const limpiarConfirmacionVentaAntigua = vi.fn();
    const mostrarError = vi.fn();

    manejarError(
      {
        estado: "ERROR_CORREGIBLE",
        codigo: "PADRON_ARCA_CAIDO",
        mensaje:
          "ARCA está caído y no pudimos verificar el CUIT. No se emitió ningún comprobante. Intentá nuevamente en otro momento.",
      },
      {
        invalidarPreview,
        limpiarPreview,
        limpiarHuella,
        limpiarConfirmacionVentaAntigua,
        mostrarError,
      },
    );

    expect(invalidarPreview).toHaveBeenCalledOnce();
    expect(limpiarPreview).toHaveBeenCalledOnce();
    expect(limpiarHuella).toHaveBeenCalledOnce();
    expect(limpiarConfirmacionVentaAntigua).toHaveBeenCalledOnce();
    expect(mostrarError).toHaveBeenCalledWith(
      "ARCA está caído y no pudimos verificar el CUIT. No se emitió ningún comprobante. Intentá nuevamente en otro momento.",
    );
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

  it("bloquea revisar y reprograma la consulta si la selección cambia durante el debounce", async () => {
    vi.useFakeTimers();
    const onConsultarCuit = vi.fn(() => new Promise<never>(() => undefined));
    render(
      createElement(DialogoEmisionFiscal, {
        open: true,
        contexto: {
          comprador: {
            razonSocial: "Comprador",
            documento: "30-71419966-4",
            condicionIva: "CONSUMIDOR_FINAL",
          },
          emisor: { razonSocial: "Emisor", cuit: "30714199664" },
          sucursal: {
            id: "71000000-0000-4000-8000-000000000301",
            nombre: "Casa central",
            puntoVenta: null,
            modo: null,
          },
          tipoComprobante: "VENTA",
        },
        favoritos: [],
        onOpenChange: vi.fn(),
        onConsultarCuit,
        onPrevisualizar: vi.fn(),
        onConfirmar: vi.fn(),
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.click(screen.getByRole("radio", { name: /Factura A/i }));
    expect(
      (screen.getByRole("button", { name: "Revisar datos fiscales" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(document.body.contains(screen.getByText("Consultando CUIT en ARCA…"))).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(onConsultarCuit).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(onConsultarCuit).toHaveBeenCalledWith({
      sucursalId: "71000000-0000-4000-8000-000000000301",
      cuit: "30714199664",
    });
  });

  it("una nota de crédito no monta la consulta viva del padrón", async () => {
    vi.useFakeTimers();
    const onConsultarCuit = vi.fn();
    render(
      createElement(DialogoEmisionFiscal, {
        open: true,
        contexto: {
          comprador: {
            razonSocial: "Comprador",
            documento: "30-71419966-4",
            condicionIva: "CONSUMIDOR_FINAL",
          },
          emisor: { razonSocial: "Emisor", cuit: "30714199664" },
          sucursal: {
            id: "71000000-0000-4000-8000-000000000301",
            nombre: "Casa central",
            puntoVenta: null,
            modo: null,
          },
          tipoComprobante: "NOTA_CREDITO",
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
        onConsultarCuit,
        onPrevisualizar: vi.fn(),
        onConfirmar: vi.fn(),
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onConsultarCuit).not.toHaveBeenCalled();
  });
});
