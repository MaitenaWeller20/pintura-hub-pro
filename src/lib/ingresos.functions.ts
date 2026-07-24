/**
 * Server functions del ingreso de mercadería. Toda la parte de IA vive acá para
 * que la ANTHROPIC_API_KEY nunca salga del servidor.
 *
 * El matching corre server-side con el cliente autenticado del usuario (respeta
 * RLS): equivalencia aprendida -> código exacto (si el proveedor lo permite) ->
 * shortlist pg_trgm + IA elige. La suma de stock la hace la RPC transaccional
 * confirmar_ingreso_mercaderia, que se llama aparte desde el cliente.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ExtraccionSchema,
  MatchDecisionSchema,
  quitarPaginasDuplicadas,
  documentoInconsistente,
  riesgoEnvaseCantidad,
  validarArchivo,
  normalizarTexto,
  type Extraccion,
  type LineaExtraida,
} from "./ingresos-ia";

const MODELO = () => process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const MOCK = () => process.env.EXTRACCION_MOCK_MODE === "true" || !process.env.ANTHROPIC_API_KEY;

// Una línea ya matcheada, lista para la grilla de revisión.
export interface ItemRevision {
  linea: number;
  pagina: number;
  codigo_proveedor: string;
  descripcion_proveedor: string;
  cantidad: number | null;
  cantidad_raw: string;
  descripcion_raw: string;
  producto_id: string | null;
  codigo: string | null;
  descripcion: string | null;
  origen_match: "APRENDIDO" | "CODIGO" | "IA" | "MANUAL" | "NUEVO" | "IGNORADA";
  confianza: "ALTA" | "MEDIA" | "BAJA" | null;
  advertencia: string | null;
}

// ---------------------------------------------------------------------------
// Extracción con visión (o mock determinista sin key)
// ---------------------------------------------------------------------------

async function extraerConIA(
  archivoBase64: string,
  mime: string,
): Promise<{ ex: Extraccion; uso: unknown }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = new Anthropic();

  const esPdf = mime === "application/pdf";
  const documento = esPdf
    ? {
        type: "document" as const,
        source: {
          type: "base64" as const,
          media_type: "application/pdf" as const,
          data: archivoBase64,
        },
      }
    : {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mime as "image/jpeg" | "image/png" | "image/webp",
          data: archivoBase64,
        },
      };

  const msg = await client.messages.parse({
    model: MODELO(),
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system:
      "Sos un asistente que lee remitos de proveedores de una pinturería argentina. " +
      "Extraé cada línea de artículo con su código de proveedor, descripción y CANTIDAD. " +
      "CUIDADO con la cantidad: muchas filas traen el TAMAÑO DE ENVASE en el medio (ej '10 LT') " +
      "y la cantidad real al final (ej '1.00'). La cantidad es cuántos bultos entran, NO el envase. " +
      "Ante la duda, poné el número de la última columna numérica como cantidad y dejá el resto en descripcion_raw, " +
      "y completá 'advertencia'. Registrá TODOS los números de remito y fechas que veas, por si el archivo mezcla documentos.",
    messages: [
      {
        role: "user",
        content: [documento, { type: "text", text: "Extraé todas las líneas de este remito." }],
      },
    ],
    output_config: { format: zodOutputFormat(ExtraccionSchema) },
  });

  if (!msg.parsed_output) {
    throw new Error("El modelo no devolvió una extracción válida.");
  }
  return { ex: msg.parsed_output, uso: msg.usage };
}

// Mock: extracción fija que imita un remito de KUM chico, para poder recorrer
// todo el flujo (revisión, matching, confirmación) sin key y sin gastar plata.
function extraerMock(): { ex: Extraccion; uso: unknown } {
  const items: LineaExtraida[] = [
    {
      linea: 1,
      pagina: 1,
      codigo_proveedor: "86013",
      descripcion: "Masilla Plastica 500grs Zeocar Formula Polyester",
      cantidad: 1,
      cantidad_raw: "1.00",
      descripcion_raw: "Masilla Plastica 500grs Zeocar Formula Polyester",
      advertencia: null,
    },
    {
      linea: 2,
      pagina: 1,
      codigo_proveedor: "26301",
      descripcion: "Aerosol AA 200 cc Negro Mate",
      cantidad: 5,
      cantidad_raw: "5.00",
      descripcion_raw: "Aerosol AA 200 cc Negro Mate",
      advertencia: null,
    },
    {
      linea: 3,
      pagina: 1,
      codigo_proveedor: "66215",
      descripcion: "Talento Latex Int-Ext Lavable 4L",
      cantidad: 1,
      cantidad_raw: "1.00",
      descripcion_raw: "Talento Latex Int-Ext Lavable 4L",
      advertencia: null,
    },
  ];
  return {
    ex: {
      proveedor_nombre: "KUM",
      numero_remito: "00054-00023918",
      numeros_remito_detectados: ["00054-00023918"],
      fecha_remito: "2026-07-21",
      fechas_detectadas: ["2026-07-21"],
      paginas_total: 1,
      items,
    },
    uso: { mock: true },
  };
}

// ---------------------------------------------------------------------------
// Matching de una tanda de líneas contra el catálogo
// ---------------------------------------------------------------------------

interface Candidato {
  id: string;
  codigo: string;
  nombre: string;
}

async function matchearConIA(
  pendientes: { linea: number; texto: string; candidatos: Candidato[] }[],
): Promise<Map<number, { producto_id: string | null; confianza: "ALTA" | "MEDIA" | "BAJA" }>> {
  const res = new Map<
    number,
    { producto_id: string | null; confianza: "ALTA" | "MEDIA" | "BAJA" }
  >();
  if (pendientes.length === 0) return res;

  if (MOCK()) {
    // Mock: elige el primer candidato (el de mayor score de pg_trgm) con confianza MEDIA.
    for (const p of pendientes) {
      res.set(p.linea, {
        producto_id: p.candidatos[0]?.id ?? null,
        confianza: p.candidatos[0] ? "MEDIA" : "BAJA",
      });
    }
    return res;
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = new Anthropic();

  const texto = pendientes
    .map(
      (p) =>
        `Línea ${p.linea}: "${p.texto}"\n  Candidatos:\n` +
        p.candidatos.map((c) => `    - id=${c.id} · ${c.codigo} · ${c.nombre}`).join("\n"),
    )
    .join("\n\n");

  const msg = await client.messages.parse({
    model: MODELO(),
    max_tokens: 4000,
    output_config: { effort: "low", format: zodOutputFormat(MatchDecisionSchema) },
    system:
      "Cada línea es un artículo de un remito de proveedor. Elegí, de la lista de candidatos, " +
      "el producto propio que le corresponde. Devolvé su id exacto o null si ninguno corresponde. " +
      "No inventes ids fuera de la lista.",
    messages: [{ role: "user", content: [{ type: "text", text: texto }] }],
  });

  for (const d of msg.parsed_output?.decisiones ?? []) {
    const p = pendientes.find((x) => x.linea === d.linea);
    const valido = p?.candidatos.some((c) => c.id === d.producto_id);
    res.set(d.linea, { producto_id: valido ? d.producto_id : null, confianza: d.confianza });
  }
  return res;
}

// ---------------------------------------------------------------------------
// extraerYMatchear — el server fn principal
// ---------------------------------------------------------------------------

export const extraerYMatchearRemito = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        proveedor_id: z.string().uuid(),
        sucursal_id: z.string().uuid(),
        archivo_base64: z.string().min(1),
        mime: z.string().min(1),
        filename: z.string().min(1).max(200),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    // Validación server-side sobre el TAMAÑO REAL del base64, no un `bytes` que
    // manda el cliente (que podría mentir). Buffer.byteLength da el tamaño exacto
    // decodificado (contando el padding), no una cota superior.
    const bytesReales = Buffer.byteLength(data.archivo_base64, "base64");
    const errArchivo = validarArchivo(data.mime, bytesReales);
    if (errArchivo) throw new Error(errArchivo);

    // Borrador PRIMERO: es el gate del rate limit y valida sucursal propia +
    // proveedor activo del lado servidor. Recién después se gasta plata en la IA,
    // así que no se puede quemar llamadas invocando el endpoint con UUIDs sueltos.
    const { data: idBorr, error: eBorr } = await supabase.rpc("crear_borrador_ingreso", {
      p_proveedor_id: data.proveedor_id,
      p_sucursal_id: data.sucursal_id,
    });
    if (eBorr) throw new Error(eBorr.message);
    const ingresoId = idBorr as string;

    // Subir el archivo al bucket privado en la ruta definitiva. Si falla, se marca
    // el borrador como ERROR (con el motivo) y se corta: queda visible y distinguible
    // en el listado, no como un PENDIENTE fantasma.
    const nombreSeguro = data.filename.replace(/[^\w.\-]/g, "_");
    const archivoPath = `${data.sucursal_id}/${ingresoId}/${nombreSeguro}`;
    const buffer = Buffer.from(data.archivo_base64, "base64");
    const { error: eUp } = await supabase.storage
      .from("remitos-proveedor")
      .upload(archivoPath, buffer, { contentType: data.mime, upsert: true });
    if (eUp) {
      await supabase.rpc("guardar_extraccion_ingreso", {
        p_ingreso_id: ingresoId,
        p_error: `No se pudo guardar el archivo: ${eUp.message}`,
      });
      throw new Error(`No se pudo guardar el archivo: ${eUp.message}`);
    }

    // ¿Este proveedor usa mis mismos códigos? (gate del match por código exacto)
    const { data: prov } = await supabase
      .from("proveedores")
      .select("codigos_coinciden_con_los_propios")
      .eq("id", data.proveedor_id)
      .single();
    const usaCodigosPropios = !!prov?.codigos_coinciden_con_los_propios;

    // 1. Extracción. Si falla, dejamos el borrador en estado ERROR con el mensaje
    //    (no se evapora) y propagamos el error al cliente.
    let ex: Extraccion, uso: unknown;
    try {
      const r = MOCK() ? extraerMock() : await extraerConIA(data.archivo_base64, data.mime);
      ex = r.ex;
      uso = r.uso;
    } catch (e: any) {
      await supabase.rpc("guardar_extraccion_ingreso", {
        p_ingreso_id: ingresoId,
        p_error: e?.message ?? "Falló la extracción",
        p_archivo_path: archivoPath,
      });
      throw new Error(`No se pudo leer el remito: ${e?.message ?? e}`);
    }

    // 2. Páginas duplicadas
    const { items: itemsUnicos, paginasQuitadas } = quitarPaginasDuplicadas(ex.items);

    // 3. Documento mezclado (dos remitos en un archivo)
    const inconsistencia = documentoInconsistente(ex);

    // 4. Matching por línea
    const pendientes: { linea: number; texto: string; candidatos: Candidato[] }[] = [];
    const resueltos = new Map<number, Partial<ItemRevision>>();

    for (const it of itemsUnicos) {
      const cod = it.codigo_proveedor?.trim();
      const codNorm = normalizarTexto(cod);

      // a. equivalencia aprendida (por código NORMALIZADO)
      if (codNorm) {
        const { data: eq } = await supabase
          .from("producto_codigos_proveedor")
          .select("producto_id, productos(codigo, nombre)")
          .eq("proveedor_id", data.proveedor_id)
          .eq("codigo_proveedor_norm", codNorm)
          .maybeSingle();
        if (eq?.producto_id) {
          const p = eq.productos as any;
          resueltos.set(it.linea, {
            producto_id: eq.producto_id,
            codigo: p?.codigo ?? null,
            descripcion: p?.nombre ?? null,
            origen_match: "APRENDIDO",
            confianza: "ALTA",
          });
          continue;
        }
      }

      // b. código propio exacto — SOLO si el proveedor lo permite
      if (cod && usaCodigosPropios) {
        const { data: pExacto } = await supabase
          .from("productos")
          .select("id, codigo, nombre")
          .eq("codigo", cod)
          .maybeSingle();
        if (pExacto) {
          resueltos.set(it.linea, {
            producto_id: pExacto.id,
            codigo: pExacto.codigo,
            descripcion: pExacto.nombre,
            origen_match: "CODIGO",
            confianza: "ALTA",
          });
          continue;
        }
      }

      // c. shortlist pg_trgm → la IA elige después
      const { data: cand } = await supabase.rpc("buscar_productos_similares", {
        p_texto: it.descripcion || it.descripcion_raw,
        p_codigo: cod || undefined,
        p_limite: 8,
      });
      pendientes.push({
        linea: it.linea,
        texto: it.descripcion || it.descripcion_raw,
        candidatos: (cand ?? []).map((c: any) => ({
          id: c.id,
          codigo: c.codigo,
          nombre: c.nombre,
        })),
      });
    }

    const decisiones = await matchearConIA(pendientes);

    // 5. Armar los ítems de revisión
    const items: ItemRevision[] = itemsUnicos.map((it) => {
      const base: ItemRevision = {
        linea: it.linea,
        pagina: it.pagina,
        codigo_proveedor: it.codigo_proveedor ?? "",
        descripcion_proveedor: it.descripcion ?? "",
        cantidad: it.cantidad ?? null,
        cantidad_raw: it.cantidad_raw ?? "",
        descripcion_raw: it.descripcion_raw ?? "",
        producto_id: null,
        codigo: null,
        descripcion: null,
        origen_match: "MANUAL",
        confianza: null,
        advertencia:
          it.advertencia ??
          (riesgoEnvaseCantidad(it)
            ? "Revisá la cantidad: puede confundirse con el envase."
            : null),
      };
      const r = resueltos.get(it.linea);
      if (r) return { ...base, ...r } as ItemRevision;

      const pend = pendientes.find((p) => p.linea === it.linea);
      const dec = decisiones.get(it.linea);
      if (dec?.producto_id) {
        const c = pend?.candidatos.find((x) => x.id === dec.producto_id);
        return {
          ...base,
          producto_id: dec.producto_id,
          codigo: c?.codigo ?? null,
          descripcion: c?.nombre ?? null,
          origen_match: "IA",
          confianza: dec.confianza,
        };
      }
      return base; // sin resolver → a mano
    });

    // 6. Persistir el borrador con lo extraído (el trabajo caro queda guardado).
    //    El bloqueo por documento inconsistente se persiste: la confirmación lo
    //    respeta aunque se refresque, se retome el borrador o se llame directo.
    const { error: errGuardar } = await supabase.rpc("guardar_extraccion_ingreso", {
      p_ingreso_id: ingresoId,
      p_extraccion: ex as any,
      p_items: items.map((it) => ({ ...it, producto_id: it.producto_id ?? "" })) as any,
      p_uso_tokens: uso as any,
      p_numero: ex.numero_remito ?? undefined,
      p_fecha: ex.fecha_remito ?? undefined,
      p_bloqueo: inconsistencia ?? undefined,
      p_archivo_path: archivoPath,
    });
    if (errGuardar) throw new Error(errGuardar.message);

    return {
      ingreso_id: ingresoId,
      proveedor_nombre: ex.proveedor_nombre,
      numero_remito: ex.numero_remito,
      fecha_remito: ex.fecha_remito,
      paginas_total: ex.paginas_total,
      paginas_quitadas: paginasQuitadas,
      inconsistencia,
      items,
      mock: MOCK(),
    };
  });

// Búsqueda difusa para el botón "buscar otro producto" de la grilla.
export const buscarProductosIngreso = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ texto: z.string().min(1), codigo: z.string().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase.rpc("buscar_productos_similares", {
      p_texto: data.texto,
      p_codigo: data.codigo || undefined,
      p_limite: 12,
    });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
