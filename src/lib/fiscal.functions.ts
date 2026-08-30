import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cargarFlagsFacturacionDesdeSupabase,
  decidirEscritorFiscal,
  permiteLectorLegacySinMarca,
  type FlagsFacturacion,
  type TipoEntradaFiscal,
} from "./fiscal/feature.server";
import {
  autorizarOperacionFiscal,
  evaluarPermisoFiscal,
  type LecturasPermisoFiscal,
} from "./fiscal/permiso.server";
import {
  ErrorImpresionFiscal,
  prepararDatosFiscalesImpresos,
  prepararDatosFiscalesLegacyMarcados,
  type DatosFiscalesPreparados,
} from "./fiscal/impresion";
import { exigirPngDataUrlFiscal, type QrAfipInput } from "./fiscal/qr";
import {
  codigoErrorFiscalUsuario,
  parsearEntradaFiscal,
  crearErrorFiscalUsuario,
  referenciaErrorFiscalUsuario,
  type CodigoErrorFiscalUsuario,
} from "./fiscal/error-usuario";
import { cuitValido } from "./fiscal/codigos";
import type { ContextoFiscal } from "./fiscal/contexto";
import { receptorPadronArcaSchema, type ReceptorPadronArca } from "./fiscal/padron-arca-shared";
import {
  notaCreditoPeriodoInputSchema,
  type NotaCreditoPeriodoInput,
} from "./fiscal/nota-credito-periodo";
import {
  cargarEvidenciaAutorizacionFiscal,
  type FilaEvidenciaAutorizacionSegura,
  type FilaVentaEvidenciaAutorizacionSegura,
} from "./fiscal/evidencia-auditoria";
import { COLUMNAS_VENTA_SEGURAS } from "./ventas-proyeccion";

const receptorSchema = z.discriminatedUnion("origen", [
  z.object({ origen: z.literal("CLIENTE_COMERCIAL") }).strict(),
  z.object({ origen: z.literal("FAVORITO"), receptor_fiscal_id: z.string().uuid() }).strict(),
  z
    .object({
      origen: z.literal("MANUAL"),
      tipo_documento: z.enum(["CUIT", "CUIL", "DNI", "CDI", "SIN_IDENTIFICAR"]),
      numero_documento: z.string().nullable(),
      razon_social: z.string().trim().min(1),
      condicion_iva: z.enum(["RESPONSABLE_INSCRIPTO", "MONOTRIBUTO", "EXENTO", "CONSUMIDOR_FINAL"]),
      domicilio: z.string().nullable(),
      guardar_para_proximas: z.boolean(),
      confirma_datos_manuales: z.literal(true),
    })
    .strict(),
  z.object({ origen: z.literal("COMPROBANTE_ORIGINAL") }).strict(),
]);

const legacyInputSchema = z.object({ venta_id: z.string().uuid() }).strict();
const incidenteInputSchema = legacyInputSchema;
const seleccionLetraV2Schema = z.union([
  z.enum(["A", "B"]),
  z.object({ origen: z.literal("AUTOMATICA_NC_PERIODO") }).strict(),
]);
const v2BaseInputSchema = z
  .object({
    venta_id: z.string().uuid(),
    receptor: receptorSchema,
    letra_solicitada: seleccionLetraV2Schema,
    confirma_venta_antigua: z.boolean(),
  })
  .strict();
