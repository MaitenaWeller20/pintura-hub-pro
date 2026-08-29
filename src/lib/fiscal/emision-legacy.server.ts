/* eslint-disable @typescript-eslint/no-explicit-any -- extracción mecánica temporal del writer legacy; Task 14 lo elimina */

/**
 * Facturación electrónica: emisión, configuración y certificado.
 *
 * Todo corre en el servidor. El certificado y la clave privada no se exponen
 * jamás al navegador, y `credenciales_arca` no tiene policies ni grants para
 * `authenticated`: sólo se lee con la service role desde el backend.
 */
import {
  determinarLetra,
  cbteTipoAfip,
  letraDeCbteTipo,
  facturaDeLetra,
  esComprobanteFiscal,
  esNotaInterna,
  docTipoAfip,
  docNroAfip,
  cuitValido,
  condicionIvaReceptorId,
  CONDICION_IVA_CLIENTE,
  type CondicionIva,
  type Letra,
} from "./codigos";
import { calcularTotales } from "./iva";
import {
  solicitarCae,
  ultimoAutorizado,
  consultarComprobante,
  esErrorTransitorio,
  MOCK,
} from "./arca";
import { diasDesdeHoyAr, fueraDeVentanaAfip, VENTANA_AFIP_DIAS } from "./fecha";
import { camposEvidenciaFiscalLegacy } from "./legacy-compat";
import { qrAfipDataUrl } from "./qr";
import { cargarContextoFiscal } from "./contexto.server";
import {
  crearSnapshotFiscal,
  identidadReservaCoincide,
  resolverReceptorFiscalLegacy,
  type ReceptorDeclaradoLegacy,
} from "./snapshot";
import { COLUMNAS_VENTA_SEGURAS } from "../ventas-proyeccion";

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

