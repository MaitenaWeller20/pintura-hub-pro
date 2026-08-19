import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  normalizarCredencialesPublicas,
  validarHabilitacionCredencial,
  type CredencialArcaPublica,
  type CredencialArcaSecreta,
} from "./config";
import type { AmbienteArca } from "./contexto";
import { cargarContextoFiscal } from "./contexto.server";
import {
  generarCsrDesdeClave,
  generarParYCsr,
  prepararSubject,
  validarCuitEmisor,
  verificarCertificado,
} from "./cert";
import { decryptString, encryptString } from "./crypto";
import { MOCK, ultimoAutorizado } from "./arca";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function exigirAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.rpc("is_admin", { _user_id: userId });
  if (error) throw new Error(`No se pudo verificar el permiso de administrador: ${error.message}`);
  if (!data) throw new Error("Sólo un administrador puede tocar la configuración fiscal.");
}

export type ConfigFiscalPublica = {
  mock_mode: boolean;
  emisores: Array<{
    id: string;
    razon_social: string;
    nombre_fantasia: string | null;
    cuit: string | null;
    domicilio_fiscal: string | null;
    condicion_iva: "RESPONSABLE_INSCRIPTO" | "MONOTRIBUTO" | null;
    ingresos_brutos: string | null;
    inicio_actividades: string | null;
    sucursales: Array<{
      id: string;
      nombre: string;
      telefono: string | null;
      punto_venta: {
        id: string;
        numero: number;
        modo: AmbienteArca;
        activo: boolean;
      } | null;
    }>;
    credenciales: CredencialArcaPublica[];
  }>;
};

const ambienteSchema = z.enum(["HOMOLOGACION", "PRODUCCION"]);

function ambienteArca(valor: string): AmbienteArca {
  if (valor === "HOMOLOGACION" || valor === "PRODUCCION") return valor;
  throw new Error(`Ambiente ARCA inválido en la base: ${valor}.`);
}

export const obtenerConfigFiscal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<ConfigFiscalPublica> => {
    const sb = await admin();
    const [{ data: emisores, error: emisoresError }, { data: credenciales, error: credError }] =
      await Promise.all([
        sb
          .from("emisores")
          .select(
            "id,razon_social,nombre_fantasia,cuit,domicilio_fiscal,condicion_iva,ingresos_brutos,inicio_actividades,sucursales(id,nombre,telefono,punto_venta:puntos_venta!puntos_venta_sucursal_id_fkey(id,numero,modo,activo))",
          )
          .order("razon_social"),
        sb
          .from("credenciales_arca")
          .select(
            "emisor_id,ambiente,arca_key_enc,arca_cert_enc,cert_vence_at,cert_alias,probada_at,habilitada",
          ),
      ]);
    if (emisoresError) throw new Error(`No se pudo cargar los emisores: ${emisoresError.message}`);
    if (credError) throw new Error(`No se pudo cargar el estado de ARCA: ${credError.message}`);

    return {
      mock_mode: MOCK,
      emisores: (emisores ?? []).map((emisor) => {
        const condicion =
          emisor.condicion_iva === "RESPONSABLE_INSCRIPTO" || emisor.condicion_iva === "MONOTRIBUTO"
            ? emisor.condicion_iva
            : null;
        const filas: CredencialArcaSecreta[] = (credenciales ?? [])
          .filter((fila) => fila.emisor_id === emisor.id)
          .map((fila) => ({
            ambiente: ambienteArca(fila.ambiente),
            arca_key_enc: fila.arca_key_enc,
            arca_cert_enc: fila.arca_cert_enc,
            cert_vence_at: fila.cert_vence_at,
            cert_alias: fila.cert_alias,
            probada_at: fila.probada_at,
            habilitada: fila.habilitada,
          }));

        return {
          id: emisor.id as string,
          razon_social: emisor.razon_social as string,
          nombre_fantasia: (emisor.nombre_fantasia ?? null) as string | null,
          cuit: (emisor.cuit ?? null) as string | null,
          domicilio_fiscal: (emisor.domicilio_fiscal ?? null) as string | null,
          condicion_iva: condicion,
          ingresos_brutos: (emisor.ingresos_brutos ?? null) as string | null,
          inicio_actividades: (emisor.inicio_actividades ?? null) as string | null,
          sucursales: (emisor.sucursales ?? []).map((sucursal) => {
            const relacionPv = sucursal.punto_venta;
            const pv = Array.isArray(relacionPv) ? relacionPv[0] : relacionPv;
            return {
              id: sucursal.id as string,
              nombre: sucursal.nombre as string,
              telefono: (sucursal.telefono ?? null) as string | null,
              punto_venta: pv
                ? {
                    id: pv.id as string,
                    numero: Number(pv.numero),
                    modo: ambienteArca(pv.modo),
                    activo: Boolean(pv.activo),
                  }
                : null,
            };
          }),
          credenciales: normalizarCredencialesPublicas(filas),
        };
      }),
    };
  });

