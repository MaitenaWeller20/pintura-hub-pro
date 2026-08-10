/**
 * Facturación electrónica: emisión, configuración y certificado.
 *
 * Todo corre en el servidor. El certificado y la clave privada no se exponen
 * jamás al navegador, y la tabla fiscal_config no tiene policies de RLS para
 * `authenticated` — se lee sólo con la service_role key desde acá.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  determinarLetra,
  cbteTipoAfip,
  letraDeCbteTipo,
  facturaDeLetra,
  puedeForzarConsumidorFinal,
  esComprobanteFiscal,
  esNotaInterna,
  docTipoAfip,
  docNroAfip,
  cuitValido,
  condicionIvaReceptorId,
  CONDICION_IVA_CLIENTE,
  type CondicionIva,
  type Letra,
} from "./fiscal/codigos";
import { calcularTotales } from "./fiscal/iva";
import {
  solicitarCae,
  ultimoAutorizado,
  consultarComprobante,
  esErrorTransitorio,
  MOCK,
} from "./fiscal/arca";
import { diasDesdeHoyAr, fueraDeVentanaAfip, VENTANA_AFIP_DIAS } from "./fiscal/fecha";
import {
  generarParYCsr,
  validarCuitEmisor,
  prepararSubject,
  verificarCertificado,
} from "./fiscal/cert";
import { encryptString, decryptString } from "./fiscal/crypto";
import { qrAfipDataUrl } from "./fiscal/qr";

// Ventana de gracia del claim anti doble-submit: si una emisión de la MISMA venta
// se reservó hace menos que esto, un segundo request no puede re-reservar (se
// considera "en curso"). Un reintento legítimo tras un timeout no depende de este
// grace: entra por el camino de recuperación (consulta el CAE ya reservado).
//
// DEBE ser > TIMEOUT_MS de la llamada a AFIP (25s): un intento lento-pero-vivo
// SIEMPRE termina (por éxito o por AfipTimeout a los 25s) antes de la gracia, y al
// terminar re-estampa updated_at (marcarPendiente / guardado del CAE). Así la rama
// `updated_at.lt` sólo se activa cuando el request original quedó realmente muerto
// (crash / serverless killed), no cuando todavía está esperando a AFIP.
const EMISION_GRACE_MS = 90_000;

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

async function requireAdmin(supabase: any, userId: string) {
  const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
  if (!isAdmin) throw new Error("Sólo un administrador puede tocar la configuración fiscal.");
}

// ============================================================
// Configuración fiscal
// ============================================================

export const obtenerConfigFiscal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const sb = await admin();
    const [{ data: cfg }, { data: pvs }] = await Promise.all([
      sb.from("fiscal_config").select("*").eq("id", true).maybeSingle(),
      sb.from("puntos_venta").select("*, sucursal:sucursales(nombre, codigo)").order("numero"),
    ]);

    const diasParaVencer = cfg?.cert_vence_at
      ? Math.floor((new Date(cfg.cert_vence_at).getTime() - Date.now()) / 86_400_000)
      : null;

    return {
      // Nunca mandamos arca_key_enc ni arca_cert_enc al navegador.
      cuit: cfg?.cuit ?? null,
      razon_social: cfg?.razon_social ?? null,
      nombre_fantasia: cfg?.nombre_fantasia ?? null,
      domicilio_fiscal: cfg?.domicilio_fiscal ?? null,
      condicion_iva: cfg?.condicion_iva ?? "RESPONSABLE_INSCRIPTO",
      inicio_actividades: cfg?.inicio_actividades ?? null,
      ingresos_brutos: cfg?.ingresos_brutos ?? null,
      habilitada: cfg?.habilitada ?? false,
      tiene_clave: !!cfg?.arca_key_enc,
      tiene_certificado: !!cfg?.arca_cert_enc,
      cert_vence_at: cfg?.cert_vence_at ?? null,
      dias_para_vencer: diasParaVencer,
      puntos_venta: pvs ?? [],
      mock_mode: MOCK,
    };
  });

export const guardarConfigFiscal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        cuit: z.string().min(1),
        razon_social: z.string().min(1),
        nombre_fantasia: z.string().optional().nullable(),
        domicilio_fiscal: z.string().optional().nullable(),
        // El EMISOR sólo puede ser RI o Monotributo: son las dos condiciones para
        // las que la matriz A/B/C está definida. Un sujeto exento no emite con IVA
        // discriminado. (El EXENTO sí es válido como condición del RECEPTOR.)
        condicion_iva: z.enum(["RESPONSABLE_INSCRIPTO", "MONOTRIBUTO"]),
        inicio_actividades: z.string().optional().nullable(),
        // Va impreso en el encabezado del comprobante. Texto libre porque admite
        // "Exento" o "Convenio Multilateral NNN-NNNNNN", no sólo un número.
        ingresos_brutos: z.string().optional().nullable(),
        habilitada: z.boolean().default(false),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const sb = await admin();
    await requireAdmin(context.supabase, context.userId);

    const cuit = validarCuitEmisor(data.cuit);

    // Con la facturación prendida, los datos que van IMPRESOS en el comprobante
    // dejan de ser opcionales: una factura sin Ingresos Brutos o sin domicilio
    // fiscal está incompleta, y el problema recién se ve cuando el comprobante ya
    // se emitió. Se pide acá, que es el único momento en que hay alguien mirando.
    if (data.habilitada) {
      const faltan = [
        !data.domicilio_fiscal?.trim() && "el domicilio fiscal",
        !data.ingresos_brutos?.trim() && "el número de Ingresos Brutos",
        !data.inicio_actividades && "la fecha de inicio de actividades",
      ].filter(Boolean) as string[];
      if (faltan.length) {
        throw new Error(
          `Para habilitar la facturación falta ${faltan.join(", ")}. ` +
            "Son datos que van impresos en cada comprobante; te los tiene que dar el contador.",
        );
      }
    }

    const { error } = await sb
      .from("fiscal_config")
      .update({ ...data, cuit })
      .eq("id", true);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const guardarPuntoVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        sucursal_id: z.string().uuid(),
        numero: z.number().int().positive(),
        modo: z.enum(["HOMOLOGACION", "PRODUCCION"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const sb = await admin();
    await requireAdmin(context.supabase, context.userId);

    const { error } = await sb.from("puntos_venta").upsert(data, { onConflict: "sucursal_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============================================================
// Certificado
// ============================================================

/**
 * Genera la clave privada + el CSR. El CSR se le da al contador para que lo suba
 * a AFIP; la clave privada queda cifrada acá y no sale nunca.
 */
