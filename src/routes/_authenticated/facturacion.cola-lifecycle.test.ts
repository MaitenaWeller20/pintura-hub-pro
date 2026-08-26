import { describe, expect, it } from "vitest";
import {
  despacharRespuestaConfirmacionFiscal,
  manejarErrorCorregibleDialogo,
} from "@/components/fiscal/dialogo-emision-contract";
import {
  huellaConsultaCola,
  retenerSeleccionColaFiscalHastaCerrar,
  resolverCicloSeleccionColaFiscal,
  type SeleccionColaFiscal,
  type TabColaFiscal,
} from "@/lib/fiscal/cola-ui";

const VENTA = "10000000-0000-4000-8000-000000000001";
const MENSAJE_CAIDA_ARCA =
  "ARCA está caído y no pudimos verificar el CUIT. No se emitió ningún comprobante. Intentá nuevamente en otro momento.";

type Fila = {
  venta_id: string;
  afip_estado: "SIN_FACTURAR" | "ERROR_CORREGIBLE";
  tab: TabColaFiscal;
};

describe("ciclo del diálogo de emisión en la ruta de cola", () => {
  it("retiene el error al mover la venta de pendientes a revisar y navega sólo al cerrar", () => {
    const search = { tab: "pendientes" as const, page: 1, venta: VENTA };
    const huella = huellaConsultaCola(search);
    const filaPendiente: Fila = {
      venta_id: VENTA,
      afip_estado: "SIN_FACTURAR",
      tab: "pendientes",
    };
    let seleccion = retenerSeleccionColaFiscalHastaCerrar({
      fila: filaPendiente,
      huellaConsulta: huella,
    });

    const filaMovida: Fila = {
      venta_id: VENTA,
      afip_estado: "ERROR_CORREGIBLE",
      tab: "revisar",
    };
    const duranteError = resolverCicloSeleccionColaFiscal({
      seleccion,
      huellaConsulta: huella,
      isPlaceholderData: false,
      tab: search.tab,
      venta: search.venta,
      filas: [filaMovida],
    });
    seleccion = duranteError.seleccion;

    let mensajeVisible: string | null = null;
    let preview: object | null = {};
    let huellaPreview: string | null = "a".repeat(64);
    let completada = false;
    if (seleccion) {
      despacharRespuestaConfirmacionFiscal(
        {
          estado: "ERROR_CORREGIBLE",
          codigo: "PADRON_ARCA_CAIDO",
          mensaje: "texto remoto que no debe mostrarse",
        },
        {
          onReconfirmacion: () => {
            throw new Error("No corresponde reconfirmar.");
          },
          onErrorCorregible: (resultado) =>
            manejarErrorCorregibleDialogo(resultado, {
              invalidarPreview: () => undefined,
              limpiarPreview: () => {
                preview = null;
              },
              limpiarHuella: () => {
                huellaPreview = null;
              },
              limpiarConfirmacionVentaAntigua: () => undefined,
              mostrarError: (mensaje) => {
                mensajeVisible = mensaje;
              },
            }),
          onCompletada: () => {
            completada = true;
          },
        },
      );
    }

    expect(duranteError.tabAutoritativo).toBe("pendientes");
    expect(seleccion?.fila).toBe(filaMovida);
    expect(mensajeVisible).toBe(MENSAJE_CAIDA_ARCA);
    expect(preview).toBeNull();
    expect(huellaPreview).toBeNull();
    expect(completada).toBe(false);

    const despuesDeCerrar = resolverCicloSeleccionColaFiscal({
      seleccion: null,
      huellaConsulta: huella,
      isPlaceholderData: false,
      tab: search.tab,
      venta: search.venta,
      filas: [filaMovida],
    });
    expect(despuesDeCerrar.seleccion).toBeNull();
    expect(despuesDeCerrar.tabAutoritativo).toBe("revisar");
  });
});
