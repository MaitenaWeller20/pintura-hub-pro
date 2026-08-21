/**
 * Los emisores y los datos de contacto de cada sucursal.
 *
 * Es lo que sale en el encabezado de los presupuestos y los remitos. Va por
 * server function y no por RLS porque `emisores` y `sucursales` son de sólo
 * lectura para el usuario común: los toca un admin, igual que la configuración
 * fiscal.
 *
 * Ver `src/lib/impresos/encabezado.ts` y la migración 20260814120000.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { bytesDeDataUrl, medirImagen } from "@/lib/impresos/imagen";
import { validarCuitEmisor } from "@/lib/fiscal/cert";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";

// Los mismos dos helpers que usa fiscal.functions: el cliente de servicio para
// escribir, y el chequeo de admin por la RPC `is_admin`, que es la que manda.
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function exigirAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data: esAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
  if (!esAdmin) throw new Error("Sólo un administrador puede cambiar estos datos.");
}

/** Los emisores con las sucursales que le cuelgan. Para la pantalla de config. */
export const listarEmisores = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("emisores")
      .select(
        "id, razon_social, nombre_fantasia, cuit, domicilio_fiscal, condicion_iva, ingresos_brutos, inicio_actividades, logo, sucursales(id, nombre, direccion, telefono)",
      )
      .order("razon_social");
    if (error) {
      console.error("[Emisores] no se pudieron cargar", {
        codigo: error.code,
        mensaje: error.message,
      });
      throw new Error(`No se pudieron traer los emisores: ${error.message}`);
    }
    console.info("[Emisores] cargados", { cantidad: data?.length ?? 0 });
    return data ?? [];
  });

/**
 * Un logo razonable.
 *
 * El tope se mide sobre la cadena YA en base64, que es lo que se guarda y lo que
 * viaja: 100 KB de texto son ~75 KB de imagen.
 *
 * Y no alcanza con mirar la firma de los primeros bytes, que es lo que hacía la
 * primera versión: una cadena que empiece con la firma de PNG y siga con basura
 * pasaba igual y se guardaba. Se leen las CABECERAS de verdad (el IHDR de PNG,
 * el SOFn de JPEG) y de ahí salen el ancho y el alto — que además son lo que
 * hace pesado al PDF, más que los bytes del archivo.
 */
const TOPE_LOGO = 100 * 1024;
const LADO_MAX = 1000;
const logoValido = z
  .string()
  .max(TOPE_LOGO, "El logo no puede pasar de 100 KB. Achicalo y volvé a intentar.")
  .refine(
    (s) => /^data:image\/(png|jpeg);base64,/.test(s),
    "El logo tiene que ser un PNG o un JPEG.",
  )
  .refine(
    (s) => medirImagen(bytesDeDataUrl(s)) !== null,
    "Ese archivo no es un PNG ni un JPEG que se pueda leer.",
  )
  .refine((s) => {
    const m = medirImagen(bytesDeDataUrl(s))!;
    return m.ancho <= LADO_MAX && m.alto <= LADO_MAX;
  }, `El logo no puede tener más de ${LADO_MAX} píxeles de lado.`)
  .nullable();

export const guardarEmisor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        // Los topes no son burocracia: esto va en el encabezado de cada
        // impreso, y un texto pegado de cientos de caracteres empuja el título
        // y la tabla fuera de la hoja.
        razon_social: z
          .string()
          .min(1, "La razón social no puede quedar vacía.")
          .max(120, "La razón social no puede pasar de 120 caracteres."),
        nombre_fantasia: z.string().max(120).optional().nullable(),
        cuit: z.string().max(20).optional().nullable(),
        domicilio_fiscal: z
          .string()
          .max(200, "El domicilio no puede pasar de 200 caracteres.")
          .optional()
          .nullable(),
        condicion_iva: z.enum(["RESPONSABLE_INSCRIPTO", "MONOTRIBUTO"]).optional().nullable(),
        ingresos_brutos: z.string().max(80).optional().nullable(),
        inicio_actividades: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha de inicio no es válida.")
          .optional()
          .nullable(),
        logo: logoValido.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const sb = await admin();
    await exigirAdmin(context.supabase, context.userId);
    const { id, ...camposEntrada } = data;
    const cuit = camposEntrada.cuit?.trim() ? validarCuitEmisor(camposEntrada.cuit) : null;
    const campos = { ...camposEntrada, cuit };
    const { error } = await sb.from("emisores").update(campos).eq("id", id);
    if (error) throw new Error(`No se pudo guardar: ${error.message}`);
    return { ok: true };
  });

/** La dirección y el teléfono del LOCAL, que es lo que se imprime. */
export const guardarContactoSucursal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        direccion: z
          .string()
          .max(200, "La dirección no puede pasar de 200 caracteres.")
          .optional()
          .nullable(),
        telefono: z
          .string()
          .max(40, "El teléfono no puede pasar de 40 caracteres.")
          .optional()
          .nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const sb = await admin();
    await exigirAdmin(context.supabase, context.userId);
    const { id, ...campos } = data;
    const { error } = await sb.from("sucursales").update(campos).eq("id", id);
    if (error) throw new Error(`No se pudo guardar: ${error.message}`);
    return { ok: true };
  });