export const generarCsr = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sb = await admin();
    await requireAdmin(context.supabase, context.userId);

    const { data: cfg } = await sb.from("fiscal_config").select("*").eq("id", true).maybeSingle();
    const cuit = validarCuitEmisor(cfg?.cuit);

    // Regenerar el CSR pisa la clave privada y deja huérfano al certificado que
    // ya estuviera cargado. Es el footgun silencioso de lubricentro: acá avisamos.
    if (cfg?.arca_cert_enc) {
      throw new Error(
        "Ya hay un certificado cargado. Generar un CSR nuevo invalida el actual y hay que rehacer el trámite en AFIP. " +
          "Si querés renovarlo igual, primero borrá el certificado.",
      );
    }

    const { org, cn } = prepararSubject(cfg?.razon_social ?? null, cfg?.nombre_fantasia ?? null);
    const { csr, keyPem } = await generarParYCsr(org, cn, cuit);

    const { error } = await sb
      .from("fiscal_config")
      .update({ arca_key_enc: encryptString(keyPem), cert_alias: cn })
      .eq("id", true);
    if (error) throw new Error(error.message);

    return { csr, alias: cn };
  });

export const guardarCertificado = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ pem: z.string().min(1) }).parse(d))
  .handler(async ({ data, context }) => {
    const sb = await admin();
    await requireAdmin(context.supabase, context.userId);

    const { data: cfg } = await sb
      .from("fiscal_config")
      .select("arca_key_enc")
      .eq("id", true)
      .maybeSingle();

    if (!cfg?.arca_key_enc) {
      throw new Error("Primero generá el CSR: todavía no hay clave privada asociada.");
    }

    const keyPem = decryptString(cfg.arca_key_enc);
    if (!keyPem) {
      throw new Error("No se pudo descifrar la clave privada. ¿Cambió ARCA_ENCRYPTION_KEY?");
    }

    // Falla cerrado: si el .crt no corresponde a nuestra clave, no se guarda.
    const { vence } = verificarCertificado(data.pem, keyPem);

    const { error } = await sb
      .from("fiscal_config")
      .update({ arca_cert_enc: encryptString(data.pem), cert_vence_at: vence.toISOString() })
      .eq("id", true);
    if (error) throw new Error(error.message);

    return { vence: vence.toISOString() };
  });

export const borrarCertificado = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sb = await admin();
    await requireAdmin(context.supabase, context.userId);
    await sb
      .from("fiscal_config")
      .update({ arca_cert_enc: null, arca_key_enc: null, cert_vence_at: null })
      .eq("id", true);
    return { ok: true };
  });

/** Prueba la conexión con AFIP consultando el último comprobante autorizado. */
export const probarConexionAfip = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ sucursal_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const sb = await admin();
    await requireAdmin(context.supabase, context.userId);

    if (MOCK) {
      return { ok: true, mock: true, ultimo: 0, mensaje: "Mock mode activo: no se llamó a AFIP." };
    }

    const { emisor, pv } = await cargarEmisorYPv(sb, data.sucursal_id);
    // Factura B (6) es el tipo más común; sirve como sonda.
    const ultimo = await ultimoAutorizado(emisor, pv, 6, sb);
    return {
      ok: true,
      mock: false,
      ultimo,
      mensaje: `AFIP respondió. Último comprobante tipo B autorizado en el PV ${pv.numero}: ${ultimo}.`,
    };
  });

