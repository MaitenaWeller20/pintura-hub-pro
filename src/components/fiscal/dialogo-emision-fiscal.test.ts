// @vitest-environment jsdom
import { createElement, StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogoEmisionFiscal } from "./dialogo-emision-fiscal";
import type { ContextoDialogoEmision } from "./dialogo-emision-fiscal";
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

const CONTEXTO_ACTIVO: ContextoDialogoEmision = {
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
};

function receptorArca(razonSocial = "IDENTIDAD OFICIAL SA") {
  return {
    estado: "VERIFICADO" as const,
    receptor: {
      cuit: "30714199664",
      razonSocial,
      domicilioFiscal: null,
      estado: "ACTIVO" as const,
      tipoPersona: "JURIDICA" as const,
      condicionIvaConfirmada: null,
      verificadoArcaAt: "2026-08-26T12:34:56.000-03:00",
    },
  };
}

function propsDialogo(
  overrides: Partial<Parameters<typeof DialogoEmisionFiscal>[0]> = {},
): Parameters<typeof DialogoEmisionFiscal>[0] {
  return {
    open: true,
    contexto: CONTEXTO_ACTIVO,
    favoritos: [],
    onOpenChange: vi.fn(),
    onConsultarCuit: vi.fn(async () => receptorArca()),
    onPrevisualizar: vi.fn(),
    onConfirmar: vi.fn(),
    ...overrides,
  };
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

  it("bloquea revisar pero conserva el debounce si la letra no cambia la clave fiscal", async () => {
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
    expect(onConsultarCuit).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(onConsultarCuit).toHaveBeenCalledOnce();
    expect(onConsultarCuit).toHaveBeenLastCalledWith({
      sucursalId: "71000000-0000-4000-8000-000000000301",
      cuit: "30714199664",
    });
  });

  it("no reutiliza el verificado de otra sucursal con el mismo CUIT", async () => {
    vi.useFakeTimers();
    const onConsultarCuit = vi.fn(async ({ sucursalId }: { sucursalId: string }) =>
      receptorArca(sucursalId.endsWith("301") ? "OFICIAL SUCURSAL A" : "OFICIAL SUCURSAL B"),
    );
    const props = propsDialogo({ onConsultarCuit });
    const vista = render(createElement(DialogoEmisionFiscal, props));
    fireEvent.click(screen.getByRole("radio", { name: /Factura A/i }));
    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(screen.getByDisplayValue("OFICIAL SUCURSAL A")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Revisar datos fiscales" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    vista.rerender(
      createElement(DialogoEmisionFiscal, {
        ...props,
        contexto: {
          ...CONTEXTO_ACTIVO,
          sucursal: {
            ...CONTEXTO_ACTIVO.sucursal,
            id: "71000000-0000-4000-8000-000000000302",
            nombre: "Sucursal B",
          },
        },
      }),
    );

    expect(screen.queryByDisplayValue("OFICIAL SUCURSAL A")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Revisar datos fiscales" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(screen.getByDisplayValue("OFICIAL SUCURSAL B")).toBeTruthy();
  });

  it("descarta una respuesta tardía de la sucursal anterior con el mismo CUIT", async () => {
    vi.useFakeTimers();
    let resolverA!: (value: ReturnType<typeof receptorArca>) => void;
    let resolverB!: (value: ReturnType<typeof receptorArca>) => void;
    const respuestaA = new Promise<ReturnType<typeof receptorArca>>((resolve) => {
      resolverA = resolve;
    });
    const respuestaB = new Promise<ReturnType<typeof receptorArca>>((resolve) => {
      resolverB = resolve;
    });
    const onConsultarCuit = vi.fn(({ sucursalId }: { sucursalId: string }) =>
      sucursalId.endsWith("301") ? respuestaA : respuestaB,
    );
    const props = propsDialogo({ onConsultarCuit });
    const vista = render(createElement(DialogoEmisionFiscal, props));
    fireEvent.click(screen.getByRole("radio", { name: /Factura A/i }));
    await act(async () => vi.advanceTimersByTimeAsync(300));

    vista.rerender(
      createElement(DialogoEmisionFiscal, {
        ...props,
        contexto: {
          ...CONTEXTO_ACTIVO,
          sucursal: { ...CONTEXTO_ACTIVO.sucursal, id: "71000000-0000-4000-8000-000000000302" },
        },
      }),
    );
    await act(async () => {
      resolverA(receptorArca("RESPUESTA VIEJA A"));
      await Promise.resolve();
    });
    expect(screen.queryByDisplayValue("RESPUESTA VIEJA A")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Revisar datos fiscales" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(300));
    await act(async () => {
      resolverB(receptorArca("RESPUESTA ACTUAL B"));
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("RESPUESTA ACTUAL B")).toBeTruthy();
  });

  it("no reconsulta por guardar, condición B ni letra si la clave fiscal no cambió", async () => {
    vi.useFakeTimers();
    const onConsultarCuit = vi.fn(async () => receptorArca());
    render(createElement(DialogoEmisionFiscal, propsDialogo({ onConsultarCuit })));
    fireEvent.click(screen.getByRole("radio", { name: /^Factura B/i }));
    fireEvent.click(screen.getByRole("radio", { name: /Otro receptor/i }));
    fireEvent.change(screen.getByLabelText(/Tipo de documento/i), { target: { value: "CUIT" } });
    fireEvent.change(screen.getByLabelText(/Número de documento/i), {
      target: { value: "30-71419966-4" },
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(onConsultarCuit).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("checkbox", { name: /Guardar para próximas facturas/i }));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(onConsultarCuit).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByLabelText("Condición de IVA"), { target: { value: "EXENTO" } });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(onConsultarCuit).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("radio", { name: /^Factura A/i }));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(onConsultarCuit).toHaveBeenCalledOnce();
  });

  it("reconsulta al cambiar el origen fiscal aunque sucursal y CUIT coincidan", async () => {
    vi.useFakeTimers();
    const favorito = {
      id: "10000000-0000-4000-8000-000000000001",
      sucursal_id: CONTEXTO_ACTIVO.sucursal.id,
      cliente_comercial_id: null,
      tipo_documento: "CUIT" as const,
      numero_documento: "30-71419966-4",
      razon_social: "Guardado viejo",
      condicion_iva: "EXENTO" as const,
      domicilio: null,
    };
    const onConsultarCuit = vi.fn(async () => receptorArca());
    render(
      createElement(DialogoEmisionFiscal, propsDialogo({ favoritos: [favorito], onConsultarCuit })),
    );
    fireEvent.click(screen.getByRole("radio", { name: /^Factura B/i }));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(onConsultarCuit).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("radio", { name: /Guardado/i }));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(onConsultarCuit).toHaveBeenCalledTimes(2);
  });

  it("en StrictMode el cleanup conserva una sola consulta efectiva", async () => {
    vi.useFakeTimers();
    const onConsultarCuit = vi.fn(async () => receptorArca());
    render(
      createElement(
        StrictMode,
        null,
        createElement(DialogoEmisionFiscal, propsDialogo({ onConsultarCuit })),
      ),
    );

    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(onConsultarCuit).toHaveBeenCalledOnce();
  });

  it("usa el callback más reciente sin reiniciar el debounce de una clave estable", async () => {
    vi.useFakeTimers();
    const anterior = vi.fn(async () => receptorArca("CALLBACK ANTERIOR"));
    const actual = vi.fn(async () => receptorArca("CALLBACK ACTUAL"));
    const props = propsDialogo({ onConsultarCuit: anterior });
    const vista = render(createElement(DialogoEmisionFiscal, props));
    await act(async () => vi.advanceTimersByTimeAsync(200));

    vista.rerender(createElement(DialogoEmisionFiscal, { ...props, onConsultarCuit: actual }));
    await act(async () => vi.advanceTimersByTimeAsync(100));

    expect(anterior).not.toHaveBeenCalled();
    expect(actual).toHaveBeenCalledOnce();
    expect(screen.getByDisplayValue("CALLBACK ACTUAL")).toBeTruthy();
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
