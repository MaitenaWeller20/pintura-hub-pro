import { supabase } from "@/integrations/supabase/client";

/**
 * Mensaje legible cuando el CUIT/DNI choca con una ficha que ya existe.
 *
 * "Ya existe un cliente con ese CUIT/DNI" es cierto pero inútil: fue
 * exactamente lo que dejó trabada a la usuaria, que no tenía forma de averiguar
 * de quién era el documento. El mensaje tiene que decir el nombre.
 *
 * Ver docs/superpowers/specs/2026-08-11-cuit-canonico-design.md
 */

const TABLAS = {
  clientes: { indice: "uq_clientes_cuit_dni_activo", singular: "un cliente" },
  proveedores: { indice: "uq_proveedores_cuit_activo", singular: "un proveedor" },
} as const;

type Tabla = keyof typeof TABLAS;

/**
 * Traduce el error de un alta/edición a algo que se pueda leer.
 *
 * Sólo trata como "documento duplicado" al 23505 que nombra al índice de
 * CUIT: otra restricción única daría un mensaje equivocado.
 */
export async function errorDocumentoLegible(
  tabla: Tabla,
  err: { code?: string; message?: string } | null | undefined,
  cuitNorm: string,
): Promise<string> {
  const { indice, singular } = TABLAS[tabla];
  const msg = err?.message ?? "";
  const esDuplicadoDeDocumento = err?.code === "23505" && msg.includes(indice);

  if (!esDuplicadoDeDocumento) return msg || "No se pudo guardar.";

  const generico = `Ya existe ${singular} con ese CUIT/DNI.`;
  if (!cuitNorm) return generico;

  // Averiguar de quién es. Si esta consulta falla, se cae al mensaje de
  // siempre: el mensaje de error no puede romperse por un error.
  try {
    const { data } = await supabase
      .from(tabla)
      .select("razon_social")
      .eq("cuit_dni", cuitNorm)
      .eq("activo", true)
      .limit(1)
      .maybeSingle();
    const nombre = (data as { razon_social?: string } | null)?.razon_social;
    // El índice sólo cubre las fichas activas, de ahí el "activo".
    return nombre ? `Ya existe ${singular} activo con ese CUIT/DNI: ${nombre}.` : generico;
  } catch {
    return generico;
  }
}
