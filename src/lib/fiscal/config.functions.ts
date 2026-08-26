import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  actualizacionModalidadFacturaA,
  actualizacionResetCredencialPorCambioPuntoVenta,
  autorizarAntesDeClientePrivilegiado,
  confirmacionModalidadFacturaASchema,
  estadoFiscalPublicoMinimo,
  exigirEmisorActualizado,
  ejecutarPruebaActivacionPadron,
  normalizarCredencialesPublicas,
  probarAccesoSecuenciasFactura,
  probarConexionSegunModo,
  validarHabilitacionCredencial,
  type CredencialArcaPublica,
  type CredencialArcaSecreta,
  type EntradaPruebaPadron,
  type ResultadoPruebaPadron,
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
import { autorizarAdministradorFiscal } from "./permiso.server";
import { crearErrorFiscalUsuario, parsearEntradaFiscal } from "./error-usuario";
import { consultarPadronArcaDesdeContexto } from "./padron-arca.server";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function exigirAdmin(supabase: SupabaseClient<Database>, userId: string) {
  await autorizarAdministradorFiscal({
    userId,
    lecturas: {
      async consultarEsAdmin(id) {
        const { data, error } = await supabase.rpc("is_admin", { _user_id: id });
        if (error || typeof data !== "boolean") {
          throw new Error("No se pudo verificar el permiso de administrador.");
        }
        return data;
      },
      async cargarPerfil(id) {
        const { data, error } = await supabase
          .from("profiles")
          .select("activo")
          .eq("id", id)
          .maybeSingle();
        if (error) throw new Error("No se pudo verificar el perfil del administrador.");
        return data;
      },
    },
  });
}

type DependenciasPruebaPadronAdministrativa = {
  mockMode: boolean;
  ahora(): Date;
  exigirAdmin(supabase: SupabaseClient<Database>, userId: string): Promise<void>;
  crearClientePrivilegiado(): Promise<SupabaseClient<Database>>;
  consultarPadron(
    input: Parameters<typeof consultarPadronArcaDesdeContexto>[0],
  ): ReturnType<typeof consultarPadronArcaDesdeContexto>;
};

const dependenciasPruebaPadronAdministrativa: DependenciasPruebaPadronAdministrativa = {
  mockMode: MOCK,
  ahora: () => new Date(),
  exigirAdmin,
  crearClientePrivilegiado: admin,
  consultarPadron: consultarPadronArcaDesdeContexto,
};

function errorConfiguracionPadron(): never {
  throw crearErrorFiscalUsuario("PADRON_CONFIG_INVALIDA");
}