// ============================================================
// Emisión
// ============================================================

async function cargarEmisorYPv(sb: any, sucursalId: string) {
  const [{ data: cfg }, { data: pv }] = await Promise.all([
    sb.from("fiscal_config").select("*").eq("id", true).maybeSingle(),
    sb.from("puntos_venta").select("*").eq("sucursal_id", sucursalId).maybeSingle(),
  ]);

  if (!cfg?.cuit) throw new Error("Falta configurar el CUIT del emisor.");
  if (!cfg.habilitada) throw new Error("La facturación electrónica está deshabilitada.");
  if (!pv) throw new Error("Esta sucursal no tiene punto de venta configurado.");
  if (!pv.activo) throw new Error("El punto de venta de esta sucursal está inactivo.");

  return {
    emisor: {
      cuit: cfg.cuit,
      arca_key_enc: cfg.arca_key_enc,
      arca_cert_enc: cfg.arca_cert_enc,
      condicion_iva: cfg.condicion_iva as CondicionIva,
    },
    // Lo que se imprime en el encabezado del comprobante. Va aparte del `emisor`
    // (que lleva los secretos) para no arrastrar el certificado a ningún lado.
    emisorImpreso: {
      razon_social: cfg.razon_social ?? null,
      nombre_fantasia: cfg.nombre_fantasia ?? null,
      cuit: cfg.cuit as string,
      domicilio_fiscal: cfg.domicilio_fiscal ?? null,
      condicion_iva: cfg.condicion_iva as CondicionIva,
      ingresos_brutos: cfg.ingresos_brutos ?? null,
      inicio_actividades: cfg.inicio_actividades ?? null,
    },
    pv: { numero: pv.numero as number, modo: pv.modo as "HOMOLOGACION" | "PRODUCCION" },
  };
}

/**
 * Emite un comprobante en AFIP y le pega el CAE.
 *
 * Los pasos delicados, en orden:
 *   1. Si el comprobante es interno (remito, factura interna), NO va a AFIP.
 *   2. Recuperación: si ya tiene número reservado pero no CAE, primero le
 *      preguntamos a AFIP si igual lo autorizó (puede haber sido un timeout).
 *   3. Guarda anti-duplicación: el último número de AFIP tiene que coincidir con
 *      el último que tenemos registrado. Si no, hay comprobantes huérfanos y
 *      emitir uno nuevo duplicaría la numeración fiscal.
 *   4. Los totales se recalculan desde los ítems guardados en la base, no desde
 *      lo que manda el navegador.
 */