const v2InputSchema = v2BaseInputSchema
  .extend({ huella_confirmacion: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
export const emitirInputSchema = z.union([legacyInputSchema, v2InputSchema]);
export const postBorradorInputSchema = v2BaseInputSchema
  .extend({
    huella_confirmacion_provisional: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type ResultadoConsultaCuitPadron =
  | { estado: "INACTIVO" }
  | { estado: "VERIFICADO"; receptor: ReceptorPadronArca };

export const consultaCuitPadronInputSchema = z
  .object({
    sucursal_id: z.string().uuid(),
    cuit: z.string(),
  })
  .strict();

export async function ejecutarConsultaPadronOperador(
  input: { sucursalId: string; cuit: string },
  deps: {
    autorizarSucursal(): Promise<void>;
    cargarContexto(): Promise<ContextoFiscal>;
    consultar(contexto: ContextoFiscal, cuit: string): Promise<ReceptorPadronArca>;
  },
): Promise<ResultadoConsultaCuitPadron> {
  await deps.autorizarSucursal();
  let contexto: ContextoFiscal;
  try {
    contexto = await deps.cargarContexto();
  } catch {
    throw crearErrorFiscalUsuario("PADRON_CONFIG_INVALIDA");
  }
  if (!contexto.padron.validacionActiva) return { estado: "INACTIVO" };
  try {
    const receptor = receptorPadronArcaSchema.parse(await deps.consultar(contexto, input.cuit));
    return { estado: "VERIFICADO", receptor };
  } catch (cause) {
    if (codigoErrorFiscalUsuario(cause)) throw cause;
    throw crearErrorFiscalUsuario("RESPUESTA_PADRON_INVALIDA");
  }
}

const itemBorradorSchema = z
  .object({
    producto_id: z.string().uuid(),
    cantidad: z.number().finite().nonnegative(),
    descuento_porcentaje: z.number().finite().min(0).max(100).default(0),
    precio_unitario_sin_iva: z.number().finite().nonnegative().optional(),
  })
  .strict();

const pagoBorradorSchema = z
  .object({
    forma_pago: z.enum([
      "EFECTIVO",
      "TRANSFERENCIA",
      "TARJETA_DEBITO",
      "TARJETA_CREDITO",
      "MERCADO_PAGO",
      "CHEQUE",
      "CTA_CTE",
    ]),
    monto: z.number().finite().nonnegative(),
    detalle: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const previewInputSchema = z.discriminatedUnion("origen", [
  z
    .object({
      origen: z.literal("VENTA_EXISTENTE"),
      venta_id: z.string().uuid(),
      receptor: receptorSchema,
      letra_solicitada: seleccionLetraV2Schema,
    })
    .strict(),
  z
    .object({
      origen: z.literal("BORRADOR"),
      sucursal_id: z.string().uuid(),
      cliente_id: z.string().uuid(),
      fecha_comercial: z.string().datetime(),
      items: z.array(itemBorradorSchema).min(1),
      pagos: z.array(pagoBorradorSchema),
      percepciones: z.number().finite().nonnegative(),
      receptor: receptorSchema,
      letra_solicitada: z.enum(["A", "B"]),
    })
    .strict(),
]);

function tipoEntrada(data: z.infer<typeof emitirInputSchema>): TipoEntradaFiscal {
  return Object.prototype.hasOwnProperty.call(data, "receptor") ? "V2" : "LEGACY";
}

type ContextoFiscalFn = {
  supabase: SupabaseClient<Database>;
  userId: string;
};

function lecturasPermiso(supabase: SupabaseClient<Database>): LecturasPermisoFiscal {
  return {
    async cargarVenta(ventaId) {
      const { data, error } = await supabase
        .from("ventas")
        .select("id,sucursal_id,fecha")
        .eq("id", ventaId)
        .maybeSingle();
      if (error || !data) return null;
      return { id: data.id, sucursalId: data.sucursal_id, fecha: data.fecha };
    },
    async consultarEsAdmin(userId) {
      const { data, error } = await supabase.rpc("is_admin", { _user_id: userId });
      if (error || typeof data !== "boolean")
        throw new Error("No se pudo verificar el rol fiscal.");
      return data;
    },
    async cargarPerfil(userId) {
      const { data, error } = await supabase
        .from("profiles")
        .select("activo,puede_facturar,puede_emitir_nc_periodo,sucursal_id")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw new Error("No se pudo verificar el perfil fiscal.");
      const perfil = data as unknown as {
        activo: boolean;
        puede_facturar: boolean;
        sucursal_id: string | null;
      } | null;
      return perfil
        ? {
            activo: perfil.activo,
            puedeFacturar: perfil.puede_facturar,
            sucursalId: perfil.sucursal_id,
          }
        : null;
    },
    ahora: () => new Date(),
  };
}

async function autorizarVenta(
  context: ContextoFiscalFn,
  input: {
    ventaId: string;
    accion: "PREVISUALIZAR" | "EMITIR" | "CONCILIAR" | "LIBERAR";
    confirmaVentaAntigua: boolean;
  },
) {
  return autorizarOperacionFiscal({
    ...input,
    userId: context.userId,
    lecturas: lecturasPermiso(context.supabase),
  });
}

const mantenimiento = () => ({
  estado: "MANTENIMIENTO" as const,
  mensaje: "La escritura fiscal está temporalmente en mantenimiento.",
});

type VentaIncidenteFiscal = {
  id: string;
  afip_estado: string;
  afip_fase: string | null;
  afip_error: string | null;
  afip_error_clase: string | null;
  afip_error_codigo: string | null;
  afip_error_fase: string | null;
  afip_ultimo_error_at: string | null;
};

function registro(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function diferenciasIncidente(value: unknown): string[] {
  const resumen = registro(value);
  const diagnostico = registro(resumen?.diagnostico);
  const diferencias = registro(diagnostico?.diferencias);
  if (!Array.isArray(diferencias?.campos)) return [];
  return [...new Set(diferencias.campos)]
    .filter((campo): campo is string => typeof campo === "string" && campo.trim().length > 0)
    .map((campo) => campo.trim().slice(0, 160))
    .sort();
}

function codigoMensajeIncidente(venta: VentaIncidenteFiscal): CodigoErrorFiscalUsuario {
  if (venta.afip_error_clase === "RECHAZO") return "INCIDENTE_RECHAZO";
  if (venta.afip_estado === "PENDIENTE" || venta.afip_estado === "RECONCILIAR") {
    return "INCIDENTE_PENDIENTE";
  }
  if (venta.afip_estado === "BLOQUEADO" || venta.afip_error_clase === "INTEGRIDAD") {
    return "INCIDENTE_INTEGRIDAD";
  }
  if (venta.afip_estado === "ERROR" && venta.afip_fase === null) {
    return "INCIDENTE_LEGACY_ERROR";
  }
  return "INCIDENTE_FISCAL";
}

/** Proyección mínima: nunca entrega SOAP, credenciales ni el resumen privado completo. */
export function proyectarIncidenteFiscal(
  venta: VentaIncidenteFiscal,
  intento: { resultado: string | null; respuesta_resumen: unknown } | null,
) {
  return {
    venta_id: venta.id,
    estado: venta.afip_estado,
    fase: venta.afip_fase,
    // afip_error histórico puede contener SQL, red o stacks del escritor legacy.
    // Sólo sale un código cerrado que la UI vuelve a traducir localmente.
    mensaje: referenciaErrorFiscalUsuario(codigoMensajeIncidente(venta)),
    clase: venta.afip_error_clase,
    codigo: venta.afip_error_codigo,
    fase_error: venta.afip_error_fase,
    fecha: venta.afip_ultimo_error_at,
    diferencias: diferenciasIncidente(intento?.respuesta_resumen),
    legacy: venta.afip_estado === "PENDIENTE" || venta.afip_estado === "ERROR",
  };
}

export async function ejecutarFachadaEmisionPostBorrador<T>(
  _input: z.infer<typeof postBorradorInputSchema>,
  deps: {
    asegurarAutenticacion(): Promise<unknown>;
    autorizar(): Promise<unknown>;
    cargarFlags(): Promise<FlagsFacturacion>;
    ejecutar(): Promise<T>;
  },
): Promise<T | ReturnType<typeof mantenimiento>> {
  await deps.asegurarAutenticacion();
  await deps.autorizar();
  const escritor = decidirEscritorFiscal(await deps.cargarFlags(), "V2");
  if (escritor === "MANTENIMIENTO") return mantenimiento();
  return deps.ejecutar();
}

type ResultadoCreacionNotaCreditoPeriodo = {
  id: string;
  numero: string;
  cta_cte: boolean;
};

type ArgumentosRpcNotaCreditoPeriodo = {
  p_sucursal_id: string;
  p_cliente_id: string;
  p_modalidad: NotaCreditoPeriodoInput["modalidad"];
  p_periodo_desde: string;
  p_periodo_hasta: string;
  p_motivo: string;
  p_resolucion: NotaCreditoPeriodoInput["resolucion"];
  p_items: NotaCreditoPeriodoInput["items"];
  p_reintegros: NotaCreditoPeriodoInput["pagos"];
  p_idempotency_key: string;
};

const resultadoCreacionNotaCreditoPeriodoSchema = z
  .array(
    z
      .object({
        venta_id: z.string().uuid(),
        numero: z.string().min(1),
        es_cta_cte: z.boolean(),
      })
      .strict(),
  )
  .length(1);

/**
 * Cerco testeable de la acción: contrato estricto -> flags frescos -> única RPC.
 * La RPC JWT-bound conserva la autoridad final sobre sesión, perfil, sucursal y
 * capacidad, incluso si la UI o esta lectura de flags quedan obsoletas.
 */
export async function ejecutarCreacionNotaCreditoPeriodoFiscal(
  rawInput: unknown,
  deps: {
    cargarFlags(): Promise<FlagsFacturacion>;
    crear(args: ArgumentosRpcNotaCreditoPeriodo): Promise<unknown>;
  },
): Promise<ResultadoCreacionNotaCreditoPeriodo> {
  const input = parsearEntradaFiscal(notaCreditoPeriodoInputSchema, rawInput);
  let flags: FlagsFacturacion;
  try {
    flags = await deps.cargarFlags();
  } catch (error) {
    if (codigoErrorFiscalUsuario(error)) throw error;
    throw crearErrorFiscalUsuario("CONFIGURACION_INVALIDA");
  }
  if (
    flags.facturacion_receptor_v2_enabled !== true ||
    flags.facturacion_legacy_writer_enabled !== false ||
    flags.nota_credito_periodo_enabled !== true
  ) {
    throw crearErrorFiscalUsuario("MANTENIMIENTO");
  }

  try {
    const [row] = resultadoCreacionNotaCreditoPeriodoSchema.parse(
      await deps.crear({
        p_sucursal_id: input.sucursal_id,
        p_cliente_id: input.cliente_id,
        p_modalidad: input.modalidad,
        p_periodo_desde: input.periodo_desde,
        p_periodo_hasta: input.periodo_hasta,
        p_motivo: input.motivo,
        p_resolucion: input.resolucion,
        p_items: input.items,
        p_reintegros: input.pagos,
        p_idempotency_key: input.idempotency_key,
      }),
    );
    return { id: row.venta_id, numero: row.numero, cta_cte: row.es_cta_cte };
  } catch (error) {
    if (codigoErrorFiscalUsuario(error)) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42501") {
      throw crearErrorFiscalUsuario("PERMISO_NC_PERIODO");
    }
    throw crearErrorFiscalUsuario("ERROR_CORREGIBLE");
  }
}

export const crearNotaCreditoPeriodoFiscal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => parsearEntradaFiscal(notaCreditoPeriodoInputSchema, value))
  .handler(async ({ data, context }) =>
    ejecutarCreacionNotaCreditoPeriodoFiscal(data, {
      cargarFlags: () => cargarFlagsFacturacionDesdeSupabase(context.supabase as never),
      async crear(args) {
        const { data: result, error } = await context.supabase.rpc(
          "crear_nota_credito_periodo_fiscal" as never,
          args as never,
        );
        if (error) throw error;
        return result;
      },
    }),
  );

/** Consulta visual acotada: auth -> permiso user-bound -> service-role -> ARCA. */
export const consultarCuitPadronArca = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    parsearEntradaFiscal(consultaCuitPadronInputSchema, value, "REVISION"),
  )
  .handler(async ({ data, context }) => {
    if (!cuitValido(data.cuit)) throw crearErrorFiscalUsuario("CUIT_INVALIDO");

    return ejecutarConsultaPadronOperador(
      { sucursalId: data.sucursal_id, cuit: data.cuit.replace(/\D/g, "") },
      {
        async autorizarSucursal() {
          const lecturas = lecturasPermiso(context.supabase);
          const [esAdmin, perfil] = await Promise.all([
            lecturas.consultarEsAdmin(context.userId),
            lecturas.cargarPerfil(context.userId),
          ]);
          evaluarPermisoFiscal({
            venta: { id: "CONSULTA_PADRON", sucursalId: data.sucursal_id, diasAntiguedad: 0 },
            perfil,
            esAdmin,
            accion: "PREVISUALIZAR",
            confirmaVentaAntigua: false,
          });
        },
        async cargarContexto() {
          const [{ supabaseAdmin }, { cargarContextoFiscal }] = await Promise.all([
            import("@/integrations/supabase/client.server"),
            import("./fiscal/contexto.server"),
          ]);
          return cargarContextoFiscal(supabaseAdmin, data.sucursal_id);
        },
        async consultar(contextoFiscal, cuit) {
          const [{ supabaseAdmin }, { consultarPadronArcaDesdeContexto }] = await Promise.all([
            import("@/integrations/supabase/client.server"),
            import("./fiscal/padron-arca.server"),
          ]);
          return consultarPadronArcaDesdeContexto({
            cuit,
            emisor: contextoFiscal.emisor,
            ambiente: contextoFiscal.pv.modo,
            admin: supabaseAdmin,
          });
        },
      },
    );
  });

/** Facade único: auth -> permiso user-bound -> flags -> import server-only -> writer exacto. */
export const emitirComprobante = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => parsearEntradaFiscal(emitirInputSchema, value))
  .handler(async ({ data, context }) => {
    const entrada = tipoEntrada(data);
    // El click del cliente legacy era su única confirmación posible; sigue
    // requiriendo admin para ventas demoradas durante el drain. El cliente v2
    // debe enviar el booleano explícito de su diálogo de confirmación.
    const confirmaVentaAntigua = "receptor" in data ? data.confirma_venta_antigua : true;
    await autorizarVenta(context, {
      ventaId: data.venta_id,
      accion: "EMITIR",
      confirmaVentaAntigua,
    });
    const flags = await cargarFlagsFacturacionDesdeSupabase(context.supabase as never);
    const escritor = decidirEscritorFiscal(flags, entrada);
    if (escritor === "MANTENIMIENTO") return mantenimiento();

    if (escritor === "LEGACY") {
      const { emitirComprobanteLegacy } = await import("./fiscal/emision-legacy.server");
      return emitirComprobanteLegacy({ data, context });
    }

    if (!("receptor" in data)) throw new Error("El escritor v2 exige receptor confirmado.");
    const [{ supabaseAdmin }, { ejecutarEmisionFiscal }, { crearDependenciasEmisionFiscalServer }] =
      await Promise.all([
        import("@/integrations/supabase/client.server"),
        import("./fiscal/emision"),
        import("./fiscal/emision.server"),
      ]);
    const deps = crearDependenciasEmisionFiscalServer({
      admin: supabaseAdmin,
      usuario: context.supabase,
      ventaIdAutorizada: data.venta_id,
    });
    return ejecutarEmisionFiscal(
      {
        ventaId: data.venta_id,
        receptor: data.receptor,
        letraSolicitada: data.letra_solicitada,
        confirmaVentaAntigua: data.confirma_venta_antigua,
        huellaConfirmacion: data.huella_confirmacion,
      },
      deps,
    );
  });

/**
 * Camino dedicado para una venta que acaba de nacer desde un borrador. La
 * huella no autoriza: auth, permiso y flags se verifican primero. El motor la
 * compara después del claim contra su única preparación autoritativa.
 */
export const emitirComprobantePostBorrador = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => parsearEntradaFiscal(postBorradorInputSchema, value))
  .handler(async ({ data, context }) =>
    ejecutarFachadaEmisionPostBorrador(data, {
      async asegurarAutenticacion() {
        if (!context.userId) throw new Error("La emisión fiscal exige una sesión autenticada.");
      },
      autorizar: () =>
        autorizarVenta(context, {
          ventaId: data.venta_id,
          accion: "EMITIR",
          confirmaVentaAntigua: data.confirma_venta_antigua,
        }),
      cargarFlags: () => cargarFlagsFacturacionDesdeSupabase(context.supabase as never),
      async ejecutar() {
        const [
          { supabaseAdmin },
          { ejecutarEmisionFiscal },
          { crearDependenciasEmisionFiscalServer },
        ] = await Promise.all([
          import("@/integrations/supabase/client.server"),
          import("./fiscal/emision"),
          import("./fiscal/emision.server"),
        ]);
        return ejecutarEmisionFiscal(
          {
            ventaId: data.venta_id,
            receptor: data.receptor,
            letraSolicitada: data.letra_solicitada,
            confirmaVentaAntigua: data.confirma_venta_antigua,
            huellaConfirmacion: data.huella_confirmacion_provisional,
          },
          crearDependenciasEmisionFiscalServer({
            admin: supabaseAdmin,
            usuario: context.supabase,
            ventaIdAutorizada: data.venta_id,
          }),
        );
      },
    }),
  );

export const reconciliarComprobante = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => parsearEntradaFiscal(legacyInputSchema, value))
  .handler(async ({ data, context }) => {
    await autorizarVenta(context, {
      ventaId: data.venta_id,
      accion: "CONCILIAR",
      confirmaVentaAntigua: false,
    });
    const flags = await cargarFlagsFacturacionDesdeSupabase(context.supabase as never);
    const escritor = decidirEscritorFiscal(flags, "V2");
    if (escritor === "MANTENIMIENTO") return mantenimiento();
    const [
      { supabaseAdmin },
      { ejecutarConciliacionFiscal },
      { crearDependenciasEmisionFiscalServer },
    ] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("./fiscal/emision"),
      import("./fiscal/emision.server"),
    ]);
    return ejecutarConciliacionFiscal(
      { ventaId: data.venta_id },
      crearDependenciasEmisionFiscalServer({
        admin: supabaseAdmin,
        usuario: context.supabase,
        ventaIdAutorizada: data.venta_id,
      }),
    );
  });

