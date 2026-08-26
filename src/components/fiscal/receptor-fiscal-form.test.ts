import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReceptorFiscalForm, type ReceptorFormulario } from "./receptor-fiscal-form";
import * as estadoDialogo from "./dialogo-emision-state";

const RECEPTOR_MANUAL: Extract<ReceptorFormulario, { origen: "MANUAL" }> = {
  origen: "MANUAL",
  tipo_documento: "CUIT",
  numero_documento: "30714199664",
  razon_social: "Receptor de prueba",
  condicion_iva: "CONSUMIDOR_FINAL",
  domicilio: "",
  guardar_para_proximas: false,
};

type LetraSolicitada = "A" | "B";

type AdaptarReceptorFormularioALetra = (
  value: ReceptorFormulario,
  letraSolicitada: LetraSolicitada,
) => ReceptorFormulario;

type ReceptorFiscalFormConLetra = (
  props: Parameters<typeof ReceptorFiscalForm>[0] & {
    letraSolicitada: LetraSolicitada;
  },
) => ReturnType<typeof ReceptorFiscalForm>;

function renderFormulario(
  letraSolicitada: LetraSolicitada,
  value: ReceptorFormulario = RECEPTOR_MANUAL,
  errores: Partial<
    Record<
      | "cliente_comercial"
      | "receptor"
      | "tipo_documento"
      | "numero_documento"
      | "razon_social"
      | "condicion_iva"
      | "confirmacion",
      string
    >
  > = {},
): string {
  return renderToStaticMarkup(
    createElement(ReceptorFiscalForm as ReceptorFiscalFormConLetra, {
      value,
      letraSolicitada,
      favoritos: [],
      clienteComercial: {
        razonSocial: "Cliente comercial",
        documento: null,
        condicionIva: "CONSUMIDOR_FINAL",
      },
      confirmaDatosManuales: false,
      errores,
      disabled: false,
      onChange: vi.fn(),
      onConfirmaDatosManuales: vi.fn(),
    }),
  );
}

function inputDocumento(html: string): string {
  return html.match(/<input[^>]*id="receptor-numero-documento"[^>]*>/)?.[0] ?? "";
}

