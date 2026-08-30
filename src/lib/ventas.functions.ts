/**
 * Ventas: creación y anulación.
 *
 * La lógica vive en dos funciones de Postgres (crear_venta / anular_venta), no acá.
 * La razón es la atomicidad: esto antes eran 4 llamadas sueltas a la base
 * (venta -> items -> pagos -> stock) sin transacción, así que un fallo a mitad de
 * camino dejaba datos a medio escribir. Y el stock se descontaba leyendo-y-
 * escribiendo desde JS, lo que permite que dos cajas vendan la misma última lata.
 *
 * Dentro de la función de Postgres todo eso es una única transacción, el descuento
 * de stock es atómico con guarda anti-negativo, y los precios se resuelven contra
 * el catálogo en vez de confiar en lo que manda el navegador.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  cargarFlagsFacturacionDesdeSupabase,
  decidirEscritorFiscal,
  type FlagsFacturacion,
} from "./fiscal/feature.server";
import {
  autorizarContextoVentas,
  autorizarOperacionFiscal,
  type ContextoVentas,
} from "./fiscal/permiso.server";
import { normalizarDescripcionItem } from "./item-descripcion";
import { COLUMNAS_VENTA_SEGURAS, proyectarListadoVentasSeguro } from "./ventas-proyeccion";

const descripcionItemSchema = z.string().transform((value, context) => {
  try {
    return normalizarDescripcionItem(value);
  } catch (cause) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: cause instanceof Error ? cause.message : "La descripción de la línea es inválida.",
    });
    return z.NEVER;
  }
});

const itemSchema = z
  .object({
    // R5: producto_id puede faltar en una línea de CONCEPTO LIBRE (recargo/interés
    // de una Nota de Débito). En ese caso se exige descripción y precio. La RPC sólo
    // acepta líneas sin producto en NOTA_DEBITO.
    producto_id: z.string().uuid().nullable().optional(),
    cantidad: z.number().nonnegative(),
    descuento_porcentaje: z.number().min(0).max(100).default(0),
    // Opcional: el cajero puede pisar el precio de lista (es una necesidad real del
    // mostrador, se negocia en el momento). Si no viene, la base usa el del catálogo.
    // Si viene, se guardan los dos y la diferencia queda auditada.
    precio_unitario_sin_iva: z.number().nonnegative().optional(),
    // En productos congela el texto de la línea; en conceptos libres además
    // identifica el concepto porque no existe un producto de catálogo.
    descripcion: descripcionItemSchema.optional(),
    iva_porcentaje: z.number().min(0).max(100).optional(),
  })
  .refine((it) => !!it.producto_id || (!!it.descripcion && it.precio_unitario_sin_iva != null), {
    message: "Una línea sin producto necesita descripción y precio",
  });

const pagoSchema = z.object({
  forma_pago: z.enum([
    "EFECTIVO",
    "TRANSFERENCIA",
    "TARJETA_DEBITO",
    "TARJETA_CREDITO",
    "MERCADO_PAGO",
    "CHEQUE",
    "CTA_CTE",
  ]),
  monto: z.number().nonnegative(),
  detalle: z.record(z.string(), z.any()).default({}),
});

export const ventaInputSchema = z.object({
  sucursal_id: z.string().uuid(),
  // Nulo sólo en un remito de obra: ahí la obra ES el cliente y `crear_venta`
  // resuelve (o crea) su ficha a partir de `nombre_obra`. Para cualquier otro
  // comprobante la RPC rechaza el nulo, que es la barrera que vale.
  cliente_id: z.string().uuid().optional().nullable(),
  tipo_comprobante: z.enum([
    "VENTA",
    "FACTURA_A",
    "FACTURA_B",
    "FACTURA_C",
    "NOTA_CREDITO",
    "NOTA_DEBITO",
    "REMITO",
    "REMITO_OBRA",
    "FAC_INTERNA_CTA_CTE",
  ]),
  condicion_venta: z.enum(["CONTADO", "CTA_CTE"]),
  fecha: z.string().optional(),
  percepciones: z.number().nonnegative().default(0),
  observaciones: z.string().optional().nullable(),
  nombre_obra: z.string().optional().nullable(),
  // El comprobante que rectifica una nota de crédito/débito. Opcional acá y la
  // regla la pone crear_venta, que es la que puede consultar la base: la nota de
  // DÉBITO lo exige (es un recargo calculado sobre el total de esa factura), la
  // de CRÉDITO puede ir sin ninguno y entonces queda como documento interno que
  // no se manda a AFIP (ver esNotaInterna en fiscal/codigos.ts).
  cbte_asoc_id: z.string().uuid().optional().nullable(),
  // Clave de idempotencia generada al montar el formulario. Un doble-submit con la
  // misma key devuelve la venta ya creada en vez de duplicarla (defensa server-side).
  idempotency_key: z.string().uuid().optional(),
  items: z.array(itemSchema).min(0),
  pagos: z.array(pagoSchema).default([]),
});

export type VentaInput = z.infer<typeof ventaInputSchema>;
type ResultadoCreacionVenta = { id: string; numero: string; cta_cte: boolean };

const columnasOriginalSeguro = [
  "id",
  "numero_comprobante",
  "tipo_comprobante",
  "fecha",
  "subtotal_sin_iva",
  "iva_total",
  "percepciones",
  "total",
  "total_pagado",
  "condicion_venta",
  "afip_estado",
  "afip_fase",
  "afip_validez",
  "afip_modo",
  "afip_simulado",
  "afip_numero",
  "afip_emisor_cuit",
  "afip_punto_venta",
  "afip_cbte_tipo",
  "cae",
] as const;

export const COLUMNAS_COMPROBANTE_ORIGINAL_SEGURAS = columnasOriginalSeguro.join(",");
type ColumnaOriginalSegura = (typeof columnasOriginalSeguro)[number];
export type ComprobanteOriginalSeguro = Pick<
  Database["public"]["Tables"]["ventas"]["Row"],
  ColumnaOriginalSegura
> & { tiene_snapshot_persistido: boolean };

type FiltrosListadoVentas = { sucursalId: string | null; estadoPago: string | null };
type EvidenciaListado = { id: string; afip_snapshot: unknown };
type EvidenciaOriginal = EvidenciaListado & { afip_snapshot_hash: string | null };

export async function ejecutarListadoVentasSeguro(
  input: FiltrosListadoVentas,
  deps: {
    autorizar(): Promise<ContextoVentas>;
    cargarVisibles(filtros: FiltrosListadoVentas): Promise<Array<Record<string, unknown>>>;
    cargarEvidencias(ids: string[]): Promise<EvidenciaListado[]>;
  },
) {
  const contexto = await deps.autorizar();
  const filtros = {
    sucursalId: contexto.esAdmin ? input.sucursalId : contexto.sucursalId,
    estadoPago: input.estadoPago,
  };
  const visibles = await deps.cargarVisibles(filtros);
  if (visibles.length === 0) return [];
  const evidencias = await deps.cargarEvidencias(visibles.map((venta) => String(venta.id)));
  return proyectarListadoVentasSeguro(visibles, evidencias);
}

function snapshotPersistido(evidencia: EvidenciaOriginal | undefined): boolean {
  if (!evidencia?.afip_snapshot || !evidencia.afip_snapshot_hash) return false;
  if (typeof evidencia.afip_snapshot !== "object" || Array.isArray(evidencia.afip_snapshot)) {
    return false;
  }
  return (evidencia.afip_snapshot as Record<string, unknown>).hash === evidencia.afip_snapshot_hash;
}

export async function ejecutarListadoComprobantesOriginalesSeguro(
  input: { clienteId: string; receptorV2: boolean },
  deps: {
    autorizar(): Promise<ContextoVentas>;
    cargarVisibles(contexto: ContextoVentas): Promise<Array<Record<string, unknown>>>;
    cargarEvidencias(ids: string[]): Promise<EvidenciaOriginal[]>;
  },
) {
  const contexto = await deps.autorizar();
  const visibles = await deps.cargarVisibles(contexto);
  if (visibles.length === 0) return [];
  const evidencias = await deps.cargarEvidencias(visibles.map((venta) => String(venta.id)));
  const evidenciaPorId = new Map(evidencias.map((evidencia) => [evidencia.id, evidencia]));
  return visibles
    .map((venta) => {
      const segura = Object.fromEntries(
        columnasOriginalSeguro.map((columna) => [columna, venta[columna]]),
      );
      return {
        ...segura,
        tiene_snapshot_persistido: snapshotPersistido(evidenciaPorId.get(String(venta.id))),
      } as ComprobanteOriginalSeguro;
    })
    .filter((venta) => !input.receptorV2 || venta.tiene_snapshot_persistido);
}

export async function ejecutarLecturaOriginalFiscalAutorizada<T>(
  ventaId: string,
  deps: {
    autorizar(ventaId: string): Promise<void>;
    cargarExacta(ventaId: string): Promise<T>;
  },
): Promise<T> {
  await deps.autorizar(ventaId);
  return deps.cargarExacta(ventaId);
}

type ClienteVentas = SupabaseClient<Database>;

function lecturasContextoVentas(supabase: ClienteVentas) {
  return {
    async consultarEsAdmin(userId: string) {
      const { data, error } = await supabase.rpc("is_admin", { _user_id: userId });
      if (error || typeof data !== "boolean")
        throw new Error("No se pudo verificar el rol de Ventas.");
      return data;
    },
    async cargarPerfil(userId: string) {
      const { data, error } = await supabase
        .from("profiles")
        .select("activo,puede_facturar,sucursal_id,secciones")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw new Error("No se pudo verificar el perfil de Ventas.");
      return data
        ? {
            activo: data.activo,
            puedeFacturar: data.puede_facturar,
            sucursalId: data.sucursal_id,
            secciones: data.secciones,
          }
        : null;
    },
  };
}

async function autorizarConsultaVentas(
  supabase: ClienteVentas,
  userId: string,
  exigirCapacidadFiscal: boolean,
) {
  return autorizarContextoVentas({
    userId,
    exigirCapacidadFiscal,
    lecturas: lecturasContextoVentas(supabase),
  });
}

async function autorizarOriginalFiscal(supabase: ClienteVentas, userId: string, ventaId: string) {
  await autorizarOperacionFiscal({
    userId,
    ventaId,
    accion: "PREVISUALIZAR",
    confirmaVentaAntigua: false,
    lecturas: {
      async cargarVenta(id) {
        const { data, error } = await supabase
          .from("ventas")
          .select("id,sucursal_id,fecha")
          .eq("id", id)
          .maybeSingle();
        if (error || !data) return null;
        return { id: data.id, sucursalId: data.sucursal_id, fecha: data.fecha };
      },
      ...lecturasContextoVentas(supabase),
      ahora: () => new Date(),
    },
  });
}

const listadoVentasInputSchema = z
  .object({
    sucursal_id: z.string().uuid().optional(),
    estado_pago: z.enum(["PAGADO", "PARCIAL", "PENDIENTE"]).optional(),
  })
  .strict();

export const listarVentasSeguras = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => listadoVentasInputSchema.parse(value))
  .handler(async ({ data, context }) =>
    ejecutarListadoVentasSeguro(
      {
        sucursalId: data.sucursal_id ?? null,
        estadoPago: data.estado_pago ?? null,
      },
      {
        autorizar: () => autorizarConsultaVentas(context.supabase, context.userId, false),
        async cargarVisibles(filtros) {
          let consulta = context.supabase
            .from("ventas")
            .select(
              `${COLUMNAS_VENTA_SEGURAS}, cliente:clientes(razon_social,cuit_dni), sucursal:sucursales(nombre,codigo,telefono), pagos:venta_pagos(forma_pago,monto)`,
            )
            .neq("estado", "PENDIENTE_FISCAL")
            .order("fecha", { ascending: false })
            .limit(200);
          if (filtros.sucursalId) consulta = consulta.eq("sucursal_id", filtros.sucursalId);
          if (filtros.estadoPago) {
            consulta = consulta.eq(
              "estado_pago",
              filtros.estadoPago as Database["public"]["Enums"]["estado_pago"],
            );
          }
          const { data: ventas, error } = await consulta;
          if (error) throw new Error("No se pudo cargar el listado de ventas autorizado.");
          return (ventas ?? []) as unknown as Array<Record<string, unknown>>;
        },
        async cargarEvidencias(ids) {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: evidencias, error } = await supabaseAdmin
            .from("ventas")
            .select("id,afip_snapshot")
            .in("id", ids);
          if (error) throw new Error("No se pudo completar la presentación fiscal del listado.");
          return (evidencias ?? []) as EvidenciaListado[];
        },
      },
    ),
  );

const originalesInputSchema = z
  .object({ cliente_id: z.string().uuid(), receptor_v2: z.boolean() })
  .strict();

export const listarComprobantesOriginalesVenta = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => originalesInputSchema.parse(value))
  .handler(async ({ data, context }) =>
    ejecutarListadoComprobantesOriginalesSeguro(
      { clienteId: data.cliente_id, receptorV2: data.receptor_v2 },
      {
        autorizar: () => autorizarConsultaVentas(context.supabase, context.userId, true),
        async cargarVisibles(contexto) {
          let consulta = context.supabase
            .from("ventas")
            .select(COLUMNAS_COMPROBANTE_ORIGINAL_SEGURAS)
            .eq("cliente_id", data.cliente_id)
            .eq("estado", "ACTIVA");
          if (!contexto.esAdmin && contexto.sucursalId) {
            consulta = consulta.eq("sucursal_id", contexto.sucursalId);
          }
          if (data.receptor_v2) {
            consulta = consulta
              .eq("tipo_comprobante", "VENTA")
              .eq("afip_estado", "APROBADO")
              .eq("afip_fase", "PERSISTIDO")
              .eq("afip_validez", "PRODUCCION")
              .eq("afip_modo", "PRODUCCION")
              .eq("afip_simulado", false)
              .not("cae", "is", null)
              .not("afip_numero", "is", null);
          } else {
            consulta = consulta.in("tipo_comprobante", ["FACTURA_A", "FACTURA_B", "FACTURA_C"]);
          }
          const { data: ventas, error } = await consulta
            .order("fecha", { ascending: false })
            .limit(30);
          if (error)
            throw new Error("No se pudieron leer los comprobantes originales autorizados.");
          return (ventas ?? []) as unknown as Array<Record<string, unknown>>;
        },
        async cargarEvidencias(ids) {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: evidencias, error } = await supabaseAdmin
            .from("ventas")
            .select("id,afip_snapshot,afip_snapshot_hash")
            .in("id", ids);
          if (error) throw new Error("No se pudo verificar la evidencia fiscal de los originales.");
          return (evidencias ?? []) as EvidenciaOriginal[];
        },
      },
    ),
  );

export async function ejecutarCreacionNotaSegunFlags(
  input: Omit<VentaInput, "tipo_comprobante"> & {
    tipo_comprobante: "NOTA_CREDITO" | "NOTA_DEBITO";
  },
  deps: {
    cargarFlags(): Promise<FlagsFacturacion>;
    crearRegular(input: VentaInput): Promise<ResultadoCreacionVenta>;
    crearNotaCreditoTotal(
      originalId: string,
      idempotencyKey: string,
    ): Promise<ResultadoCreacionVenta>;
  },
): Promise<ResultadoCreacionVenta> {
  const flags = await deps.cargarFlags();
  if (flags.facturacion_receptor_v2_enabled && flags.facturacion_legacy_writer_enabled) {
    throw new Error("La configuración fiscal es inválida: ambos escritores están activos.");
  }
  if (!flags.facturacion_receptor_v2_enabled && !flags.facturacion_legacy_writer_enabled) {
    throw new Error("La facturación está en mantenimiento. No se registró ningún comprobante.");
  }
  if (flags.facturacion_receptor_v2_enabled) {
    if (input.tipo_comprobante === "NOTA_DEBITO") {
      throw new Error("La nota de débito nueva queda fuera de alcance fiscal.");
    }
    if (!input.cbte_asoc_id) {
      throw new Error("La nota de crédito fiscal exige el comprobante original.");
    }
    if (!input.idempotency_key) {
      throw new Error("Falta la clave de idempotencia de la nota de crédito.");
    }
    return deps.crearNotaCreditoTotal(input.cbte_asoc_id, input.idempotency_key);
  }
  return deps.crearRegular(input);
}

function normalizarVentaCreada(value: unknown): ResultadoCreacionVenta {
  const row = Array.isArray(value) ? value[0] : value;
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("El servidor no devolvió el comprobante creado.");
  }
  const valueRow = row as Record<string, unknown>;
  const id = valueRow.venta_id ?? valueRow.nc_id;
  const numero = valueRow.numero ?? valueRow.nc_numero;
  if (typeof id !== "string" || typeof numero !== "string") {
    throw new Error("El servidor devolvió un comprobante incompleto.");
  }
  return { id, numero, cta_cte: valueRow.es_cta_cte === true };
}

export const crearVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ventaInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const crearRegular = async (input: VentaInput) => {
      const { data: result, error } = await supabase.rpc("crear_venta", {
        p_sucursal_id: input.sucursal_id,
        // El cast es por los tipos generados, no por la base: un parámetro `uuid`
        // admite NULL, pero el generador de tipos de Supabase lo declara `string`.
        p_cliente_id: (input.cliente_id ?? null) as unknown as string,
        p_tipo_comprobante: input.tipo_comprobante,
        p_condicion_venta: input.condicion_venta,
        p_items: input.items,
        p_pagos: input.pagos,
        p_percepciones: input.percepciones ?? 0,
        p_observaciones: input.observaciones ?? undefined,
        p_nombre_obra: input.nombre_obra ?? undefined,
        p_fecha: input.fecha ?? undefined,
        p_cbte_asoc_id: input.cbte_asoc_id ?? undefined,
        p_idempotency_key: input.idempotency_key ?? undefined,
      });
      if (error) throw new Error(error.message);
      return normalizarVentaCreada(result);
    };

    if (data.tipo_comprobante !== "NOTA_CREDITO" && data.tipo_comprobante !== "NOTA_DEBITO") {
      return crearRegular(data);
    }

    return ejecutarCreacionNotaSegunFlags(
      data as VentaInput & { tipo_comprobante: "NOTA_CREDITO" | "NOTA_DEBITO" },
      {
        cargarFlags: () => cargarFlagsFacturacionDesdeSupabase(supabase as never),
        crearRegular,
        async crearNotaCreditoTotal(originalId, idempotencyKey) {
          const original = await ejecutarLecturaOriginalFiscalAutorizada(originalId, {
            autorizar: (ventaId) => autorizarOriginalFiscal(supabase, context.userId, ventaId),
            async cargarExacta(ventaId) {
              const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
              const { data: fila, error } = await supabaseAdmin
                .from("ventas")
                .select(
                  "id,tipo_comprobante,estado,afip_estado,afip_fase,afip_validez,afip_modo,afip_simulado,afip_numero,afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_snapshot,afip_snapshot_hash,cae",
                )
                .eq("id", ventaId)
                .maybeSingle();
              if (error || !fila) {
                throw new Error("No se pudo leer el comprobante original autorizado.");
              }
              return fila;
            },
          });
          if (
            original.tipo_comprobante !== "VENTA" ||
            original.estado !== "ACTIVA" ||
            original.afip_estado !== "APROBADO" ||
            original.afip_fase !== "PERSISTIDO" ||
            original.afip_validez !== "PRODUCCION" ||
            original.afip_modo !== "PRODUCCION" ||
            original.afip_simulado ||
            !original.cae ||
            original.afip_numero == null ||
            !original.afip_emisor_cuit ||
            original.afip_punto_venta == null ||
            original.afip_cbte_tipo == null ||
            !original.afip_snapshot ||
            !original.afip_snapshot_hash
          ) {
            throw new Error(
              "La nota de crédito v2 exige una venta neutral aprobada con identidad fiscal real completa.",
            );
          }
          const { data: result, error } = await supabase.rpc("anular_venta", {
            p_venta_id: originalId,
            p_idempotency_key: idempotencyKey,
          });
          if (error) throw new Error(error.message);
          return normalizarVentaCreada(result);
        },
      },
    );
  });

const conversionBaseSchema = z.object({
  presupuesto_id: z.string().uuid(),
  condicion_venta: z.enum(["CONTADO", "CTA_CTE"]),
  pagos: z.array(pagoSchema).default([]),
  idempotency_key: z.string().uuid(),
});

export const conversionPresupuestoInputSchema = z.discriminatedUnion("entrada", [
  conversionBaseSchema
    .extend({ entrada: z.literal("V2"), cliente_id: z.string().uuid().nullable() })
    .strict(),
  conversionBaseSchema
    .extend({
      entrada: z.literal("LEGACY"),
      cliente_id: z.string().uuid(),
      tipo_comprobante: z.enum(["FACTURA_A", "FACTURA_B"]),
    })
    .strict(),
]);

export type ConversionPresupuestoInput = z.infer<typeof conversionPresupuestoInputSchema>;
export type ConversionPresupuestoResultado = {
  id: string;
  numero: string;
  cta_cte: boolean;
  clienteId: string;
};

const mantenimientoConversion = () => ({
  estado: "MANTENIMIENTO" as const,
  mensaje: "La facturación está temporalmente en mantenimiento. No se convirtió el presupuesto.",
});

export async function ejecutarConversionPresupuestoSegunFlags(
  input: ConversionPresupuestoInput,
  deps: {
    cargarFlags(): Promise<FlagsFacturacion>;
    convertirNeutral(
      input: Extract<ConversionPresupuestoInput, { entrada: "V2" }>,
    ): Promise<ConversionPresupuestoResultado>;
    convertirLegacy(
      input: Extract<ConversionPresupuestoInput, { entrada: "LEGACY" }>,
    ): Promise<ConversionPresupuestoResultado>;
  },
): Promise<ConversionPresupuestoResultado | ReturnType<typeof mantenimientoConversion>> {
  const escritor = decidirEscritorFiscal(await deps.cargarFlags(), input.entrada);
  if (escritor === "MANTENIMIENTO") return mantenimientoConversion();
  if (input.entrada === "V2") return deps.convertirNeutral(input);
  return deps.convertirLegacy(input);
}

export function normalizarConversion(value: unknown): ConversionPresupuestoResultado {
  const row = Array.isArray(value) ? value[0] : value;
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("El servidor no devolvió la venta convertida.");
  }
  const record = row as Record<string, unknown>;
  if (
    typeof record.venta_id !== "string" ||
    typeof record.numero !== "string" ||
    typeof record.es_cta_cte !== "boolean" ||
    typeof record.cliente_id !== "string"
  ) {
    throw new Error("El servidor devolvió una conversión incompleta.");
  }
  return {
    id: record.venta_id,
    numero: record.numero,
    cta_cte: record.es_cta_cte,
    clienteId: record.cliente_id,
  };
}

/** Fence server-side: flags autoritativos antes de cualquier RPC comercial. */
export const convertirPresupuestoEnVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => conversionPresupuestoInputSchema.parse(value))
  .handler(async ({ data, context }) =>
    ejecutarConversionPresupuestoSegunFlags(data, {
      cargarFlags: () => cargarFlagsFacturacionDesdeSupabase(context.supabase as never),
      async convertirNeutral(input) {
        const { data: result, error } = await context.supabase.rpc(
          "convertir_presupuesto_en_venta_neutral",
          {
            p_presupuesto_id: input.presupuesto_id,
            // Postgres admite NULL en este parámetro aunque el generador de
            // tipos lo represente como string; NULL activa Consumidor Final.
            p_cliente_id: input.cliente_id as unknown as string,
            p_condicion_venta: input.condicion_venta,
            p_pagos: input.pagos,
            p_idempotency_key: input.idempotency_key,
          },
        );
        if (error) throw new Error(error.message);
        return normalizarConversion(result);
      },
      async convertirLegacy(input) {
        // Compatibilidad con una base anterior al cutover. La migración
        // 20260824025115 elimina esta firma del esquema local actual, por eso
        // no forma parte de los tipos generados; el branch sigue cercado por
        // los flags autoritativos para instalaciones aún en drain legacy.
        const supabaseLegacy = context.supabase as unknown as {
          rpc(
            nombre: "convertir_presupuesto_en_venta",
            args: {
              p_presupuesto_id: string;
              p_cliente_id: string;
              p_tipo_comprobante: "FACTURA_A" | "FACTURA_B";
              p_condicion_venta: "CONTADO" | "CTA_CTE";
              p_pagos: unknown;
              p_idempotency_key: string;
            },
          ): Promise<{ data: unknown; error: { message: string } | null }>;
        };
        const { data: result, error } = await supabaseLegacy.rpc("convertir_presupuesto_en_venta", {
          p_presupuesto_id: input.presupuesto_id,
          p_cliente_id: input.cliente_id,
          p_tipo_comprobante: input.tipo_comprobante,
          p_condicion_venta: input.condicion_venta,
          p_pagos: input.pagos,
          p_idempotency_key: input.idempotency_key,
        });
        if (error) throw new Error(error.message);
        return normalizarConversion(result);
      },
    }),
  );

export const anulacionVentaInputSchema = z
  .object({
    venta_id: z.string().uuid(),
    idempotency_key: z.string().uuid(),
  })
  .strict();

export type AnulacionVentaInput = z.infer<typeof anulacionVentaInputSchema>;

export const anularVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => anulacionVentaInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: r, error } = await supabase.rpc("anular_venta", {
      p_venta_id: data.venta_id,
      p_idempotency_key: data.idempotency_key,
    });

    if (error) throw new Error(error.message);

    const row = (Array.isArray(r) ? r[0] : r) as {
      nc_id?: unknown;
      nc_numero?: unknown;
    };
    if (typeof row?.nc_id !== "string" || typeof row.nc_numero !== "string") {
      throw new Error("El servidor no devolvió la nota de crédito anuladora.");
    }
    return { ok: true, nc_id: row.nc_id, nc_numero: row.nc_numero };
  });
