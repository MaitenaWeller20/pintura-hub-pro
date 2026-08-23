import type { SelectorReceptorFiscal } from "./fiscal/receptor";

export type ReceptorFiscalCongeladoListado = {
  razonSocial: string;
  tipoDocumento: string | null;
  numeroDocumento: string | null;
  condicionIva: string | null;
};

type VentaConReceptorCongelado = {
  numero_comprobante?: string | null;
  cliente?: { razon_social?: string | null; cuit_dni?: string | null } | null;
  afip_snapshot?: unknown;
};

function esRegistro(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textoSnapshot(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
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
  };
}

function normalizarIdentidad(value: string | null | undefined): string {
  return (value ?? "").replace(/\W/g, "").toLocaleLowerCase("es-AR");
}

export function receptorFiscalDifiereDelComprador(venta: VentaConReceptorCongelado): boolean {
  const receptor = leerReceptorFiscalCongelado(venta.afip_snapshot);
  if (!receptor) return false;
  const comprador = normalizarIdentidad(venta.cliente?.razon_social);
  const documentoComprador = normalizarIdentidad(venta.cliente?.cuit_dni);
  return (
    comprador !== normalizarIdentidad(receptor.razonSocial) ||
    (!!receptor.numeroDocumento &&
      documentoComprador !== normalizarIdentidad(receptor.numeroDocumento))
  );
}

export function textoBusquedaVenta(venta: VentaConReceptorCongelado): string {
  const receptor = leerReceptorFiscalCongelado(venta.afip_snapshot);
  return [
    venta.numero_comprobante,
    venta.cliente?.razon_social,
    venta.cliente?.cuit_dni,
    receptor?.razonSocial,
    receptor?.tipoDocumento,
    receptor?.numeroDocumento,
    receptor?.condicionIva,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLocaleLowerCase("es-AR");
}

export function camposExportacionReceptorFiscal(venta: VentaConReceptorCongelado): {
  "Receptor fiscal": string;
  "Documento receptor fiscal": string;
} {
  const receptor = leerReceptorFiscalCongelado(venta.afip_snapshot);
  return {
    "Receptor fiscal": receptor?.razonSocial ?? "—",
    "Documento receptor fiscal": receptor?.numeroDocumento
      ? [receptor.tipoDocumento, receptor.numeroDocumento].filter(Boolean).join(" ")
      : "—",
  };
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
    confirmaVentaAntigua: boolean;
    huellaConfirmacion: string;
  },
  deps: {
    crearVenta(idempotencyKey: string): Promise<{ id: string }>;
    emitirPostBorrador(input: {
      ventaId: string;
      receptor: SelectorReceptorFiscal;
      confirmaVentaAntigua: boolean;
      huellaConfirmacion: string;
    }): Promise<T>;
  },
): Promise<T> {
  const ventaId = await obtenerVentaUnaVez(input.control, input.idempotencyKey, deps.crearVenta);
  return deps.emitirPostBorrador({
    ventaId,
    receptor: input.receptor,
    confirmaVentaAntigua: input.confirmaVentaAntigua,
    huellaConfirmacion: input.huellaConfirmacion,
  });
}
