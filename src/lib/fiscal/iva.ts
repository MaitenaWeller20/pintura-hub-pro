import { alicuotaValida, ivaIdAfip } from "./codigos";

/**
 * Cálculo de neto / IVA / total para AFIP.
 *
 * EL INVARIANTE (esto es lo que hace que AFIP acepte o rechace el comprobante):
 * se redondea a 2 decimales UNA VEZ POR ÍTEM, y de ahí en más todo es suma de
 * números ya redondeados. Como sumar exactos de 2 decimales da exacto, sale gratis:
 *
 *     ImpNeto + ImpIVA === ImpTotal            (exacto, sin deriva)
 *     Σ AlicIva[].BaseImp === ImpNeto
 *     Σ AlicIva[].Importe === ImpIVA
 *
 * Lo que NO hay que hacer nunca: calcular el total primero y después despejar el
 * neto y el IVA desde la cabecera. Ahí es donde aparecen las diferencias de un
 * centavo que AFIP rechaza.
 */

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Un precio neto, con su IVA sumado. Para MOSTRAR, no para declarar.
 *
 * Los presupuestos se muestran con el precio final, que es el número que la
 * clienta le dice al cliente por teléfono ("la membrana sale 157"). Mostrar el
 * neto y el IVA aparte confundía y, en algunos clientes, no querían ni que se
 * viera el desglose.
 *
 * Se calcula desde el NETO, nunca despejando desde el subtotal: con cantidades
 * y descuentos de por medio, dividir el subtotal daría un unitario con deriva.
 * Lo que se guarda en la base sigue siendo neto, que es lo que después factura.
 */
export const conIva = (
  neto: number | string | null | undefined,
  ivaPorcentaje: number | string | null | undefined,
): number => round2(Number(neto ?? 0) * (1 + Number(ivaPorcentaje ?? 0) / 100));

/**
 * Convierte el precio final que tipea la usuaria al neto que guarda el sistema.
 * Es la operación inversa de `conIva`: la interfaz trabaja siempre con importes
 * finales, pero AFIP y las RPC siguen recibiendo el neto sin alterar.
 */
export const sinIva = (
  precioFinal: number | string | null | undefined,
  ivaPorcentaje: number | string | null | undefined,
): number => round2(Number(precioFinal ?? 0) / (1 + Number(ivaPorcentaje ?? 0) / 100));

export interface ItemFiscal {
  cantidad: number;
  precio_unitario_sin_iva: number;
  descuento_porcentaje?: number | null;
  iva_porcentaje: number;
}

export interface AlicuotaAfip {
  Id: number;
  BaseImp: number;
  Importe: number;
}

export interface TotalesFiscales {
  neto: number;
  iva: number;
  /** Percepciones / otros tributos. Van al total y se declaran a AFIP como ImpTrib. */
  tributos: number;
  total: number;
  alicuotas: AlicuotaAfip[];
}

/**
 * @param percepciones se suma al total y se declara a AFIP como ImpTrib (con su
 *        array Tributos). AFIP valida ImpTotal == ImpNeto + ImpIVA + ImpTrib +
 *        ImpOpEx + ImpTotConc, así que las percepciones NO pueden quedar fuera de
 *        ImpTrib o el comprobante se rechaza (error 10048).
 */
export function calcularTotales(items: ItemFiscal[], percepciones = 0): TotalesFiscales {
  let neto = 0;
  let iva = 0;
  // Agrupamos por alícuota, sumando los importes YA redondeados de cada ítem.
  const grupos = new Map<number, { base: number; importe: number }>();

  for (const it of items) {
    const ali = alicuotaValida(it.iva_porcentaje, 21);
    const desc = Math.min(Math.max(Number(it.descuento_porcentaje ?? 0), 0), 100);

    const baseItem = round2(
      Number(it.precio_unitario_sin_iva) * (1 - desc / 100) * Number(it.cantidad),
    );
    const ivaItem = round2((baseItem * ali) / 100);

    neto += baseItem;
    iva += ivaItem;

    const g = grupos.get(ali) ?? { base: 0, importe: 0 };
    g.base += baseItem;
    g.importe += ivaItem;
    grupos.set(ali, g);
  }

  neto = round2(neto);
  iva = round2(iva);
  const tributos = round2(percepciones);
  const total = round2(neto + iva + tributos);

  const alicuotas: AlicuotaAfip[] = [...grupos.entries()]
    // Una alícuota con base 0 no aporta nada y AFIP la observa.
    .filter(([, g]) => round2(g.base) !== 0 || round2(g.importe) !== 0)
    .map(([ali, g]) => ({
      Id: ivaIdAfip(ali),
      BaseImp: round2(g.base),
      Importe: round2(g.importe),
    }));

  return { neto, iva, tributos, total, alicuotas };
}

/**
 * Precio unitario final después del descuento, con el mismo orden de redondeo
 * que una línea real: primero la base descontada y después su impuesto.
 */
export function precioFinalConDescuento(
  neto: number | string | null | undefined,
  descuentoPorcentaje: number | string | null | undefined,
  ivaPorcentaje: number | string | null | undefined,
): number {
  return calcularTotales([
    {
      cantidad: 1,
      precio_unitario_sin_iva: Number(neto ?? 0),
      descuento_porcentaje: Number(descuentoPorcentaje ?? 0),
      iva_porcentaje: Number(ivaPorcentaje ?? 0),
    },
  ]).total;
}
