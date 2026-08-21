import { cuitValido, type CondicionIva } from "./codigos";

export type AmbienteArca = "HOMOLOGACION" | "PRODUCCION";

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
};

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
  };
}
