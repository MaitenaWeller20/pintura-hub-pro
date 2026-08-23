import { describe, expect, it, vi } from "vitest";
import {
  despacharRespuestaConfirmacionFiscal,
  parsePreviewEmisionFiscal,
  parsePreviewEmisionFiscalAutoritativa,
  parseRespuestaConfirmacionFiscal,
  parseResultadoConciliacionFiscal,
} from "./dialogo-emision-contract";

const RECEPTOR = {
  razonSocial: "APLICACIONES Y SERVICIOS S.R.L.",
  domicilio: "Sarmiento 1398",
  tipoDocumento: "CUIT",
  numeroDocumento: "30714199664",
  docTipoArca: 80,
  docNroArca: "30714199664",
  condicionIva: "RESPONSABLE_INSCRIPTO",
  origen: "CLIENTE_COMERCIAL",
  origenId: "20000000-0000-4000-8000-000000000001",
  verificadoArcaAt: null,
} as const;

const CONFIRMACION = {
  version: 1,
  importe: "121.00",
  emisorCuit: "30714199664",
  puntoVenta: 5,
  modo: "PRODUCCION",
  letra: "A",
  cbteTipo: 1,
  fechaFiscal: "2026-08-23",
  receptor: RECEPTOR,
} as const;

const PREVIEW = {
  autoritativo: true,
  venta_id: "10000000-0000-4000-8000-000000000001",
  fecha_comercial: "2026-08-23T15:00:00.000Z",
  fecha_fiscal: "2026-08-23",
  total: "121.00",
  pagado: "121.00",
  saldo: "0.00",
  comprador: "20000000-0000-4000-8000-000000000001",
  receptor: RECEPTOR,
  letra: "A",
  razon_letra: "La condición determina letra A.",
  emisor_cuit: "30714199664",
  punto_venta: 5,
  modo: "PRODUCCION",
  cbte_tipo: 1,
  demora_dias: 0,
  advertencia_demora: null,
  confirmacion_factura_a_permitida: true,
  confirmacion_autoritativa: CONFIRMACION,
  huella_confirmacion: "a".repeat(64),
} as const;

const PREVIEW_PROVISIONAL = {
  autoritativo: false,
  requiere_reconfirmacion_post_creacion: true,
  comprador: "20000000-0000-4000-8000-000000000001",
  receptor: RECEPTOR,
  emisor_cuit: "30714199664",
  punto_venta: 5,
  modo: "PRODUCCION",
  letra: "A",
  razon_letra: "La condición determina letra A.",
  fecha_comercial: "2026-08-23T15:00:00.000Z",
  fecha_fiscal: "2026-08-23",
  demora_dias: 0,
  advertencia_demora: null,
  total: "121.00",
  pagado: "121.00",
  saldo: "0.00",
  confirmacion_factura_a_permitida: true,
  huella_confirmacion: "c".repeat(64),
  confirmacion_provisional: {
    importe: "121.00",
    emisor_cuit: "30714199664",
    punto_venta: 5,
    modo: "PRODUCCION",
    letra: "A",
    receptor: RECEPTOR,
  },
  advertencia: "Se revalidará contra la venta persistida.",
} as const;

describe("contrato runtime del diálogo fiscal", () => {
  it("acepta sólo la preview autoritativa completa", () => {
    expect(parsePreviewEmisionFiscal(PREVIEW)).toEqual(PREVIEW);
    expect(() =>
      parsePreviewEmisionFiscal({
        huella_confirmacion: "a".repeat(64),
        total: "121.00",
        receptor: {},
      }),
    ).toThrow(/previsualizaci.n fiscal/i);
    expect(() => parsePreviewEmisionFiscal({ ...PREVIEW, campo_inventado: true })).toThrow();
    expect(() => parsePreviewEmisionFiscal({ ...PREVIEW, total: "-1.00" })).toThrow();
  });

  it("conserva el contrato estricto de preview provisional para el cierre inmediato", () => {
    expect(parsePreviewEmisionFiscal(PREVIEW_PROVISIONAL)).toEqual(PREVIEW_PROVISIONAL);
    expect(() =>
      parsePreviewEmisionFiscal({ ...PREVIEW_PROVISIONAL, confirmacion_provisional: {} }),
    ).toThrow(/previsualizaci.n fiscal/i);
  });

  it("impide que la cola acepte una preview provisional aunque esté completa", () => {
    expect(parsePreviewEmisionFiscalAutoritativa(PREVIEW)).toEqual(PREVIEW);
    expect(() => parsePreviewEmisionFiscalAutoritativa(PREVIEW_PROVISIONAL)).toThrow(
      /autoritativa/i,
    );
  });

  it.each([
    "version",
    "importe",
    "emisorCuit",
    "puntoVenta",
    "modo",
    "letra",
    "cbteTipo",
    "fechaFiscal",
    "receptor",
  ] as const)("rechaza reconfirmación sin %s", (campo) => {
    const tupla = { ...CONFIRMACION } as Record<string, unknown>;
    delete tupla[campo];
    expect(() =>
      parseRespuestaConfirmacionFiscal({
        estado: "RECONFIRMACION_REQUERIDA",
        mensaje: "Revisá los cambios.",
        huella_confirmacion: "b".repeat(64),
        confirmacion_autoritativa: tupla,
      }),
    ).toThrow(/respuesta fiscal/i);
  });

  it("acepta sólo estados de emisión conocidos y completos", () => {
    expect(
      parseRespuestaConfirmacionFiscal({
        estado: "APROBADO",
        cae: "74111111111111",
        numero: 1,
        recuperado: false,
        advertencias: [],
      }),
    ).toMatchObject({ estado: "APROBADO" });
    expect(() => parseRespuestaConfirmacionFiscal({ estado: "APROBADO" })).toThrow(
      /respuesta fiscal/i,
    );
    expect(() => parseRespuestaConfirmacionFiscal({ estado: "EXITO", mensaje: "listo" })).toThrow(
      /respuesta fiscal/i,
    );
  });

  it.each([{ estado: "EXITO", mensaje: "listo" }, { estado: "APROBADO" }])(
    "no dispara éxito ni reconfirmación para una respuesta inválida: %o",
    (respuesta) => {
      const onCompletada = vi.fn();
      const onReconfirmacion = vi.fn();
      expect(() =>
        despacharRespuestaConfirmacionFiscal(respuesta, { onCompletada, onReconfirmacion }),
      ).toThrow(/respuesta fiscal/i);
      expect(onCompletada).not.toHaveBeenCalled();
      expect(onReconfirmacion).not.toHaveBeenCalled();
    },
  );

  it("aplica el mismo cierre estricto a conciliación", () => {
    expect(
      parseResultadoConciliacionFiscal({
        estado: "BLOQUEADO",
        diferencias: ["secuencia"],
      }),
    ).toEqual({ estado: "BLOQUEADO", diferencias: ["secuencia"] });
    expect(() => parseResultadoConciliacionFiscal({ estado: "DESCONOCIDO" })).toThrow(
      /conciliaci.n fiscal/i,
    );
  });
});