function select(html: string, id: string): string {
  return html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>[\\s\\S]*?<\\/select>`))?.[0] ?? "";
}

describe("receptor según la letra solicitada", () => {
  it("explica cuándo usar el cliente comercial y cuándo otro receptor", () => {
    const html = renderFormulario("B");

    expect(html).toContain("Sólo para factura B a Consumidor Final sin identificación fiscal.");
    expect(html).toContain("Ingresá los datos de otra persona o empresa.");
  });

  it("asocia la incompatibilidad del cliente comercial con su opción", () => {
    const mensaje = "Cliente comercial sólo permite factura B sin identificación fiscal.";
    const html = renderFormulario(
      "A",
      { origen: "CLIENTE_COMERCIAL" },
      {
        cliente_comercial: mensaje,
      },
    );
    const opcion = html.match(/<input[^>]*id="receptor-cliente-comercial"[^>]*>/)?.[0] ?? "";

    expect(opcion).toContain('aria-invalid="true"');
    expect(opcion).toContain('aria-describedby="error-receptor-cliente-comercial"');
    expect(html).toContain(mensaje);
  });

  it("para factura A muestra CUIT y exige completar el documento", () => {
    const html = renderFormulario("A", { ...RECEPTOR_MANUAL, numero_documento: "" });
    const documento = inputDocumento(html);

    expect(html).toMatch(
      /<label[^>]*for="receptor-numero-documento"[^>]*>[^<]*CUIT[^<]*<\/label>/i,
    );
    expect(documento).toContain('required=""');
    expect(documento).not.toContain('disabled=""');
  });

  it("marca la razón social y explica cómo corregirla", () => {
    const mensaje =
      "Completá la razón social del receptor. ARCA la necesita para identificar a quién se emite el comprobante.";
    const html = renderFormulario(
      "B",
      { ...RECEPTOR_MANUAL, razon_social: "" },
      {
        razon_social: mensaje,
      },
    );
    const razonSocial = html.match(/<input[^>]*id="receptor-razon-social"[^>]*>/)?.[0] ?? "";

    expect(razonSocial).toContain('aria-invalid="true"');
    expect(razonSocial).toContain('aria-describedby="error-receptor-razon-social"');
    expect(html).toContain(`id="error-receptor-razon-social"`);
    expect(html).toContain(mensaje);
  });

  it("asocia el error de confirmación con su casilla", () => {
    const mensaje = "Confirmá que revisaste los datos fiscales ingresados antes de continuar.";
    const html = renderFormulario("B", RECEPTOR_MANUAL, { confirmacion: mensaje });
    const confirmacion = html.match(/<input[^>]*id="confirmar-datos-receptor"[^>]*>/)?.[0] ?? "";

    expect(confirmacion).toContain('aria-invalid="true"');
    expect(confirmacion).toContain('aria-describedby="error-confirmar-datos-receptor"');
    expect(html).toContain(`id="error-confirmar-datos-receptor"`);
    expect(html).toContain(mensaje);
  });

  it("para factura A sólo permite CUIT y condiciones Responsable Inscripto o Monotributo", () => {
    const html = renderFormulario("A");
    const condicion = select(html, "receptor-condicion-iva");

    expect(html).not.toContain('id="receptor-tipo-documento"');
    expect(condicion).toContain('value="RESPONSABLE_INSCRIPTO"');
    expect(condicion).toContain('value="MONOTRIBUTO"');
    expect(condicion).not.toContain('value="CONSUMIDOR_FINAL"');
    expect(condicion).not.toContain('value="EXENTO"');
  });

  it("para factura B conserva una identificación cargada pero no la vuelve obligatoria", () => {
    const html = renderFormulario("B");
    const documento = inputDocumento(html);

    expect(documento).toContain('value="30714199664"');
    expect(documento).not.toContain('required=""');
    expect(documento).not.toContain('disabled=""');
  });

  it("explica y marca como obligatorio el documento de un receptor Exento", () => {
    const html = renderFormulario("B", {
      ...RECEPTOR_MANUAL,
      numero_documento: "",
      condicion_iva: "EXENTO",
    });

    expect(html).toContain("Los receptores Exentos deben identificarse con un documento válido.");
    expect(inputDocumento(html)).toContain('required=""');
    expect(html).not.toContain("Número de documento (opcional)");
  });

  it("asocia el error de identificación del Exento con el selector de documento", () => {
    const mensaje = "Un receptor Exento debe identificarse con un documento válido.";
    const html = renderFormulario(
      "B",
      {
        ...RECEPTOR_MANUAL,
        tipo_documento: "SIN_IDENTIFICAR",
        numero_documento: "",
        condicion_iva: "EXENTO",
      },
      { tipo_documento: mensaje },
    );
    const tipoDocumento = html.match(/<select[^>]*id="receptor-tipo-documento"[^>]*>/)?.[0];

    expect(tipoDocumento).toContain('aria-invalid="true"');
    expect(tipoDocumento).toContain('aria-describedby="error-receptor-tipo-documento"');
    expect(html).toContain(mensaje);
  });

  it("para factura B también permite continuar sin identificación", () => {
    const html = renderFormulario("B", {
      ...RECEPTOR_MANUAL,
      tipo_documento: "SIN_IDENTIFICAR",
      numero_documento: "",
    });

    expect(html).toContain('value="SIN_IDENTIFICAR" selected=""');
    expect(inputDocumento(html)).not.toContain('required=""');
  });

  it("para factura B ofrece identificación opcional y sólo condiciones CF o Exento", () => {
    const html = renderFormulario("B");
    const tipoDocumento = select(html, "receptor-tipo-documento");
    const condicion = select(html, "receptor-condicion-iva");

    for (const tipo of ["CUIT", "CUIL", "DNI", "CDI", "SIN_IDENTIFICAR"]) {
      expect(tipoDocumento).toContain(`value="${tipo}"`);
    }
    expect(condicion).toContain('value="CONSUMIDOR_FINAL"');
    expect(condicion).toContain('value="EXENTO"');
    expect(condicion).not.toContain('value="RESPONSABLE_INSCRIPTO"');
    expect(condicion).not.toContain('value="MONOTRIBUTO"');
  });

  it("al cambiar letra adapta un receptor manual sin conservar datos incompatibles", () => {
    const adaptar = (
      estadoDialogo as typeof estadoDialogo & {
        adaptarReceptorFormularioALetra?: AdaptarReceptorFormularioALetra;
      }
    ).adaptarReceptorFormularioALetra;
    expect(adaptar).toBeTypeOf("function");
    if (!adaptar) return;

    expect(
      adaptar(
        {
          ...RECEPTOR_MANUAL,
          tipo_documento: "DNI",
          numero_documento: "30111222",
          condicion_iva: "CONSUMIDOR_FINAL",
        },
        "A",
      ),
    ).toEqual({
      ...RECEPTOR_MANUAL,
      tipo_documento: "CUIT",
      numero_documento: "",
      condicion_iva: "RESPONSABLE_INSCRIPTO",
    });

    expect(
      adaptar(
        {
          ...RECEPTOR_MANUAL,
          tipo_documento: "CUIT",
          numero_documento: "30714199664",
          condicion_iva: "MONOTRIBUTO",
        },
        "B",
      ),
    ).toEqual({
      ...RECEPTOR_MANUAL,
      tipo_documento: "CUIT",
      numero_documento: "30714199664",
      condicion_iva: "CONSUMIDOR_FINAL",
    });
  });
});