export const guardarPuntoVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        sucursal_id: z.string().uuid(),
        numero: z.number().int().positive(),
        modo: ambienteSchema,
        activo: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const sb = await admin();
    await exigirAdmin(context.supabase, context.userId);

    const [{ data: sucursal, error: sucursalError }, { data: anterior, error: pvError }] =
      await Promise.all([
        sb.from("sucursales").select("id,emisor_id").eq("id", data.sucursal_id).maybeSingle(),
        sb
          .from("puntos_venta")
          .select("numero,modo,activo")
          .eq("sucursal_id", data.sucursal_id)
          .maybeSingle(),
      ]);
    if (sucursalError) throw new Error(sucursalError.message);
    if (pvError) throw new Error(pvError.message);
    if (!sucursal?.emisor_id) throw new Error("La sucursal no tiene un emisor fiscal asignado.");

    const { error } = await sb.from("puntos_venta").upsert(
      {
        sucursal_id: data.sucursal_id,
        emisor_id: sucursal.emisor_id,
        numero: data.numero,
        modo: data.modo,
        activo: data.activo,
      },
      { onConflict: "sucursal_id" },
    );
    if (error) throw new Error(error.message);

    const cambio =
      !anterior ||
      Number(anterior.numero) !== data.numero ||
      anterior.modo !== data.modo ||
      Boolean(anterior.activo) !== data.activo;
    if (cambio) {
      const ambientes = anterior ? [...new Set([anterior.modo, data.modo])] : [data.modo];
      const { error: resetError } = await sb
        .from("credenciales_arca")
        .update({ probada_at: null, habilitada: false })
        .eq("emisor_id", sucursal.emisor_id)
        .in("ambiente", ambientes);
      if (resetError) throw new Error(resetError.message);
    }

    return { ok: true };
  });

export const generarCsr = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ emisor_id: z.string().uuid(), ambiente: ambienteSchema }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const sb = await admin();
    await exigirAdmin(context.supabase, context.userId);

    const [{ data: emisor, error: emisorError }, { data: credencial, error: credError }] =
      await Promise.all([
        sb
          .from("emisores")
          .select("id,razon_social,nombre_fantasia,cuit")
          .eq("id", data.emisor_id)
          .maybeSingle(),
        sb
          .from("credenciales_arca")
          .select("arca_key_enc,arca_cert_enc")
          .eq("emisor_id", data.emisor_id)
          .eq("ambiente", data.ambiente)
          .maybeSingle(),
      ]);
    if (emisorError) throw new Error(emisorError.message);
    if (credError) throw new Error(credError.message);
    if (!emisor) throw new Error("No existe el emisor seleccionado.");
    if (credencial?.arca_cert_enc) {
      throw new Error(
        "Ya hay un certificado cargado para este emisor y ambiente. La renovación requiere un flujo separado.",
      );
    }

    const cuit = validarCuitEmisor(emisor.cuit);
    const { org, cn } = prepararSubject(emisor.razon_social, emisor.nombre_fantasia);
    let csr: string;
    if (credencial?.arca_key_enc) {
      const keyPem = decryptString(credencial.arca_key_enc);
      if (!keyPem) {
        throw new Error("No se pudo descifrar la clave privada. ¿Cambió ARCA_ENCRYPTION_KEY?");
      }
      csr = generarCsrDesdeClave(org, cn, cuit, keyPem);
      const { error } = await sb
        .from("credenciales_arca")
        .update({ cert_alias: cn, probada_at: null, habilitada: false })
        .eq("emisor_id", data.emisor_id)
        .eq("ambiente", data.ambiente);
      if (error) throw new Error(error.message);
    } else {
      const par = await generarParYCsr(org, cn, cuit);
      csr = par.csr;
      const { error } = await sb.from("credenciales_arca").upsert(
        {
          emisor_id: data.emisor_id,
          ambiente: data.ambiente,
          arca_key_enc: encryptString(par.keyPem),
          cert_alias: cn,
          probada_at: null,
          habilitada: false,
        },
        { onConflict: "emisor_id,ambiente" },
      );
      if (error) throw new Error(error.message);
    }

    return { csr, alias: cn, ambiente: data.ambiente };
  });

