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
