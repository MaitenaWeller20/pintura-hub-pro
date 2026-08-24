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
  value: Extract<ReceptorFormulario, { origen: "MANUAL" }> = RECEPTOR_MANUAL,
): string {
  return renderToStaticMarkup(
    createElement(ReceptorFiscalForm as ReceptorFiscalFormConLetra, {
      value,
      letraSolicitada,
      favoritos: [],
      clienteComercial: { razonSocial: "Cliente comercial", documento: null },
      confirmaDatosManuales: false,
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
  it("para factura A muestra CUIT y exige completar el documento", () => {
    const html = renderFormulario("A", { ...RECEPTOR_MANUAL, numero_documento: "" });
    const documento = inputDocumento(html);

    expect(html).toMatch(
      /<label[^>]*for="receptor-numero-documento"[^>]*>[^<]*CUIT[^<]*<\/label>/i,
    );
    expect(documento).toContain('required=""');
    expect(documento).not.toContain('disabled=""');
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