export const liberarClaimFiscal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => parsearEntradaFiscal(legacyInputSchema, value))
  .handler(async ({ data, context }) => {
    await autorizarVenta(context, {
      ventaId: data.venta_id,
      accion: "LIBERAR",
      confirmaVentaAntigua: false,
    });
    const flags = await cargarFlagsFacturacionDesdeSupabase(context.supabase as never);
    const escritor = decidirEscritorFiscal(flags, "V2");
    if (escritor === "MANTENIMIENTO") return mantenimiento();
    const [
      { supabaseAdmin },
      { crearDependenciasEmisionFiscalServer, liberarClaimFiscalVerificado },
    ] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("./fiscal/emision.server"),
    ]);
    return liberarClaimFiscalVerificado({
      ventaId: data.venta_id,
      deps: crearDependenciasEmisionFiscalServer({
        admin: supabaseAdmin,
        usuario: context.supabase,
        ventaIdAutorizada: data.venta_id,
      }),
    });
  });

export const consultarIncidenteFiscal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => parsearEntradaFiscal(incidenteInputSchema, value))
  .handler(async ({ data, context }) => {
    const permiso = await autorizarVenta(context, {
      ventaId: data.venta_id,
      accion: "CONCILIAR",
      confirmaVentaAntigua: false,
    });
    if (!permiso.esAdmin) throw new Error("El incidente fiscal exige un administrador.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [ventaResult, intentoResult] = await Promise.all([
      supabaseAdmin
        .from("ventas")
        .select(
          "id,afip_estado,afip_fase,afip_error,afip_error_clase,afip_error_codigo,afip_error_fase,afip_ultimo_error_at",
        )
        .eq("id", data.venta_id)
        .maybeSingle(),
      supabaseAdmin
        .from("emision_fiscal_intentos")
        .select("resultado,respuesta_resumen")
        .eq("venta_id", data.venta_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (ventaResult.error || !ventaResult.data) {
      throw new Error("No se pudo leer el incidente fiscal seleccionado.");
    }
    if (intentoResult.error) throw new Error("No se pudo leer la auditoría del incidente fiscal.");
    return proyectarIncidenteFiscal(ventaResult.data, intentoResult.data);
  });

export const previsualizarEmisionFiscal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => parsearEntradaFiscal(previewInputSchema, value))
  .handler(async ({ data, context }) => {
    if (data.origen === "VENTA_EXISTENTE") {
      await autorizarVenta(context, {
        ventaId: data.venta_id,
        accion: "PREVISUALIZAR",
        confirmaVentaAntigua: false,
      });
      const flags = await cargarFlagsFacturacionDesdeSupabase(context.supabase as never);
      const escritor = decidirEscritorFiscal(flags, "V2");
      if (escritor === "MANTENIMIENTO") return mantenimiento();
      const [{ supabaseAdmin }, { previsualizarVentaFiscalExistente }] = await Promise.all([
        import("@/integrations/supabase/client.server"),
        import("./fiscal/emision.server"),
      ]);
      return previsualizarVentaFiscalExistente({
        ventaId: data.venta_id,
        receptor: data.receptor,
        letraSolicitada: data.letra_solicitada,
        admin: supabaseAdmin,
        usuario: context.supabase,
      });
    }

    const lecturas = lecturasPermiso(context.supabase);
    const [esAdmin, perfil] = await Promise.all([
      lecturas.consultarEsAdmin(context.userId),
      lecturas.cargarPerfil(context.userId),
    ]);
    evaluarPermisoFiscal({
      venta: { id: "BORRADOR", sucursalId: data.sucursal_id, diasAntiguedad: 0 },
      perfil,
      esAdmin,
      accion: "PREVISUALIZAR",
      confirmaVentaAntigua: false,
    });
    const flags = await cargarFlagsFacturacionDesdeSupabase(context.supabase as never);
    const escritor = decidirEscritorFiscal(flags, "V2");
    if (escritor === "MANTENIMIENTO") return mantenimiento();
    const [{ supabaseAdmin }, { previsualizarBorradorFiscalProvisionalServer }] = await Promise.all(
      [import("@/integrations/supabase/client.server"), import("./fiscal/emision.server")],
    );
    return previsualizarBorradorFiscalProvisionalServer({
      borrador: {
        sucursalId: data.sucursal_id,
        clienteId: data.cliente_id,
        fechaComercial: data.fecha_comercial,
        items: data.items,
        pagos: data.pagos,
        percepciones: data.percepciones,
        receptor: data.receptor,
        letraSolicitada: data.letra_solicitada,
      },
      admin: supabaseAdmin,
      usuario: context.supabase,
    });
  });

export async function resolverDatosFiscalesComprobanteDesdeFila(
  filaInput: unknown,
  deps: {
    permitirLegacySinMarca?: boolean;
    cargarLegacy(): Promise<unknown>;
    generarQr(input: QrAfipInput): Promise<string>;
  },
): Promise<DatosFiscalesPreparados | null> {
  if (typeof filaInput !== "object" || filaInput === null || Array.isArray(filaInput)) {
    throw new ErrorImpresionFiscal(
      "COMPROBANTE_FISCAL_INCONSISTENTE",
      "No se pudo leer la evidencia fiscal del comprobante.",
    );
  }
  const fila = filaInput as Record<string, unknown>;

  if (!fila.cae) {
    if (fila.afip_estado === "APROBADO") {
      throw new ErrorImpresionFiscal(
        "COMPROBANTE_FISCAL_INCONSISTENTE",
        "El comprobante figura aprobado pero no conserva CAE.",
      );
    }
    return null;
  }

  let preparado: DatosFiscalesPreparados;
  const versionLegacy =
    typeof fila.afip_version === "number" &&
    Number.isInteger(fila.afip_version) &&
    fila.afip_version < 2;
  const usarLegacyMarcado = fila.afip_legacy_incompleto === true;
  const usarLegacyCompatible = deps.permitirLegacySinMarca === true && versionLegacy;
  if (usarLegacyMarcado || usarLegacyCompatible) {
    const datosHistoricos = await deps.cargarLegacy();
    if (!datosHistoricos) {
      throw new ErrorImpresionFiscal(
        "COMPROBANTE_FISCAL_INCONSISTENTE",
        "No se pudieron materializar los datos del comprobante histórico.",
      );
    }
    preparado = prepararDatosFiscalesLegacyMarcados({
      fila: usarLegacyCompatible ? { ...fila, afip_legacy_incompleto: true } : fila,
      datosHistoricos,
    });
  } else {
    preparado = prepararDatosFiscalesImpresos(fila);
  }

  const qr = exigirPngDataUrlFiscal(await deps.generarQr(preparado.qrInput));
  return { ...preparado, qr };
}

/**
 * Proyección user-bound: el navegador recibe sólo origen y timestamp confirmados.
 * El admin lee aliases escalares de evidencia_externa; nunca transporta el JSON
 * completo del intento, payload/hash ni diagnósticos.
 */
export const evidenciaAutorizacionNotaCreditoPeriodo = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => parsearEntradaFiscal(legacyInputSchema, value))
  .handler(async ({ data, context }) => {
    await autorizarVenta(context, {
      ventaId: data.venta_id,
      accion: "PREVISUALIZAR",
      confirmaVentaAntigua: false,
    });
    return cargarEvidenciaAutorizacionFiscal(data.venta_id, {
      async cargarVenta({ ventaId, columnas }) {
        const respuesta = await context.supabase
          .from("ventas")
          .select(columnas)
          .eq("id", ventaId)
          .maybeSingle();
        return respuesta as unknown as {
          data: FilaVentaEvidenciaAutorizacionSegura | null;
          error: { message: string } | null;
        };
      },
      async cargarIntento({ ventaId, columnas }) {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const respuesta = await supabaseAdmin
          .from("emision_fiscal_intentos")
          .select(columnas)
          .eq("venta_id", ventaId)
          .eq("snapshot_version", 3)
          .eq("fase", "PERSISTIDO")
          .in("resultado", ["APROBADO", "RECUPERADO_CAE"])
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return respuesta as unknown as {
          data: FilaEvidenciaAutorizacionSegura | null;
          error: { message: string } | null;
        };
      },
    });
  });

