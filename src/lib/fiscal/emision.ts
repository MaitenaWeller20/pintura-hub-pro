import type { SelectorReceptorFiscal } from "./receptor";
import type { LetraFacturaSolicitada } from "./codigos";
import type { SnapshotFiscalV2 } from "./snapshot";
import {
  copiarConfirmacionFiscal,
  crearHuellaConfirmacionFiscal,
  type ConfirmacionFiscalPostBorrador,
} from "./confirmacion";
import {
  codigoErrorFiscalUsuario,
  mensajeCodigoErrorFiscalUsuario,
  type CodigoErrorFiscalUsuario,
} from "./error-usuario";

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
  confirmacionAutoritativa: ConfirmacionFiscalPostBorrador;
  huellaConfirmacion: string;
  reconfirmacion: {
    fechaComercial: string;
    pagado: string;
    saldo: string;
    comprador: string | null;
    cbteAsoc: {
      tipo: number;
      letra: "A" | "B" | "C";
      puntoVenta: number;
      numero: number;
      fecha: string;
    } | null;
    demoraDias: number;
    advertenciaDemora: string | null;
    confirmacionFacturaAPermitida: boolean;
  };
};

export type PreviewFiscalAutoritativaReconfirmacion = {
  autoritativo: true;
  venta_id: string;
  fecha_comercial: string;
  fecha_fiscal: string;
  total: string;
  pagado: string;
  saldo: string;
  comprador: string | null;
  receptor: ConfirmacionFiscalPostBorrador["receptor"];
  letra: "A" | "B" | "C";
  razon_letra: string;
  emisor_cuit: string;
  emisor_razon_social: string;
  sucursal_id: string;
  sucursal_nombre: string;
  punto_venta: number;
  modo: "PRODUCCION" | "HOMOLOGACION";
  afip_validez: PreparacionEmisionFiscal["validez"];
  cbte_tipo: number;
  cbte_asoc: {
    tipo: number;
    letra: "A" | "B" | "C";
    punto_venta: number;
    numero: number;
    fecha: string;
  } | null;
  demora_dias: number;
  advertencia_demora: string | null;
  confirmacion_factura_a_permitida: boolean;
  confirmacion_autoritativa: ConfirmacionFiscalPostBorrador;
  huella_confirmacion: string;
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
  | {
      estado: "ERROR_CORREGIBLE";
      codigo: CodigoErrorFiscalUsuario;
      mensaje: string;
    }
  | { estado: "RECONCILIAR"; mensaje: string }
  | { estado: "BLOQUEADO"; diferencias: string[] }
  | { estado: "EN_CURSO"; mensaje: string }
  | {
      estado: "RECONFIRMACION_REQUERIDA";
      mensaje: string;
      afip_validez: PreparacionEmisionFiscal["validez"];
      preview_autoritativa: PreviewFiscalAutoritativaReconfirmacion;
      huella_confirmacion: string;
      confirmacion_autoritativa: ConfirmacionFiscalPostBorrador;
    };

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
    letraSolicitada: LetraFacturaSolicitada;
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
  cargarEstadoPersistido(ventaId: string): Promise<EstadoTransicionFiscal>;
  cargarReservaPersistida(ventaId: string): Promise<ReservaFiscalPersistida>;
  cargarEstadoParaLiberar?(ventaId: string): Promise<{
    claimToken: string;
    afipVersion: number;
    afipEstado: string;
    afipFase: string | null;
    afipNumero: number | null;
    tieneIdentidadReservada: boolean;
  }>;
  crearPayloadCae(snapshot: SnapshotFiscalV2): unknown;
  solicitarCae(reserva: ReservaFiscalPersistida, payload: unknown): Promise<SolicitudCaeFiscal>;
  esConflictoClaim(error: unknown): boolean;
  esConflictoSecuencia(error: unknown): boolean;
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
  letraSolicitada: LetraFacturaSolicitada;
  confirmaVentaAntigua: boolean;
  huellaConfirmacion: string;
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

function coincideIdentidad(
  estado: EstadoTransicionFiscal,
  claimToken: string,
  numero?: number,
): boolean {
  return (
    estado.afip_claim_token === claimToken &&
    (numero === undefined || estado.afip_numero === numero)
  );
}

function esFase(
  estado: EstadoTransicionFiscal,
  afipEstado: string,
  afipFase: string,
  claimToken: string,
  numero?: number,
): boolean {
  return (
    estado.afip_estado === afipEstado &&
    estado.afip_fase === afipFase &&
    coincideIdentidad(estado, claimToken, numero)
  );
}

function esAprobado(estado: EstadoTransicionFiscal, numero: number): boolean {
  return (
    estado.afip_estado === "APROBADO" &&
    estado.afip_fase === "PERSISTIDO" &&
    estado.afip_claim_token === null &&
    estado.afip_numero === numero
  );
}

async function recargarEstado(
  ventaId: string,
  deps: DependenciasEmisionFiscal,
): Promise<EstadoTransicionFiscal> {
  const estado = await deps.cargarEstadoPersistido(ventaId);
  if (
    estado.venta_id !== ventaId ||
    !Number.isSafeInteger(estado.afip_version) ||
    estado.afip_version < 0
  ) {
    throw new Error("La recarga fiscal autoritativa devolvió un estado inválido.");
  }
  return estado;
}

async function marcarPreflightCorregible(
  ventaId: string,
  claimToken: string,
  version: number,
  cause: unknown,
  deps: DependenciasEmisionFiscal,
): Promise<ResultadoEmisionFiscal> {
  const codigo = codigoErrorFiscalUsuario(cause) ?? "ERROR_CORREGIBLE";
  const mensaje = mensajeCodigoErrorFiscalUsuario(codigo);
  try {
    await deps.transicionar({
      ventaId,
      accion: "ERROR_CORREGIBLE",
      claimToken,
      payload: {
        ...errorEnmascarado("PREFLIGHT", codigo, mensaje, version),
        liberar_identidad: true,
      },
    });
  } catch (error) {
    const persistido = await recargarEstado(ventaId, deps);
    if (
      persistido.afip_estado !== "ERROR_CORREGIBLE" ||
      persistido.afip_claim_token !== null ||
      persistido.afip_numero !== null
    ) {
      throw error;
    }
  }
  return {
    estado: "ERROR_CORREGIBLE",
    codigo,
    mensaje,
  };
}

async function liberarPreflightParaReconfirmar(
  ventaId: string,
  claimToken: string,
  version: number,
  preparacion: PreparacionEmisionFiscal,
  deps: DependenciasEmisionFiscal,
): Promise<ResultadoEmisionFiscal> {
  try {
    await deps.transicionar({
      ventaId,
      accion: "ERROR_CORREGIBLE",
      claimToken,
      payload: {
        ...errorEnmascarado(
          "PREFLIGHT",
          "RECONFIRMACION_REQUERIDA",
          "Los datos fiscales cambiaron después de la confirmación.",
          version,
        ),
        liberar_identidad: true,
      },
    });
  } catch (error) {
    const persistido = await recargarEstado(ventaId, deps);
    if (
      persistido.afip_estado !== "ERROR_CORREGIBLE" ||
      persistido.afip_claim_token !== null ||
      persistido.afip_numero !== null
    ) {
      throw error;
    }
  }
  const confirmacion = copiarConfirmacionFiscal(preparacion.confirmacionAutoritativa);
  const vista = preparacion.reconfirmacion;
  return {
    estado: "RECONFIRMACION_REQUERIDA",
    mensaje: "Los datos fiscales cambiaron; revisalos y confirmá nuevamente.",
    afip_validez: preparacion.validez,
    huella_confirmacion: preparacion.huellaConfirmacion,
    confirmacion_autoritativa: confirmacion,
    preview_autoritativa: {
      autoritativo: true,
      venta_id: preparacion.ventaId,
      fecha_comercial: vista.fechaComercial,
      fecha_fiscal: confirmacion.fechaFiscal,
      total: confirmacion.importe,
      pagado: confirmacion.pagado,
      saldo: confirmacion.saldo,
      comprador: vista.comprador,
      receptor: confirmacion.receptor,
      letra: confirmacion.letra,
      razon_letra: confirmacion.cbteAsoc
        ? `La nota conserva la letra ${confirmacion.letra} del comprobante original.`
        : `La condición ${confirmacion.receptor.condicionIva} determina letra ${confirmacion.letra}.`,
      emisor_cuit: confirmacion.emisorCuit,
      emisor_razon_social: confirmacion.emisorRazonSocial,
      sucursal_id: confirmacion.sucursalId,
      sucursal_nombre: confirmacion.sucursalNombre,
      punto_venta: confirmacion.puntoVenta,
      modo: confirmacion.modo,
      afip_validez: preparacion.validez,
      cbte_tipo: confirmacion.cbteTipo,
      cbte_asoc: confirmacion.cbteAsoc
        ? {
            tipo: confirmacion.cbteAsoc.tipo,
            letra: confirmacion.cbteAsoc.letra,
            punto_venta: confirmacion.cbteAsoc.puntoVenta,
            numero: confirmacion.cbteAsoc.numero,
            fecha: confirmacion.cbteAsoc.fecha,
          }
        : null,
      demora_dias: vista.demoraDias,
      advertencia_demora: vista.advertenciaDemora,
      confirmacion_factura_a_permitida: vista.confirmacionFacturaAPermitida,
      confirmacion_autoritativa: confirmacion,
      huella_confirmacion: preparacion.huellaConfirmacion,
    },
  };
}

function huellaCanonicaPreparacion(preparacion: PreparacionEmisionFiscal): string {
  const huella = crearHuellaConfirmacionFiscal(preparacion.confirmacionAutoritativa);
  if (preparacion.huellaConfirmacion !== huella) {
    throw new Error("La preparación fiscal devolvió una huella autoritativa inconsistente.");
  }
  return huella;
}

async function marcarReconciliacion(
  reserva: ReservaFiscalPersistida,
  version: number,
  deps: DependenciasEmisionFiscal,
  codigo: string,
): Promise<ResultadoEmisionFiscal> {
  const intentar = (expectedVersion: number) =>
    deps.transicionar({
      ventaId: reserva.ventaId,
      accion: "RECONCILIAR",
      claimToken: reserva.claimToken,
      payload: errorEnmascarado(
        "REQUEST_INICIADO",
        codigo,
        "La respuesta fiscal es incierta y requiere conciliación.",
        expectedVersion,
      ),
    });
  try {
    await intentar(version);
  } catch (primerError) {
    let persistido = await recargarEstado(reserva.ventaId, deps);
    const yaConciliable = () =>
      persistido.afip_estado === "RECONCILIAR" &&
      (persistido.afip_fase === "REQUEST_INICIADO" ||
        persistido.afip_fase === "RESPUESTA_RECIBIDA") &&
      coincideIdentidad(persistido, reserva.claimToken, reserva.numero);
    if (!yaConciliable()) {
      if (
        persistido.afip_estado !== "EMITIENDO" ||
        (persistido.afip_fase !== "REQUEST_INICIADO" &&
          persistido.afip_fase !== "RESPUESTA_RECIBIDA") ||
        !coincideIdentidad(persistido, reserva.claimToken, reserva.numero)
      ) {
        throw primerError;
      }
      try {
        await intentar(persistido.afip_version);
      } catch (segundoError) {
        persistido = await recargarEstado(reserva.ventaId, deps);
        if (!yaConciliable()) throw segundoError;
      }
    }
  }
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
      let estadoRespuesta: EstadoTransicionFiscal;
      try {
        estadoRespuesta = await deps.transicionar({
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
      } catch (error) {
        const persistido = await recargarEstado(reserva.ventaId, deps);
        if (
          !esFase(persistido, "EMITIENDO", "RESPUESTA_RECIBIDA", reserva.claimToken, reserva.numero)
        ) {
          return marcarReconciliacion(
            reserva,
            persistido.afip_version,
            deps,
            "PERSISTENCIA_RECHAZO",
          );
        }
        estadoRespuesta = persistido;
      }
      versionPersistida = estadoRespuesta.afip_version;
      try {
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
      } catch (error) {
        const persistido = await recargarEstado(reserva.ventaId, deps);
        if (
          persistido.afip_estado !== "ERROR_CORREGIBLE" ||
          persistido.afip_claim_token !== null ||
          persistido.afip_numero !== null
        ) {
          return marcarReconciliacion(
            reserva,
            persistido.afip_version,
            deps,
            "PERSISTENCIA_RECHAZO",
          );
        }
      }
      const codigo = "ERROR_CORREGIBLE";
      return {
        estado: "ERROR_CORREGIBLE",
        codigo,
        mensaje: mensajeCodigoErrorFiscalUsuario(codigo),
      };
    } catch {
      const persistido = await recargarEstado(reserva.ventaId, deps);
      return marcarReconciliacion(reserva, persistido.afip_version, deps, "PERSISTENCIA_RECHAZO");
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
    const persistido = await recargarEstado(reserva.ventaId, deps);
    if (esFase(persistido, "EMITIENDO", "RESPUESTA_RECIBIDA", reserva.claimToken, reserva.numero)) {
      estadoRespuesta = persistido;
    } else if (esAprobado(persistido, reserva.numero)) {
      estadoRespuesta = persistido;
    } else {
      return marcarReconciliacion(reserva, persistido.afip_version, deps, "PERSISTENCIA_RESPUESTA");
    }
  }

  if (!esAprobado(estadoRespuesta, reserva.numero)) {
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
      const persistido = await recargarEstado(reserva.ventaId, deps);
      if (!esAprobado(persistido, reserva.numero)) {
        return marcarReconciliacion(reserva, persistido.afip_version, deps, "PERSISTENCIA_CAE");
      }
    }
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
    let persistido: EstadoTransicionFiscal | null = null;
    try {
      persistido = await recargarEstado(input.ventaId, deps);
    } catch {
      // Si ni siquiera puede releerse la fuente autoritativa, se conserva la
      // clasificación original del conflicto en vez de asumir un commit.
    }
    if (persistido && esFase(persistido, "EMITIENDO", "PREFLIGHT", claimToken)) {
      estado = persistido;
    } else if (deps.esConflictoClaim(error)) {
      return { estado: "EN_CURSO", mensaje: "Ya existe una emisión fiscal en curso." };
    } else {
      throw error;
    }
  }

  let preparacion: PreparacionEmisionFiscal;
  let secuencia: Awaited<ReturnType<DependenciasEmisionFiscal["consultarSecuencia"]>>;
  try {
    preparacion = await deps.prepararEmision({
      ventaId: input.ventaId,
      receptor: input.receptor,
      letraSolicitada: input.letraSolicitada,
    });
    const huellaAutoritativa = huellaCanonicaPreparacion(preparacion);
    if (input.huellaConfirmacion !== huellaAutoritativa) {
      return liberarPreflightParaReconfirmar(
        input.ventaId,
        claimToken,
        estado.afip_version,
        preparacion,
        deps,
      );
    }
    secuencia = await deps.consultarSecuencia(preparacion);
    deps.validarFechaFiscal(preparacion.fechaComprobante, secuencia.ultimaFechaRemota);
  } catch (cause) {
    const persistido = await recargarEstado(input.ventaId, deps);
    return marcarPreflightCorregible(
      input.ventaId,
      claimToken,
      persistido.afip_version,
      cause,
      deps,
    );
  }

  let numero = 0;
  const maxIntentosReserva = 3;
  for (let intentoReserva = 1; intentoReserva <= maxIntentosReserva; intentoReserva += 1) {
    numero = preparacion.simulado ? secuencia.ultimoLocal + 1 : secuencia.ultimoRemoto + 1;
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
      if (
        estado.afip_estado === "ERROR_CORREGIBLE" &&
        estado.afip_fase === null &&
        estado.afip_claim_token === null &&
        estado.afip_numero === null
      ) {
        return {
          estado: "EN_CURSO",
          mensaje: "Otra emisión de la misma identidad fiscal está en curso.",
        };
      }
      break;
    } catch (error) {
      const persistido = await recargarEstado(input.ventaId, deps);
      if (esFase(persistido, "EMITIENDO", "RESERVADO", claimToken, numero)) {
        estado = persistido;
        break;
      }
      if (persistido.afip_estado === "BLOQUEADO") {
        return { estado: "BLOQUEADO", diferencias: ["secuencia"] };
      }
      const puedeReintentarSecuencia =
        intentoReserva < maxIntentosReserva &&
        deps.esConflictoSecuencia(error) &&
        esFase(persistido, "EMITIENDO", "PREFLIGHT", claimToken);
      if (!puedeReintentarSecuencia) {
        return marcarPreflightCorregible(
          input.ventaId,
          claimToken,
          persistido.afip_version,
          error,
          deps,
        );
      }
      estado = persistido;
      try {
        preparacion = await deps.prepararEmision({
          ventaId: input.ventaId,
          receptor: input.receptor,
          letraSolicitada: input.letraSolicitada,
        });
        if (input.huellaConfirmacion !== huellaCanonicaPreparacion(preparacion)) {
          return liberarPreflightParaReconfirmar(
            input.ventaId,
            claimToken,
            estado.afip_version,
            preparacion,
            deps,
          );
        }
        secuencia = await deps.consultarSecuencia(preparacion);
        deps.validarFechaFiscal(preparacion.fechaComprobante, secuencia.ultimaFechaRemota);
      } catch (cause) {
        return marcarPreflightCorregible(
          input.ventaId,
          claimToken,
          estado.afip_version,
          cause,
          deps,
        );
      }
    }
  }
  if (estado.afip_estado === "BLOQUEADO") {
    return { estado: "BLOQUEADO", diferencias: ["secuencia"] };
  }

  let reserva: ReservaFiscalPersistida;
  try {
    reserva = reservaConEstado(await deps.cargarReservaPersistida(input.ventaId), estado);
    try {
      estado = await deps.transicionar({
        ventaId: input.ventaId,
        accion: "REQUEST_INICIADO",
        claimToken: reserva.claimToken,
        payload: { expected_version: estado.afip_version },
      });
    } catch (primerError) {
      let persistido = await recargarEstado(input.ventaId, deps);
      if (
        !esFase(persistido, "EMITIENDO", "REQUEST_INICIADO", reserva.claimToken, reserva.numero)
      ) {
        if (!esFase(persistido, "EMITIENDO", "RESERVADO", reserva.claimToken, reserva.numero)) {
          throw primerError;
        }
        try {
          estado = await deps.transicionar({
            ventaId: input.ventaId,
            accion: "REQUEST_INICIADO",
            claimToken: reserva.claimToken,
            payload: { expected_version: persistido.afip_version },
          });
        } catch (segundoError) {
          persistido = await recargarEstado(input.ventaId, deps);
          if (
            !esFase(persistido, "EMITIENDO", "REQUEST_INICIADO", reserva.claimToken, reserva.numero)
          ) {
            throw segundoError;
          }
          estado = persistido;
        }
      } else {
        estado = persistido;
      }
    }
  } catch (cause) {
    const persistido = await recargarEstado(input.ventaId, deps);
    return marcarPreflightCorregible(
      input.ventaId,
      claimToken,
      persistido.afip_version,
      cause,
      deps,
    );
  }
  return procesarRequestCae(reserva, estado, deps, input);
}

