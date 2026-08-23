import type { SelectorReceptorFiscal } from "./receptor";
import type { SnapshotFiscalV2 } from "./snapshot";

export type AccionTransicionFiscal =
  | "RECLAMAR"
  | "RESERVAR"
  | "REQUEST_INICIADO"
  | "RESPUESTA_RECIBIDA"
  | "APROBAR"
  | "RECUPERAR_CAE"
  | "ERROR_CORREGIBLE"
  | "RECONCILIAR"
  | "REENVIO_VERIFICADO"
  | "LIBERAR"
  | "CANCELAR"
  | "BLOQUEAR";

export type EstadoTransicionFiscal = {
  venta_id: string;
  afip_estado: string;
  afip_fase: string | null;
  afip_claim_token: string | null;
  afip_numero: number | null;
  afip_version: number;
};

export type PreparacionEmisionFiscal = {
  ventaId: string;
  tipoComprobante: "VENTA" | "NOTA_CREDITO";
  emisorCuit: string;
  puntoVenta: number;
  cbteTipo: number;
  modo: "PRODUCCION" | "HOMOLOGACION";
  simulado: boolean;
  validez: "PRODUCCION" | "HOMOLOGACION" | "SIMULADA";
  fechaComprobante: string;
};

export type ReservaFiscalPersistida = {
  ventaId: string;
  claimToken: string;
  afipVersion: number;
  numero: number;
  snapshot: SnapshotFiscalV2;
  payloadHash: string;
  emisorCuit: string;
  puntoVenta: number;
  cbteTipo: number;
  modo: "PRODUCCION" | "HOMOLOGACION";
};

export type SolicitudCaeFiscal =
  | {
      resultado: "APROBADA";
      cae: string;
      vencimiento: string | null;
    }
  | {
      resultado: "RECHAZADA";
      codigo: string;
      mensajeMascarado: string;
    };

export type DecisionConciliacionFiscal =
  | { accion: "RECUPERAR_CAE"; cae: string; vencimiento: string | null }
  | { accion: "REENVIAR_MISMO_NUMERO" }
  | { accion: "BLOQUEAR"; diferencias: string[] };

export type ResultadoEmisionFiscal =
  | {
      estado: "APROBADO";
      cae: string;
      numero: number;
      recuperado: boolean;
      advertencias: string[];
    }
  | { estado: "ERROR_CORREGIBLE"; mensaje: string }
  | { estado: "RECONCILIAR"; mensaje: string }
  | { estado: "BLOQUEADO"; diferencias: string[] }
  | { estado: "EN_CURSO"; mensaje: string };

export type DependenciasEmisionFiscal = {
  generarClaimToken(): string;
  ahoraIso(): string;
  autorizarEmision(input: { ventaId: string; confirmaVentaAntigua: boolean }): Promise<{
    tipoComprobante: "VENTA" | "NOTA_CREDITO" | "NOTA_DEBITO";
    afipVersion: number;
  }>;
  autorizarConciliacion(input: { ventaId: string }): Promise<void>;
  prepararEmision(input: {
    ventaId: string;
    receptor: SelectorReceptorFiscal;
  }): Promise<PreparacionEmisionFiscal>;
  consultarSecuencia(input: PreparacionEmisionFiscal): Promise<{
    ultimoRemoto: number;
    ultimaFechaRemota: string | null;
    ultimoLocal: number;
  }>;
  validarFechaFiscal(fecha: string, ultimaFechaRemota: string | null): void;
  crearSnapshot(input: {
    preparacion: PreparacionEmisionFiscal;
    numero: number;
    receptor: SelectorReceptorFiscal;
  }): Promise<SnapshotFiscalV2>;
  transicionar(input: {
    ventaId: string;
    accion: AccionTransicionFiscal;
    claimToken: string | null;
    payload: Record<string, unknown>;
  }): Promise<EstadoTransicionFiscal>;
  cargarReservaPersistida(ventaId: string): Promise<ReservaFiscalPersistida>;
  cargarEstadoParaLiberar?(ventaId: string): Promise<{
    claimToken: string;
    afipVersion: number;
  }>;
  crearPayloadCae(snapshot: SnapshotFiscalV2): unknown;
  solicitarCae(reserva: ReservaFiscalPersistida, payload: unknown): Promise<SolicitudCaeFiscal>;
  esConflictoClaim(error: unknown): boolean;
  consultarComprobanteCompleto(reserva: ReservaFiscalPersistida): Promise<unknown | null>;
  consultarUltimoAutorizado(reserva: ReservaFiscalPersistida): Promise<number>;
  decidirConciliacion(input: {
    snapshot: SnapshotFiscalV2;
    remoto: unknown | null;
    ultimoRemoto: number;
    numeroReservado: number;
    payloadHash: string;
  }): DecisionConciliacionFiscal;
  guardarFavoritoConfirmado?(input: {
    ventaId: string;
    receptor: Extract<SelectorReceptorFiscal, { origen: "MANUAL" }>;
  }): Promise<void>;
};