/** Proyección exacta del detalle fiscal después de revocar SELECT browser sobre ventas. */
export const detalleVentaFiscalSegura = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => parsearEntradaFiscal(legacyInputSchema, value))
  .handler(async ({ data, context }) => {
    await autorizarVenta(context, {
      ventaId: data.venta_id,
      accion: "PREVISUALIZAR",
      confirmaVentaAntigua: false,
    });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: venta, error } = await supabaseAdmin
      .from("ventas")
      .select(
        `${COLUMNAS_VENTA_SEGURAS}, cliente:clientes(razon_social,cuit_dni), sucursal:sucursales(nombre,telefono)`,
      )
      .eq("id", data.venta_id)
      .maybeSingle();
    if (error || !venta) throw new Error("No se pudo cargar el detalle fiscal autorizado.");
    return venta;
  });

/**
 * Fuentes auditadas exactas. La autorización se resuelve user-bound antes de
 * abrir las lecturas admin; el navegador no obtiene acceso directo a las tablas.
 */
export const fuentesAuditoriaNotaCreditoPeriodo = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => parsearEntradaFiscal(legacyInputSchema, value))
  .handler(async ({ data, context }) => {
    await autorizarVenta(context, {
      ventaId: data.venta_id,
      accion: "PREVISUALIZAR",
      confirmaVentaAntigua: false,
    });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: cabecera, error: cabeceraError } = await supabaseAdmin
      .from("ventas")
      .select("usuario_id,nc_periodo_modalidad")
      .eq("id", data.venta_id)
      .maybeSingle();
    if (cabeceraError || !cabecera?.usuario_id || !cabecera.nc_periodo_modalidad) {
      throw new Error("No se pudo reconstruir la auditoría de la nota de crédito.");
    }
    const [operador, reintegros, stock, cuentaCorriente] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("nombre_completo,username")
        .eq("id", cabecera.usuario_id)
        .maybeSingle(),
      supabaseAdmin
        .from("nota_credito_periodo_reintegros")
        .select("id,forma_pago,monto,orden")
        .eq("venta_id", data.venta_id)
        .order("orden", { ascending: true }),
      supabaseAdmin
        .from("stock_movimientos")
        .select(
          "id,producto_id,cantidad,cantidad_anterior,cantidad_nueva,created_at,producto:productos(codigo,nombre)",
        )
        .eq("referencia_id", data.venta_id)
        .eq("tipo", "DEVOLUCION")
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("cuenta_corriente_movimientos")
        .select("id,tipo,estado,monto,descripcion,created_at")
        .eq("venta_id", data.venta_id)
        .order("created_at", { ascending: true }),
    ]);
    if (
      operador.error ||
      !operador.data ||
      reintegros.error ||
      stock.error ||
      cuentaCorriente.error
    ) {
      throw new Error("No se pudo reconstruir la auditoría de la nota de crédito.");
    }
    return {
      operador: operador.data,
      reintegros: reintegros.data ?? [],
      stock: stock.data ?? [],
      cuentaCorriente: cuentaCorriente.data ?? [],
    };
  });