class ErrorPersistenciaCaeLegacy extends Error {
  readonly name = "ErrorPersistenciaCaeLegacy";
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

// ============================================================
// Emisión
// ============================================================

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
export async function emitirComprobanteLegacy({
  data,
  context,
}: {
  data: { venta_id: string };
  context: { supabase: any };
}) {
  const sb = await admin();
  const { supabase } = context;

  // Leemos la venta con el cliente RLS: si el usuario no puede ver esta venta
  // (otra sucursal), no puede facturarla.
  const { data: venta, error: vErr } = await supabase
    .from("ventas")
    .select(`${COLUMNAS_VENTA_SEGURAS}, cliente:clientes(razon_social, cuit_dni, tipo, direccion)`)
    .eq("id", data.venta_id)
    .single();
  if (vErr || !venta) throw new Error("Venta no encontrada.");

  if (!esComprobanteFiscal(venta.tipo_comprobante)) {
    throw new Error(
      `${venta.tipo_comprobante} es un documento interno: no se manda a AFIP. ` +
        "Sólo se facturan Factura A/B/C y notas de crédito/débito.",
    );
  }
  if (
    esNotaInterna(
      venta.tipo_comprobante,
      venta.afip_cbte_asoc_id,
      venta.periodo_asoc_desde,
      venta.periodo_asoc_hasta,
    )
  ) {
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

  const { emisor, emisorImpreso, pv } = await cargarContextoFiscal(sb, venta.sucursal_id);

  // --- Letra y tipo -------------------------------------------------------
  // Compatibilidad legacy: la ausencia de cliente representa explícitamente al
  // consumidor final anónimo. El camino v2 recibe un receptor confirmado.
  const condReceptor: CondicionIva = venta.cliente?.tipo
    ? (CONDICION_IVA_CLIENTE[venta.cliente.tipo] ?? "CONSUMIDOR_FINAL")
    : "CONSUMIDOR_FINAL";
  const cuitCliente = venta.cliente?.cuit_dni ?? null;
  const receptorVivo: ReceptorDeclaradoLegacy = {
    razon_social: venta.cliente?.razon_social ?? null,
    cuit_dni: cuitCliente,
    doc_tipo: docTipoAfip(cuitCliente),
    doc_nro: docNroAfip(cuitCliente),
    condicion_iva: condReceptor,
    domicilio: venta.cliente?.direccion ?? null,
  };

  let letra: Letra;
  let cbtesAsoc: Array<{ tipo: number; ptoVta: number; nro: number }> | undefined;
  let snapshotOriginal: unknown | null = null;

  if (venta.tipo_comprobante === "NOTA_CREDITO" || venta.tipo_comprobante === "NOTA_DEBITO") {
    // Una nota hereda la letra del comprobante que rectifica, y tiene que
    // referenciarlo (CbtesAsoc) o AFIP la rechaza.
    const { data: orig } = await supabase
      .from("ventas")
      .select(
        "tipo_comprobante, afip_emisor_cuit, afip_cbte_tipo, afip_punto_venta, afip_numero, cae, afip_snapshot",
      )
      .eq("id", venta.afip_cbte_asoc_id ?? "")
      .maybeSingle();

    if (!orig?.cae) {
      throw new Error(
        "La nota de crédito/débito tiene que estar asociada a un comprobante que ya tenga CAE.",
      );
    }
    if (orig.afip_emisor_cuit !== emisor.cuit) {
      throw new Error("La nota no puede asociarse a un comprobante emitido por otro CUIT.");
    }
    // Letra y receptor salen del comprobante REALMENTE emitido. Si existe
    // snapshot v1 no se relee la identidad viva para reconstruir la nota.
    letra = letraDeCbteTipo(orig.afip_cbte_tipo);
    snapshotOriginal = orig.afip_snapshot;
    cbtesAsoc = [
      { tipo: orig.afip_cbte_tipo!, ptoVta: orig.afip_punto_venta!, nro: orig.afip_numero! },
    ];
  } else {
    // La letra se deriva sólo de la condición real; el tipo comercial no puede
    // forzar un downgrade de A a B.
    letra = determinarLetra(emisor.condicion_iva, condReceptor);
  }

  const receptorEfectivo = resolverReceptorFiscalLegacy({
    tipoComprobante: venta.tipo_comprobante,
    letra,
    receptorVivo,
    snapshotOriginal,
  });

  // Factura A exige DocTipo 80 = CUIT VÁLIDO (con dígito verificador). Un CUIT
  // de 11 dígitos con verificador mal (o un CUIL cargado como CUIT) pasaba el
  // chequeo de longitud y AFIP lo rechazaba con un 10013/10016 críptico,
  // quemando un viaje y dejando un número reservado. Se valida acá, antes de ir
  // a AFIP, sin ofrecer un downgrade fiscal.
  if (
    letra === "A" &&
    (receptorEfectivo.doc_tipo !== 80 || !cuitValido(receptorEfectivo.cuit_dni))
  ) {
    throw new Error(
      "Para Factura A el receptor necesita un CUIT válido. Corregí su identidad fiscal antes de emitir.",
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
  // SIEMPRE con esta copia, nunca releyendo clientes/emisores: si mañana se
  // corrige el CUIT del cliente o el domicilio del emisor, el comprobante ya
  // emitido tiene que seguir imprimiéndose igual que el que se entregó.
  const snapshot = crearSnapshotFiscal({
    emisor: emisorImpreso,
    receptor: receptorEfectivo,
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
  });
  const evidenciaLegacy = camposEvidenciaFiscalLegacy({
    modo: pv.modo,
    simulado: MOCK,
    fecha: snapshot.fecha,
  });

  // --- Recuperación de un intento anterior --------------------------------
  // Si hay un número reservado, la identidad de esa reserva (punto de venta,
  // tipo y modo) manda: es lo que AFIP pudo haber autorizado.
  if (venta.afip_numero) {
    const mismaIdentidad = identidadReservaCoincide(
      {
        cuit: venta.afip_emisor_cuit,
        punto_venta: venta.afip_punto_venta,
        cbte_tipo: venta.afip_cbte_tipo,
        ambiente: venta.afip_modo,
      },
      {
        cuit: emisor.cuit,
        punto_venta: pv.numero,
        cbte_tipo: cbteTipo,
        ambiente: pv.modo,
      },
    );

    // La identidad cambió entre el intento fallido y este reintento: cambió la
    // condición de IVA del cliente (y con ella la letra), o el punto de venta
    // pasó de homologación a producción. Seguir de largo emitiría un comprobante
    // NUEVO mientras el reservado puede estar autorizado en AFIP sin registro
    // local: dos comprobantes fiscales por una sola venta. Se frena.
    if (!mismaIdentidad) {
      throw new Error(
        `Este comprobante tiene reservado el número ${venta.afip_numero} (punto de venta ` +
          `${venta.afip_punto_venta}, tipo ${venta.afip_cbte_tipo}, ${venta.afip_modo}, CUIT ` +
          `${venta.afip_emisor_cuit ?? "sin registrar"}), pero ahora ` +
          "correspondería emitir uno distinto. Puede haber quedado un comprobante autorizado en AFIP " +
          "sin registrar acá. No se emite para no duplicar: hay que reconciliar la numeración antes de seguir.",
      );
    }

    try {
      const recuperado = await consultarComprobante(emisor, pv, cbteTipo, venta.afip_numero, sb);
      if (recuperado) {
        // AFIP sí lo había autorizado: el timeout nos mintió. Guardamos el CAE
        // en vez de emitir de nuevo (que duplicaría el comprobante).
        const { error: recuperarError } = await sb
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
            ...evidenciaLegacy,
            // Si la letra emitida difiere del tipo tipeado, reescribe tipo/numero interno.
            ...(await camposReescrituraLetra(sb, venta, cbteTipo)),
          })
          .eq("id", venta.id);
        if (recuperarError) {
          throw new Error(
            `ARCA autorizó el comprobante, pero no se pudo persistir la evidencia legacy: ${recuperarError.message}.`,
          );
        }
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
      .eq("afip_emisor_cuit", emisor.cuit)
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
      afip_emisor_cuit: emisor.cuit,
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
      ...evidenciaLegacy,
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
        docTipo: receptorEfectivo.doc_tipo,
        docNro: receptorEfectivo.doc_nro,
        neto: totales.neto,
        iva: totales.iva,
        tributos: totales.tributos,
        total: totales.total,
        condicionIvaReceptorId: condicionIvaReceptorId(receptorEfectivo.condicion_iva),
        alicuotas: totales.alicuotas,
        comprobantesAsociados: cbtesAsoc,
      },
      sb,
    );

    const { error: aprobacionError } = await sb
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
    if (aprobacionError) {
      throw new ErrorPersistenciaCaeLegacy(
        `ARCA autorizó el comprobante, pero no se pudo persistir la aprobación legacy: ${aprobacionError.message}.`,
      );
    }

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
    if (e instanceof ErrorPersistenciaCaeLegacy) {
      // La respuesta de ARCA ya pudo contener CAE: conservar identidad/número
      // para que el siguiente intento consulte y recupere, nunca reemitir.
      await marcarPendiente(sb, venta.id, msg);
      throw new Error(
        "ARCA respondió, pero no se pudo guardar la autorización. El comprobante quedó pendiente de recuperación; reintentá sin crear otro.",
      );
    }

    // Rechazo de negocio: AFIP NO autorizó el número, así que hay que LIBERARLO.
    // Si no, ese número reservado sin CAE desincroniza el contador local del de
    // AFIP y traba la numeración para siempre.
    await sb
      .from("ventas")
      .update({
        afip_estado: "ERROR",
        afip_error: msg,
        afip_numero: null,
        afip_emisor_cuit: null,
      })
      .eq("id", venta.id);
    throw e;
  }
}

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
export async function datosFiscalesComprobanteLegacy({
  data,
  context,
}: {
  data: { venta_id: string };
  context: { supabase: any };
}) {
  const sb = await admin();
  const { data: venta } = await context.supabase
    .from("ventas")
    .select(`${COLUMNAS_VENTA_SEGURAS}, cliente:clientes(razon_social, cuit_dni, tipo, direccion)`)
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
    const { data: sucursal } = await sb
      .from("sucursales")
      .select(
        "telefono, emisor:emisores(cuit, razon_social, nombre_fantasia, domicilio_fiscal, condicion_iva, ingresos_brutos, inicio_actividades)",
      )
      .eq("id", venta.sucursal_id)
      .maybeSingle();
    emisor = sucursal?.emisor
      ? {
          ...sucursal.emisor,
          cuit: venta.afip_emisor_cuit ?? sucursal.emisor.cuit,
          telefono: sucursal.telefono ?? null,
        }
      : null;
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
    // Los históricos anteriores al snapshot no tienen fecha/total fiscales
    // separados. En esa rama explícita se conserva la mejor evidencia disponible
    // de la propia venta para poder reconstruir el QR, siempre marcada legacy.
    fecha: snap?.fecha ?? venta.fecha,
    total: snap?.totales?.total ?? venta.afip_imp_total ?? venta.total,
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
}
