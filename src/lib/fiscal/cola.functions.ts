import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  autorizarContextoColaFiscal,
  type ContextoColaFiscal,
  type LecturasContextoColaFiscal,
} from "./permiso.server";
import {
  cargarFlagsFacturacionDesdeSupabase,
  decidirEscritorFiscal,
  type FlagsFacturacion,
} from "./feature.server";
import { parsearEntradaFiscal } from "./error-usuario";

const tabs = ["pendientes", "revisar", "emitidas", "historial"] as const;
const estadosCola = [
  "SIN_FACTURAR",
  "EMITIENDO",
  "APROBADO",
  "ERROR_CORREGIBLE",
  "RECONCILIAR",
  "CANCELADO",
  "BLOQUEADO",
  "PENDIENTE",
  "ERROR",
] as const;
const fasesCola = [
  "PREFLIGHT",
  "RESERVADO",
  "REQUEST_INICIADO",
  "RESPUESTA_RECIBIDA",
  "PERSISTIDO",
] as const;
const condicionesIva = [
  "RESPONSABLE_INSCRIPTO",
  "MONOTRIBUTO",
  "EXENTO",
  "CONSUMIDOR_FINAL",
] as const;
const tiposDocumentoFavorito = ["CUIT", "CUIL", "DNI", "CDI"] as const;

const tabSchema = z.enum(tabs, {
  errorMap: () => ({ message: "Tab fiscal desconocido." }),
});
const estadoSchema = z.enum(estadosCola, {
  errorMap: () => ({ message: "Estado fiscal desconocido." }),
});

function esFechaCalendario(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const fechaSchema = z
  .string()
  .refine(esFechaCalendario, { message: "Fecha inválida; usá AAAA-MM-DD." });

const documentoBusquedaSchema = z
  .string()
  .trim()
  .min(1, "El documento está vacío.")
  .max(32, "El documento es demasiado largo.")
  .refine((value) => /^[\d.\-\s]+$/.test(value), {
    message: "El documento sólo admite dígitos y separadores de formato.",
  })
  .transform((value) => value.replace(/\D/g, ""))
  .refine((value) => /^\d{7,11}$/.test(value), {
    message: "El documento debe tener entre 7 y 11 dígitos.",
  });

export const colaFiscalQuerySchema = z
  .object({
    tab: tabSchema,
    page: z.number().int().min(1, "La página debe ser mayor o igual a 1."),
    pageSize: z.number().int().min(1).max(100, "El tamaño de página máximo es 100."),
    desde: fechaSchema.optional(),
    hasta: fechaSchema.optional(),
    sucursal_id: z.string().uuid().optional(),
    emisor_id: z.string().uuid().optional(),
    documento: documentoBusquedaSchema.optional(),
    estado: estadoSchema.optional(),
    venta_id: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.desde && value.hasta && value.desde > value.hasta) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hasta"],
        message: "La fecha hasta no puede ser anterior a la fecha desde.",
      });
    }
  });

export type ColaFiscalQuery = z.infer<typeof colaFiscalQuerySchema>;

export type ColaFiscalRpcArgs = {
  p_tab: ColaFiscalQuery["tab"];
  p_page: number;
  p_page_size: number;
  p_desde?: string;
  p_hasta?: string;
  p_sucursal_id?: string;
  p_emisor_id?: string;
  p_documento?: string;
  p_estado?: (typeof estadosCola)[number];
  p_venta_id?: string;
};

const filaColaSchema = z
  .object({
    venta_id: z.string().uuid(),
    tipo_comprobante: z.string().min(1),
    numero_comprobante: z.string().min(1),
    fecha_comercial: z.string().datetime({ offset: true }),
    fecha_fiscal: fechaSchema.nullable(),
    cliente_id: z.string().uuid().nullable(),
    cliente_razon_social: z.string().nullable(),
    documento_comercial: z.string().nullable(),
    receptor_razon_social: z.string().nullable(),
    receptor_tipo_documento: z.string().nullable(),
    receptor_numero_documento: z.string().nullable(),
    receptor_condicion_iva: z.string().nullable(),
    emisor_id: z.string().uuid().nullable(),
    emisor_razon_social: z.string().nullable(),
    emisor_cuit: z.string().nullable(),
    sucursal_id: z.string().uuid().nullable(),
    sucursal_nombre: z.string().nullable(),
    total: z.string(),
    total_pagado: z.string(),
    saldo: z.string(),
    afip_estado: estadoSchema,
    afip_fase: z.enum(fasesCola).nullable(),
    afip_legacy_incompleto: z.boolean(),
    claim_vencido: z.boolean(),
    venta_antigua: z.boolean(),
    afip_validez: z.enum(["PRODUCCION", "HOMOLOGACION", "SIMULADA"]).nullable(),
    afip_punto_venta: z.number().int().nullable(),
    afip_cbte_tipo: z.number().int().nullable(),
    afip_numero: z.number().int().nullable(),
    cae: z.string().nullable(),
    cae_vencimiento: fechaSchema.nullable(),
    periodo_asoc_desde: fechaSchema.nullable(),
    periodo_asoc_hasta: fechaSchema.nullable(),
    nc_periodo_modalidad: z.enum(["DEVOLUCION_PRODUCTOS", "BONIFICACION_AJUSTE"]).nullable(),
    motivo_nota_credito: z.string().nullable(),
    nc_resolucion: z.enum(["REINTEGRO", "SALDO_FAVOR"]).nullable(),
    nc_periodo_payload_hash: z.string().nullable(),
    nc_efectos_aplicados_at: z.string().datetime({ offset: true }).nullable(),
    tab: tabSchema,
  })
  .strict();