/** Lectura user-bound y fail-closed para PDF fiscal. No participa del writer v2. */
export const datosFiscalesComprobante = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => parsearEntradaFiscal(legacyInputSchema, value))
  .handler(async ({ data, context }) => {
    await autorizarVenta(context, {
      ventaId: data.venta_id,
      accion: "PREVISUALIZAR",
      confirmaVentaAntigua: false,
    });
    const { data: venta, error } = await context.supabase
      .from("ventas")
      .select(
        "id,afip_estado,afip_fase,afip_version,afip_legacy_incompleto,afip_snapshot,afip_snapshot_hash,afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,afip_simulado,afip_validez,afip_fecha_comprobante,afip_imp_total,cae,cae_vencimiento",
      )
      .eq("id", data.venta_id)
      .maybeSingle();
    if (error || !venta) {
      throw new ErrorImpresionFiscal(
        "COMPROBANTE_FISCAL_INCONSISTENTE",
        "No se pudo leer el comprobante fiscal autorizado.",
        error ? { cause: error } : undefined,
      );
    }

    const [flags, { qrAfipDataUrlObligatorio }, { escenarioMockFiscalActual }] = await Promise.all([
      cargarFlagsFacturacionDesdeSupabase(context.supabase as never),
      import("./fiscal/qr"),
      import("./fiscal/mock-scenario.server"),
    ]);
    const generarQr =
      escenarioMockFiscalActual() === "QR_ERROR"
        ? async () => {
            throw new ErrorImpresionFiscal(
              "QR_FISCAL_OBLIGATORIO",
              "El escenario de prueba impidió generar el QR fiscal obligatorio.",
            );
          }
        : qrAfipDataUrlObligatorio;
    return resolverDatosFiscalesComprobanteDesdeFila(venta, {
      permitirLegacySinMarca: permiteLectorLegacySinMarca(flags),
      generarQr,
      async cargarLegacy() {
        const { datosFiscalesComprobanteLegacy } = await import("./fiscal/emision-legacy.server");
        return datosFiscalesComprobanteLegacy({ data, context });
      },
    });
  });
