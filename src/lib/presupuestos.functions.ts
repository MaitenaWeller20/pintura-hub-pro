import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normalizarDescripcionItem } from "./item-descripcion";
import {
  ejecutarOperacionComercialSegura,
  mensajeErrorOperacion,
  type ResultadoOperacionSegura,
} from "./operacion-comercial-segura";

export type PreflightConversionPresupuesto = {
  presupuestoId: string;
  sucursalId: string;
  sucursalNombre: string;
  caja: null | { id: string; abiertaDesde: string };
};

type DependenciasPreflightConversion = {
  cargarPresupuestoUsuario(presupuestoId: string): Promise<unknown>;
  cargarCajasUsuario(sucursalId: string, limite: number): Promise<unknown>;
};

function esRegistro(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nombreSucursal(value: unknown): string | null {
  const relacion = Array.isArray(value) ? value[0] : value;
  if (!esRegistro(relacion) || typeof relacion.nombre !== "string") return null;
  const nombre = relacion.nombre.trim();
  return nombre || null;
}

export async function ejecutarPreflightConversionPresupuesto(
  input: { presupuestoId: string },
  deps: DependenciasPreflightConversion,
): Promise<PreflightConversionPresupuesto> {
  let presupuesto: unknown;
  try {
    presupuesto = await deps.cargarPresupuestoUsuario(input.presupuestoId);
  } catch {
    throw new Error("No se pudo leer el presupuesto o no tenés acceso.");
  }
  if (
    !esRegistro(presupuesto) ||
    presupuesto.id !== input.presupuestoId ||
    typeof presupuesto.sucursal_id !== "string"
  ) {
    throw new Error("No se pudo leer el presupuesto o no tenés acceso.");
  }

  const sucursalNombre = nombreSucursal(presupuesto.sucursal);
  if (!sucursalNombre) throw new Error("El presupuesto no tiene una sucursal válida.");

  let cajas: unknown;
  try {
    cajas = await deps.cargarCajasUsuario(presupuesto.sucursal_id, 2);
  } catch {
    throw new Error("No se pudo confirmar la caja de la sucursal.");
  }
  if (!Array.isArray(cajas) || cajas.length > 1) {
    throw new Error("No se pudo confirmar la caja de la sucursal.");
  }

  const caja = cajas[0];
  if (caja === undefined) {
    return {
      presupuestoId: presupuesto.id,
      sucursalId: presupuesto.sucursal_id,
      sucursalNombre,
      caja: null,
    };
  }
  if (!esRegistro(caja) || typeof caja.id !== "string" || typeof caja.abierta_en !== "string") {
    throw new Error("No se pudo confirmar la caja de la sucursal.");
  }

  return {
    presupuestoId: presupuesto.id,
    sucursalId: presupuesto.sucursal_id,
    sucursalNombre,
    caja: { id: caja.id, abiertaDesde: caja.abierta_en },
  };
}

const preflightConversionInputSchema = z.object({ presupuesto_id: z.string().uuid() }).strict();

export const preflightConversionPresupuesto = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => preflightConversionInputSchema.parse(value))
  .handler(async ({ data, context }) =>
    ejecutarPreflightConversionPresupuesto(
      { presupuestoId: data.presupuesto_id },
      {
        async cargarPresupuestoUsuario(presupuestoId) {
          const { data: presupuesto, error } = await context.supabase
            .from("presupuestos")
            .select("id,sucursal_id,sucursal:sucursales(nombre)")
            .eq("id", presupuestoId)
            .maybeSingle();
          if (error) throw error;
          return presupuesto;
        },
        async cargarCajasUsuario(sucursalId, limite) {
          const { data: cajas, error } = await context.supabase
            .from("caja_sesiones")
            .select("id,abierta_en")
            .eq("sucursal_id", sucursalId)
            .eq("estado", "ABIERTA")
            .order("abierta_en", { ascending: false })
            .limit(limite);
          if (error) throw error;
          return cajas ?? [];
        },
      },
    ),
  );

const descripcionPresupuestoSchema = z.string().transform((value, context) => {
  try {
    return normalizarDescripcionItem(value);
  } catch (cause) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: cause instanceof Error ? cause.message : mensajeErrorOperacion("DATOS_INVALIDOS"),
    });
    return z.NEVER;
  }
});

