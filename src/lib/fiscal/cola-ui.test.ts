import { describe, expect, it } from "vitest";
import {
  actualizarBusquedaCola,
  clasificarInteraccionCola,
  crearActualizadorBusquedaCola,
  accionesColaHabilitadas,
  cerrarResultadoCola,
  debeRefrescarCola,
  huellaConsultaCola,
  normalizarBusquedaCola,
  presentarResultadoCola,
  presentarEstadoColaFiscal,
  resolverSeleccionColaFiscal,
  resolverTabAutoritativo,
} from "./cola-ui";

const VENTA = "10000000-0000-4000-8000-000000000001";

type Caso = {
  nombre: string;
  estado: string;
  fase?: string | null;
  claimVencido?: boolean;
  numeroFiscal?: number | null;
  ventaAntigua?: boolean;
  legacyIncompleto?: boolean;
  tab: "pendientes" | "revisar" | "emitidas" | "historial";
  empleado: string;
  admin: string;
};

const casos: Caso[] = [
  {
    nombre: "venta sin facturar",
    estado: "SIN_FACTURAR",
    tab: "pendientes",
    empleado: "Facturar",
    admin: "Facturar",
  },
  {
    nombre: "claim vigente",
    estado: "EMITIENDO",
    fase: "PREFLIGHT",
    claimVencido: false,
    tab: "pendientes",
    empleado: "Procesando",
    admin: "Procesando",
  },
  {
    nombre: "claim vencido antes del request",
    estado: "EMITIENDO",
    fase: "PREFLIGHT",
    claimVencido: true,
    numeroFiscal: null,
    tab: "revisar",
    empleado: "Requiere administrador",
    admin: "Liberar claim verificado",
  },
  {
    nombre: "claim vencido con número",
    estado: "EMITIENDO",
    fase: "REQUEST_INICIADO",
    claimVencido: true,
    numeroFiscal: 42,
    tab: "revisar",
    empleado: "Requiere administrador",
    admin: "Verificar con ARCA",
  },
  {
    nombre: "conciliación",
    estado: "RECONCILIAR",
    fase: "REQUEST_INICIADO",
    tab: "revisar",
    empleado: "Requiere administrador",
    admin: "Verificar con ARCA",
  },
  {
    nombre: "error corregible reciente",
    estado: "ERROR_CORREGIBLE",
    tab: "revisar",
    empleado: "Corregir/reintentar",
    admin: "Corregir/reintentar",
  },
  {
    nombre: "error corregible de venta antigua",
    estado: "ERROR_CORREGIBLE",
    ventaAntigua: true,
    tab: "revisar",
    empleado: "Requiere administrador",
    admin: "Corregir/reintentar",
  },
  {
    nombre: "pendiente legacy",
    estado: "PENDIENTE",
    tab: "revisar",
    empleado: "Requiere administrador",
    admin: "Ver incidente legacy",
  },
  {
    nombre: "error legacy",
    estado: "ERROR",
    tab: "revisar",
    empleado: "Requiere administrador",
    admin: "Ver incidente legacy",
  },
  {
    nombre: "bloqueo de integridad",
    estado: "BLOQUEADO",
    tab: "revisar",
    empleado: "Requiere administrador",
    admin: "Ver incidente",
  },
  {
    nombre: "comprobante aprobado",
    estado: "APROBADO",
    fase: "PERSISTIDO",
    tab: "emitidas",
    empleado: "Ver/descargar",
    admin: "Ver/descargar",
  },
  {
    nombre: "comprobante aprobado legacy incompleto",
    estado: "APROBADO",
    fase: null,
    legacyIncompleto: true,
    tab: "emitidas",
    empleado: "Ver/descargar",
    admin: "Ver/descargar",
  },
  {
    nombre: "intención cancelada",
    estado: "CANCELADO",
    tab: "historial",
    empleado: "Ver",
    admin: "Ver",
  },
];

