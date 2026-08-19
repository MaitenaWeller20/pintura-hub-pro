import {
  construirContextoFiscal,
  type ContextoFiscal,
  type CredencialFiscalRow,
  type EmisorFiscalRow,
  type PuntoVentaFiscalRow,
  type SucursalFiscalRow,
} from "./contexto";

type SucursalConEmisor = SucursalFiscalRow & { emisor: EmisorFiscalRow | null };

function errorConsulta(entidad: string, error: { message?: string } | null | undefined): never {
  throw new Error(`No se pudo cargar ${entidad}: ${error?.message || "error desconocido"}.`);
}

/**
 * Resuelve el contexto exclusivamente desde la sucursal. El emisor nunca llega
 * como argumento del navegador: se sigue el vínculo guardado en la base y luego
 * se filtran PV y credencial con ese mismo id.
 */
export async function cargarContextoFiscal(
  sb: any,
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

  const sucursalConEmisor = (sucursalData ?? null) as SucursalConEmisor | null;
  const sucursal = sucursalConEmisor
    ? {
        id: sucursalConEmisor.id,
        nombre: sucursalConEmisor.nombre,
        telefono: sucursalConEmisor.telefono,
        emisor_id: sucursalConEmisor.emisor_id,
      }
    : null;
  const emisor = sucursalConEmisor?.emisor ?? null;

  const { data: pvData, error: pvError } = await sb
    .from("puntos_venta")
    .select("sucursal_id,emisor_id,numero,modo,activo")
    .eq("sucursal_id", sucursalId)
    .maybeSingle();
  if (pvError) errorConsulta("el punto de venta", pvError);
  const pv = (pvData ?? null) as PuntoVentaFiscalRow | null;

  let credencial: CredencialFiscalRow | null = null;
  if (emisor && pv) {
    const { data: credencialData, error: credencialError } = await sb
      .from("credenciales_arca")
      .select("emisor_id,ambiente,arca_key_enc,arca_cert_enc,habilitada")
      .eq("emisor_id", emisor.id)
      .eq("ambiente", pv.modo)
      .maybeSingle();
    if (credencialError) errorConsulta("la credencial ARCA", credencialError);
    credencial = (credencialData ?? null) as CredencialFiscalRow | null;
  }

  return construirContextoFiscal({ sucursal, emisor, pv, credencial }, opciones);
}