export const emitirComprobante = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ venta_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const sb = await admin();
    const { supabase } = context;

    // Leemos la venta con el cliente RLS: si el usuario no puede ver esta venta
    // (otra sucursal), no puede facturarla.
    const { data: venta, error: vErr } = await supabase
      .from("ventas")
      .select("*, cliente:clientes(razon_social, cuit_dni, tipo, direccion)")
      .eq("id", data.venta_id)
      .single();
    if (vErr || !venta) throw new Error("Venta no encontrada.");

    if (!esComprobanteFiscal(venta.tipo_comprobante)) {
      throw new Error(
        `${venta.tipo_comprobante} es un documento interno: no se manda a AFIP. ` +
          "Sólo se facturan Factura A/B/C y notas de crédito/débito.",
      );
    }
    if (esNotaInterna(venta.tipo_comprobante, venta.afip_cbte_asoc_id)) {
      throw new Error(
        "Esta nota revierte un comprobante que nunca se declaró a AFIP, así que no hay nada que rectificar: " +
          "no corresponde emitirla. Sirve sólo como documento interno (ya devolvió el stock y la plata).",
      );
    }
    if (venta.estado === "ANULADA") throw new Error("La venta está anulada.");
    if (venta.cae) throw new Error(`Este comprobante ya tiene CAE (${venta.cae}).`);

    // --- Ventana de fechas de AFIP -----------------------------------------
    // WSFEv1 rechaza un CbteFch a más de 5 días corridos de hoy (Concepto=1).
    // Se corta ACÁ, antes de consultar el último autorizado y antes de reservar
    // número: ir a AFIP para que lo rechace quema un viaje y deja la venta en
    // ERROR sin que el motivo se entienda.
    //
    // NO se aplica en mock: ahí no hay AFIP que rechace nada, y el sistema se usa
    // hoy para facturar ventas viejas mientras el trámite del certificado avanza.
    // Imponerla en modo simulado sería romper el uso actual sin ganar nada.
    const diasDeAtraso = diasDesdeHoyAr(new Date(venta.fecha));
    if (!MOCK && fueraDeVentanaAfip(new Date(venta.fecha))) {
      throw new Error(
        diasDeAtraso > 0
          ? `Esta venta es de hace ${diasDeAtraso} días y AFIP sólo autoriza comprobantes fechados hasta ${VENTANA_AFIP_DIAS} días atrás. ` +
              "Ya no se puede emitir con su fecha original: consultá con el contador cómo regularizarla."
          : `Esta venta está fechada ${Math.abs(diasDeAtraso)} días en el futuro y AFIP sólo autoriza hasta ${VENTANA_AFIP_DIAS} días adelante. ` +
              "Revisá la fecha de la venta.",
      );
    }

    const { emisor, emisorImpreso, pv } = await cargarEmisorYPv(sb, venta.sucursal_id);

    // --- Letra y tipo -------------------------------------------------------
    const condReceptor: CondicionIva | null = venta.cliente?.tipo
      ? (CONDICION_IVA_CLIENTE[venta.cliente.tipo] ?? "CONSUMIDOR_FINAL")
      : null;

    let letra: Letra;
    let cbtesAsoc: Array<{ tipo: number; ptoVta: number; nro: number }> | undefined;

    if (venta.tipo_comprobante === "NOTA_CREDITO" || venta.tipo_comprobante === "NOTA_DEBITO") {
      // Una nota hereda la letra del comprobante que rectifica, y tiene que
      // referenciarlo (CbtesAsoc) o AFIP la rechaza.
      const { data: orig } = await supabase
        .from("ventas")
        .select("tipo_comprobante, afip_cbte_tipo, afip_punto_venta, afip_numero, cae")
        .eq("id", venta.afip_cbte_asoc_id ?? "")
        .maybeSingle();

      if (!orig?.cae) {
        throw new Error(
          "La nota de crédito/débito tiene que estar asociada a un comprobante que ya tenga CAE.",
        );
      }
      // La letra de la NC sale del comprobante REALMENTE emitido (afip_cbte_tipo),
      // no del tipo_comprobante tipeado: una venta FACTURA_A emitida como B (por
      // el forzado a Consumidor Final) tiene cbte 6, y su NC debe salir B.
      letra = letraDeCbteTipo(orig.afip_cbte_tipo);
      cbtesAsoc = [
        { tipo: orig.afip_cbte_tipo!, ptoVta: orig.afip_punto_venta!, nro: orig.afip_numero! },
      ];
    } else {
      // Un RI que le vende a un RI factura A por defecto, pero puede elegir emitir
      // B (Consumidor Final) tipeando la venta como FACTURA_B. Server-authoritative:
      // sólo se permite el downgrade A→B cuando emisor y receptor son RI.
      const condEfectiva =
        venta.tipo_comprobante === "FACTURA_B" &&
        puedeForzarConsumidorFinal(emisor.condicion_iva, condReceptor)
          ? "CONSUMIDOR_FINAL"
          : condReceptor;
      letra = determinarLetra(emisor.condicion_iva, condEfectiva);
    }

    const cuitCliente = venta.cliente?.cuit_dni ?? null;

    // La condición del receptor que se DECLARA a AFIP (RG 5616) tiene que ser
    // coherente con la letra emitida: si salió B pero el cliente es RI, es porque
    // se emitió como Consumidor Final (forzado, o NC de una factura forzada), y el
    // CondicionIVAReceptorId debe ser 5, no 1 — si no, AFIP rechaza (10016).
    const condReceptorEfectiva: CondicionIva | null =
      letra === "B" && condReceptor === "RESPONSABLE_INSCRIPTO" ? "CONSUMIDOR_FINAL" : condReceptor;

    // Factura A exige DocTipo 80 = CUIT VÁLIDO (con dígito verificador). Un CUIT
    // de 11 dígitos con verificador mal (o un CUIL cargado como CUIT) pasaba el
    // chequeo de longitud y AFIP lo rechazaba con un 10013/10016 críptico,
    // quemando un viaje y dejando un número reservado. Se valida acá, antes de ir
    // a AFIP, con un mensaje accionable que ofrece la salida por Factura B.
    if (letra === "A" && (docTipoAfip(cuitCliente) !== 80 || !cuitValido(cuitCliente))) {
      throw new Error(
        "Para Factura A el cliente necesita un CUIT válido. Corregí el CUIT en la ficha del cliente, " +
          "o cambiá su condición de IVA a Consumidor Final para emitir Factura B.",
      );
    }

    const cbteTipo = cbteTipoAfip(venta.tipo_comprobante, letra);

    // --- Totales, recalculados desde la base --------------------------------
    const { data: items } = await supabase
      .from("venta_items")
      .select(
        "codigo, descripcion, cantidad, precio_unitario_sin_iva, descuento_porcentaje, iva_porcentaje, subtotal_con_iva",
      )
      .eq("venta_id", venta.id);

    const totales = calcularTotales(
      (items ?? []).map((i: any) => ({
        cantidad: Math.abs(Number(i.cantidad)),
        precio_unitario_sin_iva: Math.abs(Number(i.precio_unitario_sin_iva)),
        descuento_porcentaje: Number(i.descuento_porcentaje ?? 0),
        iva_porcentaje: Number(i.iva_porcentaje),
      })),
      Math.abs(Number(venta.percepciones ?? 0)),
    );

    // --- Snapshot fiscal ----------------------------------------------------
    // Congela lo que se le declara a AFIP. De acá en más el PDF y el QR se arman
    // SIEMPRE con esta copia, nunca releyendo clientes/fiscal_config: si mañana se
    // corrige el CUIT del cliente o el domicilio del emisor, el comprobante ya
    // emitido tiene que seguir imprimiéndose igual que el que se entregó.
    const snapshot = {
      emisor: emisorImpreso,
      receptor: {
        razon_social: venta.cliente?.razon_social ?? null,
        cuit_dni: cuitCliente,
        doc_tipo: docTipoAfip(cuitCliente),
        doc_nro: docNroAfip(cuitCliente),
        // La condición REALMENTE declarada, que puede no ser la de la ficha:
        // un RI al que se le emite B va como Consumidor Final.
        condicion_iva: condReceptorEfectiva,
        domicilio: venta.cliente?.direccion ?? null,
      },
      condicion_venta: venta.condicion_venta ?? null,
      totales,
      // La fecha que se le declara a AFIP. El QR se arma con ESTA, no con
      // venta.fecha en vivo: si la fecha de la venta cambiara después, el QR
      // dejaría de coincidir con lo que AFIP tiene registrado.
      fecha: new Date(venta.fecha).toISOString(),
      // Las líneas tal como se declararon. Sin esto una reimpresión sale del
      // venta_items actual, que puede no ser el que se facturó.
      lineas: (items ?? []).map((i: any) => ({
        codigo: i.codigo,
        descripcion: i.descripcion,
        cantidad: Math.abs(Number(i.cantidad)),
        precio_unitario_sin_iva: Math.abs(Number(i.precio_unitario_sin_iva)),
        descuento_porcentaje: Number(i.descuento_porcentaje ?? 0),
        iva_porcentaje: Number(i.iva_porcentaje),
        subtotal_con_iva: Math.abs(Number(i.subtotal_con_iva ?? 0)),
      })),
      version: 1,
    };

    // --- Recuperación de un intento anterior --------------------------------
    // Si hay un número reservado, la identidad de esa reserva (punto de venta,
    // tipo y modo) manda: es lo que AFIP pudo haber autorizado.
    if (venta.afip_numero) {
      const mismaIdentidad =
        venta.afip_punto_venta === pv.numero &&
        venta.afip_cbte_tipo === cbteTipo &&
        venta.afip_modo === pv.modo;

      // La identidad cambió entre el intento fallido y este reintento: cambió la
      // condición de IVA del cliente (y con ella la letra), o el punto de venta
      // pasó de homologación a producción. Seguir de largo emitiría un comprobante
      // NUEVO mientras el reservado puede estar autorizado en AFIP sin registro
      // local: dos comprobantes fiscales por una sola venta. Se frena.
      if (!mismaIdentidad) {
        throw new Error(
          `Este comprobante tiene reservado el número ${venta.afip_numero} (punto de venta ` +
            `${venta.afip_punto_venta}, tipo ${venta.afip_cbte_tipo}, ${venta.afip_modo}), pero ahora ` +
            "correspondería emitir uno distinto. Puede haber quedado un comprobante autorizado en AFIP " +
            "sin registrar acá. No se emite para no duplicar: hay que reconciliar la numeración antes de seguir.",
        );
      }

      try {
        const recuperado = await consultarComprobante(emisor, pv, cbteTipo, venta.afip_numero, sb);
        if (recuperado) {
          // AFIP sí lo había autorizado: el timeout nos mintió. Guardamos el CAE
          // en vez de emitir de nuevo (que duplicaría el comprobante).
          await sb
            .from("ventas")
            .update({
              cae: recuperado.cae,
              cae_vencimiento: recuperado.vencimiento?.toISOString().slice(0, 10) ?? null,
              afip_estado: "APROBADO",
              afip_error: null,
              afip_emitido_at: new Date().toISOString(),
              // OJO: acá NO se pisa el snapshot. El CAE que se está recuperando es
              // de un intento ANTERIOR, así que lo que vale es lo que se declaró
              // entonces (guardado al reservar), no lo que se recalculó recién.
              // `snapshot` sólo entra si la reserva es vieja y no tiene ninguno.
              ...(venta.afip_snapshot
                ? {}
                : { afip_snapshot: snapshot, afip_imp_total: totales.total }),
              // Si la letra emitida difiere del tipo tipeado, reescribe tipo/numero interno.
              ...(await camposReescrituraLetra(sb, venta, cbteTipo)),
            })
            .eq("id", venta.id);
          return {
            cae: recuperado.cae,
            numero: venta.afip_numero,
            recuperado: true,
            modo: pv.modo,
          };
        }
      } catch (e) {
        if (esErrorTransitorio(e)) {
          await marcarPendiente(sb, venta.id, (e as Error).message);
          throw new Error(
            "AFIP no responde. El comprobante quedó pendiente: reintentá en unos minutos.",
          );
        }
        throw e;
      }
    }

    // --- Guarda anti-duplicación --------------------------------------------
    let numero: number;
    try {
      const ultimoAfip = await ultimoAutorizado(emisor, pv, cbteTipo, sb);

      // El "último local" se cuenta sobre comprobantes AUTORIZADOS (con CAE), no
      // sobre números meramente reservados. Si contáramos las reservas, un rechazo
      // de AFIP dejaría un número reservado sin CAE que después no coincidiría con
      // el contador de AFIP y trabaría la numeración para siempre.
      //
      // Y se cuenta SÓLO dentro del mismo espacio de numeración: los CAE simulados
      // (mock) y los reales son dos mundos separados. Sin el filtro por
      // afip_simulado, apagar el mock con el punto de venta todavía en
      // HOMOLOGACION traía los comprobantes de mentira al conteo, la guarda de
      // abajo veía "AFIP: 0, acá: 20" y se negaba a emitir para siempre.
      const { data: ultimoLocalRow } = await sb
        .from("ventas")
        .select("afip_numero")
        .eq("afip_punto_venta", pv.numero)
        .eq("afip_cbte_tipo", cbteTipo)
        .eq("afip_modo", pv.modo)
        .eq("afip_simulado", MOCK)
        .not("cae", "is", null)
        .order("afip_numero", { ascending: false })
        .limit(1)
        .maybeSingle();

      const ultimoLocal = Number(ultimoLocalRow?.afip_numero ?? 0);

      if (!MOCK && ultimoAfip !== ultimoLocal) {
        throw new Error(
          ultimoAfip > ultimoLocal
            ? `AFIP tiene autorizado el comprobante ${ultimoAfip} pero acá el último registrado es el ${ultimoLocal}. ` +
                "Hay comprobantes autorizados en AFIP sin registro local: NO se emite para no duplicar la numeración fiscal. " +
                "Hay que reconciliar primero."
            : `Acá figura el comprobante ${ultimoLocal} pero AFIP sólo reconoce hasta el ${ultimoAfip}. ` +
                "Suele ser un comprobante de prueba (homologación) mezclado con producción.",
        );
      }

      // En PRODUCCIÓN el número lo dicta AFIP (ultimoAfip, ya validado == ultimoLocal
      // por la guarda de arriba). En MOCK no hay AFIP: ultimoAutorizado() devuelve 0
      // fijo, así que ultimoAfip+1 daría SIEMPRE 1 y la 2da emisión de cada
      // (PV,tipo,modo) chocaría con el índice único uq_ventas_afip_numeracion. En MOCK
      // numeramos desde el último LOCAL (mayor afip_numero ya autorizado con CAE).
      numero = (MOCK ? ultimoLocal : ultimoAfip) + 1;
    } catch (e) {
      if (esErrorTransitorio(e)) {
        await marcarPendiente(sb, venta.id, (e as Error).message);
        throw new Error(
          "AFIP no responde. El comprobante quedó pendiente: reintentá en unos minutos.",
        );
      }
      throw e;
    }

    // Reservamos el número ANTES de llamar a AFIP: si la llamada se va por
    // timeout, el reintento sabe qué número consultar en vez de emitir otro.
    // El índice único uq_ventas_afip_numeracion impide que dos VENTAS DISTINTAS
    // tomen el mismo número. Pero NO frena el doble-submit de la MISMA venta
    // (doble click / retry): al ser la misma fila, ambos updates tendrían éxito y
    // ambos llamarían a AFIP → comprobante duplicado. Por eso la reserva es un
    // CLAIM ATÓMICO con dos condiciones (AND):
    //   1. `cae IS NULL`: nunca re-reservar una venta YA autorizada. Sin esto, si
    //      un request concurrente terminó (APROBADO+CAE) mientras otro estaba en la
    //      consulta de recuperación, el segundo pasaría `afip_estado.neq.PENDIENTE`
    //      (APROBADO ≠ PENDIENTE) y emitiría un comprobante DUPLICADO.
    //   2. no hay emisión en curso reciente: `afip_estado.neq.PENDIENTE` OR el
    //      PENDIENTE ya venció la gracia (request muerto).
    // El segundo request, tras el lock de fila, re-evalúa el WHERE contra la fila
    // ya reservada/aprobada, no matchea, y afecta 0 filas.
    const graceThreshold = new Date(Date.now() - EMISION_GRACE_MS).toISOString();
    const { data: reservada, error: reservaErr } = await sb
      .from("ventas")
      .update({
        afip_cbte_tipo: cbteTipo,
        afip_punto_venta: pv.numero,
        afip_numero: numero,
        afip_modo: pv.modo,
        afip_estado: "PENDIENTE",
        afip_intentos: (venta.afip_intentos ?? 0) + 1,
        // La marca va en la RESERVA, no al guardar el CAE: el índice único
        // uq_ventas_afip_numeracion incluye afip_simulado, así que una reserva sin
        // marcar vive en el espacio de numeración real aunque sea de mock, y puede
        // chocar con un número real durante el corte de un modo al otro.
        afip_simulado: MOCK,
        // El snapshot se congela ACÁ, junto con el número, porque a partir de este
        // momento el comprobante ya tiene identidad fiscal. Si la llamada se corta
        // por timeout y el reintento recupera el CAE, lo que vale es lo que se
        // declaró en ESTE intento, no lo que se recalcule después.
        afip_snapshot: snapshot,
        afip_imp_total: totales.total,
      })
      .eq("id", venta.id)
      .is("cae", null)
      .or(`afip_estado.neq.PENDIENTE,updated_at.lt.${graceThreshold}`)
      .select("id");

    if (reservaErr) {
      throw new Error(
        "Otro comprobante tomó ese número de AFIP en este instante. Reintentá la emisión.",
      );
    }
    if (!reservada || reservada.length === 0) {
      // El claim no afectó filas: hay otra emisión de ESTA misma venta en curso.
      // El reintento legítimo tras un timeout NO cae acá: entra por el camino de
      // recuperación (la venta ya tiene afip_numero) que consulta el CAE en AFIP.
      throw new Error(
        "Ya hay una emisión en curso para este comprobante. Esperá unos segundos y reintentá.",
      );
    }

    // --- CAE ----------------------------------------------------------------
    try {
      const r = await solicitarCae(
        emisor,
        pv,
        {
          cbteTipo,
          numero,
          fecha: new Date(venta.fecha),
          docTipo: docTipoAfip(cuitCliente),
          docNro: docNroAfip(cuitCliente),
          neto: totales.neto,
          iva: totales.iva,
          tributos: totales.tributos,
          total: totales.total,
          condicionIvaReceptorId: condicionIvaReceptorId(condReceptorEfectiva),
          alicuotas: totales.alicuotas,
          comprobantesAsociados: cbtesAsoc,
        },
        sb,
      );

      await sb
        .from("ventas")
        .update({
          cae: r.cae,
          cae_vencimiento: r.vencimiento?.toISOString().slice(0, 10) ?? null,
          afip_estado: "APROBADO",
          afip_error: null,
          afip_emitido_at: new Date().toISOString(),
          // afip_simulado, afip_snapshot y afip_imp_total ya quedaron estampados en
          // la reserva, con los datos de este mismo intento. No se reescriben.
          // Si la letra emitida difiere del tipo tipeado, reescribe tipo/numero interno.
          ...(await camposReescrituraLetra(sb, venta, cbteTipo)),
        })
        .eq("id", venta.id);

      return { cae: r.cae, numero, recuperado: false, modo: pv.modo };
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[AFIP] falló la emisión:", {
        venta: venta.id,
        pv: pv.numero,
        cbteTipo,
        numero,
        modo: pv.modo,
        error: msg,
      });

      if (esErrorTransitorio(e)) {
        // Queda PENDIENTE con el número reservado. AFIP pudo haberlo autorizado
        // igual, así que el reintento primero consulta antes de re-emitir.
        await marcarPendiente(sb, venta.id, msg);
        throw new Error(
          "AFIP no responde. El comprobante quedó pendiente: reintentá en unos minutos.",
        );
      }

      // Rechazo de negocio: AFIP NO autorizó el número, así que hay que LIBERARLO.
      // Si no, ese número reservado sin CAE desincroniza el contador local del de
      // AFIP y traba la numeración para siempre.
      await sb
        .from("ventas")
        .update({ afip_estado: "ERROR", afip_error: msg, afip_numero: null })
        .eq("id", venta.id);
      throw e;
    }
  });