const itemPresupuestoSchema = z
  .object({
    producto_id: z.string().uuid(),
    cantidad: z.number().finite().positive(),
    descuento_porcentaje: z.number().finite().min(0).max(100).default(0),
    descripcion: descripcionPresupuestoSchema.optional(),
  })
  .strict();

const camposCabeceraPresupuesto = {
  p_cliente_id: z.string().uuid().optional(),
  p_nombre_cliente: z.string().optional(),
  p_validez_hasta: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  p_observaciones: z.string().optional(),
};

export const crearPresupuestoInputSchema = z
  .object({
    p_sucursal_id: z.string().uuid(),
    p_items: z.array(itemPresupuestoSchema).min(1),
    ...camposCabeceraPresupuesto,
  })
  .strict();

export const editarPresupuestoInputSchema = z
  .object({
    p_presupuesto_id: z.string().uuid(),
    p_items: z.array(itemPresupuestoSchema).min(1),
    p_repreciar: z.boolean(),
    ...camposCabeceraPresupuesto,
  })
  .strict();

const resultadoAltaPresupuestoSchema = z
  .object({ presupuesto_id: z.string().uuid(), numero: z.string().min(1) })
  .strict();
const resultadoEdicionPresupuestoSchema = resultadoAltaPresupuestoSchema
  .extend({
    total: z.union([z.number(), z.string()]).transform(Number).refine(Number.isFinite),
  })
  .strict();

function primeraFila(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function validarEntradaCerrada<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
): z.output<TSchema> {
  const resultado = schema.safeParse(value);
  if (!resultado.success) throw new Error(mensajeErrorOperacion("DATOS_INVALIDOS"));
  return resultado.data;
}

export type ResultadoAltaPresupuesto = {
  presupuestoId: string;
  numero: string;
};
export type ResultadoEdicionPresupuesto = ResultadoAltaPresupuesto & { total: number };

type RespuestaRpcPresupuesto = { data: unknown; error: unknown };
type DependenciasWriterPresupuesto = {
  ejecutarRpc(): Promise<RespuestaRpcPresupuesto>;
  registrar?: Parameters<typeof ejecutarOperacionComercialSegura>[2];
};

export async function ejecutarCreacionPresupuestoCerrada(
  _input: z.infer<typeof crearPresupuestoInputSchema>,
  deps: DependenciasWriterPresupuesto,
): Promise<ResultadoOperacionSegura<ResultadoAltaPresupuesto>> {
  return ejecutarOperacionComercialSegura(
    "CREAR_PRESUPUESTO",
    async () => {
      const { data, error } = await deps.ejecutarRpc();
      if (error) throw error;
      const fila = resultadoAltaPresupuestoSchema.parse(primeraFila(data));
      return { presupuestoId: fila.presupuesto_id, numero: fila.numero };
    },
    deps.registrar,
  );
}

export async function ejecutarEdicionPresupuestoCerrada(
  _input: z.infer<typeof editarPresupuestoInputSchema>,
  deps: DependenciasWriterPresupuesto,
): Promise<ResultadoOperacionSegura<ResultadoEdicionPresupuesto>> {
  return ejecutarOperacionComercialSegura(
    "EDITAR_PRESUPUESTO",
    async () => {
      const { data, error } = await deps.ejecutarRpc();
      if (error) throw error;
      const fila = resultadoEdicionPresupuestoSchema.parse(primeraFila(data));
      return {
        presupuestoId: fila.presupuesto_id,
        numero: fila.numero,
        total: Number(fila.total),
      };
    },
    deps.registrar,
  );
}

export const crearPresupuesto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((value: unknown) => validarEntradaCerrada(crearPresupuestoInputSchema, value))
  .handler(
    async ({ data, context }): Promise<ResultadoOperacionSegura<ResultadoAltaPresupuesto>> =>
      ejecutarCreacionPresupuestoCerrada(data, {
        ejecutarRpc: async () => {
          const { data: result, error } = await context.supabase.rpc("crear_presupuesto", data);
          return { data: result, error };
        },
      }),
  );

export const editarPresupuesto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((value: unknown) => validarEntradaCerrada(editarPresupuestoInputSchema, value))
  .handler(
    async ({ data, context }): Promise<ResultadoOperacionSegura<ResultadoEdicionPresupuesto>> =>
      ejecutarEdicionPresupuestoCerrada(data, {
        ejecutarRpc: async () => {
          const { data: result, error } = await context.supabase.rpc("editar_presupuesto", data);
          return { data: result, error };
        },
      }),
  );
