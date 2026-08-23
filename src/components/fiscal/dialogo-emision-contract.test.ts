import { describe, expect, it, vi } from "vitest";
import {
  despacharRespuestaConfirmacionFiscal,
  parsePreviewEmisionFiscal,
  parsePreviewEmisionFiscalAutoritativa,
  parseRespuestaConfirmacionFiscal,
  parseResultadoConciliacionFiscal,
  parseResultadoLiberacionFiscal,
  reconfirmarPreviewEmisionFiscal,
} from "./dialogo-emision-contract";
import {
  crearHuellaConfirmacionFiscal,
  type ConfirmacionFiscalPostBorrador,
} from "@/lib/fiscal/confirmacion";

const HUELLA_CONFIRMACION = "9d5026caa845681a6d62da9ccd828217c554c8d2822531c5399931e733a0bae9";

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
  emisorRazonSocial: "EMISOR AUTORITATIVO S.A.",
  sucursalId: "30000000-0000-4000-8000-000000000001",
  sucursalNombre: "Casa Central",
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
  emisor_razon_social: "EMISOR AUTORITATIVO S.A.",
  sucursal_id: "30000000-0000-4000-8000-000000000001",
  sucursal_nombre: "Casa Central",
  punto_venta: 5,
  modo: "PRODUCCION",
  afip_validez: "PRODUCCION",
  cbte_tipo: 1,
  cbte_asoc: null,
  demora_dias: 0,
  advertencia_demora: null,
  confirmacion_factura_a_permitida: true,
  confirmacion_autoritativa: CONFIRMACION,
  huella_confirmacion: HUELLA_CONFIRMACION,
} as const;

const PREVIEW_PROVISIONAL = {
  autoritativo: false,
  requiere_reconfirmacion_post_creacion: true,
  comprador: "20000000-0000-4000-8000-000000000001",
  receptor: RECEPTOR,
  emisor_cuit: "30714199664",
  emisor_razon_social: "EMISOR AUTORITATIVO S.A.",
  sucursal_id: "30000000-0000-4000-8000-000000000001",
  sucursal_nombre: "Casa Central",
  punto_venta: 5,
  modo: "PRODUCCION",
  afip_validez: "PRODUCCION",
  letra: "A",
  cbte_tipo: 1,
  cbte_asoc: null,
  razon_letra: "La condición determina letra A.",
  fecha_comercial: "2026-08-23T15:00:00.000Z",
  fecha_fiscal: "2026-08-23",
  demora_dias: 0,
  advertencia_demora: null,
  total: "121.00",
  pagado: "121.00",
  saldo: "0.00",
  confirmacion_factura_a_permitida: true,
  huella_confirmacion: HUELLA_CONFIRMACION,
  confirmacion_provisional: {
    version: 1,
    importe: "121.00",
    emisor_cuit: "30714199664",
    emisor_razon_social: "EMISOR AUTORITATIVO S.A.",
    sucursal_id: "30000000-0000-4000-8000-000000000001",
    sucursal_nombre: "Casa Central",
    punto_venta: 5,
    modo: "PRODUCCION",
    letra: "A",
    cbte_tipo: 1,
    fecha_fiscal: "2026-08-23",
    receptor: RECEPTOR,
  },
  advertencia: "Se revalidará contra la venta persistida.",
} as const;