export async function ejecutarPruebaPadronAdministrativa(
  input: {
    entrada: EntradaPruebaPadron;
    userClient: SupabaseClient<Database>;
    userId: string;
  },
  deps: DependenciasPruebaPadronAdministrativa = dependenciasPruebaPadronAdministrativa,
): Promise<ResultadoPruebaPadron> {
  await deps.exigirAdmin(input.userClient, input.userId);
  if (deps.mockMode) errorConfiguracionPadron();
  let sb: SupabaseClient<Database>;
  try {
    sb = await deps.crearClientePrivilegiado();
  } catch {
    errorConfiguracionPadron();
  }

  // La versión se captura antes del CUIT: el trigger por CUIT invalida este
  // snapshot incluso cuando el cambio ocurre entre ambas lecturas.
  let credencialResultado;
  try {
    credencialResultado = await sb
      .from("credenciales_arca")
      .select("emisor_id,ambiente,arca_key_enc,arca_cert_enc,updated_at")
      .eq("emisor_id", input.entrada.emisor_id)
      .eq("ambiente", input.entrada.ambiente)
      .maybeSingle();
  } catch {
    errorConfiguracionPadron();
  }
  const { data: credencial, error: credencialError } = credencialResultado;
  if (
    credencialError ||
    !credencial ||
    credencial.emisor_id !== input.entrada.emisor_id ||
    credencial.ambiente !== input.entrada.ambiente ||
    typeof credencial.updated_at !== "string" ||
    credencial.updated_at.length === 0
  ) {
    errorConfiguracionPadron();
  }
  const versionCredencial = credencial.updated_at;

  let emisorResultado;
  try {
    emisorResultado = await sb
      .from("emisores")
      .select("id,cuit")
      .eq("id", input.entrada.emisor_id)
      .maybeSingle();
  } catch {
    errorConfiguracionPadron();
  }
  const { data: emisor, error: emisorError } = emisorResultado;
  if (
    emisorError ||
    !emisor ||
    emisor.id !== input.entrada.emisor_id ||
    typeof emisor.cuit !== "string"
  ) {
    errorConfiguracionPadron();
  }
  const cuitEmisor = emisor.cuit;

  // El trigger genérico mueve updated_at para credenciales, resets por CUIT y
  // resets por cambio de PV. Éste mismo snapshot protege éxito y fallo.
  const actualizar = async (
    campos: Database["public"]["Tables"]["credenciales_arca"]["Update"],
  ) => {
    const { data: actualizada, error } = await sb
      .from("credenciales_arca")
      .update(campos)
      .eq("emisor_id", input.entrada.emisor_id)
      .eq("ambiente", input.entrada.ambiente)
      .eq("updated_at", versionCredencial)
      .select("emisor_id,ambiente")
      .maybeSingle();
    if (
      error ||
      !actualizada ||
      actualizada.emisor_id !== input.entrada.emisor_id ||
      actualizada.ambiente !== input.entrada.ambiente
    ) {
      throw new Error("No se pudo persistir el estado seguro del padrón.");
    }
  };

  return ejecutarPruebaActivacionPadron({
    mockMode: deps.mockMode,
    cuitEmisor,
    consultar: () =>
      deps.consultarPadron({
        cuit: cuitEmisor,
        emisor: {
          cuit: cuitEmisor,
          arca_key_enc: credencial.arca_key_enc,
          arca_cert_enc: credencial.arca_cert_enc,
        },
        ambiente: input.entrada.ambiente,
        admin: sb,
      }),
    registrarExito: (fecha) =>
      actualizar({
        padron_probado_at: fecha,
        padron_validacion_activa: true,
        padron_ultimo_error_codigo: null,
        padron_ultimo_error_at: null,
      }),
    registrarFallo: ({ codigo, fecha }) =>
      actualizar({
        padron_probado_at: null,
        padron_validacion_activa: false,
        padron_ultimo_error_codigo: codigo,
        padron_ultimo_error_at: fecha,
      }),
    ahora: deps.ahora,
  });
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
    factura_a_modalidad: "DESCONOCIDA" | "ESTANDAR_CONFIRMADA" | "NO_SOPORTADA";
    factura_a_confirmada_at: string | null;
    factura_a_confirmada_por: string | null;
    factura_a_revalidar_at: string | null;
    factura_a_evidencia: string | null;
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
  .handler(async ({ context }): Promise<ConfigFiscalPublica> => {
    const inicio = Date.now();
    try {
      const sb = await autorizarAntesDeClientePrivilegiado(
        () => exigirAdmin(context.supabase, context.userId),
        admin,
      );
      const [{ data: emisores, error: emisoresError }, { data: credenciales, error: credError }] =
        await Promise.all([
          sb
            .from("emisores")
            .select(
              "id,razon_social,nombre_fantasia,cuit,domicilio_fiscal,condicion_iva,ingresos_brutos,inicio_actividades,factura_a_modalidad,factura_a_confirmada_at,factura_a_confirmada_por,factura_a_revalidar_at,factura_a_evidencia,sucursales(id,nombre,telefono,punto_venta:puntos_venta!puntos_venta_sucursal_id_fkey(id,numero,modo,activo))",
            )
            .order("razon_social"),
          sb
            .from("credenciales_arca")
            .select(
              "emisor_id,ambiente,arca_key_enc,arca_cert_enc,cert_vence_at,cert_alias,probada_at,habilitada,padron_probado_at,padron_validacion_activa,padron_ultimo_error_codigo,padron_ultimo_error_at",
            ),
        ]);
      if (emisoresError) {
        throw new Error(`No se pudo cargar los emisores: ${emisoresError.message}`);
      }
      if (credError) throw new Error(`No se pudo cargar el estado de ARCA: ${credError.message}`);

      const resultado = {
        mock_mode: MOCK,
        emisores: (emisores ?? []).map((emisor) => {
          const condicion =
            emisor.condicion_iva === "RESPONSABLE_INSCRIPTO" ||
            emisor.condicion_iva === "MONOTRIBUTO"
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
              padron_probado_at: fila.padron_probado_at,
              padron_validacion_activa: fila.padron_validacion_activa,
              padron_ultimo_error_codigo: fila.padron_ultimo_error_codigo,
              padron_ultimo_error_at: fila.padron_ultimo_error_at,
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
            factura_a_modalidad:
              emisor.factura_a_modalidad as ConfigFiscalPublica["emisores"][number]["factura_a_modalidad"],
            factura_a_confirmada_at: emisor.factura_a_confirmada_at,
            factura_a_confirmada_por: emisor.factura_a_confirmada_por,
            factura_a_revalidar_at: emisor.factura_a_revalidar_at,
            factura_a_evidencia: emisor.factura_a_evidencia,
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
      } satisfies ConfigFiscalPublica;

      console.info("[FiscalConfig] configuración cargada", {
        emisores: resultado.emisores.length,
        credenciales: credenciales?.length ?? 0,
        duracion_ms: Date.now() - inicio,
      });
      return resultado;
    } catch (error) {
      console.error("[FiscalConfig] no se pudo cargar", {
        nombre: error instanceof Error ? error.name : typeof error,
        mensaje: error instanceof Error ? error.message : String(error),
        duracion_ms: Date.now() - inicio,
      });
      throw error;
    }
  });

/** Lectura que puede usar una pantalla operativa: no abre el cliente service-role. */
export const obtenerEstadoFiscalPublico = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => estadoFiscalPublicoMinimo(MOCK));

export const guardarPuntoVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    parsearEntradaFiscal(
      z.object({
        sucursal_id: z.string().uuid(),
        numero: z.number().int().positive(),
        modo: ambienteSchema,
        activo: z.boolean(),
      }),
      d,
      "CONFIGURACION",
    ),
  )
  .handler(async ({ data, context }) => {
    const sb = await autorizarAntesDeClientePrivilegiado(
      () => exigirAdmin(context.supabase, context.userId),
      admin,
    );

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
      const reset = actualizacionResetCredencialPorCambioPuntoVenta(
        anterior ? ambienteArca(anterior.modo) : undefined,
        data.modo,
      );
      const { error: resetError } = await sb
        .from("credenciales_arca")
        .update(reset.campos)
        .eq("emisor_id", sucursal.emisor_id)
        .in("ambiente", reset.ambientes);
      if (resetError) throw new Error(resetError.message);
    }

    return { ok: true };
  });

