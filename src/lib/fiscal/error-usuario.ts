import type { ZodType } from "zod";

export type MomentoErrorFiscal = "REVISION" | "EMISION" | "CONSULTA" | "CONFIGURACION";

export const CODIGOS_ERROR_FISCAL_USUARIO = [
  "VALIDACION_RAZON_SOCIAL",
  "VALIDACION_DOCUMENTO",
  "VALIDACION_RECEPTOR_GUARDADO",
  "VALIDACION_CONFIRMACION",
  "VALIDACION_LETRA",
  "VALIDACION_VENTA",
  "VALIDACION_DATOS",
  "CONSULTA_INVALIDA",
  "CONFIGURACION_INVALIDA",
  "ARCA_RECHAZO",
  "MANTENIMIENTO",
  "RECONFIRMACION",
  "ERROR_CORREGIBLE",
  "INCIDENTE_RECHAZO",
  "INCIDENTE_PENDIENTE",
  "INCIDENTE_INTEGRIDAD",
  "INCIDENTE_LEGACY_ERROR",
  "INCIDENTE_FISCAL",
  "MANTENIMIENTO_POST_VENTA",
  "PADRON_ARCA_CAIDO",
  "PADRON_NO_AUTORIZADO",
  "PADRON_CONFIG_INVALIDA",
  "CUIT_INVALIDO",
  "CUIT_NO_ENCONTRADO",
  "CUIT_INACTIVO",
  "RESPUESTA_PADRON_INVALIDA",
  "CONDICION_FISCAL_INCOMPATIBLE",
  "VALIDACION_PERIODO_DESDE",
  "VALIDACION_PERIODO_HASTA",
  "VALIDACION_MOTIVO_NC_PERIODO",
  "VALIDACION_MODALIDAD_NC_PERIODO",
  "VALIDACION_RESOLUCION_NC_PERIODO",
  "VALIDACION_ITEMS_NC_PERIODO",
  "VALIDACION_PAGOS_NC_PERIODO",
  "PERMISO_NC_PERIODO",
  "FCE_NC_PERIODO_NO_SOPORTADA",
  "CERTIFICADO_ARCA_INVALIDO",
  "ARCA_CAIDA_PRE_REQUEST_NC",
  "ARCA_INCIERTA_POST_REQUEST_NC",
  "CONFLICTO_RECONCILIACION_NC",
] as const;

export type CodigoErrorFiscalUsuario = (typeof CODIGOS_ERROR_FISCAL_USUARIO)[number];

type IssueValidacion = {
  path?: unknown;
  message?: unknown;
};

const MENSAJE_RAZON_SOCIAL =
  "Completá la razón social del receptor. ARCA la necesita para identificar a quién se emite el comprobante.";

