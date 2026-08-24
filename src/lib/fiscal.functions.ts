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

const receptorSchema = z.discriminatedUnion("origen", [
  z.object({ origen: z.literal("CLIENTE_COMERCIAL") }).strict(),
  z.object({ origen: z.literal("FAVORITO"), receptor_fiscal_id: z.string().uuid() }).strict(),
  z
    .object({
      origen: z.literal("MANUAL"),
      tipo_documento: z.enum(["CUIT", "CUIL", "DNI", "CDI", "SIN_IDENTIFICAR"]),
      numero_documento: z.string().nullable(),
      razon_social: z.string().min(1),
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
const v2BaseInputSchema = z
  .object({
    venta_id: z.string().uuid(),
    receptor: receptorSchema,
    letra_solicitada: z.enum(["A", "B"]),
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
      letra_solicitada: z.enum(["A", "B"]),
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
        .select("activo,puede_facturar,sucursal_id")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw new Error("No se pudo verificar el perfil fiscal.");
      return data
        ? {
            activo: data.activo,
            puedeFacturar: data.puede_facturar,
            sucursalId: data.sucursal_id,
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

/** Proyección mínima: nunca entrega SOAP, credenciales ni el resumen privado completo. */
export function proyectarIncidenteFiscal(
  venta: VentaIncidenteFiscal,
  intento: { resultado: string | null; respuesta_resumen: unknown } | null,
) {
  return {
    venta_id: venta.id,
    estado: venta.afip_estado,
    fase: venta.afip_fase,
    mensaje: venta.afip_error,
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

/** Facade único: auth -> permiso user-bound -> flags -> import server-only -> writer exacto. */
export const emitirComprobante = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => emitirInputSchema.parse(value))
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
  .inputValidator((value: unknown) => postBorradorInputSchema.parse(value))
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
  .inputValidator((value: unknown) => legacyInputSchema.parse(value))
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
  .inputValidator((value: unknown) => legacyInputSchema.parse(value))
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
  .inputValidator((value: unknown) => incidenteInputSchema.parse(value))
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
  .inputValidator((value: unknown) => previewInputSchema.parse(value))
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

/** Lectura user-bound y fail-closed para PDF fiscal. No participa del writer v2. */
export const datosFiscalesComprobante = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => legacyInputSchema.parse(value))
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
