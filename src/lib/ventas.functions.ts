/**
 * Server function: crearVenta
 * Toma el formulario completo, genera número de comprobante,
 * inserta venta + items + pagos en transacción lógica y descuenta stock.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const itemSchema = z.object({
  producto_id: z.string().uuid(),
  codigo: z.string(),
  descripcion: z.string(),
  cantidad: z.number().nonnegative(),
  precio_unitario_sin_iva: z.number().nonnegative(),
  iva_porcentaje: z.number().nonnegative(),
  descuento_porcentaje: z.number().min(0).max(100).default(0),
});

const pagoSchema = z.object({
  forma_pago: z.enum(["EFECTIVO","TRANSFERENCIA","TARJETA_DEBITO","TARJETA_CREDITO","MERCADO_PAGO","CHEQUE","CTA_CTE"]),
  monto: z.number().nonnegative(),
  detalle: z.record(z.string(), z.any()).default({}),
});

const ventaSchema = z.object({
  sucursal_id: z.string().uuid(),
  cliente_id: z.string().uuid(),
  tipo_comprobante: z.enum(["FACTURA_A","FACTURA_B","NOTA_CREDITO","NOTA_DEBITO","REMITO","REMITO_OBRA","FAC_INTERNA_CTA_CTE"]),
  condicion_venta: z.enum(["CONTADO","CTA_CTE"]),
  fecha: z.string().optional(),
  percepciones: z.number().nonnegative().default(0),
  observaciones: z.string().optional().nullable(),
  nombre_obra: z.string().optional().nullable(),
  items: z.array(itemSchema).min(0),
  pagos: z.array(pagoSchema).default([]),
});

// Tipos que NO descuentan stock al emitirse (no salen mercaderías)
const TIPOS_SIN_STOCK = new Set(["NOTA_CREDITO","NOTA_DEBITO"]);
// Tipos que NO impactan en caja (van a cuenta corriente del cliente)
const TIPOS_CTA_CTE = new Set(["REMITO","REMITO_OBRA","FAC_INTERNA_CTA_CTE"]);

export const crearVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ventaSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Calcular totales
    let subSinIva = 0, ivaTotal = 0;
    const itemsCalc = data.items.map((it) => {
      const baseConDesc = it.precio_unitario_sin_iva * (1 - (it.descuento_porcentaje ?? 0) / 100);
      const subItem = baseConDesc * it.cantidad;
      const ivaItem = subItem * (it.iva_porcentaje / 100);
      subSinIva += subItem;
      ivaTotal += ivaItem;
      return {
        ...it,
        subtotal_sin_iva: +subItem.toFixed(2),
        iva_monto: +ivaItem.toFixed(2),
        subtotal_con_iva: +(subItem + ivaItem).toFixed(2),
      };
    });
    const total = +(subSinIva + ivaTotal + (data.percepciones ?? 0)).toFixed(2);
    const totalPagado = +data.pagos.reduce((a,p) => a + p.monto, 0).toFixed(2);
    const estadoPago = totalPagado >= total ? "PAGADO" : totalPagado > 0 ? "PARCIAL" : "PENDIENTE";

    // Numero comprobante
    const { data: numero, error: numErr } = await supabase.rpc("next_comprobante_numero", {
      _sucursal_id: data.sucursal_id, _tipo: data.tipo_comprobante,
    });
    if (numErr) throw new Error(numErr.message);

    // Insertar venta
    const { data: venta, error: vErr } = await supabase.from("ventas").insert({
      sucursal_id: data.sucursal_id,
      cliente_id: data.cliente_id,
      usuario_id: userId,
      fecha: data.fecha ?? new Date().toISOString(),
      numero_comprobante: numero as unknown as string,
      tipo_comprobante: data.tipo_comprobante,
      condicion_venta: data.condicion_venta,
      subtotal_sin_iva: +subSinIva.toFixed(2),
      iva_total: +ivaTotal.toFixed(2),
      percepciones: data.percepciones ?? 0,
      total,
      total_pagado: totalPagado,
      estado_pago: estadoPago,
      observaciones: data.observaciones ?? null,
    }).select().single();
    if (vErr) throw new Error(vErr.message);

    // Items
    const { error: iErr } = await supabase.from("venta_items").insert(
      itemsCalc.map((it) => ({ ...it, venta_id: venta.id }))
    );
    if (iErr) throw new Error(iErr.message);

    // Pagos
    if (data.pagos.length) {
      const { error: pErr } = await supabase.from("venta_pagos").insert(
        data.pagos.map((p) => ({ ...p, venta_id: venta.id }))
      );
      if (pErr) throw new Error(pErr.message);
    }

    // Descontar stock + registrar movimientos (sólo si no es REMITO; un remito de venta sale aparte)
    if (data.tipo_comprobante !== "REMITO") {
      for (const it of data.items) {
        const { data: row } = await supabase.from("stock_sucursal")
          .select("cantidad").eq("producto_id", it.producto_id).eq("sucursal_id", data.sucursal_id).maybeSingle();
        const anterior = Number(row?.cantidad ?? 0);
        const nueva = anterior - it.cantidad;
        await supabase.from("stock_sucursal").upsert({
          producto_id: it.producto_id, sucursal_id: data.sucursal_id, cantidad: nueva,
        }, { onConflict: "producto_id,sucursal_id" });
        await supabase.from("stock_movimientos").insert({
          producto_id: it.producto_id,
          sucursal_id: data.sucursal_id,
          tipo: "VENTA",
          cantidad: -it.cantidad,
          cantidad_anterior: anterior,
          cantidad_nueva: nueva,
          referencia_id: venta.id,
          usuario_id: userId,
          motivo: `Venta ${numero}`,
        });
      }
    }

    return { id: venta.id, numero: numero as unknown as string };
  });

export const anularVenta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ venta_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: v } = await supabase.from("ventas").select("*").eq("id", data.venta_id).single();
    if (!v) throw new Error("Venta no encontrada");
    if (v.estado === "ANULADA") throw new Error("La venta ya fue anulada");

    // Generar NC
    const { data: numero } = await supabase.rpc("next_comprobante_numero", {
      _sucursal_id: v.sucursal_id, _tipo: "NOTA_CREDITO" as const,
    });
    const { data: nc } = await supabase.from("ventas").insert({
      sucursal_id: v.sucursal_id, cliente_id: v.cliente_id, usuario_id: userId,
      numero_comprobante: numero as unknown as string, tipo_comprobante: "NOTA_CREDITO",
      condicion_venta: v.condicion_venta,
      subtotal_sin_iva: -Number(v.subtotal_sin_iva), iva_total: -Number(v.iva_total),
      percepciones: -Number(v.percepciones), total: -Number(v.total), total_pagado: 0,
      estado_pago: "PENDIENTE", observaciones: `Nota de crédito por anulación de ${v.numero_comprobante}`,
    }).select().single();

    await supabase.from("ventas").update({ estado: "ANULADA", venta_anulada_por: nc?.id }).eq("id", v.id);

    // Devolver stock
    const { data: items = [] } = await supabase.from("venta_items").select("*").eq("venta_id", v.id);
    for (const it of items as any[]) {
      const { data: row } = await supabase.from("stock_sucursal")
        .select("cantidad").eq("producto_id", it.producto_id).eq("sucursal_id", v.sucursal_id).maybeSingle();
      const anterior = Number(row?.cantidad ?? 0);
      const nueva = anterior + Number(it.cantidad);
      await supabase.from("stock_sucursal").upsert({
        producto_id: it.producto_id, sucursal_id: v.sucursal_id, cantidad: nueva,
      }, { onConflict: "producto_id,sucursal_id" });
      await supabase.from("stock_movimientos").insert({
        producto_id: it.producto_id, sucursal_id: v.sucursal_id,
        tipo: "ANULACION_VENTA", cantidad: Number(it.cantidad),
        cantidad_anterior: anterior, cantidad_nueva: nueva,
        referencia_id: v.id, usuario_id: userId, motivo: `Anulación ${v.numero_comprobante}`,
      });
    }

    return { ok: true, nc_numero: numero };
  });
