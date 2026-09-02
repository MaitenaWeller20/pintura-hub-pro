export type FlagsFacturacion = {
  facturacion_receptor_v2_enabled: boolean;
  facturacion_legacy_writer_enabled: boolean;
  nota_credito_periodo_enabled: boolean;
};

export type TipoEntradaFiscal = "LEGACY" | "V2";
export type EscritorFiscal = "LEGACY" | "V2" | "MANTENIMIENTO";

type FilaSettings = FlagsFacturacion & { id: boolean };

function esFilaSettings(value: unknown): value is FilaSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.id === true &&
    typeof row.facturacion_receptor_v2_enabled === "boolean" &&
    typeof row.facturacion_legacy_writer_enabled === "boolean" &&
    typeof row.nota_credito_periodo_enabled === "boolean"
  );
}

/** Se invoca por escritura. Deliberadamente no tiene cache de proceso/request. */
export async function leerFlagsFacturacion(
  consultar: () => Promise<unknown>,
): Promise<FlagsFacturacion> {
  const rows = await consultar();
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("La configuración fiscal debe contener exactamente una fila id=true.");
  }
  if (!esFilaSettings(rows[0])) {
    throw new Error("Los flags fiscales deben ser booleanos válidos en la fila id=true.");
  }
  return {
    facturacion_receptor_v2_enabled: rows[0].facturacion_receptor_v2_enabled,
    facturacion_legacy_writer_enabled: rows[0].facturacion_legacy_writer_enabled,
    nota_credito_periodo_enabled: rows[0].nota_credito_periodo_enabled,
  };
}

export function decidirEscritorFiscal(
  flags: FlagsFacturacion,
  entrada: TipoEntradaFiscal,
): EscritorFiscal {
  const { facturacion_receptor_v2_enabled: v2, facturacion_legacy_writer_enabled: legacy } = flags;
  if (v2 && legacy)
    throw new Error("La configuración fiscal es inválida: ambos escritores están activos.");
  if (!v2 && !legacy) return "MANTENIMIENTO";
  if (legacy) {
    if (entrada !== "LEGACY") throw new Error("El cliente receptor v2 todavía no está habilitado.");
    return "LEGACY";
  }
  if (entrada !== "V2") throw new Error("El cliente legacy quedó fuera del drain fiscal.");
  return "V2";
}

/**
 * Ventana compatible estricta del lector: sólo mientras el escritor legacy es
 * el único habilitado se toleran aprobaciones históricas previas al marcador.
 * El cutover v2 vuelve a cerrar automáticamente ese fallback.
 */
export function permiteLectorLegacySinMarca(flags: FlagsFacturacion): boolean {
  const { facturacion_receptor_v2_enabled: v2, facturacion_legacy_writer_enabled: legacy } = flags;
  if (v2 && legacy) {
    throw new Error("La configuración fiscal es inválida: ambos escritores están activos.");
  }
  return !v2 && legacy;
}

export async function cargarFlagsFacturacionDesdeSupabase(supabaseUsuario: {
  from(tabla: "settings"): {
    select(columnas: string): {
      eq(
        columna: "id",
        valor: true,
      ): Promise<{ data: unknown; error: { message?: string } | null }>;
    };
  };
}): Promise<FlagsFacturacion> {
  return leerFlagsFacturacion(async () => {
    const { data, error } = await supabaseUsuario
      .from("settings")
      .select(
        "id,facturacion_receptor_v2_enabled,facturacion_legacy_writer_enabled,nota_credito_periodo_enabled",
      )
      .eq("id", true);
    if (error)
      throw new Error(
        `No se pudo leer la configuración fiscal: ${error.message ?? "error desconocido"}.`,
      );
    return data;
  });
}
