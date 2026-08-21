import {
  construirContextoFiscal,
  type ContextoFiscal,
  type CredencialFiscalRow,
  type EmisorFiscalRow,
  type PuntoVentaFiscalRow,
  type SucursalFiscalRow,
} from "./contexto";
import type { CondicionIva } from "./codigos";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";

function errorConsulta(entidad: string, error: { message?: string } | null | undefined): never {
  throw new Error(`No se pudo cargar ${entidad}: ${error?.message || "error desconocido"}.`);
}

function condicionIva(valor: string | null): CondicionIva | null {
  if (
    valor === "RESPONSABLE_INSCRIPTO" ||
    valor === "MONOTRIBUTO" ||
    valor === "EXENTO" ||
    valor === "CONSUMIDOR_FINAL"
  ) {
    return valor;
  }
  return null;
}

function ambienteArca(valor: string): "HOMOLOGACION" | "PRODUCCION" {
  if (valor === "HOMOLOGACION" || valor === "PRODUCCION") return valor;
  throw new Error(`El ambiente ARCA guardado no es válido: ${valor}.`);
}

/**
 * Resuelve el contexto exclusivamente desde la sucursal. El emisor nunca llega
 * como argumento del navegador: se sigue el vínculo guardado en la base y luego
 * se filtran PV y credencial con ese mismo id.
 */
export async function cargarContextoFiscal(
  sb: SupabaseClient<Database>,
  sucursalId: string,
  opciones: { exigirHabilitada: boolean } = { exigirHabilitada: true },
): Promise<ContextoFiscal> {
  const { data: sucursalData, error: sucursalError } = await sb
    .from("sucursales")
    .select(
      "id,nombre,telefono,emisor_id,emisor:emisores(id,razon_social,nombre_fantasia,cuit,domicilio_fiscal,condicion_iva,ingresos_brutos,inicio_actividades)",
    )
    .eq("id", sucursalId)
    .maybeSingle();
  if (sucursalError) errorConsulta("la sucursal y su emisor", sucursalError);

  const sucursal: SucursalFiscalRow | null = sucursalData
    ? {
        id: sucursalData.id,
        nombre: sucursalData.nombre,
        telefono: sucursalData.telefono,
        emisor_id: sucursalData.emisor_id,
      }
    : null;
  const emisorData = sucursalData?.emisor ?? null;
  const emisor: EmisorFiscalRow | null = emisorData
    ? {
        id: emisorData.id,
        razon_social: emisorData.razon_social,
        nombre_fantasia: emisorData.nombre_fantasia,
        cuit: emisorData.cuit,
        domicilio_fiscal: emisorData.domicilio_fiscal,
        condicion_iva: condicionIva(emisorData.condicion_iva),
        ingresos_brutos: emisorData.ingresos_brutos,
        inicio_actividades: emisorData.inicio_actividades,
      }
    : null;

  const { data: pvData, error: pvError } = await sb
    .from("puntos_venta")
    .select("sucursal_id,emisor_id,numero,modo,activo")
    .eq("sucursal_id", sucursalId)
    .maybeSingle();
  if (pvError) errorConsulta("el punto de venta", pvError);
  const pv: PuntoVentaFiscalRow | null = pvData
    ? {
        sucursal_id: pvData.sucursal_id,
        emisor_id: pvData.emisor_id,
        numero: pvData.numero,
        modo: ambienteArca(pvData.modo),
        activo: pvData.activo,
      }
    : null;

  let credencial: CredencialFiscalRow | null = null;
  if (emisor && pv) {
    const { data: credencialData, error: credencialError } = await sb
      .from("credenciales_arca")
      .select("emisor_id,ambiente,arca_key_enc,arca_cert_enc,habilitada")
      .eq("emisor_id", emisor.id)
      .eq("ambiente", pv.modo)
      .maybeSingle();
    if (credencialError) errorConsulta("la credencial ARCA", credencialError);
    credencial = credencialData
      ? {
          emisor_id: credencialData.emisor_id,
          ambiente: ambienteArca(credencialData.ambiente),
          arca_key_enc: credencialData.arca_key_enc,
          arca_cert_enc: credencialData.arca_cert_enc,
          habilitada: credencialData.habilitada,
        }
      : null;
  }

  return construirContextoFiscal({ sucursal, emisor, pv, credencial }, opciones);
}