describe("presentación de estados de la cola fiscal", () => {
  it("abre detalle descargable para APROBADO y detalle readonly para CANCELADO", () => {
    expect(clasificarInteraccionCola("Ver/descargar")).toBe("DETALLE_DESCARGA");
    expect(clasificarInteraccionCola("Ver")).toBe("DETALLE_LECTURA");
    expect(clasificarInteraccionCola("Facturar")).toBe("EMISION");
    expect(clasificarInteraccionCola("Procesando")).toBeNull();
    expect(clasificarInteraccionCola("Requiere administrador")).toBeNull();
  });

  it.each(casos)("clasifica $nombre y ofrece sólo la acción segura", (caso) => {
    const entrada = {
      estado: caso.estado,
      fase: caso.fase ?? null,
      claimVencido: caso.claimVencido ?? false,
      numeroFiscal: caso.numeroFiscal ?? null,
      ventaAntigua: caso.ventaAntigua ?? false,
      legacyIncompleto: caso.legacyIncompleto ?? false,
    };

    expect(presentarEstadoColaFiscal({ ...entrada, esAdmin: false })).toEqual({
      tab: caso.tab,
      accion: caso.empleado,
    });
    expect(presentarEstadoColaFiscal({ ...entrada, esAdmin: true })).toEqual({
      tab: caso.tab,
      accion: caso.admin,
    });
  });

  it("falla cerrado ante un estado o una combinación desconocidos", () => {
    expect(() =>
      presentarEstadoColaFiscal({
        estado: "NO_APLICA",
        fase: null,
        claimVencido: false,
        numeroFiscal: null,
        ventaAntigua: false,
        legacyIncompleto: false,
        esAdmin: true,
      }),
    ).toThrow(/estado fiscal no soportado/i);

    expect(() =>
      presentarEstadoColaFiscal({
        estado: "EMITIENDO",
        fase: "REQUEST_INICIADO",
        claimVencido: true,
        numeroFiscal: null,
        ventaAntigua: false,
        legacyIncompleto: false,
        esAdmin: true,
      }),
    ).toThrow(/identidad fiscal incierta/i);

    expect(() =>
      presentarEstadoColaFiscal({
        estado: "APROBADO",
        fase: null,
        claimVencido: false,
        numeroFiscal: 42,
        ventaAntigua: false,
        legacyIncompleto: false,
        esAdmin: true,
      }),
    ).toThrow(/APROBADO sin persistencia/i);
  });
});

describe("URL de la cola fiscal", () => {
  it("normaliza sólo el contrato público y elimina parámetros desconocidos", () => {
    expect(
      normalizarBusquedaCola({
        tab: "revisar",
        page: "3",
        desde: "2026-08-01",
        hasta: "2026-08-31",
        documento: " 30-71419966-4 ",
        estado: "ERROR_CORREGIBLE",
        venta: VENTA,
        resultado: "factura_aprobada",
        limite: "200",
        secreto: "no",
      }),
    ).toEqual({
      tab: "revisar",
      page: 3,
      desde: "2026-08-01",
      hasta: "2026-08-31",
      documento: "30-71419966-4",
      estado: "ERROR_CORREGIBLE",
      venta: VENTA,
      resultado: "factura_aprobada",
    });
  });

  it("descarta fechas, UUID, estados y resultados inválidos y exige venta para resultado", () => {
    expect(
      normalizarBusquedaCola({
        tab: "todos",
        page: -2,
        desde: "2026-02-30",
        sucursal: "no-es-uuid",
        estado: "APROBAR_TODO",
        resultado: "factura_aprobada",
      }),
    ).toEqual({ tab: "pendientes", page: 1 });
  });

  it("descarta un documento que el contrato del servidor no podría buscar", () => {
    expect(
      normalizarBusquedaCola({
        tab: "pendientes",
        page: 1,
        documento: "CUIT cualquiera",
      }),
    ).toEqual({ tab: "pendientes", page: 1 });
    expect(normalizarBusquedaCola({ tab: "pendientes", page: 1, documento: "12-345" })).toEqual({
      tab: "pendientes",
      page: 1,
    });
  });

  it("reinicia la página al cambiar tab o filtros", () => {
    const actual = { tab: "emitidas" as const, page: 8, documento: "30714199664" };
    expect(actualizarBusquedaCola(actual, { tab: "revisar" })).toEqual({
      tab: "revisar",
      page: 1,
      documento: "30714199664",
    });
    expect(actualizarBusquedaCola(actual, { estado: "APROBADO" })).toEqual({
      tab: "emitidas",
      page: 1,
      documento: "30714199664",
      estado: "APROBADO",
    });
  });

  it("aplica el cambio sobre el search vigente y conserva el resultado de otra navegación", () => {
    const actualizarTab = crearActualizadorBusquedaCola({ tab: "emitidas" });

    expect(
      actualizarTab({
        tab: "pendientes",
        page: 1,
        venta: VENTA,
        resultado: "factura_aprobada",
      }),
    ).toEqual({
      tab: "emitidas",
      page: 1,
      venta: VENTA,
      resultado: "factura_aprobada",
    });
  });

  it("cerrar el resultado preserva venta, pestaña, página y filtros", () => {
    expect(
      cerrarResultadoCola({
        tab: "revisar",
        page: 4,
        venta: VENTA,
        documento: "30714199664",
        resultado: "venta_creada_requiere_revision",
      }),
    ).toEqual({ tab: "revisar", page: 4, venta: VENTA, documento: "30714199664" });
  });
});

