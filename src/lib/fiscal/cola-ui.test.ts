import { describe, expect, it } from "vitest";
import { presentarEstadoColaFiscal } from "./cola-ui";

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