export async function ejecutarConciliacionFiscal(
  input: { ventaId: string },
  deps: DependenciasEmisionFiscal,
): Promise<ResultadoEmisionFiscal> {
  await deps.autorizarConciliacion(input);
  let reserva = await deps.cargarReservaPersistida(input.ventaId);
  const estadoInicial = await recargarEstado(input.ventaId, deps);
  if (
    estadoInicial.afip_estado === "EMITIENDO" &&
    (estadoInicial.afip_fase === "REQUEST_INICIADO" ||
      estadoInicial.afip_fase === "RESPUESTA_RECIBIDA") &&
    coincideIdentidad(estadoInicial, reserva.claimToken, reserva.numero)
  ) {
    await marcarReconciliacion(reserva, estadoInicial.afip_version, deps, "CONCILIACION_MANUAL");
    reserva = await deps.cargarReservaPersistida(input.ventaId);
  }
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
    try {
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
    } catch (error) {
      const persistido = await recargarEstado(input.ventaId, deps);
      if (!esAprobado(persistido, reserva.numero)) throw error;
    }
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
    try {
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
    } catch (error) {
      const persistido = await recargarEstado(input.ventaId, deps);
      if (persistido.afip_estado !== "BLOQUEADO") throw error;
    }
    return { estado: "BLOQUEADO", diferencias: campos };
  }

  const nuevoClaim = deps.generarClaimToken();
  let estadoReenvio: EstadoTransicionFiscal;
  try {
    estadoReenvio = await deps.transicionar({
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
  } catch (error) {
    const persistido = await recargarEstado(input.ventaId, deps);
    if (!esFase(persistido, "EMITIENDO", "RESERVADO", nuevoClaim, reserva.numero)) {
      throw error;
    }
    estadoReenvio = persistido;
  }
  const reservaReenvio = reservaConEstado(reserva, estadoReenvio);
  let estadoRequest: EstadoTransicionFiscal;
  try {
    estadoRequest = await deps.transicionar({
      ventaId: input.ventaId,
      accion: "REQUEST_INICIADO",
      claimToken: reservaReenvio.claimToken,
      payload: { expected_version: estadoReenvio.afip_version },
    });
  } catch (error) {
    const persistido = await recargarEstado(input.ventaId, deps);
    if (
      !esFase(
        persistido,
        "EMITIENDO",
        "REQUEST_INICIADO",
        reservaReenvio.claimToken,
        reservaReenvio.numero,
      )
    ) {
      throw error;
    }
    estadoRequest = persistido;
  }
  return procesarRequestCae(reservaReenvio, estadoRequest, deps, null);
}