const MENSAJES_USUARIO: Record<CodigoErrorFiscalUsuario, string> = {
  VALIDACION_RAZON_SOCIAL: MENSAJE_RAZON_SOCIAL,
  VALIDACION_DOCUMENTO:
    "Revisá el documento del receptor. Completalo con el tipo y la cantidad de dígitos indicados antes de continuar.",
  VALIDACION_RECEPTOR_GUARDADO: "Elegí un receptor guardado válido antes de continuar.",
  VALIDACION_CONFIRMACION:
    "Confirmá que revisaste los datos fiscales ingresados antes de continuar.",
  VALIDACION_LETRA: "Elegí si corresponde emitir una factura A o una factura B.",
  VALIDACION_VENTA:
    "No pudimos identificar la venta que querés facturar. Volvé a abrirla desde la cola fiscal.",
  VALIDACION_DATOS:
    "Revisá los datos fiscales ingresados. Hay información incompleta o con un formato inválido.",
  CONSULTA_INVALIDA:
    "No pudimos identificar la información fiscal solicitada. Volvé a abrirla desde la pantalla anterior.",
  CONFIGURACION_INVALIDA:
    "Revisá los datos de configuración fiscal. Hay información incompleta o con un formato inválido.",
  ARCA_RECHAZO:
    "ARCA rechazó el comprobante. Revisá los datos fiscales indicados y corregilos antes de volver a intentar.",
  MANTENIMIENTO:
    "La facturación electrónica está temporalmente en mantenimiento. La emisión no comenzó; volvé a intentar más tarde.",
  RECONFIRMACION:
    "Los datos fiscales cambiaron mientras los revisabas. Verificá la información actualizada y confirmá nuevamente.",
  ERROR_CORREGIBLE:
    "ARCA no autorizó el comprobante. Revisá los datos fiscales y corregilos antes de volver a intentar.",
  INCIDENTE_RECHAZO:
    "ARCA rechazó el comprobante. Revisá los datos fiscales y el código informado antes de volver a intentar.",
  INCIDENTE_PENDIENTE:
    "La respuesta de ARCA no pudo confirmarse y el comprobante quedó pendiente. Verificá su estado antes de reintentar.",
  INCIDENTE_INTEGRIDAD:
    "Los datos recibidos no coinciden con la emisión reservada. El comprobante quedó bloqueado para una revisión segura.",
  INCIDENTE_LEGACY_ERROR:
    "Una emisión anterior terminó con error y no conserva un diagnóstico seguro. Revisá los datos antes de reintentar.",
  INCIDENTE_FISCAL:
    "La emisión requiere revisión. Consultá el estado, la fase y las diferencias indicadas antes de realizar otra acción.",
  MANTENIMIENTO_POST_VENTA:
    "La venta quedó registrada y la emisión está en mantenimiento. No repitas la venta ni el cobro; revisá el estado en la cola fiscal.",
  PADRON_ARCA_CAIDO:
    "ARCA está caído y no pudimos verificar el CUIT. No se emitió ningún comprobante. Intentá nuevamente en otro momento.",
  PADRON_NO_AUTORIZADO:
    "El certificado no está habilitado para consultar el padrón de ARCA. Un administrador debe asociarlo al servicio ws_sr_constancia_inscripcion y probar nuevamente la conexión.",
  PADRON_CONFIG_INVALIDA:
    "No se pudo usar la configuración del padrón de ARCA. Un administrador debe revisar el certificado y volver a probar la conexión. No se emitió ningún comprobante.",
  CUIT_INVALIDO: "El CUIT ingresado no es válido. Revisá los 11 dígitos y volvé a intentar.",
  CUIT_NO_ENCONTRADO:
    "ARCA no encontró el CUIT ingresado. Revisalo antes de continuar. No se emitió ningún comprobante.",
  CUIT_INACTIVO:
    "El CUIT figura inactivo en ARCA. No se puede emitir el comprobante a ese receptor.",
  RESPUESTA_PADRON_INVALIDA:
    "ARCA devolvió datos incompletos o inconsistentes para este CUIT. No se emitió ningún comprobante. Intentá nuevamente o avisale a un administrador.",
  CONDICION_FISCAL_INCOMPATIBLE:
    "La condición fiscal informada por ARCA no es compatible con la letra elegida. Revisá la letra del comprobante antes de continuar.",
  VALIDACION_PERIODO_DESDE: "Elegí la fecha desde del período asociado.",
  VALIDACION_PERIODO_HASTA: "Elegí la fecha hasta del período asociado.",
  VALIDACION_MOTIVO_NC_PERIODO:
    "Explicá el motivo de la nota de crédito con al menos 5 caracteres.",
  VALIDACION_MODALIDAD_NC_PERIODO: "Elegí cómo se compone la nota de crédito.",
  VALIDACION_RESOLUCION_NC_PERIODO: "Elegí qué ocurre con el importe acreditado.",
  VALIDACION_ITEMS_NC_PERIODO: "Revisá los productos o el importe de la nota de crédito.",
  VALIDACION_PAGOS_NC_PERIODO: "El reintegro debe coincidir con el total de la nota.",
  PERMISO_NC_PERIODO:
    "No tenés permiso para crear notas de crédito por período. Pedile acceso a un administrador.",
  FCE_NC_PERIODO_NO_SOPORTADA:
    "Una nota de crédito por período no es compatible con FCE. Asociá los comprobantes puntuales que querés ajustar.",
  CERTIFICADO_ARCA_INVALIDO:
    "No se pudo emitir porque el certificado de ARCA está vencido o no autorizado. Un administrador debe corregir la configuración fiscal del emisor.",
  ARCA_CAIDA_PRE_REQUEST_NC:
    "ARCA está caída. No se pudo emitir la nota de crédito. Intentá nuevamente en otro momento.",
  ARCA_INCIERTA_POST_REQUEST_NC:
    "ARCA está caída y estamos verificando si autorizó la nota. No vuelvas a emitirla.",
  CONFLICTO_RECONCILIACION_NC:
    "Los datos recuperados de ARCA no coinciden con la nota reservada. La emisión quedó bloqueada para revisión; no vuelvas a emitirla.",
};

const CODIGO_POR_CAMPO: Record<string, CodigoErrorFiscalUsuario> = {
  "receptor.razon_social": "VALIDACION_RAZON_SOCIAL",
  "receptor.numero_documento": "VALIDACION_DOCUMENTO",
  "receptor.receptor_fiscal_id": "VALIDACION_RECEPTOR_GUARDADO",
  "receptor.confirma_datos_manuales": "VALIDACION_CONFIRMACION",
  letra_solicitada: "VALIDACION_LETRA",
  venta_id: "VALIDACION_VENTA",
  periodo_desde: "VALIDACION_PERIODO_DESDE",
  periodo_hasta: "VALIDACION_PERIODO_HASTA",
  motivo: "VALIDACION_MOTIVO_NC_PERIODO",
  modalidad: "VALIDACION_MODALIDAD_NC_PERIODO",
  resolucion: "VALIDACION_RESOLUCION_NC_PERIODO",
  items: "VALIDACION_ITEMS_NC_PERIODO",
  pagos: "VALIDACION_PAGOS_NC_PERIODO",
};