const filtrosDisponiblesSchema = z
  .object({
    sucursales: z.array(z.object({ id: z.string().uuid(), nombre: z.string() }).strict()),
    emisores: z.array(
      z
        .object({
          id: z.string().uuid(),
          razon_social: z.string(),
          cuit: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const respuestaRpcSchema = z
  .array(
    z
      .object({
        filas: z.array(filaColaSchema),
        pagina: z.number().int().min(1),
        tamano_pagina: z.number().int().min(1).max(100),
        total: z.number().int().nonnegative(),
        paginas: z.number().int().nonnegative(),
        conteo_pendientes: z.number().int().nonnegative(),
        conteo_revisar: z.number().int().nonnegative(),
        conteo_emitidas: z.number().int().nonnegative(),
        conteo_historial: z.number().int().nonnegative(),
        filtros_disponibles: filtrosDisponiblesSchema,
      })
      .strict(),
  )
  .length(1);

const favoritoSchema = z
  .object({
    id: z.string().uuid(),
    sucursal_id: z.string().uuid(),
    cliente_comercial_id: z.string().uuid().nullable(),
    tipo_documento: z.enum(tiposDocumentoFavorito),
    numero_documento: z.string(),
    razon_social: z.string(),
    condicion_iva: z.enum(condicionesIva),
    domicilio: z.string().nullable(),
  })
  .strip();

const favoritosSchema = z.array(favoritoSchema);
const listarFavoritosInputSchema = z.object({ sucursal_id: z.string().uuid().optional() }).strict();
const guardarFavoritoInputSchema = z.object({ venta_id: z.string().uuid() }).strict();
const desactivarFavoritoInputSchema = z.object({ receptor_id: z.string().uuid() }).strict();
const detalleNcPeriodoInputSchema = z.object({ venta_id: z.string().uuid() }).strict();

const detalleNcPeriodoSchema = z
  .object({
    neto: z.string(),
    iva: z.string(),
    total: z.string(),
    concepto: z.string().nullable(),
    alicuotas: z.array(
      z
        .object({
          id: z.string().uuid(),
          base: z.string(),
          porcentaje: z.string(),
          iva: z.string(),
        })
        .strict(),
    ),
    reintegros: z.array(
      z
        .object({
          id: z.string().uuid(),
          orden: z.number().int().nonnegative(),
          formaPago: z.string(),
          monto: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type ColaFiscalFila = z.infer<typeof filaColaSchema>;
export type ReceptorFiscalFavorito = z.infer<typeof favoritoSchema>;
export type DetalleNcPeriodoAutoritativo = z.infer<typeof detalleNcPeriodoSchema>;

type ContextoAutorizado = ContextoColaFiscal;

export type DependenciasColaFiscal = {
  cargarFlags(): Promise<FlagsFacturacion>;
  autorizar(userId: string): Promise<ContextoAutorizado>;
  consultarCola(args: ColaFiscalRpcArgs): Promise<unknown>;
  listarFavoritos(args: { sucursalId: string | null }): Promise<unknown>;
  guardarFavoritoDesdeVenta(ventaId: string): Promise<unknown>;
  desactivarFavorito(id: string): Promise<void>;
};

async function exigirRolloutV2(deps: DependenciasColaFiscal): Promise<void> {
  const escritor = decidirEscritorFiscal(await deps.cargarFlags(), "V2");
  if (escritor !== "V2") {
    throw new Error("La cola fiscal v2 no está habilitada de forma exclusiva.");
  }
}

function proyeccionSegura<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("La proyección segura de la cola fiscal no coincide con el contrato.");
  }
  return parsed.data;
}

export function crearServicioColaFiscal(deps: DependenciasColaFiscal) {
  return {
    async listarColaFiscal(userId: string, rawInput: unknown) {
      const input = colaFiscalQuerySchema.parse(rawInput);
      await exigirRolloutV2(deps);
      const contexto = await deps.autorizar(userId);
      const sucursalId = contexto.esAdmin ? input.sucursal_id : (contexto.sucursalId ?? undefined);
      const respuesta = proyeccionSegura(
        respuestaRpcSchema,
        await deps.consultarCola({
          p_tab: input.tab,
          p_page: input.venta_id ? 1 : input.page,
          p_page_size: input.pageSize,
          p_desde: input.desde,
          p_hasta: input.hasta,
          p_sucursal_id: sucursalId,
          p_emisor_id: input.emisor_id,
          p_documento: input.documento,
          p_estado: input.estado,
          p_venta_id: input.venta_id,
        }),
      )[0];

      return {
        filas: respuesta.filas,
        page: input.venta_id ? 1 : respuesta.pagina,
        pageSize: respuesta.tamano_pagina,
        total: respuesta.total,
        paginas: respuesta.paginas,
        conteos: {
          pendientes: respuesta.conteo_pendientes,
          revisar: respuesta.conteo_revisar,
          emitidas: respuesta.conteo_emitidas,
          historial: respuesta.conteo_historial,
        },
        filtrosDisponibles: respuesta.filtros_disponibles,
      };
    },

    async listarReceptoresFiscales(userId: string, rawInput: unknown) {
      const input = listarFavoritosInputSchema.parse(rawInput);
      await exigirRolloutV2(deps);
      const contexto = await deps.autorizar(userId);
      const sucursalId = contexto.esAdmin ? (input.sucursal_id ?? null) : contexto.sucursalId;
      return proyeccionSegura(favoritosSchema, await deps.listarFavoritos({ sucursalId }));
    },

    async guardarReceptorFiscal(userId: string, rawInput: unknown) {
      const input = guardarFavoritoInputSchema.parse(rawInput);
      await exigirRolloutV2(deps);
      await deps.autorizar(userId);
      return proyeccionSegura(favoritoSchema, await deps.guardarFavoritoDesdeVenta(input.venta_id));
    },

    async desactivarReceptorFiscal(userId: string, rawInput: unknown) {
      const input = desactivarFavoritoInputSchema.parse(rawInput);
      await exigirRolloutV2(deps);
      await deps.autorizar(userId);
      await deps.desactivarFavorito(input.receptor_id);
    },
  };
}

function lecturasContexto(supabase: SupabaseClient<Database>): LecturasContextoColaFiscal {
  return {
    async consultarEsAdmin(userId) {
      const { data, error } = await supabase.rpc("is_admin", { _user_id: userId });
      if (error || typeof data !== "boolean") {
        throw new Error("No se pudo verificar el rol fiscal.");
      }
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
    async cargarSucursal(sucursalId, userId) {
      const [
        { data: sucursal, error: sucursalError },
        { data: asignacion, error: asignacionError },
      ] = await Promise.all([
        supabase.from("sucursales").select("id,activa").eq("id", sucursalId).maybeSingle(),
        supabase
          .from("profile_sucursales")
          .select("sucursal_id")
          .eq("profile_id", userId)
          .eq("sucursal_id", sucursalId)
          .maybeSingle(),
      ]);
      if (sucursalError || asignacionError) {
        throw new Error("No se pudo verificar la sucursal fiscal activa.");
      }
      if (!sucursal) return null;
      return { activa: sucursal.activa, asignada: Boolean(asignacion) };
    },
  };
}

function dependenciasSupabase(supabase: SupabaseClient<Database>): DependenciasColaFiscal {
  const proyeccionFavorito =
    "id,sucursal_id,cliente_comercial_id,tipo_documento,numero_documento,razon_social,condicion_iva,domicilio";

  return {
    cargarFlags: () => cargarFlagsFacturacionDesdeSupabase(supabase as never),
    autorizar: (userId) =>
      autorizarContextoColaFiscal({ userId, lecturas: lecturasContexto(supabase) }),
    async consultarCola(args) {
      const { data, error } = await supabase.rpc("cola_fiscal_lectura", args);
      if (error) throw new Error(`No se pudo consultar la cola fiscal: ${error.message}`);
      return data;
    },
    async listarFavoritos({ sucursalId }) {
      let query = supabase
        .from("receptores_fiscales")
        .select(proyeccionFavorito)
        .eq("activo", true)
        .order("razon_social")
        .order("id");
      if (sucursalId) query = query.eq("sucursal_id", sucursalId);
      const { data, error } = await query;
      if (error) throw new Error(`No se pudieron listar los receptores fiscales: ${error.message}`);
      return data ?? [];
    },
    async guardarFavoritoDesdeVenta(ventaId) {
      const { data, error } = await supabase.rpc("guardar_receptor_fiscal_desde_venta", {
        p_venta_id: ventaId,
      });
      const favorito = data?.[0];
      if (error || !favorito) {
        throw new Error(`No se pudo guardar el receptor fiscal: ${error?.message ?? "sin fila"}`);
      }
      return favorito;
    },
    async desactivarFavorito(id) {
      const { error } = await supabase.rpc("desactivar_receptor_fiscal", {
        p_receptor_id: id,
      });
      if (error) throw new Error(`No se pudo desactivar el receptor fiscal: ${error.message}`);
    },
  };
}

export const listarColaFiscal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    parsearEntradaFiscal(colaFiscalQuerySchema, value, "CONSULTA"),
  )
  .handler(async ({ data, context }) =>
    crearServicioColaFiscal(dependenciasSupabase(context.supabase)).listarColaFiscal(
      context.userId,
      data,
    ),
  );

export const listarReceptoresFiscales = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    parsearEntradaFiscal(listarFavoritosInputSchema, value, "CONSULTA"),
  )
  .handler(async ({ data, context }) =>
    crearServicioColaFiscal(dependenciasSupabase(context.supabase)).listarReceptoresFiscales(
      context.userId,
      data,
    ),
  );

/** Lectura acotada de la intención persistida; nunca recompone el editor del navegador. */
export const leerDetalleNcPeriodoFiscal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    parsearEntradaFiscal(detalleNcPeriodoInputSchema, value, "CONSULTA"),
  )
  .handler(async ({ data, context }) => {
    // `ventas` ya no expone SELECT directo a `authenticated`. Reutilizar la
    // RPC exacta de la cola conserva en PostgreSQL el scope admin/sucursal y
    // evita abrir una lectura lateral sólo para este diálogo.
    const cola = await crearServicioColaFiscal(
      dependenciasSupabase(context.supabase),
    ).listarColaFiscal(context.userId, {
      tab: "pendientes",
      page: 1,
      pageSize: 1,
      venta_id: data.venta_id,
    });
    const venta = cola.filas[0];
    const consultaReintegros = (
      context.supabase as unknown as {
        from(table: string): {
          select(columns: string): {
            eq(
              column: string,
              value: string,
            ): {
              order(column: string): Promise<{
                data:
                  | { id: string; orden: number; forma_pago: string; monto: string | number }[]
                  | null;
                error: unknown;
              }>;
            };
          };
        };
      }
    )
      .from("nota_credito_periodo_reintegros")
      .select("id,orden,forma_pago,monto")
      .eq("venta_id", data.venta_id)
      .order("orden");
    const [{ data: items, error: itemsError }, { data: reintegros, error: reintegrosError }] =
      await Promise.all([
        context.supabase
          .from("venta_items")
          .select("id,descripcion,subtotal_sin_iva,iva_porcentaje,iva_monto")
          .eq("venta_id", data.venta_id)
          .order("id"),
        consultaReintegros,
      ]);
    if (itemsError || reintegrosError || !venta || !venta.nc_periodo_modalidad) {
      throw new Error("No se pudo leer la intención fiscal por período.");
    }
    const neto = (items ?? []).reduce(
      (total, item) => total + Math.abs(Number(item.subtotal_sin_iva)),
      0,
    );
    const iva = (items ?? []).reduce((total, item) => total + Math.abs(Number(item.iva_monto)), 0);
    const detalle = {
      neto: String(neto),
      iva: String(iva),
      total: String(Math.abs(Number(venta.total))),
      concepto:
        venta.nc_periodo_modalidad === "BONIFICACION_AJUSTE"
          ? (items?.[0]?.descripcion ?? null)
          : null,
      alicuotas: (items ?? []).map((item) => ({
        id: item.id,
        base: String(Math.abs(Number(item.subtotal_sin_iva))),
        porcentaje: String(item.iva_porcentaje),
        iva: String(Math.abs(Number(item.iva_monto))),
      })),
      reintegros: (reintegros ?? []).map((reintegro) => ({
        id: reintegro.id,
        orden: reintegro.orden,
        formaPago: reintegro.forma_pago,
        monto: String(Math.abs(Number(reintegro.monto))),
      })),
    };
    return detalleNcPeriodoSchema.parse(detalle);
  });

export const guardarReceptorFiscal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    parsearEntradaFiscal(guardarFavoritoInputSchema, value, "REVISION"),
  )
  .handler(async ({ data, context }) =>
    crearServicioColaFiscal(dependenciasSupabase(context.supabase)).guardarReceptorFiscal(
      context.userId,
      data,
    ),
  );

export const desactivarReceptorFiscal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    parsearEntradaFiscal(desactivarFavoritoInputSchema, value, "REVISION"),
  )
  .handler(async ({ data, context }) =>
    crearServicioColaFiscal(dependenciasSupabase(context.supabase)).desactivarReceptorFiscal(
      context.userId,
      data,
    ),
  );