/**
 * Si la letra REALMENTE emitida (derivada del CbteTipo de AFIP) difiere del
 * tipo_comprobante TIPEADO, devuelve los campos para reescribir tipo_comprobante y
 * numero_comprobante (número interno) a la letra correcta. Ej: se tipeó FACTURA_A a
 * un consumidor final; AFIP autoriza B (cbte 6) → se reescribe a FACTURA_B con un
 * número FVTA fresco. Sólo aplica a facturas: el enum no distingue letra en NC/ND.
 * Escribe con el cliente admin (service_role), que el trigger guard_ventas_columnas
 * deja pasar. Si no puede sacar número nuevo, NO frena la emisión (el CAE ya está):
 * deja el tipo/numero originales y loguea.
 */
async function camposReescrituraLetra(sb: any, venta: any, cbteTipo: number) {
  const esFactura =
    venta.tipo_comprobante === "FACTURA_A" ||
    venta.tipo_comprobante === "FACTURA_B" ||
    venta.tipo_comprobante === "FACTURA_C";
  if (!esFactura) return {};
  const tipoEmitido = facturaDeLetra(letraDeCbteTipo(cbteTipo));
  if (tipoEmitido === venta.tipo_comprobante) return {};
  const { data: nuevoNumero, error } = await sb.rpc("next_comprobante_numero", {
    _sucursal_id: venta.sucursal_id,
    _tipo: tipoEmitido,
  });
  if (error || !nuevoNumero) {
    console.error("[AFIP] no se pudo reescribir tipo/numero a la letra emitida:", error?.message);
    return {};
  }
  return { tipo_comprobante: tipoEmitido, numero_comprobante: nuevoNumero };
}