describe("actualización y resultado autoritativos", () => {
  it("inmoviliza placeholder de otra clave pero no un polling de la clave actual", () => {
    expect(accionesColaHabilitadas({ isPlaceholderData: true, isFetching: true })).toBe(false);
    expect(accionesColaHabilitadas({ isPlaceholderData: false, isFetching: true })).toBe(true);
    expect(accionesColaHabilitadas({ isPlaceholderData: false, isFetching: false })).toBe(true);
  });

  it("corrige una pestaña obsoleta sólo para la venta exacta devuelta por servidor", () => {
    expect(
      resolverTabAutoritativo("pendientes", VENTA, [{ venta_id: VENTA, tab: "revisar" }]),
    ).toBe("revisar");
    expect(
      resolverTabAutoritativo("pendientes", undefined, [{ venta_id: VENTA, tab: "revisar" }]),
    ).toBe("pendientes");
  });

  it("hace polling sólo si la página contiene un EMITIENDO reciente según el servidor", () => {
    expect(debeRefrescarCola([{ afip_estado: "EMITIENDO", claim_vencido: false }])).toBe(true);
    expect(debeRefrescarCola([{ afip_estado: "EMITIENDO", claim_vencido: true }])).toBe(false);
    expect(debeRefrescarCola([{ afip_estado: "SIN_FACTURAR", claim_vencido: false }])).toBe(false);
  });

  it("explica el resultado parcial sin invitar a repetir venta ni cobro", () => {
    expect(presentarResultadoCola("venta_creada_factura_pendiente", false)).toEqual({
      titulo: "La venta quedó registrada",
      detalle:
        "No repitas la venta ni el cobro recién enviado. La factura quedó pendiente en la cola.",
      requiereAdministrador: false,
    });
    expect(presentarResultadoCola("venta_creada_requiere_revision", true)).toEqual({
      titulo: "La venta quedó registrada",
      detalle: "No repitas la venta ni el cobro recién enviado. La factura quedó a revisar.",
      requiereAdministrador: true,
    });
  });

  it("descarta definitivamente la selección al cambiar clave y no la remonta al volver", () => {
    type Fila = { venta_id: string };
    type Seleccion = { fila: Fila; huellaConsulta: string };

    const anterior = huellaConsultaCola({ tab: "pendientes", page: 1 });
    const siguiente = huellaConsultaCola({
      tab: "revisar",
      page: 2,
      sucursal: "20000000-0000-4000-8000-000000000001",
    });
    expect(siguiente).not.toBe(anterior);

    let seleccion: Seleccion | null = {
      fila: { venta_id: VENTA },
      huellaConsulta: anterior,
    };
    seleccion = resolverSeleccionColaFiscal({
      seleccion,
      huellaConsulta: siguiente,
      isPlaceholderData: true,
      filas: [{ venta_id: VENTA }],
    });
    expect(seleccion).toBeNull();
    seleccion = resolverSeleccionColaFiscal({
      seleccion,
      huellaConsulta: siguiente,
      isPlaceholderData: false,
      filas: [],
    });
    expect(seleccion).toBeNull();
    expect(
      resolverSeleccionColaFiscal({
        seleccion,
        huellaConsulta: anterior,
        isPlaceholderData: false,
        filas: [{ venta_id: VENTA }],
      }),
    ).toBeNull();
  });

  it("conserva el diálogo pero reemplaza la fila capturada durante polling same-key", () => {
    type Fila = {
      venta_id: string;
      afip_estado: string;
      receptor_razon_social: string;
      emisor_cuit: string;
      afip_punto_venta: number;
    };
    type Seleccion = { fila: Fila; huellaConsulta: string };

    const filaVieja: Fila = {
      venta_id: VENTA,
      afip_estado: "SIN_FACTURAR",
      receptor_razon_social: "Receptor anterior",
      emisor_cuit: "30714199664",
      afip_punto_venta: 5,
    };
    const filaActual: Fila = {
      venta_id: VENTA,
      afip_estado: "ERROR_CORREGIBLE",
      receptor_razon_social: "Receptor autoritativo",
      emisor_cuit: "30717322467",
      afip_punto_venta: 8,
    };
    const seleccion: Seleccion = {
      fila: filaVieja,
      huellaConsulta: "clave-estable",
    };
    const vigente = resolverSeleccionColaFiscal({
      seleccion,
      huellaConsulta: "clave-estable",
      isPlaceholderData: false,
      filas: [filaActual],
    });
    expect(vigente).not.toBeNull();
    expect(vigente?.huellaConsulta).toBe("clave-estable");
    expect(vigente?.fila).toBe(filaActual);
    expect(vigente?.fila).toMatchObject({
      afip_estado: "ERROR_CORREGIBLE",
      receptor_razon_social: "Receptor autoritativo",
      emisor_cuit: "30717322467",
      afip_punto_venta: 8,
    });
    expect(
      resolverSeleccionColaFiscal({
        seleccion: vigente,
        huellaConsulta: "clave-estable",
        isPlaceholderData: false,
        filas: [filaActual],
      }),
    ).toBe(vigente);
    expect(
      resolverSeleccionColaFiscal({
        seleccion: vigente,
        huellaConsulta: "clave-estable",
        isPlaceholderData: false,
        filas: [],
      }),
    ).toBeNull();
  });
});
