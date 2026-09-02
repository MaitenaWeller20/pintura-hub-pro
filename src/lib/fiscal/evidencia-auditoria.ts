export type EvidenciaAutorizacionFiscal = {
  origen: "EMISION" | "RECUPERACION";
  confirmadoAt: string;
};

export const COLUMNAS_VENTA_EVIDENCIA_AUTORIZACION_SEGURA = "afip_emitido_at" as const;

export const COLUMNAS_EVIDENCIA_AUTORIZACION_SEGURA =
  "resultado,emision_tipo:respuesta_resumen->evidencia_externa->respuesta_emision->>tipo,emision_resultado:respuesta_resumen->evidencia_externa->respuesta_emision->>resultado,emision_fuente:respuesta_resumen->evidencia_externa->respuesta_emision->>fuente,emision_emitido_at:respuesta_resumen->evidencia_externa->respuesta_emision->>emitido_at,recuperacion_tipo:respuesta_resumen->evidencia_externa->consulta_recuperacion->>tipo,recuperacion_resultado:respuesta_resumen->evidencia_externa->consulta_recuperacion->>resultado,recuperacion_fuente:respuesta_resumen->evidencia_externa->consulta_recuperacion->>fuente,recuperacion_coincidencia:respuesta_resumen->evidencia_externa->consulta_recuperacion->>coincidencia_completa" as const;

export type FilaVentaEvidenciaAutorizacionSegura = {
  afip_emitido_at: string | null;
};

export type FilaEvidenciaAutorizacionSegura = {
  resultado: string | null;
  emision_tipo: string | null;
  emision_resultado: string | null;
  emision_fuente: string | null;
  emision_emitido_at: string | null;
  recuperacion_tipo: string | null;
  recuperacion_resultado: string | null;
  recuperacion_fuente: string | null;
  recuperacion_coincidencia: string | null;
};

type RespuestaLecturaEvidencia = {
  data: FilaEvidenciaAutorizacionSegura | null;
  error: { message: string } | null;
};

type RespuestaLecturaVenta = {
  data: FilaVentaEvidenciaAutorizacionSegura | null;
  error: { message: string } | null;
};

function timestampSeguro(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return false;
  }
  return Number.isFinite(new Date(value).getTime());
}

function proyectarFila(
  row: FilaEvidenciaAutorizacionSegura,
  afipEmitidoAt: string,
): EvidenciaAutorizacionFiscal {
  if (
    row.resultado === "APROBADO" &&
    row.emision_tipo === "EMISION" &&
    row.emision_resultado === "A" &&
    row.emision_fuente === "FECAESolicitar" &&
    timestampSeguro(row.emision_emitido_at)
  ) {
    return { origen: "EMISION", confirmadoAt: row.emision_emitido_at };
  }
  if (
    row.resultado === "RECUPERADO_CAE" &&
    row.recuperacion_tipo === "CONSULTA_ARCA" &&
    row.recuperacion_resultado === "COINCIDE" &&
    row.recuperacion_fuente === "FECompConsultar" &&
    row.recuperacion_coincidencia === "true" &&
    timestampSeguro(afipEmitidoAt)
  ) {
    return { origen: "RECUPERACION", confirmadoAt: afipEmitidoAt };
  }
  throw new Error("No se pudo validar la evidencia de autorización fiscal.");
}

export async function cargarEvidenciaAutorizacionFiscal(
  ventaId: string,
  deps: {
    cargarVenta(input: {
      ventaId: string;
      columnas: typeof COLUMNAS_VENTA_EVIDENCIA_AUTORIZACION_SEGURA;
    }): Promise<RespuestaLecturaVenta>;
    cargarIntento(input: {
      ventaId: string;
      columnas: typeof COLUMNAS_EVIDENCIA_AUTORIZACION_SEGURA;
    }): Promise<RespuestaLecturaEvidencia>;
  },
): Promise<EvidenciaAutorizacionFiscal | null> {
  // Esta lectura user-bound ocurre antes de abrir la frontera admin. Para una
  // recuperación, afip_emitido_at es el reloj canónico persistido por la venta:
  // updated_at del intento usa now() y puede quedar legítimamente antes.
  const venta = await deps.cargarVenta({
    ventaId,
    columnas: COLUMNAS_VENTA_EVIDENCIA_AUTORIZACION_SEGURA,
  });
  if (venta.error || !venta.data || !timestampSeguro(venta.data.afip_emitido_at)) {
    throw new Error("No se pudo validar la emisión fiscal autorizada.");
  }

  const respuesta = await deps.cargarIntento({
    ventaId,
    columnas: COLUMNAS_EVIDENCIA_AUTORIZACION_SEGURA,
  });
  if (respuesta.error) {
    throw new Error("No se pudo leer la evidencia de autorización fiscal.");
  }
  return respuesta.data ? proyectarFila(respuesta.data, venta.data.afip_emitido_at) : null;
}
