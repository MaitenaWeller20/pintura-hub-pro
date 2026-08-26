export type TabColaFiscal = "pendientes" | "revisar" | "emitidas" | "historial";

export type ResultadoColaFiscal =
  | "venta_creada_factura_pendiente"
  | "venta_creada_requiere_revision"
  | "factura_aprobada";

export type BusquedaColaFiscal = {
  tab: TabColaFiscal;
  page: number;
  desde?: string;
  hasta?: string;
  sucursal?: string;
  emisor?: string;
  documento?: string;
  estado?: string;
  venta?: string;
  resultado?: ResultadoColaFiscal;
};

const TABS = new Set<TabColaFiscal>(["pendientes", "revisar", "emitidas", "historial"]);
const ORDEN_TABS: readonly TabColaFiscal[] = ["pendientes", "revisar", "emitidas", "historial"];
const RESULTADOS = new Set<ResultadoColaFiscal>([
  "venta_creada_factura_pendiente",
  "venta_creada_requiere_revision",
  "factura_aprobada",
]);
const ESTADOS = new Set([
  "SIN_FACTURAR",
  "EMITIENDO",
  "APROBADO",
  "ERROR_CORREGIBLE",
  "RECONCILIAR",
  "CANCELADO",
  "BLOQUEADO",
  "PENDIENTE",
  "ERROR",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function textoUnico(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const limpio = raw.trim();
  return limpio || undefined;
}

function fechaCalendario(value: unknown): string | undefined {
  const raw = textoUnico(value);
  const match = raw ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) : null;
  if (!raw || !match) return undefined;
  const fecha = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return fecha.getUTCFullYear() === Number(match[1]) &&
    fecha.getUTCMonth() === Number(match[2]) - 1 &&
    fecha.getUTCDate() === Number(match[3])
    ? raw
    : undefined;
}

function uuid(value: unknown): string | undefined {
  const raw = textoUnico(value);
  return raw && UUID.test(raw) ? raw.toLowerCase() : undefined;
}

function documentoBusqueda(value: unknown): string | undefined {
  const raw = textoUnico(value);
  if (!raw || !/^[\d.\-\s]+$/.test(raw)) return undefined;
  const digitos = raw.replace(/\D/g, "");
  return /^\d{7,11}$/.test(digitos) ? raw : undefined;
}

export function normalizarBusquedaCola(raw: Record<string, unknown>): BusquedaColaFiscal {
  const tabRaw = textoUnico(raw.tab);
  const tab =
    tabRaw && TABS.has(tabRaw as TabColaFiscal) ? (tabRaw as TabColaFiscal) : "pendientes";
  const pageRaw = typeof raw.page === "number" ? raw.page : Number(textoUnico(raw.page));
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const venta = uuid(raw.venta);
  const resultadoRaw = textoUnico(raw.resultado);
  const resultado =
    venta && resultadoRaw && RESULTADOS.has(resultadoRaw as ResultadoColaFiscal)
      ? (resultadoRaw as ResultadoColaFiscal)
      : undefined;
  const estadoRaw = textoUnico(raw.estado);
  const estado = estadoRaw && ESTADOS.has(estadoRaw) ? estadoRaw : undefined;

  return {
    tab,
    page,
    ...(fechaCalendario(raw.desde) ? { desde: fechaCalendario(raw.desde) } : {}),
    ...(fechaCalendario(raw.hasta) ? { hasta: fechaCalendario(raw.hasta) } : {}),
    ...(uuid(raw.sucursal) ? { sucursal: uuid(raw.sucursal) } : {}),
    ...(uuid(raw.emisor) ? { emisor: uuid(raw.emisor) } : {}),
    ...(documentoBusqueda(raw.documento) ? { documento: documentoBusqueda(raw.documento) } : {}),
    ...(estado ? { estado } : {}),
    ...(venta ? { venta } : {}),
    ...(resultado ? { resultado } : {}),
  };
}

export function navegarTabColaPorTecla(actual: TabColaFiscal, tecla: string): TabColaFiscal | null {
  if (tecla === "Home") return ORDEN_TABS[0];
  if (tecla === "End") return ORDEN_TABS[ORDEN_TABS.length - 1];
  if (tecla !== "ArrowLeft" && tecla !== "ArrowRight") return null;
  const indice = ORDEN_TABS.indexOf(actual);
  const delta = tecla === "ArrowRight" ? 1 : -1;
  return ORDEN_TABS[(indice + delta + ORDEN_TABS.length) % ORDEN_TABS.length];
}

const REINICIA_PAGINA = new Set([
  "tab",
  "desde",
  "hasta",
  "sucursal",
  "emisor",
  "documento",
  "estado",
  "venta",
]);

export function actualizarBusquedaCola(
  actual: BusquedaColaFiscal,
  cambios: Partial<BusquedaColaFiscal>,
): BusquedaColaFiscal {
  const siguiente = { ...actual, ...cambios } as Record<string, unknown>;
  for (const [key, value] of Object.entries(cambios)) {
    if (value === undefined || value === "") delete siguiente[key];
  }
  if (Object.keys(cambios).some((key) => REINICIA_PAGINA.has(key))) siguiente.page = 1;
  return normalizarBusquedaCola(siguiente);
}

export function crearActualizadorBusquedaCola(cambios: Partial<BusquedaColaFiscal>) {
  return (actual: Record<string, unknown>): BusquedaColaFiscal =>
    actualizarBusquedaCola(normalizarBusquedaCola(actual), cambios);
}

export function cerrarResultadoCola(actual: BusquedaColaFiscal): BusquedaColaFiscal {
  const { resultado: _resultado, ...resto } = actual;
  return resto;
}

export function resolverTabAutoritativo(
  actual: TabColaFiscal,
  venta: string | undefined,
  filas: Array<{ venta_id: string; tab: TabColaFiscal }>,
): TabColaFiscal {
  if (!venta) return actual;
  return filas.find((fila) => fila.venta_id === venta)?.tab ?? actual;
}

export function debeRefrescarCola(
  filas: Array<{ afip_estado: string; claim_vencido: boolean }>,
): boolean {
  return filas.some((fila) => fila.afip_estado === "EMITIENDO" && !fila.claim_vencido);
}

/** `isFetching` también cubre polling; sólo placeholder significa datos de otra clave. */
export function accionesColaHabilitadas(input: {
  isPlaceholderData: boolean;
  isFetching: boolean;
}): boolean {
  return !input.isPlaceholderData;
}

/**
 * Identidad estable de la consulta que alimenta la tabla. `resultado` sólo
 * controla el banner posterior a una emisión y no cambia los datos pedidos.
 */
export function huellaConsultaCola(raw: Record<string, unknown>): string {
  const search = normalizarBusquedaCola(raw);
  return JSON.stringify([
    search.tab,
    search.page,
    search.desde ?? null,
    search.hasta ?? null,
    search.sucursal ?? null,
    search.emisor ?? null,
    search.documento ?? null,
    search.estado ?? null,
    search.venta ?? null,
  ]);
}

export type SeleccionColaFiscal<T extends { venta_id: string }> = {
  fila: T;
  huellaConsulta: string;
  retenerHastaCerrar?: true;
};

export function retenerSeleccionColaFiscalHastaCerrar<T extends { venta_id: string }>(
  seleccion: SeleccionColaFiscal<T> | null,
): SeleccionColaFiscal<T> | null {
  if (!seleccion || seleccion.retenerHastaCerrar) return seleccion;
  return { ...seleccion, retenerHastaCerrar: true };
}

/**
 * Una selección normal sólo sigue siendo autoritativa para la misma consulta
 * y mientras su fila existe. La selección retenida puede sobrevivir a que la
 * fila salga de esa consulta, pero nunca a un placeholder o cambio de clave.
 */
export function resolverSeleccionColaFiscal<T extends { venta_id: string }>(input: {
  seleccion: SeleccionColaFiscal<T> | null;
  huellaConsulta: string;
  isPlaceholderData: boolean;
  filas: T[];
}): SeleccionColaFiscal<T> | null {
  if (
    !input.seleccion ||
    input.isPlaceholderData ||
    input.seleccion.huellaConsulta !== input.huellaConsulta
  ) {
    return null;
  }
  const ventaId = input.seleccion.fila.venta_id;
  const filaActual = input.filas.find((fila) => fila.venta_id === ventaId);
  if (!filaActual) return input.seleccion.retenerHastaCerrar ? input.seleccion : null;
  if (filaActual === input.seleccion.fila) return input.seleccion;
  return { ...input.seleccion, fila: filaActual };
}

/**
 * Resuelve en conjunto la selección y la pestaña de la ruta. Un error que el
 * operador todavía debe leer fija ambas hasta el cierre explícito del diálogo;
 * al cerrarlo, la navegación autoritativa vuelve a seguir la fila actual.
 */
export function resolverCicloSeleccionColaFiscal<
  T extends { venta_id: string; tab: TabColaFiscal },
>(input: {
  seleccion: SeleccionColaFiscal<T> | null;
  huellaConsulta: string;
  isPlaceholderData: boolean;
  tab: TabColaFiscal;
  venta: string | undefined;
  filas: T[];
}): {
  seleccion: SeleccionColaFiscal<T> | null;
  tabAutoritativo: TabColaFiscal;
} {
  const seleccion = resolverSeleccionColaFiscal(input);
  return {
    seleccion,
    tabAutoritativo:
      input.isPlaceholderData || seleccion?.retenerHastaCerrar
        ? input.tab
        : resolverTabAutoritativo(input.tab, input.venta, input.filas),
  };
}

export function presentarResultadoCola(
  resultado: ResultadoColaFiscal,
  requiereAdministrador: boolean,
  tipoComprobante = "VENTA",
): { titulo: string; detalle: string; requiereAdministrador: boolean } {
  const documento =
    tipoComprobante === "NOTA_CREDITO"
      ? "nota de crédito"
      : tipoComprobante === "NOTA_DEBITO"
        ? "nota de débito"
        : "factura";
  if (resultado === "factura_aprobada") {
    return {
      titulo: `${documento.charAt(0).toUpperCase()}${documento.slice(1)} autorizada`,
      detalle: `ARCA autorizó la ${documento} de esta venta.`,
      requiereAdministrador: false,
    };
  }
  return {
    titulo: "La venta quedó registrada",
    detalle:
      resultado === "venta_creada_requiere_revision"
        ? `No repitas la venta ni el cobro recién enviado. La ${documento} quedó a revisar.`
        : `No repitas la venta ni el cobro recién enviado. La ${documento} quedó pendiente en la cola.`,
    requiereAdministrador: resultado === "venta_creada_requiere_revision" && requiereAdministrador,
  };
}

export type PresentacionEstadoColaFiscal = {
  tab: TabColaFiscal;
  accion: string;
};

export type InteraccionColaFiscal =
  | "EMISION"
  | "TRANSICION"
  | "DETALLE_DESCARGA"
  | "DETALLE_LECTURA"
  | "INCIDENTE_LECTURA";

export function clasificarInteraccionCola(accion: string): InteraccionColaFiscal | null {
  if (accion === "Facturar" || accion === "Corregir/reintentar") return "EMISION";
  if (accion === "Verificar con ARCA" || accion === "Liberar claim verificado") {
    return "TRANSICION";
  }
  if (accion === "Ver/descargar") return "DETALLE_DESCARGA";
  if (accion === "Ver") return "DETALLE_LECTURA";
  if (accion === "Ver incidente" || accion === "Ver incidente legacy") {
    return "INCIDENTE_LECTURA";
  }
  return null;
}

export function presentarEstadoColaFiscal(input: {
  estado: string;
  fase: string | null;
  claimVencido: boolean;
  numeroFiscal: number | null;
  ventaAntigua: boolean;
  legacyIncompleto: boolean;
  esAdmin: boolean;
}): PresentacionEstadoColaFiscal {
  switch (input.estado) {
    case "SIN_FACTURAR":
      return {
        tab: "pendientes",
        accion: input.ventaAntigua && !input.esAdmin ? "Requiere administrador" : "Facturar",
      };

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
      if (input.fase !== "PERSISTIDO" && !input.legacyIncompleto) {
        throw new Error("Estado fiscal no soportado: APROBADO sin persistencia.");
      }
      return { tab: "emitidas", accion: "Ver/descargar" };

    case "CANCELADO":
      return { tab: "historial", accion: "Ver" };

    default:
      throw new Error(`Estado fiscal no soportado: ${input.estado}.`);
  }
}