async function marcarPendiente(sb: any, ventaId: string, error: string) {
  await sb.from("ventas").update({ afip_estado: "PENDIENTE", afip_error: error }).eq("id", ventaId);
}

/** Datos del comprobante fiscal para imprimir (incluye el QR de AFIP). */
export const datosFiscalesComprobante = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ venta_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const sb = await admin();
    const { data: venta } = await context.supabase
      .from("ventas")
      .select("*, cliente:clientes(razon_social, cuit_dni, tipo, direccion)")
      .eq("id", data.venta_id)
      .single();

    // Un comprobante con CAE siempre tiene asignados punto de venta, tipo y
    // número: los reservamos antes de llamar a AFIP. Si falta alguno, el dato
    // está inconsistente y no armamos un QR inválido.
    if (
      !venta?.cae ||
      venta.afip_punto_venta == null ||
      venta.afip_cbte_tipo == null ||
      venta.afip_numero == null
    ) {
      return null;
    }

    // La fuente de verdad es el snapshot tomado al emitir. Los comprobantes
    // anteriores a esa columna no lo tienen: para esos se reconstruye con los
    // datos de hoy (lo mejor disponible) y se avisa con `sin_snapshot`, porque
    // pueden haber cambiado desde que se emitieron.
    const snap = venta.afip_snapshot as any | null;

    let emisor = snap?.emisor ?? null;
    if (!emisor) {
      const { data: cfg } = await sb
        .from("fiscal_config")
        .select(
          "cuit, razon_social, nombre_fantasia, domicilio_fiscal, condicion_iva, ingresos_brutos, inicio_actividades",
        )
        .eq("id", true)
        .maybeSingle();
      emisor = cfg ?? null;
    }

    const receptor = snap?.receptor ?? {
      razon_social: venta.cliente?.razon_social ?? null,
      cuit_dni: venta.cliente?.cuit_dni ?? null,
      doc_tipo: docTipoAfip(venta.cliente?.cuit_dni ?? null),
      doc_nro: docNroAfip(venta.cliente?.cuit_dni ?? null),
      condicion_iva: venta.cliente?.tipo
        ? (CONDICION_IVA_CLIENTE[venta.cliente.tipo] ?? "CONSUMIDOR_FINAL")
        : null,
      domicilio: venta.cliente?.direccion ?? null,
    };

    const importe = Math.abs(Number(snap?.totales?.total ?? venta.afip_imp_total ?? venta.total));

    const qr = await qrAfipDataUrl({
      // La fecha CONGELADA, que es la que se le declaró. venta.fecha sólo entra
      // en comprobantes viejos sin snapshot.
      fecha: new Date(snap?.fecha ?? venta.fecha),
      cuit: Number(String(emisor?.cuit ?? "").replace(/\D/g, "")),
      ptoVta: venta.afip_punto_venta,
      tipoCmp: venta.afip_cbte_tipo,
      nroCmp: venta.afip_numero,
      importe,
      // Del snapshot: el documento que se le declaró a AFIP, no el que tenga
      // hoy la ficha del cliente (se puede haber corregido después).
      tipoDocRec: receptor.doc_tipo,
      nroDocRec: receptor.doc_nro,
      codAut: venta.cae,
    });

    return {
      emisor,
      receptor,
      condicion_venta: snap?.condicion_venta ?? venta.condicion_venta ?? null,
      totales: snap?.totales ?? null,
      // Las líneas tal como se declararon. El PDF las prefiere sobre venta_items.
      lineas: snap?.lineas ?? null,
      fecha: snap?.fecha ?? null,
      cae: venta.cae,
      cae_vencimiento: venta.cae_vencimiento,
      punto_venta: venta.afip_punto_venta,
      numero: venta.afip_numero,
      cbte_tipo: venta.afip_cbte_tipo,
      modo: venta.afip_modo,
      simulado: !!venta.afip_simulado,
      sin_snapshot: !snap,
      qr,
    };
  });
