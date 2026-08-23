import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { crearHuellaConfirmacionFiscal } from "@/lib/fiscal/confirmacion";
import { ResumenEmisionFiscal, type PreviewEmisionFiscal } from "./resumen-emision-fiscal";

function preview(overrides: Partial<PreviewEmisionFiscal> = {}): PreviewEmisionFiscal {
  const receptor = {
    razonSocial: "RECEPTOR FISCAL",
    domicilio: "Belgrano 500, Córdoba",
    tipoDocumento: "CUIT" as const,
    numeroDocumento: "30714199664",
    docTipoArca: 80 as const,
    docNroArca: "30714199664",
    condicionIva: "RESPONSABLE_INSCRIPTO" as const,
    origen: "MANUAL" as const,
    origenId: null,
    verificadoArcaAt: null,
  };
  const confirmacion = {
    version: 1 as const,
    importe: "121.00",
    emisorCuit: "30714199664",
    emisorRazonSocial: "EMISOR",
    sucursalId: "30000000-0000-4000-8000-000000000001",
    sucursalNombre: "Casa Central",
    puntoVenta: 5,
    modo: "PRODUCCION" as const,
    afipValidez: "SIMULADA" as const,
    letra: "A" as const,
    cbteTipo: 3,
    fechaFiscal: "2026-08-23",
    pagado: "121.00",
    saldo: "0.00",
    cbteAsoc: {
      tipo: 1,
      letra: "A" as const,
      puntoVenta: 5,
      numero: 41,
      fecha: "2026-08-20",
    },
    receptor,
  };
  return {
    autoritativo: true,
    venta_id: "10000000-0000-4000-8000-000000000001",
    fecha_comercial: "2026-08-23T15:00:00.000Z",
    fecha_fiscal: "2026-08-23",
    total: "121.00",
    pagado: "121.00",
    saldo: "0.00",
    comprador: null,
    receptor,
    letra: "A",
    razon_letra: "La condición determina letra A.",
    emisor_cuit: "30714199664",
    emisor_razon_social: "EMISOR",
    sucursal_id: "30000000-0000-4000-8000-000000000001",
    sucursal_nombre: "Casa Central",
    punto_venta: 5,
    modo: "PRODUCCION",
    afip_validez: "SIMULADA",
    cbte_tipo: 3,
    cbte_asoc: { tipo: 1, letra: "A", punto_venta: 5, numero: 41, fecha: "2026-08-20" },
    demora_dias: 0,
    advertencia_demora: null,
    confirmacion_factura_a_permitida: true,
    confirmacion_autoritativa: confirmacion,
    huella_confirmacion: crearHuellaConfirmacionFiscal(confirmacion),
    ...overrides,
  } as PreviewEmisionFiscal;
}

describe("resumen de confirmación fiscal", () => {
  it("no presenta una simulación como producción legal", () => {
    const html = renderToStaticMarkup(
      createElement(ResumenEmisionFiscal, { preview: preview(), comprador: "COMPRADOR" }),
    );
    expect(html).toContain("Simulada");
    expect(html).toContain("sin validez legal");
    expect(html).not.toContain(">Producción<");
  });

  it("muestra el tipo real, domicilio y CbteAsoc completo", () => {
    const html = renderToStaticMarkup(
      createElement(ResumenEmisionFiscal, { preview: preview(), comprador: "COMPRADOR" }),
    );
    expect(html).toContain("Nota de crédito A");
    expect(html).toContain("Belgrano 500, Córdoba");
    expect(html).toContain("Factura A");
    expect(html).toContain("PV 00005");
    expect(html).toContain("00000041");
    expect(html).toContain("20/08/2026");
  });

  it("en la segunda confirmación muestra el cobrado y saldo autoritativos", () => {
    const html = renderToStaticMarkup(
      createElement(ResumenEmisionFiscal, {
        preview: preview({ pagado: "20.00", saldo: "101.00" }),
        comprador: "COMPRADOR",
        requiereSegundaConfirmacion: true,
      }),
    );
    expect(html).toContain("20,00");
    expect(html).toContain("101,00");
    expect(html).not.toContain("El servidor lo confirmará al emitir");
  });
});