type InputEmision = {
  ventaId: string;
  receptor: SelectorReceptorFiscal;
  confirmaVentaAntigua: boolean;
};

const RESUMEN_AUSENCIA = {
  tipo: "CONSULTA_ARCA",
  resultado: "AUSENTE",
  fuente: "FECompConsultar",
  ausencia_confirmada: true,
  observaciones: [],
} as const;

const RESUMEN_COINCIDENCIA = {
  tipo: "CONSULTA_ARCA",
  resultado: "COINCIDE",
  fuente: "FECompConsultar",
  coincidencia_completa: true,
  observaciones: [],
} as const;

function errorEnmascarado(fase: string, codigo: string, mensaje: string, expectedVersion: number) {
  return {
    expected_version: expectedVersion,
    error_clase: "APLICACION",
    error_codigo: codigo,
    error_fase: fase,
    mensaje_mascarado: mensaje,
  };
}

async function marcarPreflightCorregible(
  ventaId: string,
  claimToken: string,
  version: number,
  deps: DependenciasEmisionFiscal,
): Promise<ResultadoEmisionFiscal> {
  await deps.transicionar({
    ventaId,
    accion: "ERROR_CORREGIBLE",
    claimToken,
    payload: {
      ...errorEnmascarado(
        "PREFLIGHT",
        "PREFLIGHT_FALLIDO",
        "La preparación fiscal falló antes de iniciar el request.",
        version,
      ),
      liberar_identidad: true,
    },
  });
  return {
    estado: "ERROR_CORREGIBLE",
    mensaje: "La preparación fiscal falló antes de iniciar el request.",
  };
}

async function marcarReconciliacion(
  reserva: ReservaFiscalPersistida,
  version: number,
  deps: DependenciasEmisionFiscal,
  codigo: string,
): Promise<ResultadoEmisionFiscal> {
  await deps.transicionar({
    ventaId: reserva.ventaId,
    accion: "RECONCILIAR",
    claimToken: reserva.claimToken,
    payload: errorEnmascarado(
      "REQUEST_INICIADO",
      codigo,
      "La respuesta fiscal es incierta y requiere conciliación.",
      version,
    ),
  });
  return {
    estado: "RECONCILIAR",
    mensaje: "La respuesta fiscal es incierta y requiere conciliación.",
  };
}

function reservaConEstado(
  reserva: ReservaFiscalPersistida,
  estado: EstadoTransicionFiscal,
): ReservaFiscalPersistida {
  if (!estado.afip_claim_token || estado.afip_numero == null) {
    throw new Error("La transición fiscal no devolvió la identidad reservada completa.");
  }
  return {
    ...reserva,
    claimToken: estado.afip_claim_token,
    numero: estado.afip_numero,
    afipVersion: estado.afip_version,
  };
}

async function guardarFavoritoSinOcultarCae(
  input: InputEmision,
  deps: DependenciasEmisionFiscal,
): Promise<string[]> {
  if (
    input.receptor.origen !== "MANUAL" ||
    !input.receptor.guardar_para_proximas ||
    !deps.guardarFavoritoConfirmado
  ) {
    return [];
  }
  try {
    await deps.guardarFavoritoConfirmado({ ventaId: input.ventaId, receptor: input.receptor });
    return [];
  } catch {
    return ["El comprobante fue aprobado, pero no se pudo guardar el receptor favorito."];
  }
}

