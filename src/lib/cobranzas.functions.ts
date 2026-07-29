/** Cobranza de cuenta corriente: registra el pago de un cliente sobre su deuda.
 *  - NO toca stock (la mercadería ya salió al emitir el remito / factura interna).
 *  - SÍ entra a la caja del día con su forma de pago.
 *  - IMPUTA contra los comprobantes abiertos del cliente, del más viejo al más
 *    nuevo (FIFO). Antes no lo hacía: el cobro quedaba en un libro paralelo que
 *    nunca tocaba ventas.total_pagado, así que la solapa "Cuentas corrientes" de
 *    Reportes mostraba deuda que no bajaba nunca aunque el cliente pagara todo.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { calcularPrecios } from "@/lib/precios";
import { z } from "zod";

const cobranzaSchema = z.object({
  cliente_id: z.string().uuid(),
  sucursal_id: z.string().uuid(),
  monto: z.number().positive(),
  forma_pago: z.enum([
    "EFECTIVO",
    "TRANSFERENCIA",
    "TARJETA_DEBITO",
    "TARJETA_CREDITO",
    "MERCADO_PAGO",
    "CHEQUE",
  ]),
  detalle: z.record(z.string(), z.any()).default({}),
  observaciones: z.string().optional().nullable(),
});

export const registrarCobranza = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cobranzaSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: r, error } = await supabase.rpc("registrar_cobranza", {
      p_cliente_id: data.cliente_id,
      p_sucursal_id: data.sucursal_id,
      p_monto: data.monto,
      p_forma_pago: data.forma_pago,
      p_detalle: data.detalle,
      p_observaciones: data.observaciones ?? undefined,
    });
    if (error) throw new Error(error.message);

    const row: any = Array.isArray(r) ? r[0] : r;
    return {
      id: row.cobranza_id as string,
      // Saldo del cliente después del cobro (negativo = saldo a favor).
      saldo: Number(row.saldo),
    };
  });

/** Aplica un nuevo % de markup a un set de productos (recalcula precio_sin_iva). */
export const aplicarMarkup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        producto_ids: z.array(z.string().uuid()).min(1),
        markup_porcentaje: z.number().min(0),
        setear_como_default: z.boolean().default(false),
        sobrescribir_individual: z.boolean().default(true),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Solo admin");

    // En tandas: PostgREST corta en db-max-rows (1000) sin avisar, y esta pantalla
    // ofrece "seleccionar los N visibles" sobre un catálogo de 1100+. Sin trocear,
    // los últimos productos quedaban con el precio viejo y el toast informaba
    // "1000 recalculados" como si estuviera todo hecho.
    // Ver src/lib/supabase-paginado.ts.
    const TANDA = 500;
    const lista: any[] = [];
    for (let i = 0; i < data.producto_ids.length; i += TANDA) {
      const { data: prods, error } = await supabase
        .from("productos")
        .select("id, precio_fabrica, precio_sugerido_publico, markup_porcentaje, iva_porcentaje")
        .in("id", data.producto_ids.slice(i, i + TANDA));
      if (error) throw new Error(error.message);
      lista.push(...(prods ?? []));
    }
    if (lista.length < data.producto_ids.length) {
      throw new Error(
        `Se seleccionaron ${data.producto_ids.length} productos pero sólo se pudieron leer ${lista.length}. No se aplicó nada.`,
      );
    }

    // El markup se guarda en TODOS los seleccionados (así queda registrado el % que
    // el negocio quiere para cada producto). El precio de venta se RECALCULA con la
    // cadena de precios: desde el SUGERIDO AL PÚBLICO si el producto lo tiene, y si
    // no desde el costo. Un producto sin ninguna de las dos bases no puede
    // recalcularse —daría vender gratis—, así que se le guarda el markup pero no se
    // toca el precio, y se informa cuántos quedaron así (cuando se les cargue la
    // base, el precio se deriva con este markup). Antes esos se salteaban por
    // completo y en silencio, y parecía que "solo se aplicaba al primero".
    let actualizados = 0; // con precio recalculado
    let sinBase = 0; // markup guardado, pero sin sugerido ni costo para recalcular
    for (const p of lista) {
      const patch: any = {};
      if (data.sobrescribir_individual) patch.markup_porcentaje = data.markup_porcentaje;
      // Con sobrescribir_individual el % nuevo pisa el de cada producto. Sin él,
      // cada producto conserva SU markup y el % nuevo actúa sólo como default para
      // los que no tienen uno propio. Antes se recalculaba siempre con el % nuevo
      // sin guardarlo, así que un producto con markup propio 50% quedaba con el
      // precio del 30% y el markup diciendo 50%: incoherente, y la tabla lo
      // marcaba como "manual".
      const { precio_sin_iva: nuevoPrecio } = calcularPrecios(
        {
          precio_fabrica: p.precio_fabrica,
          precio_sugerido_publico: p.precio_sugerido_publico,
          iva_porcentaje: p.iva_porcentaje,
          markup_porcentaje: data.sobrescribir_individual
            ? data.markup_porcentaje
            : p.markup_porcentaje,
        },
        { markupDefault: data.markup_porcentaje },
      );
      if (nuevoPrecio > 0) {
        patch.precio_sin_iva = nuevoPrecio;
        actualizados++;
      } else sinBase++;
      if (Object.keys(patch).length > 0) {
        await supabase.from("productos").update(patch).eq("id", p.id);
      }
    }
    if (data.setear_como_default) {
      await supabase
        .from("settings")
        .update({ markup_default_porcentaje: data.markup_porcentaje })
        .eq("id", true);
    }
    return { actualizados, sin_base: sinBase };
  });
