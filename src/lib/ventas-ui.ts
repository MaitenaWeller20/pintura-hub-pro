import type { SelectorReceptorFiscal } from "./fiscal/receptor";
import { CBTE_INFO } from "./fiscal/codigos";
import { requiereConfirmacionVentaDemorada } from "./fiscal/fecha";

export type ReceptorFiscalCongeladoListado = {
  razonSocial: string;
  tipoDocumento: string | null;
  numeroDocumento: string | null;
  condicionIva: string | null;
  domicilio: string | null;
};

type VentaConReceptorCongelado = {
  numero_comprobante?: string | null;
  cliente?: { razon_social?: string | null; cuit_dni?: string | null } | null;
  fiscalPresentacion?: { receptor?: ReceptorFiscalCongeladoListado | null } | null;
};

function esRegistro(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textoSnapshot(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function enteroPositivo(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function fechaIsoCalendario(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const fecha = new Date(Date.UTC(year, month - 1, day));
  return (
    fecha.getUTCFullYear() === year &&
    fecha.getUTCMonth() === month - 1 &&
    fecha.getUTCDate() === day
  );
}

/** Lee sólo la copia inmutable de la emisión; nunca reconsulta el favorito vivo. */
export function leerReceptorFiscalCongelado(
  snapshot: unknown,
): ReceptorFiscalCongeladoListado | null {
  if (!esRegistro(snapshot) || !esRegistro(snapshot.receptor)) return null;
  const receptor = snapshot.receptor;
  const razonSocial = textoSnapshot(receptor.razonSocial) ?? textoSnapshot(receptor.razon_social);
  if (!razonSocial) return null;
  return {
    razonSocial,
    tipoDocumento: textoSnapshot(receptor.tipoDocumento) ?? textoSnapshot(receptor.tipo_documento),
    numeroDocumento:
      textoSnapshot(receptor.numeroDocumento) ??
      textoSnapshot(receptor.numero_documento) ??
      textoSnapshot(receptor.cuit_dni),
    condicionIva: textoSnapshot(receptor.condicionIva) ?? textoSnapshot(receptor.condicion_iva),
    domicilio: textoSnapshot(receptor.domicilio),
  };
}

function normalizarIdentidad(value: string | null | undefined): string {
  return (value ?? "").replace(/\W/g, "").toLocaleLowerCase("es-AR");
}

export function receptorFiscalDifiereDelComprador(venta: VentaConReceptorCongelado): boolean {
  const receptor = venta.fiscalPresentacion?.receptor ?? null;
  if (!receptor) return false;
  const comprador = normalizarIdentidad(venta.cliente?.razon_social);
  const documentoComprador = normalizarIdentidad(venta.cliente?.cuit_dni);
  return (
    comprador !== normalizarIdentidad(receptor.razonSocial) ||
    (!!receptor.numeroDocumento &&
      documentoComprador !== normalizarIdentidad(receptor.numeroDocumento))
  );
}

function camposBusquedaVenta(venta: VentaConReceptorCongelado): string[] {
  const receptor = venta.fiscalPresentacion?.receptor ?? null;
  return [
    venta.numero_comprobante,
    venta.cliente?.razon_social,
    venta.cliente?.cuit_dni,
    receptor?.razonSocial,
    receptor?.tipoDocumento,
    receptor?.numeroDocumento,
    receptor?.condicionIva,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function textoBusquedaVenta(venta: VentaConReceptorCongelado): string {
  return camposBusquedaVenta(venta).join(" ").toLocaleLowerCase("es-AR");
}

export function ventaCoincideBusqueda(venta: VentaConReceptorCongelado, busqueda: string): boolean {
  const consulta = busqueda.trim().toLocaleLowerCase("es-AR");
  if (!consulta) return true;
  if (textoBusquedaVenta(venta).includes(consulta)) return true;

  const soloDocumentoFormateado = /^[0-9\s./-]+$/.test(consulta);
  const digitos = consulta.replace(/\D/g, "");
  return (
    soloDocumentoFormateado &&
    digitos.length > 0 &&
    camposBusquedaVenta(venta).some((campo) => campo.replace(/\D/g, "").includes(digitos))
  );
}

export function camposExportacionReceptorFiscal(venta: VentaConReceptorCongelado): {
  "Receptor fiscal": string;
  "Documento receptor fiscal": string;
} {
  const receptor = venta.fiscalPresentacion?.receptor ?? null;
  return {
    "Receptor fiscal": receptor?.razonSocial ?? "—",
    "Documento receptor fiscal": receptor?.numeroDocumento
      ? [receptor.tipoDocumento, receptor.numeroDocumento].filter(Boolean).join(" ")
      : "—",
  };
}

export type ComprobanteAsociadoFiscalListado = {
  tipo: number;
  puntoVenta: number;
  numero: number;
  cuit: string;
  fecha: string;
  letra: "A" | "B" | "C";
  titulo: "Factura" | "Nota de crédito" | "Nota de débito" | "Recibo";
};

/** Lee la evidencia inmutable CbteAsoc de una nota sin reconsultar el original vivo. */
export function leerComprobanteAsociadoFiscal(
  snapshot: unknown,
): ComprobanteAsociadoFiscalListado | null {
  if (!esRegistro(snapshot) || !Array.isArray(snapshot.cbtesAsoc)) return null;
  if (snapshot.cbtesAsoc.length !== 1 || !esRegistro(snapshot.cbtesAsoc[0])) return null;
  const asociado = snapshot.cbtesAsoc[0];
  if (
    !enteroPositivo(asociado.tipo) ||
    !enteroPositivo(asociado.puntoVenta) ||
    !enteroPositivo(asociado.numero) ||
    !fechaIsoCalendario(asociado.fecha) ||
    typeof asociado.cuit !== "string" ||
    !/^\d{11}$/.test(asociado.cuit)
  ) {
    return null;
  }
  const info = CBTE_INFO[asociado.tipo];
  if (!info) return null;
  const titulo = [1, 6, 11].includes(asociado.tipo)
    ? "Factura"
    : [3, 8, 13].includes(asociado.tipo)
      ? "Nota de crédito"
      : [2, 7, 12].includes(asociado.tipo)
        ? "Nota de débito"
        : asociado.tipo === 15
          ? "Recibo"
          : null;
  if (!titulo) return null;
  return {
    tipo: asociado.tipo,
    puntoVenta: asociado.puntoVenta,
    numero: asociado.numero,
    cuit: asociado.cuit,
    fecha: asociado.fecha,
    letra: info.letra,
    titulo,
  };
}

export type ValidezFiscalVenta = "PRODUCCION" | "HOMOLOGACION" | "SIMULADA";

type VentaConValidezFiscal = {
  cae?: string | null;
  afip_validez?: unknown;
  afip_modo?: unknown;
  afip_simulado?: boolean | null;
  afip_punto_venta?: number | null;
  afip_numero?: number | null;
};

/** Prioriza la marca explícita v2 y conserva fallbacks para comprobantes legacy. */
export function validezFiscalVenta(venta: VentaConValidezFiscal): ValidezFiscalVenta | null {
  if (
    venta.afip_validez === "PRODUCCION" ||
    venta.afip_validez === "HOMOLOGACION" ||
    venta.afip_validez === "SIMULADA"
  ) {
    return venta.afip_validez;
  }
  if (venta.afip_simulado === true) return "SIMULADA";
  if (venta.afip_modo === "PRODUCCION" || venta.afip_modo === "HOMOLOGACION") {
    return venta.afip_modo;
  }
  return null;
}

export type DescripcionCaeLegacy = {
  tone: "success" | "warning";
  detalle: string;
  title: string | null;
};

export function describirCaeLegacy(venta: VentaConValidezFiscal): DescripcionCaeLegacy | null {
  if (!venta.cae) return null;
  const validez = validezFiscalVenta(venta);
  if (validez === "SIMULADA") {
    return {
      tone: "warning",
      detalle: "simulado — sin validez legal",
      title: "CAE generado en modo simulado: no se declaró a AFIP y no tiene validez legal.",
    };
  }
  if (validez === "HOMOLOGACION") {
    return {
      tone: "warning",
      detalle: "homologación — sin validez legal",
      title: "CAE obtenido en homologación: es una prueba y no tiene validez legal.",
    };
  }
  return {
    tone: "success",
    detalle:
      venta.afip_punto_venta && venta.afip_numero
        ? `PV ${venta.afip_punto_venta}-${venta.afip_numero}`
        : "Producción",
    title: validez === "PRODUCCION" ? "Comprobante con validez legal ante AFIP." : null,
  };
}

export function requiereAdvertenciaAnulacionProduccion(venta: VentaConValidezFiscal): boolean {
  return !!venta.cae && validezFiscalVenta(venta) === "PRODUCCION";
}

/**
 * El emisor legacy no abre la reconfirmación administrativa del flujo v2. Por
 * eso un empleado no debe recibir el botón cuando la venta ya es demorada.
 */
export function puedeOfrecerEmisionLegacy(
  input: { puedeFacturar: boolean; isAdmin: boolean; fecha: string | Date },
  hoy: Date = new Date(),
): boolean {
  if (!input.puedeFacturar) return false;
  const fecha = input.fecha instanceof Date ? input.fecha : new Date(input.fecha);
  if (!Number.isFinite(fecha.getTime()) || !Number.isFinite(hoy.getTime())) return false;
  return input.isAdmin || !requiereConfirmacionVentaDemorada(fecha, () => hoy);
}

export type AccionCierreVenta =
  | { id: "REGISTRAR_Y_FACTURAR"; etiqueta: "Registrar venta y facturar" }
  | { id: "REGISTRAR_SIN_FACTURAR"; etiqueta: "Registrar sin facturar" }
  | { id: "REGISTRAR_LEGACY"; etiqueta: "Guardar" }
  | { id: "REGISTRAR_UNICO"; etiqueta: "Guardar" };

export type DecisionCierreVenta = {
  tipoPersistido: string;
  bloqueado: boolean;
  explicacion: string | null;
  acciones: AccionCierreVenta[];
};

type EntradaCierreVenta = {
  facturacionV2Habilitada: boolean;
  facturacionLegacyHabilitada: boolean;
  puedeFacturar: boolean;
  tipoComprobante: string;
};

const TIPOS_POSITIVOS = new Set(["VENTA", "FACTURA_A", "FACTURA_B", "FACTURA_C"]);

export function opcionesCierreVenta(input: EntradaCierreVenta): DecisionCierreVenta {
  if (input.facturacionV2Habilitada && input.facturacionLegacyHabilitada) {
    throw new Error("La configuración fiscal es inválida: ambos escritores están activos.");
  }

  if (input.facturacionLegacyHabilitada && TIPOS_POSITIVOS.has(input.tipoComprobante)) {
    return {
      tipoPersistido: input.tipoComprobante,
      bloqueado: false,
      explicacion: null,
      acciones: [{ id: "REGISTRAR_LEGACY", etiqueta: "Guardar" }],
    };
  }

  // El cierre dual pertenece exclusivamente al contrato neutral VENTA. Una
  // A/B/C residual durante el rollout v2 no se transforma silenciosamente en
  // VENTA ni abre el diálogo fiscal; la barrera de servidor decidirá su alcance.
  if (
    !TIPOS_POSITIVOS.has(input.tipoComprobante) ||
    (input.facturacionV2Habilitada && input.tipoComprobante !== "VENTA")
  ) {
    return {
      tipoPersistido: input.tipoComprobante,
      bloqueado: false,
      explicacion: null,
      acciones: [{ id: "REGISTRAR_UNICO", etiqueta: "Guardar" }],
    };
  }

  const tipoPersistido = "VENTA";
  if (!input.facturacionV2Habilitada) {
    return {
      tipoPersistido,
      bloqueado: true,
      explicacion: "La facturación está en mantenimiento. No se registró la venta ni el cobro.",
      acciones: [],
    };
  }

  if (!input.puedeFacturar) {
    return {
      tipoPersistido,
      bloqueado: false,
      explicacion:
        "La venta quedará en la cola. Necesitás el permiso Puede facturar para emitirla.",
      acciones: [{ id: "REGISTRAR_SIN_FACTURAR", etiqueta: "Registrar sin facturar" }],
    };
  }

  return {
    tipoPersistido,
    bloqueado: false,
    explicacion: null,
    acciones: [
      { id: "REGISTRAR_Y_FACTURAR", etiqueta: "Registrar venta y facturar" },
      { id: "REGISTRAR_SIN_FACTURAR", etiqueta: "Registrar sin facturar" },
    ],
  };
}

function redondearDos(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function resumirCierreVenta(input: {
  total: number;
  pagadoAhora: number;
  esCtaCte: boolean;
}) {
  const total = redondearDos(input.total);
  const pagadoAhora = redondearDos(input.pagadoAhora);
  return {
    total,
    pagadoAhora,
    saldo: redondearDos(total - pagadoAhora),
    esCtaCte: input.esCtaCte,
    totalFiscal: total,
  };
}

export type ResultadoColaVenta =
  | "venta_creada_factura_pendiente"
  | "venta_creada_requiere_revision"
  | "factura_aprobada";

export function resultadoColaDespuesDeEmision(
  estado:
    | "APROBADO"
    | "ERROR_CORREGIBLE"
    | "MANTENIMIENTO"
    | "RECONCILIAR"
    | "BLOQUEADO"
    | "EN_CURSO"
    | "TRANSPORTE_INCIERTO",
): ResultadoColaVenta {
  if (estado === "APROBADO") return "factura_aprobada";
  if (estado === "ERROR_CORREGIBLE" || estado === "MANTENIMIENTO") {
    return "venta_creada_factura_pendiente";
  }
  return "venta_creada_requiere_revision";
}

export type ControlCreacionVenta = {
  ventaId: string | null;
  idempotencyKey: string | null;
  creacionEnCurso: Promise<string> | null;
};

export function crearControlCreacionVenta(): ControlCreacionVenta {
  return { ventaId: null, idempotencyKey: null, creacionEnCurso: null };
}

async function obtenerVentaUnaVez(
  control: ControlCreacionVenta,
  idempotencyKey: string,
  crearVenta: (idempotencyKey: string) => Promise<{ id: string }>,
): Promise<string> {
  if (control.idempotencyKey && control.idempotencyKey !== idempotencyKey) {
    throw new Error("El cierre intentó reutilizar una venta con otra clave de idempotencia.");
  }
  if (control.ventaId) return control.ventaId;
  if (control.creacionEnCurso) return control.creacionEnCurso;

  control.idempotencyKey = idempotencyKey;
  control.creacionEnCurso = crearVenta(idempotencyKey)
    .then((venta) => {
      if (!venta.id) throw new Error("El servidor no devolvió el ID de la venta creada.");
      control.ventaId = venta.id;
      return venta.id;
    })
    .catch((error) => {
      control.idempotencyKey = null;
      throw error;
    })
    .finally(() => {
      control.creacionEnCurso = null;
    });

  return control.creacionEnCurso;
}

export async function registrarVentaSinFactura(
  control: ControlCreacionVenta,
  idempotencyKey: string,
  crearVenta: (idempotencyKey: string) => Promise<{ id: string }>,
): Promise<{ ventaId: string; href: string }> {
  const ventaId = await obtenerVentaUnaVez(control, idempotencyKey, crearVenta);
  return {
    ventaId,
    href: `/facturacion/cola?venta=${ventaId}&resultado=venta_creada_factura_pendiente`,
  };
}

export async function confirmarCierreFiscalInmediato<T>(
  input: {
    control: ControlCreacionVenta;
    idempotencyKey: string;
    receptor: SelectorReceptorFiscal;
    letraSolicitada: "A" | "B";
    confirmaVentaAntigua: boolean;
    huellaConfirmacion: string;
  },
  deps: {
    crearVenta(idempotencyKey: string): Promise<{ id: string }>;
    emitirPostBorrador(input: {
      ventaId: string;
      receptor: SelectorReceptorFiscal;
      letraSolicitada: "A" | "B";
      confirmaVentaAntigua: boolean;
      huellaConfirmacion: string;
    }): Promise<T>;
  },
): Promise<T> {
  let ventaId: string;
  try {
    ventaId = await obtenerVentaUnaVez(input.control, input.idempotencyKey, deps.crearVenta);
  } catch (cause) {
    const detalle = cause instanceof Error ? cause.message : "Error desconocido";
    throw new Error(
      `No se pudo confirmar si la venta quedó registrada. No repitas la venta ni el cobro: verificá la venta en la cola de facturación antes de volver a intentar. Detalle: ${detalle}`,
      { cause },
    );
  }
  return deps.emitirPostBorrador({
    ventaId,
    receptor: input.receptor,
    letraSolicitada: input.letraSolicitada,
    confirmaVentaAntigua: input.confirmaVentaAntigua,
    huellaConfirmacion: input.huellaConfirmacion,
  });
}