async function procesarRequestCae(
  reservaInicial: ReservaFiscalPersistida,
  estadoRequest: EstadoTransicionFiscal,
  deps: DependenciasEmisionFiscal,
  inputOriginal: InputEmision | null,
): Promise<ResultadoEmisionFiscal> {
  const reserva = reservaConEstado(reservaInicial, estadoRequest);
  let respuesta: SolicitudCaeFiscal;
  try {
    const payloadCae = deps.crearPayloadCae(reserva.snapshot);
    respuesta = await deps.solicitarCae(reserva, payloadCae);
  } catch {
    return marcarReconciliacion(reserva, estadoRequest.afip_version, deps, "REQUEST_INCIERTO");
  }

  if (respuesta.resultado === "RECHAZADA") {
    let versionPersistida = estadoRequest.afip_version;
    try {
      const estadoRespuesta = await deps.transicionar({
        ventaId: reserva.ventaId,
        accion: "RESPUESTA_RECIBIDA",
        claimToken: reserva.claimToken,
        payload: {
          expected_version: versionPersistida,
          respuesta_resumen: {
            tipo: "EMISION",
            resultado: "R",
            fuente: "FECAESolicitar",
            rechazo_confirmado: true,
            codigo: respuesta.codigo,
            mensaje: respuesta.mensajeMascarado,
            observaciones: [],
          },
        },
      });
      versionPersistida = estadoRespuesta.afip_version;
      await deps.transicionar({
        ventaId: reserva.ventaId,
        accion: "ERROR_CORREGIBLE",
        claimToken: reserva.claimToken,
        payload: {
          ...errorEnmascarado(
            "RESPUESTA_RECIBIDA",
            respuesta.codigo,
            respuesta.mensajeMascarado,
            versionPersistida,
          ),
          error_clase: "RECHAZO",
          liberar_identidad: true,
        },
      });
      return { estado: "ERROR_CORREGIBLE", mensaje: respuesta.mensajeMascarado };
    } catch {
      return marcarReconciliacion(reserva, versionPersistida, deps, "PERSISTENCIA_RECHAZO");
    }
  }

  if (respuesta.vencimiento === null) {
    return marcarReconciliacion(reserva, estadoRequest.afip_version, deps, "VENCIMIENTO_AUSENTE");
  }

  let estadoRespuesta: EstadoTransicionFiscal;
  try {
    estadoRespuesta = await deps.transicionar({
      ventaId: reserva.ventaId,
      accion: "RESPUESTA_RECIBIDA",
      claimToken: reserva.claimToken,
      payload: {
        expected_version: estadoRequest.afip_version,
        respuesta_resumen: {
          tipo: "EMISION",
          resultado: "A",
          fuente: "FECAESolicitar",
          rechazo_confirmado: false,
          observaciones: [],
        },
      },
    });
  } catch {
    return marcarReconciliacion(
      reserva,
      estadoRequest.afip_version,
      deps,
      "PERSISTENCIA_RESPUESTA",
    );
  }

  try {
    await deps.transicionar({
      ventaId: reserva.ventaId,
      accion: "APROBAR",
      claimToken: reserva.claimToken,
      payload: {
        expected_version: estadoRespuesta.afip_version,
        cae: respuesta.cae,
        cae_vencimiento: respuesta.vencimiento,
        emitido_at: deps.ahoraIso(),
      },
    });
  } catch {
    return marcarReconciliacion(reserva, estadoRespuesta.afip_version, deps, "PERSISTENCIA_CAE");
  }

  const advertencias = inputOriginal ? await guardarFavoritoSinOcultarCae(inputOriginal, deps) : [];
  return {
    estado: "APROBADO",
    cae: respuesta.cae,
    numero: reserva.numero,
    recuperado: false,
    advertencias,
  };
}

export async function ejecutarEmisionFiscal(
  input: InputEmision,
  deps: DependenciasEmisionFiscal,
): Promise<ResultadoEmisionFiscal> {
  const autorizacion = await deps.autorizarEmision({
    ventaId: input.ventaId,
    confirmaVentaAntigua: input.confirmaVentaAntigua,
  });
  if (autorizacion.tipoComprobante === "NOTA_DEBITO") {
    throw new Error("La nota de débito nueva queda fuera de alcance fiscal.");
  }
  if (
    autorizacion.tipoComprobante === "NOTA_CREDITO" &&
    input.receptor.origen !== "COMPROBANTE_ORIGINAL"
  ) {
    throw new Error("La nota de crédito debe usar el receptor del comprobante original.");
  }
  if (
    autorizacion.tipoComprobante === "VENTA" &&
    input.receptor.origen === "COMPROBANTE_ORIGINAL"
  ) {
    throw new Error("Una venta ordinaria no admite receptor de comprobante original.");
  }

  const claimToken = deps.generarClaimToken();
  let estado: EstadoTransicionFiscal;
  try {
    estado = await deps.transicionar({
      ventaId: input.ventaId,
      accion: "RECLAMAR",
      claimToken,
      payload: {
        expected_version: autorizacion.afipVersion,
        lease_segundos: 300,
      },
    });
  } catch (error) {
    if (deps.esConflictoClaim(error)) {
      return { estado: "EN_CURSO", mensaje: "Ya existe una emisión fiscal en curso." };
    }
    throw error;
  }

  let preparacion: PreparacionEmisionFiscal;
  let secuencia: Awaited<ReturnType<DependenciasEmisionFiscal["consultarSecuencia"]>>;
  try {
    preparacion = await deps.prepararEmision({
      ventaId: input.ventaId,
      receptor: input.receptor,
    });
    secuencia = await deps.consultarSecuencia(preparacion);
    deps.validarFechaFiscal(preparacion.fechaComprobante, secuencia.ultimaFechaRemota);
  } catch {
    return marcarPreflightCorregible(input.ventaId, claimToken, estado.afip_version, deps);
  }

  const numero = preparacion.simulado ? secuencia.ultimoLocal + 1 : secuencia.ultimoRemoto + 1;
  try {
    const snapshot = await deps.crearSnapshot({
      preparacion,
      numero,
      receptor: input.receptor,
    });
    estado = await deps.transicionar({
      ventaId: input.ventaId,
      accion: "RESERVAR",
      claimToken,
      payload: {
        expected_version: estado.afip_version,
        snapshot,
        snapshot_hash: snapshot.hash,
        numero_propuesto: numero,
        fecha_comprobante: preparacion.fechaComprobante,
        emisor_cuit: preparacion.emisorCuit,
        punto_venta: preparacion.puntoVenta,
        cbte_tipo: preparacion.cbteTipo,
        modo: preparacion.modo,
        simulado: preparacion.simulado,
        validez: preparacion.validez,
        ultimo_remoto: secuencia.ultimoRemoto,
        ultimo_local_observado: secuencia.ultimoLocal,
      },
    });
  } catch {
    return marcarPreflightCorregible(input.ventaId, claimToken, estado.afip_version, deps);
  }
  if (estado.afip_estado === "BLOQUEADO") {
    return { estado: "BLOQUEADO", diferencias: ["secuencia"] };
  }

  let reserva: ReservaFiscalPersistida;
  try {
    reserva = reservaConEstado(await deps.cargarReservaPersistida(input.ventaId), estado);
    estado = await deps.transicionar({
      ventaId: input.ventaId,
      accion: "REQUEST_INICIADO",
      claimToken: reserva.claimToken,
      payload: { expected_version: estado.afip_version },
    });
  } catch {
    return marcarPreflightCorregible(input.ventaId, claimToken, estado.afip_version, deps);
  }
  return procesarRequestCae(reserva, estado, deps, input);
}

