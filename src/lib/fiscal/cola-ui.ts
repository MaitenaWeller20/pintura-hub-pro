export type TabColaFiscal = "pendientes" | "revisar" | "emitidas" | "historial";

export type PresentacionEstadoColaFiscal = {
  tab: TabColaFiscal;
  accion: string;
};

export function presentarEstadoColaFiscal(input: {
  estado: string;
  fase: string | null;
  claimVencido: boolean;
  numeroFiscal: number | null;
  ventaAntigua: boolean;
  esAdmin: boolean;
}): PresentacionEstadoColaFiscal {
  switch (input.estado) {
    case "SIN_FACTURAR":
      return { tab: "pendientes", accion: "Facturar" };

    case "EMITIENDO": {
      if (!input.claimVencido) {
        if (
          input.fase !== "PREFLIGHT" &&
          input.fase !== "RESERVADO" &&
          input.fase !== "REQUEST_INICIADO" &&
          input.fase !== "RESPUESTA_RECIBIDA"
        ) {
          throw new Error("Identidad fiscal incierta en una emisión activa.");
        }
        return { tab: "pendientes", accion: "Procesando" };
      }

      if (input.numeroFiscal !== null) {
        if (
          input.fase !== "RESERVADO" &&
          input.fase !== "REQUEST_INICIADO" &&
          input.fase !== "RESPUESTA_RECIBIDA"
        ) {
          throw new Error("Identidad fiscal incierta: el número no coincide con la fase.");
        }
        return {
          tab: "revisar",
          accion: input.esAdmin ? "Verificar con ARCA" : "Requiere administrador",
        };
      }

      if (input.fase !== "PREFLIGHT") {
        throw new Error("Identidad fiscal incierta: no se puede liberar automáticamente.");
      }
      return {
        tab: "revisar",
        accion: input.esAdmin ? "Liberar claim verificado" : "Requiere administrador",
      };
    }

    case "RECONCILIAR":
      return {
        tab: "revisar",
        accion: input.esAdmin ? "Verificar con ARCA" : "Requiere administrador",
      };

    case "ERROR_CORREGIBLE":
      return {
        tab: "revisar",
        accion:
          input.ventaAntigua && !input.esAdmin ? "Requiere administrador" : "Corregir/reintentar",
      };

    case "PENDIENTE":
    case "ERROR":
      return {
        tab: "revisar",
        accion: input.esAdmin ? "Ver incidente legacy" : "Requiere administrador",
      };

    case "BLOQUEADO":
      return {
        tab: "revisar",
        accion: input.esAdmin ? "Ver incidente" : "Requiere administrador",
      };

    case "APROBADO":
      if (input.fase !== "PERSISTIDO") {
        throw new Error("Estado fiscal no soportado: APROBADO sin persistencia.");
      }
      return { tab: "emitidas", accion: "Ver/descargar" };

    case "CANCELADO":
      return { tab: "historial", accion: "Ver" };

    default:
      throw new Error(`Estado fiscal no soportado: ${input.estado}.`);
  }
}
