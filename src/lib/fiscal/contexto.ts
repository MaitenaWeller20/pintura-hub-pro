import { cuitValido, type CondicionIva } from "./codigos";
import { crearErrorFiscalUsuario } from "./error-usuario";
import { fechaFiscalHoyAr } from "./fecha";

export type AmbienteArca = "HOMOLOGACION" | "PRODUCCION";
export type ModalidadFacturaA = "DESCONOCIDA" | "ESTANDAR_CONFIRMADA" | "NO_SOPORTADA";

export type SucursalFiscalRow = {
  id: string;
  nombre: string;
  telefono: string | null;
  emisor_id: string;
};

export type EmisorFiscalRow = {
  id: string;
  razon_social: string;
  nombre_fantasia: string | null;
  cuit: string | null;
  domicilio_fiscal: string | null;
  condicion_iva: CondicionIva | null;
  ingresos_brutos: string | null;
  inicio_actividades: string | null;
  factura_a_modalidad: ModalidadFacturaA;
  factura_a_revalidar_at: string | null;
};

export type PuntoVentaFiscalRow = {
  sucursal_id: string;
  emisor_id: string;
  numero: number;
  modo: AmbienteArca;
  activo: boolean;
};

export type CredencialFiscalRow = {
  emisor_id: string;
  ambiente: AmbienteArca;
  arca_key_enc: string | null;
  arca_cert_enc: string | null;
  habilitada: boolean;
  padron_probado_at: string | null;
  padron_validacion_activa: boolean;
};

export type ContextoFiscalInput = {
  sucursal: SucursalFiscalRow | null;
  emisor: EmisorFiscalRow | null;
  pv: PuntoVentaFiscalRow | null;
  credencial: CredencialFiscalRow | null;
};

export type ContextoFiscal = {
  emisor: {
    cuit: string;
    condicion_iva: CondicionIva;
    arca_key_enc: string;
    arca_cert_enc: string;
  };
  emisorImpreso: {
    razon_social: string;
    nombre_fantasia: string | null;
    cuit: string;
    domicilio_fiscal: string | null;
    condicion_iva: CondicionIva;
    ingresos_brutos: string | null;
    inicio_actividades: string;
    telefono: string | null;
  };
  pv: { numero: number; modo: AmbienteArca };
  sucursal: SucursalFiscalRow;
  facturaA: {
    modalidad: ModalidadFacturaA;
    revalidar_at: string | null;
  };
  padron: {
    probadoAt: string | null;
    validacionActiva: boolean;
  };
};

const MODALIDADES_FACTURA_A = new Set<ModalidadFacturaA>([
  "DESCONOCIDA",
  "ESTANDAR_CONFIRMADA",
  "NO_SOPORTADA",
]);

function fechaIsoValida(fecha: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const comprobacion = new Date(Date.UTC(year, month - 1, day));
  return (
    comprobacion.getUTCFullYear() === year &&
    comprobacion.getUTCMonth() === month - 1 &&
    comprobacion.getUTCDate() === day
  );
}

/**
 * La conectividad con WSFE no demuestra que el contribuyente pueda emitir la
 * variante A estándar. Esa decisión es administrativa y vence: sólo se aplica
 * después de haber derivado la letra real del receptor.
 */
export function validarModalidadFacturaA(
  letra: "A" | "B" | "C",
  modalidad: ModalidadFacturaA,
  revalidarAt: string | null,
  ahora = new Date(),
): void {
  if (letra !== "A") return;
  if (!MODALIDADES_FACTURA_A.has(modalidad)) {
    throw new Error("La modalidad de Factura A guardada no es válida.");
  }
  if (modalidad === "NO_SOPORTADA") {
    throw new Error("Este emisor figura sin soporte para Factura A estándar.");
  }
  if (modalidad !== "ESTANDAR_CONFIRMADA") {
    throw new Error("Falta confirmar administrativamente la modalidad de Factura A estándar.");
  }
  if (!revalidarAt || !fechaIsoValida(revalidarAt)) {
    throw new Error("La confirmación de Factura A no tiene una fecha de revalidación válida.");
  }
  if (revalidarAt < fechaFiscalHoyAr(() => ahora)) {
    throw new Error("La confirmación de Factura A está vencida y debe revalidarse.");
  }
}

export function construirContextoFiscal(
  input: ContextoFiscalInput,
  opciones: { exigirHabilitada: boolean },
): ContextoFiscal {
  const { sucursal, emisor, pv, credencial } = input;
  if (!sucursal || !emisor) {
    throw new Error("La sucursal no tiene emisor fiscal configurado.");
  }
  if (!pv) {
    throw new Error("Esta sucursal no tiene punto de venta configurado.");
  }
  if (sucursal.emisor_id !== emisor.id || pv.emisor_id !== emisor.id) {
    throw new Error("El punto de venta no corresponde al emisor de la sucursal.");
  }
  if (pv.sucursal_id !== sucursal.id) {
    throw new Error("El punto de venta no corresponde a la sucursal seleccionada.");
  }
  if (!pv.activo) {
    throw new Error("El punto de venta de esta sucursal está inactivo.");
  }
  if (!Number.isInteger(pv.numero) || pv.numero <= 0) {
    throw new Error("El número del punto de venta no es válido.");
  }
  if (!emisor.cuit || !emisor.condicion_iva || !emisor.inicio_actividades) {
    throw new Error("Faltan datos fiscales obligatorios del emisor.");
  }
  if (!cuitValido(emisor.cuit)) {
    throw new Error("El CUIT del emisor es inválido.");
  }
  if (!MODALIDADES_FACTURA_A.has(emisor.factura_a_modalidad)) {
    throw new Error("La modalidad de Factura A guardada no es válida.");
  }
  if (!credencial || credencial.ambiente !== pv.modo || credencial.emisor_id !== emisor.id) {
    const ambiente = pv.modo === "PRODUCCION" ? "producción" : "homologación";
    throw new Error(`Falta la credencial de ${ambiente} para este emisor.`);
  }
  if (!credencial.arca_key_enc) {
    throw new Error("Falta la clave privada del emisor.");
  }
  if (!credencial.arca_cert_enc) {
    throw new Error("Falta cargar el certificado del emisor.");
  }
  if (opciones.exigirHabilitada && !credencial.habilitada) {
    throw new Error("La facturación electrónica de este emisor está deshabilitada.");
  }
  if (credencial.padron_validacion_activa && !credencial.padron_probado_at) {
    throw crearErrorFiscalUsuario("PADRON_CONFIG_INVALIDA");
  }

  return {
    emisor: {
      cuit: emisor.cuit,
      condicion_iva: emisor.condicion_iva,
      arca_key_enc: credencial.arca_key_enc,
      arca_cert_enc: credencial.arca_cert_enc,
    },
    emisorImpreso: {
      razon_social: emisor.razon_social,
      nombre_fantasia: emisor.nombre_fantasia,
      cuit: emisor.cuit,
      domicilio_fiscal: emisor.domicilio_fiscal,
      condicion_iva: emisor.condicion_iva,
      ingresos_brutos: emisor.ingresos_brutos,
      inicio_actividades: emisor.inicio_actividades,
      telefono: sucursal.telefono,
    },
    pv: { numero: pv.numero, modo: pv.modo },
    sucursal,
    facturaA: {
      modalidad: emisor.factura_a_modalidad,
      revalidar_at: emisor.factura_a_revalidar_at,
    },
    padron: {
      probadoAt: credencial.padron_probado_at,
      validacionActiva: credencial.padron_validacion_activa,
    },
  };
}