export const probarYActivarPadronArca = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    parsearEntradaFiscal(
      z.object({ emisor_id: z.string().uuid(), ambiente: ambienteSchema }).strict(),
      d,
      "CONFIGURACION",
    ),
  )
  .handler(async ({ data, context }) =>
    ejecutarPruebaPadronAdministrativa({
      entrada: data,
      userClient: context.supabase,
      userId: context.userId,
    }),
  );

export const generarCsr = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    parsearEntradaFiscal(
      z.object({ emisor_id: z.string().uuid(), ambiente: ambienteSchema }),
      d,
      "CONFIGURACION",
    ),
  )
  .handler(async ({ data, context }) => {
    const sb = await autorizarAntesDeClientePrivilegiado(
      () => exigirAdmin(context.supabase, context.userId),
      admin,
    );

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
    parsearEntradaFiscal(
      z.object({ emisor_id: z.string().uuid(), ambiente: ambienteSchema, pem: z.string().min(1) }),
      d,
      "CONFIGURACION",
    ),
  )
  .handler(async ({ data, context }) => {
    const sb = await autorizarAntesDeClientePrivilegiado(
      () => exigirAdmin(context.supabase, context.userId),
      admin,
    );

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
  .inputValidator((d: unknown) =>
    parsearEntradaFiscal(z.object({ sucursal_id: z.string().uuid() }).strict(), d, "CONFIGURACION"),
  )
  .handler(async ({ data, context }) => {
    const sb = await autorizarAntesDeClientePrivilegiado(
      () => exigirAdmin(context.supabase, context.userId),
      admin,
    );

    return probarConexionSegunModo(MOCK, async () => {
      const fiscal = await cargarContextoFiscal(sb, data.sucursal_id, { exigirHabilitada: false });
      const consultar = (cbteTipo: 6 | 1) =>
        ultimoAutorizado(fiscal.emisor, fiscal.pv, cbteTipo, sb);
      return probarAccesoSecuenciasFactura(consultar, async ({ probada_at }) => {
        const { error } = await sb
          .from("credenciales_arca")
          .update({ probada_at })
          .eq("emisor_id", fiscal.sucursal.emisor_id)
          .eq("ambiente", fiscal.pv.modo);
        if (error) throw new Error(error.message);
      });
    });
  });

export const guardarModalidadFacturaA = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    parsearEntradaFiscal(confirmacionModalidadFacturaASchema, d, "CONFIGURACION"),
  )
  .handler(async ({ data, context }) => {
    const sb = await autorizarAntesDeClientePrivilegiado(
      () => exigirAdmin(context.supabase, context.userId),
      admin,
    );
    const campos = actualizacionModalidadFacturaA(data, context.userId);
    const { data: actualizada, error } = await sb
      .from("emisores")
      .update(campos)
      .eq("id", data.emisor_id)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`No se pudo guardar la modalidad de Factura A: ${error.message}`);
    exigirEmisorActualizado(actualizada);
    return {
      ok: true,
      modalidad: campos.factura_a_modalidad,
      confirmada_at: campos.factura_a_confirmada_at,
      revalidar_at: campos.factura_a_revalidar_at,
    };
  });

export const guardarHabilitacionCredencial = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    parsearEntradaFiscal(
      z.object({
        emisor_id: z.string().uuid(),
        ambiente: ambienteSchema,
        habilitada: z.boolean(),
      }),
      d,
      "CONFIGURACION",
    ),
  )
  .handler(async ({ data, context }) => {
    const sb = await autorizarAntesDeClientePrivilegiado(
      () => exigirAdmin(context.supabase, context.userId),
      admin,
    );
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