export async function ejecutarConciliacionFiscal(
  input: { ventaId: string },
  deps: DependenciasEmisionFiscal,
): Promise<ResultadoEmisionFiscal> {
  await deps.autorizarConciliacion(input);
  const reserva = await deps.cargarReservaPersistida(input.ventaId);
  const remoto = await deps.consultarComprobanteCompleto(reserva);
  const ultimoRemoto =
    remoto === null ? await deps.consultarUltimoAutorizado(reserva) : reserva.numero;
  const decision = deps.decidirConciliacion({
    snapshot: reserva.snapshot,
    remoto,
    ultimoRemoto,
    numeroReservado: reserva.numero,
    payloadHash: reserva.payloadHash,
  });

  if (decision.accion === "RECUPERAR_CAE") {
    await deps.transicionar({
      ventaId: input.ventaId,
      accion: "RECUPERAR_CAE",
      claimToken: reserva.claimToken,
      payload: {
        expected_version: reserva.afipVersion,
        cae: decision.cae,
        cae_vencimiento: decision.vencimiento,
        payload_hash: reserva.payloadHash,
        respuesta_resumen: RESUMEN_COINCIDENCIA,
      },
    });
    return {
      estado: "APROBADO",
      cae: decision.cae,
      numero: reserva.numero,
      recuperado: true,
      advertencias: [],
    };
  }

  if (decision.accion === "BLOQUEAR") {
    const campos = [...new Set(decision.diferencias)].sort();
    await deps.transicionar({
      ventaId: input.ventaId,
      accion: "BLOQUEAR",
      claimToken: reserva.claimToken,
      payload: {
        ...errorEnmascarado(
          "CONCILIACION",
          "DIVERGENCIA_ARCA",
          "La consulta ARCA no coincide con la identidad fiscal reservada.",
          reserva.afipVersion,
        ),
        error_clase: "DIVERGENCIA",
        diferencias: { campos },
      },
    });
    return { estado: "BLOQUEADO", diferencias: campos };
  }

  const nuevoClaim = deps.generarClaimToken();
  const estadoReenvio = await deps.transicionar({
    ventaId: input.ventaId,
    accion: "REENVIO_VERIFICADO",
    claimToken: reserva.claimToken,
    payload: {
      expected_version: reserva.afipVersion,
      nuevo_claim_token: nuevoClaim,
      ultimo_remoto: ultimoRemoto,
      respuesta_resumen: RESUMEN_AUSENCIA,
      payload_hash: reserva.payloadHash,
    },
  });
  const reservaReenvio = reservaConEstado(reserva, estadoReenvio);
  const estadoRequest = await deps.transicionar({
    ventaId: input.ventaId,
    accion: "REQUEST_INICIADO",
    claimToken: reservaReenvio.claimToken,
    payload: { expected_version: estadoReenvio.afip_version },
  });
  return procesarRequestCae(reservaReenvio, estadoRequest, deps, null);
}