const PREFIJO_ERROR_USUARIO = "FISCAL_USUARIO_V1:";

const PATRON_CONEXION =
  /(?:Failed to fetch|fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|getaddrinfo|timeout|timed out|connection|socket)/i;

function esRegistro(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathIssue(value: unknown): string {
  return Array.isArray(value)
    ? value
        .filter((segmento) => typeof segmento === "string" || typeof segmento === "number")
        .join(".")
    : "";
}

function issuesDesdeValor(value: unknown): IssueValidacion[] | null {
  if (Array.isArray(value)) return value.filter(esRegistro);
  if (!esRegistro(value)) return null;
  if (Array.isArray(value.issues)) return value.issues.filter(esRegistro);
  if (Array.isArray(value.errors)) return value.errors.filter(esRegistro);
  return null;
}

function intentarJson(texto: string): unknown {
  const limpio = texto.trim();
  const candidatos = [limpio];
  const inicio = limpio.indexOf("[");
  const fin = limpio.lastIndexOf("]");
  if (inicio >= 0 && fin > inicio) candidatos.push(limpio.slice(inicio, fin + 1));

  for (const candidato of candidatos) {
    try {
      return JSON.parse(candidato);
    } catch {
      // El mensaje puede no ser JSON; se clasifica más abajo sin exponerlo.
    }
  }
  return null;
}

function extraerIssues(error: unknown): IssueValidacion[] | null {
  const directos = issuesDesdeValor(error);
  if (directos) return directos;
  if (!esRegistro(error)) return null;

  const causa = extraerIssues(error.cause);
  if (causa) return causa;
  if (typeof error.message !== "string") return null;
  return issuesDesdeValor(intentarJson(error.message));
}

function codigoDeIssues(
  issues: IssueValidacion[],
  momento: MomentoErrorFiscal = "REVISION",
): CodigoErrorFiscalUsuario | null {
  for (const issue of issues) {
    const campo = pathIssue(issue.path);
    const raiz = campo.split(".")[0];
    if (CODIGO_POR_CAMPO[campo]) return CODIGO_POR_CAMPO[campo];
    if (CODIGO_POR_CAMPO[raiz]) return CODIGO_POR_CAMPO[raiz];
  }
  if (!issues.length) return null;
  if (momento === "CONFIGURACION") return "CONFIGURACION_INVALIDA";
  if (momento === "CONSULTA") return "CONSULTA_INVALIDA";
  return "VALIDACION_DATOS";
}

function textoError(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  if (esRegistro(error) && typeof error.message === "string") return error.message.trim();
  return typeof error === "string" ? error.trim() : "";
}

function mensajeFallback(momento: MomentoErrorFiscal, conexion: boolean): string {
  if (momento === "CONFIGURACION") {
    return conexion
      ? "Se cortó la conexión mientras actualizábamos la configuración fiscal. Volvé a cargar la pantalla y verificá el estado antes de repetir la acción."
      : "No pudimos completar la configuración fiscal. Volvé a cargar la pantalla y verificá el estado; si continúa, avisale a un administrador técnico.";
  }
  if (momento === "EMISION") {
    return conexion
      ? "No pudimos confirmar la respuesta de ARCA porque se cortó la conexión. No vuelvas a crear ni cobrar la venta; revisá su estado en la cola fiscal antes de reintentar."
      : "No pudimos confirmar la respuesta de ARCA. No vuelvas a crear ni cobrar la venta; revisá su estado en la cola fiscal antes de reintentar.";
  }
  if (momento === "CONSULTA") {
    return conexion
      ? "No pudimos cargar la información fiscal porque se cortó la conexión. Verificá internet y volvé a intentar."
      : "No pudimos cargar la información fiscal. Volvé a intentar; si continúa, avisale a un administrador.";
  }
  return conexion
    ? "No pudimos revisar los datos fiscales porque se cortó la conexión. La emisión no comenzó; verificá internet y volvé a intentar."
    : "No pudimos revisar los datos fiscales. La emisión no comenzó; verificá los datos y volvé a intentar. Si continúa, avisale a un administrador.";
}

function esCodigoErrorFiscalUsuario(value: unknown): value is CodigoErrorFiscalUsuario {
  return typeof value === "string" && Object.hasOwn(MENSAJES_USUARIO, value);
}

function codigoMarcado(error: unknown, mensaje: string): CodigoErrorFiscalUsuario | null {
  if (esRegistro(error)) {
    if (error.tipo === "ERROR_FISCAL_USUARIO_V1" && esCodigoErrorFiscalUsuario(error.codigo)) {
      return error.codigo;
    }
    if (esCodigoErrorFiscalUsuario(error.codigoFiscalUsuario)) {
      return error.codigoFiscalUsuario;
    }
  }
  if (!mensaje.startsWith(PREFIJO_ERROR_USUARIO)) return null;
  const codigo = mensaje.slice(PREFIJO_ERROR_USUARIO.length);
  return esCodigoErrorFiscalUsuario(codigo) ? codigo : null;
}

export function codigoErrorFiscalUsuario(error: unknown): CodigoErrorFiscalUsuario | null {
  return codigoMarcado(error, textoError(error));
}

export function mensajeCodigoErrorFiscalUsuario(codigo: CodigoErrorFiscalUsuario): string {
  return MENSAJES_USUARIO[codigo];
}

/**
 * Clasifica una indisponibilidad de ARCA con la única frontera que vuelve
 * segura o insegura una repetición: la fase ya persistida. Una vez durable
 * REQUEST_INICIADO, nunca vuelve a ofrecer una emisión ciega.
 */
export function codigoCaidaArcaSegunFase(
  fasePersistida: string | null,
): "ARCA_CAIDA_PRE_REQUEST_NC" | "ARCA_INCIERTA_POST_REQUEST_NC" {
  return fasePersistida === "REQUEST_INICIADO" ||
    fasePersistida === "RESPUESTA_RECIBIDA" ||
    fasePersistida === "PERSISTIDO"
    ? "ARCA_INCIERTA_POST_REQUEST_NC"
    : "ARCA_CAIDA_PRE_REQUEST_NC";
}

/** Reconoce únicamente señales estructuradas de transporte ARCA, no texto SQL o de negocio. */
export function esCaidaArcaConfirmada(error: unknown): boolean {
  const codigo = codigoErrorFiscalUsuario(error);
  if (codigo === "ARCA_CAIDA_PRE_REQUEST_NC" || codigo === "ARCA_INCIERTA_POST_REQUEST_NC") {
    return true;
  }
  if (!esRegistro(error)) return false;
  if (error.name === "AfipTimeout") return true;
  return (
    typeof error.code === "string" &&
    [
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNRESET",
      "ENETUNREACH",
      "EPIPE",
    ].includes(error.code)
  );
}

/**
 * Crea el único tipo de Error cuyo significado puede sobrevivir el transporte
 * cliente/servidor. El mensaje sólo lleva un código cerrado; nunca concatena
 * causas, SQL, respuestas de red ni valores de entorno.
 */
export function crearErrorFiscalUsuario(codigo: CodigoErrorFiscalUsuario): Error {
  const error = new Error(`${PREFIJO_ERROR_USUARIO}${codigo}`) as Error & {
    codigoFiscalUsuario: CodigoErrorFiscalUsuario;
  };
  error.name = "ErrorFiscalUsuario";
  error.codigoFiscalUsuario = codigo;
  return error;
}

/** Referencia estructurada para respuestas seguras que no se lanzan como Error. */
export function referenciaErrorFiscalUsuario(codigo: CodigoErrorFiscalUsuario) {
  return { tipo: "ERROR_FISCAL_USUARIO_V1" as const, codigo };
}

/**
 * Última barrera antes de mostrar un error fiscal. Reconoce validaciones
 * estructuradas, conserva únicamente mensajes de dominio y reemplaza cualquier
 * detalle técnico por una instrucción acorde al momento del flujo.
 */
export function mensajeErrorFiscal(error: unknown, momento: MomentoErrorFiscal): string {
  const issues = extraerIssues(error);
  const codigoValidacion = issues ? codigoDeIssues(issues, momento) : null;
  if (codigoValidacion) return MENSAJES_USUARIO[codigoValidacion];

  const mensaje = textoError(error);
  const codigo = codigoErrorFiscalUsuario(error);
  if (codigo) return mensajeCodigoErrorFiscalUsuario(codigo);
  return mensajeFallback(momento, PATRON_CONEXION.test(mensaje));
}

/**
 * Valida la entrada en el límite del servidor sin permitir que Zod serialice
 * su estructura interna hacia la interfaz.
 */
export function parsearEntradaFiscal<TSchema extends ZodType>(
  schema: TSchema,
  value: unknown,
  momento: MomentoErrorFiscal = "REVISION",
): TSchema["_output"] {
  const resultado = schema.safeParse(value);
  if (resultado.success) return resultado.data;
  const codigo = codigoDeIssues(resultado.error.issues, momento) ?? "VALIDACION_DATOS";
  throw crearErrorFiscalUsuario(codigo);
}