export const guardarCertificado = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ emisor_id: z.string().uuid(), ambiente: ambienteSchema, pem: z.string().min(1) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const sb = await admin();
    await exigirAdmin(context.supabase, context.userId);

    const { data: credencial, error: credError } = await sb
      .from("credenciales_arca")
      .select("arca_key_enc")
      .eq("emisor_id", data.emisor_id)
      .eq("ambiente", data.ambiente)
      .maybeSingle();
    if (credError) throw new Error(credError.message);
    if (!credencial?.arca_key_enc) {
      throw new Error("Primero generá el CSR de este emisor y ambiente.");
    }

    const keyPem = decryptString(credencial.arca_key_enc);
    if (!keyPem) {
      throw new Error("No se pudo descifrar la clave privada. ¿Cambió ARCA_ENCRYPTION_KEY?");
    }
    const { vence } = verificarCertificado(data.pem, keyPem);

    const { error } = await sb
      .from("credenciales_arca")
      .update({
        arca_cert_enc: encryptString(data.pem),
        cert_vence_at: vence.toISOString(),
        probada_at: null,
        habilitada: false,
      })
      .eq("emisor_id", data.emisor_id)
      .eq("ambiente", data.ambiente);
    if (error) throw new Error(error.message);

    return { vence: vence.toISOString(), ambiente: data.ambiente };
  });

export const probarConexionAfip = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ sucursal_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const sb = await admin();
    await exigirAdmin(context.supabase, context.userId);

    if (MOCK) {
      return {
        ok: true,
        mock: true,
        ultimo: 0,
        mensaje: "Mock mode activo: no se llamó a ARCA y la credencial sigue sin verificar.",
      };
    }

    const fiscal = await cargarContextoFiscal(sb, data.sucursal_id, { exigirHabilitada: false });
    const ultimo = await ultimoAutorizado(fiscal.emisor, fiscal.pv, 6, sb);
    const probadaAt = new Date().toISOString();
    const { error } = await sb
      .from("credenciales_arca")
      .update({ probada_at: probadaAt })
      .eq("emisor_id", fiscal.sucursal.emisor_id)
      .eq("ambiente", fiscal.pv.modo);
    if (error) throw new Error(error.message);

    return {
      ok: true,
      mock: false,
      ultimo,
      probada_at: probadaAt,
      mensaje: `ARCA respondió. Último comprobante tipo B autorizado en el PV ${fiscal.pv.numero}: ${ultimo}.`,
    };
  });

export const guardarHabilitacionCredencial = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        emisor_id: z.string().uuid(),
        ambiente: ambienteSchema,
        habilitada: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const sb = await admin();
    await exigirAdmin(context.supabase, context.userId);
    if (data.habilitada && MOCK) {
      throw new Error(
        "No se puede habilitar una credencial mientras el modo simulado está activo.",
      );
    }

    const { data: credencial, error: credError } = await sb
      .from("credenciales_arca")
      .select("arca_key_enc,arca_cert_enc,cert_vence_at,probada_at")
      .eq("emisor_id", data.emisor_id)
      .eq("ambiente", data.ambiente)
      .maybeSingle();
    if (credError) throw new Error(credError.message);
    if (!credencial) throw new Error("No existe la credencial seleccionada.");
    validarHabilitacionCredencial(credencial, data.habilitada);

    const { error } = await sb
      .from("credenciales_arca")
      .update({ habilitada: data.habilitada })
      .eq("emisor_id", data.emisor_id)
      .eq("ambiente", data.ambiente);
    if (error) throw new Error(error.message);
    return { ok: true, habilitada: data.habilitada };
  });