function respuestaReconfirmacion(
  confirmacion: ConfirmacionFiscalPostBorrador = CONFIRMACION,
  cambiosPreview: Record<string, unknown> = {},
) {
  const huella = crearHuellaConfirmacionFiscal(confirmacion);
  const preview = {
    ...PREVIEW,
    ...cambiosPreview,
    total: confirmacion.importe,
    fecha_fiscal: confirmacion.fechaFiscal,
    receptor: confirmacion.receptor,
    letra: confirmacion.letra,
    emisor_cuit: confirmacion.emisorCuit,
    emisor_razon_social: confirmacion.emisorRazonSocial,
    sucursal_id: confirmacion.sucursalId,
    sucursal_nombre: confirmacion.sucursalNombre,
    punto_venta: confirmacion.puntoVenta,
    modo: confirmacion.modo,
    afip_validez: confirmacion.modo,
    cbte_tipo: confirmacion.cbteTipo,
    confirmacion_autoritativa: confirmacion,
    huella_confirmacion: huella,
  };
  return {
    estado: "RECONFIRMACION_REQUERIDA" as const,
    mensaje: "Revisá los cambios.",
    afip_validez: confirmacion.modo,
    preview_autoritativa: preview,
    huella_confirmacion: huella,
    confirmacion_autoritativa: confirmacion,
  };
}

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

  it("exige la identidad visual autoritativa exacta del emisor y la sucursal", () => {
    expect(() =>
      parsePreviewEmisionFiscalAutoritativa({ ...PREVIEW, emisor_razon_social: undefined }),
    ).toThrow(/previsualizaci.n fiscal/i);
    expect(() =>
      parsePreviewEmisionFiscalAutoritativa({ ...PREVIEW, sucursal_nombre: "" }),
    ).toThrow(/previsualizaci.n fiscal/i);
    expect(() =>
      parsePreviewEmisionFiscalAutoritativa({
        ...PREVIEW,
        sucursal_nombre: "Sucursal cambiada",
      }),
    ).toThrow(/previsualizaci.n fiscal/i);
  });

  it("exige validez explícita y una asociación fiscal completa cuando corresponde", () => {
    expect(() =>
      parsePreviewEmisionFiscalAutoritativa({ ...PREVIEW, afip_validez: undefined }),
    ).toThrow(/previsualizaci.n fiscal/i);
    expect(() =>
      parsePreviewEmisionFiscalAutoritativa({
        ...PREVIEW,
        cbte_asoc: { tipo: 1, punto_venta: 5, numero: 41 },
      }),
    ).toThrow(/previsualizaci.n fiscal/i);
    expect(
      parsePreviewEmisionFiscalAutoritativa({
        ...PREVIEW,
        cbte_tipo: 3,
        letra: "A",
        cbte_asoc: {
          tipo: 1,
          letra: "A",
          punto_venta: 5,
          numero: 41,
          fecha: "2026-08-20",
        },
        confirmacion_autoritativa: { ...CONFIRMACION, cbteTipo: 3 },
        huella_confirmacion: crearHuellaConfirmacionFiscal({ ...CONFIRMACION, cbteTipo: 3 }),
      }).cbte_asoc,
    ).toEqual({ tipo: 1, letra: "A", punto_venta: 5, numero: 41, fecha: "2026-08-20" });
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

  it.each(["2026-02-31", "0000-01-01", "2026-2-03"])(
    "rechaza la fecha fiscal calendario no canónica %s aun si se repite en la tupla",
    (fechaFiscal) => {
      expect(() =>
        parsePreviewEmisionFiscalAutoritativa({
          ...PREVIEW,
          fecha_fiscal: fechaFiscal,
          confirmacion_autoritativa: { ...CONFIRMACION, fechaFiscal },
        }),
      ).toThrow(/previsualizaci.n fiscal/i);
    },
  );

  it("rechaza CUIT emisor inválido aunque visible y tupla coincidan", () => {
    expect(() =>
      parsePreviewEmisionFiscalAutoritativa({
        ...PREVIEW,
        emisor_cuit: "00000000000",
        confirmacion_autoritativa: { ...CONFIRMACION, emisorCuit: "00000000000" },
      }),
    ).toThrow(/previsualizaci.n fiscal/i);
  });

  it("reutiliza las reglas canónicas del receptor para CUIT, CUIL y SIN_IDENTIFICAR", () => {
    const receptorCuilIncoherente = {
      ...RECEPTOR,
      tipoDocumento: "CUIL",
      numeroDocumento: "20123456789",
      docTipoArca: 80,
      docNroArca: "20123456789",
      condicionIva: "EXENTO",
    } as const;
    expect(() =>
      parsePreviewEmisionFiscalAutoritativa({
        ...PREVIEW,
        receptor: receptorCuilIncoherente,
        letra: "B",
        cbte_tipo: 6,
        confirmacion_autoritativa: {
          ...CONFIRMACION,
          receptor: receptorCuilIncoherente,
          letra: "B",
          cbteTipo: 6,
        },
      }),
    ).toThrow(/previsualizaci.n fiscal/i);

    const receptorAnonimoIncoherente = {
      ...RECEPTOR,
      tipoDocumento: "SIN_IDENTIFICAR",
      numeroDocumento: "0",
      docTipoArca: 99,
      docNroArca: "0",
      condicionIva: "CONSUMIDOR_FINAL",
      origen: "MANUAL",
      origenId: null,
    } as const;
    expect(() =>
      parsePreviewEmisionFiscalAutoritativa({
        ...PREVIEW,
        receptor: receptorAnonimoIncoherente,
        letra: "B",
        cbte_tipo: 6,
        confirmacion_autoritativa: {
          ...CONFIRMACION,
          receptor: receptorAnonimoIncoherente,
          letra: "B",
          cbteTipo: 6,
        },
      }),
    ).toThrow(/previsualizaci.n fiscal/i);
  });

  it.each([
    {
      ...RECEPTOR,
      razonSocial: "Receptor con CUIL",
      tipoDocumento: "CUIL",
      numeroDocumento: "20244720510",
      docTipoArca: 86,
      docNroArca: "20244720510",
      condicionIva: "EXENTO",
    },
    {
      ...RECEPTOR,
      razonSocial: "Consumidor final",
      domicilio: null,
      tipoDocumento: "SIN_IDENTIFICAR",
      numeroDocumento: null,
      docTipoArca: 99,
      docNroArca: "0",
      condicionIva: "CONSUMIDOR_FINAL",
      origen: "MANUAL",
      origenId: null,
    },
  ] as const)("acepta un receptor canónico $tipoDocumento", (receptor) => {
    const confirmacion = { ...CONFIRMACION, receptor, letra: "B" as const, cbteTipo: 6 };
    const preview = {
      ...PREVIEW,
      receptor,
      letra: "B" as const,
      cbte_tipo: 6,
      confirmacion_autoritativa: confirmacion,
      huella_confirmacion: crearHuellaConfirmacionFiscal(confirmacion),
    };
    expect(parsePreviewEmisionFiscalAutoritativa(preview)).toEqual(preview);
  });

  it.each([
    ["importe", { ...PREVIEW, total: "122.00" }],
    ["CUIT emisor", { ...PREVIEW, emisor_cuit: "30717322467" }],
    ["punto de venta", { ...PREVIEW, punto_venta: 6 }],
    ["modo", { ...PREVIEW, modo: "HOMOLOGACION" }],
    ["letra", { ...PREVIEW, letra: "B" }],
    ["CbteTipo", { ...PREVIEW, cbte_tipo: 6 }],
    ["fecha fiscal", { ...PREVIEW, fecha_fiscal: "2026-08-24" }],
    ["receptor", { ...PREVIEW, receptor: { ...RECEPTOR, razonSocial: "Otro receptor" } }],
  ] as const)("rechaza divergencia visible/tupla en %s", (_campo, preview) => {
    expect(() => parsePreviewEmisionFiscalAutoritativa(preview)).toThrow(
      /previsualizaci.n fiscal/i,
    );
  });

  it("rechaza letra o CbteTipo incompatibles con el receptor aunque la tupla coincida", () => {
    expect(() =>
      parsePreviewEmisionFiscalAutoritativa({
        ...PREVIEW,
        letra: "B",
        cbte_tipo: 6,
        confirmacion_autoritativa: { ...CONFIRMACION, letra: "B", cbteTipo: 6 },
      }),
    ).toThrow(/previsualizaci.n fiscal/i);
    expect(() =>
      parsePreviewEmisionFiscalAutoritativa({
        ...PREVIEW,
        cbte_tipo: 6,
        confirmacion_autoritativa: { ...CONFIRMACION, cbteTipo: 6 },
      }),
    ).toThrow(/previsualizaci.n fiscal/i);
  });

  it("verifica la huella SHA-256 canónica de previews autoritativas y provisionales", () => {
    expect(() =>
      parsePreviewEmisionFiscalAutoritativa({ ...PREVIEW, huella_confirmacion: "f".repeat(64) }),
    ).toThrow(/previsualizaci.n fiscal/i);
    expect(() =>
      parsePreviewEmisionFiscal({ ...PREVIEW_PROVISIONAL, huella_confirmacion: "f".repeat(64) }),
    ).toThrow(/previsualizaci.n fiscal/i);
  });

  it.each([
    ["importe", { ...PREVIEW_PROVISIONAL, total: "122.00" }],
    ["CUIT emisor", { ...PREVIEW_PROVISIONAL, emisor_cuit: "30717322467" }],
    ["punto de venta", { ...PREVIEW_PROVISIONAL, punto_venta: 6 }],
    ["modo", { ...PREVIEW_PROVISIONAL, modo: "HOMOLOGACION" }],
    ["letra", { ...PREVIEW_PROVISIONAL, letra: "B" }],
    ["CbteTipo", { ...PREVIEW_PROVISIONAL, cbte_tipo: 6 }],
    ["fecha fiscal", { ...PREVIEW_PROVISIONAL, fecha_fiscal: "2026-08-24" }],
    [
      "receptor",
      {
        ...PREVIEW_PROVISIONAL,
        receptor: { ...RECEPTOR, razonSocial: "Otro receptor" },
      },
    ],
  ] as const)("rechaza divergencia provisional visible/tupla en %s", (_campo, preview) => {
    expect(() => parsePreviewEmisionFiscal(preview)).toThrow(/previsualizaci.n fiscal/i);
  });

  it("acepta una reconfirmación completa con la huella canónica exacta", () => {
    const respuesta = respuestaReconfirmacion();
    expect(parseRespuestaConfirmacionFiscal(respuesta)).toEqual(respuesta);
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
        afip_validez: "PRODUCCION",
        huella_confirmacion: HUELLA_CONFIRMACION,
        confirmacion_autoritativa: tupla,
      }),
    ).toThrow(/respuesta fiscal/i);
  });

  it("reemplaza modo y validez juntos cuando la reconfirmación cambia de ambiente", () => {
    const confirmacion = { ...CONFIRMACION, modo: "HOMOLOGACION" as const };
    const respuesta = parseRespuestaConfirmacionFiscal(respuestaReconfirmacion(confirmacion));
    expect(respuesta.estado).toBe("RECONFIRMACION_REQUERIDA");
    if (respuesta.estado !== "RECONFIRMACION_REQUERIDA") throw new Error("Respuesta inesperada");
    expect(reconfirmarPreviewEmisionFiscal(PREVIEW, respuesta)).toMatchObject({
      autoritativo: true,
      modo: "HOMOLOGACION",
      afip_validez: "HOMOLOGACION",
      confirmacion_autoritativa: { modo: "HOMOLOGACION" },
    });
  });

  it("sustituye toda la preview por el estado autoritativo después de crear la venta", () => {
    const respuesta = parseRespuestaConfirmacionFiscal(
      respuestaReconfirmacion(CONFIRMACION, {
        venta_id: "10000000-0000-4000-8000-000000000099",
        pagado: "20.00",
        saldo: "101.00",
        comprador: null,
        demora_dias: 7,
        advertencia_demora: "Venta antigua reconfirmada por el servidor.",
        confirmacion_factura_a_permitida: false,
        cbte_asoc: {
          tipo: 1,
          letra: "A",
          punto_venta: 5,
          numero: 19,
          fecha: "2026-08-20",
        },
      }),
    );
    if (respuesta.estado !== "RECONFIRMACION_REQUERIDA") throw new Error("Respuesta inesperada");
    expect(reconfirmarPreviewEmisionFiscal(PREVIEW_PROVISIONAL, respuesta)).toMatchObject({
      autoritativo: true,
      venta_id: "10000000-0000-4000-8000-000000000099",
      pagado: "20.00",
      saldo: "101.00",
      comprador: null,
      demora_dias: 7,
      advertencia_demora: "Venta antigua reconfirmada por el servidor.",
      confirmacion_factura_a_permitida: false,
      cbte_asoc: { tipo: 1, punto_venta: 5, numero: 19, fecha: "2026-08-20" },
    });
  });

  it("rechaza una validez vieja o ausente en la reconfirmación", () => {
    const confirmacion = { ...CONFIRMACION, modo: "HOMOLOGACION" as const };
    const base = respuestaReconfirmacion(confirmacion);
    const sinValidez = { ...base } as Record<string, unknown>;
    delete sinValidez.afip_validez;
    expect(() => parseRespuestaConfirmacionFiscal(sinValidez)).toThrow(/respuesta fiscal/i);
    expect(() => parseRespuestaConfirmacionFiscal({ ...base, afip_validez: "PRODUCCION" })).toThrow(
      /respuesta fiscal/i,
    );
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
    expect(() =>
      parseRespuestaConfirmacionFiscal({
        estado: "APROBADO",
        cae: "123",
        numero: 1,
        recuperado: false,
        advertencias: [],
      }),
    ).toThrow(/respuesta fiscal/i);
    expect(() =>
      parseRespuestaConfirmacionFiscal({
        estado: "APROBADO",
        cae: "00000000000000",
        numero: 1,
        recuperado: false,
        advertencias: [],
      }),
    ).toThrow(/respuesta fiscal/i);
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
    expect(() =>
      parseResultadoConciliacionFiscal({
        estado: "APROBADO",
        cae: "CAE-invalido",
        numero: 1,
        recuperado: true,
        advertencias: [],
      }),
    ).toThrow(/conciliaci.n fiscal/i);
    expect(() =>
      parseResultadoConciliacionFiscal({ estado: "BLOQUEADO", diferencias: [] }),
    ).toThrow(/conciliaci.n fiscal/i);
  });

  it("valida directamente el resultado de liberación", () => {
    expect(parseResultadoLiberacionFiscal({ estado: "LIBERADO" })).toEqual({
      estado: "LIBERADO",
    });
    expect(() =>
      parseResultadoLiberacionFiscal({ estado: "LIBERADO", venta_id: "oculto" }),
    ).toThrow(/liberaci.n fiscal/i);
    expect(() => parseResultadoLiberacionFiscal({ estado: "OK" })).toThrow(/liberaci.n fiscal/i);
  });

  it("una respuesta semánticamente inválida no dispara callbacks", () => {
    const onCompletada = vi.fn();
    const onReconfirmacion = vi.fn();
    expect(() =>
      despacharRespuestaConfirmacionFiscal(
        {
          estado: "APROBADO",
          cae: "123",
          numero: 1,
          recuperado: false,
          advertencias: [],
        },
        { onCompletada, onReconfirmacion },
      ),
    ).toThrow(/respuesta fiscal/i);
    expect(onCompletada).not.toHaveBeenCalled();
    expect(onReconfirmacion).not.toHaveBeenCalled();
  });

  it("una reconfirmación semánticamente inválida no dispara ningún callback", () => {
    const onCompletada = vi.fn();
    const onReconfirmacion = vi.fn();
    expect(() =>
      despacharRespuestaConfirmacionFiscal(
        {
          estado: "RECONFIRMACION_REQUERIDA",
          mensaje: "Revisá los cambios.",
          afip_validez: "PRODUCCION",
          huella_confirmacion: HUELLA_CONFIRMACION,
          confirmacion_autoritativa: { ...CONFIRMACION, fechaFiscal: "2026-02-31" },
        },
        { onCompletada, onReconfirmacion },
      ),
    ).toThrow(/respuesta fiscal/i);
    expect(onCompletada).not.toHaveBeenCalled();
    expect(onReconfirmacion).not.toHaveBeenCalled();
  });
});
