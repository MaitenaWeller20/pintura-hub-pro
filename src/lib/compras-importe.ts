// El importe de una compra, tal como viene impreso en el papel.
//
// Una factura de COMPRA llega con un TOTAL, con el IVA ya adentro. La pantalla
// pedía primero "Subtotal s/IVA", que obliga a hacer a mano una cuenta que el
// comprobante ya trae hecha — y como los tres campos eran inputs chiquitos a un
// costado, la clienta no los reconoció y quedó trabada: el total daba 0, el
// botón Guardar quedaba gris y nada explicaba por qué.
// Ver docs/superpowers/specs/2026-08-03-compras-importe-design.md
//
// La cuenta va al revés que en ventas, y es a propósito:
//
//   total (dato duro, impreso)
//     − percepciones          ┐
//     − IVA                   ├─ el neto es el RESIDUO
//     = neto s/IVA            ┘
//
// `fiscal/iva.ts` dice, con razón, que nunca hay que despejar el neto desde la
// cabecera. Esa regla es para los comprobantes que EMITIMOS: AFIP valida
// ImpTotal == ImpNeto + ImpIVA + ImpTrib y rechaza por un centavo, así que ahí
// se redondea por ítem y el total es la suma. Acá no emitimos nada: registramos
// un papel ajeno cuyo total ya está decidido. Despejar el neto es lo correcto.
//
// TODA LA CUENTA VA EN CENTAVOS ENTEROS. No es preciosismo: la RPC recalcula
// `v_total := ROUND(v_sub + v_iva + v_perc, 2)` sobre `numeric` (decimal exacto)
// y ESE número es la deuda del proveedor. Si el neto saliera de un redondeo
// propio en punto flotante, la suma podía caer un centavo lejos del total que la
// clienta vio en pantalla. Con enteros, `neto + iva + perc === total` es
// aritmética de enteros: no puede fallar, no hace falta confiar en el redondeo.

/** Las alícuotas que se ofrecen en el desplegable, de más a menos frecuente. */
export const ALICUOTAS_COMPRA = [21, 10.5, 27, 5, 2.5] as const;

/** Tolerancia de la RPC al comparar pagos contra el total (`ABS(...) > 0.01`). */
export const TOLERANCIA_PAGO = 0.01;

/**
 * Tope de la RPC (`LIMITE constant numeric := 999999999`).
 *
 * Se replica acá para frenar el cero de más ANTES de mandar: si no, la pantalla
 * habilita Guardar y el rechazo vuelve del servidor con la compra a medio
 * cargar. Es exactamente el typo que este tope existe para atajar.
 */
export const TOPE_TOTAL = 999999999;

export type ModoIva =
  /** No se desglosa: el total es todo neto. Factura B/C, remito, monotributo. */
  | "sin"
  /** Se calcula desde una alícuota (el caso normal de una Factura A). */
  | "tasa"
  /** Se escribe el monto: facturas con alícuotas mezcladas. */
  | "manual";

/**
 * El desglose que corresponde a cada tipo de comprobante, si nadie lo toca.
 *
 * No es una comodidad: es lo que evita corromper el dato. Si el default fuera
 * "sin desglosar" para todo, cada Factura A quedaría guardada con `iva_total`
 * en cero — el subtotal y el IVA de la tabla `compras` pasarían a significar
 * cualquier cosa, y nadie se daría cuenta hasta querer usarlos.
 *
 * Factura A discrimina IVA (por eso 21% por defecto). La B lo lleva adentro sin
 * discriminar, la C no tiene (monotributo) y un remito no es un comprobante
 * fiscal: en los tres el desglose honesto es "no sé", o sea cero.
 */
export const MODO_IVA_POR_TIPO: Record<string, ModoIva> = {
  FACTURA_A: "tasa",
  FACTURA_B: "sin",
  FACTURA_C: "sin",
  REMITO: "sin",
  OTRO: "sin",
};

export const modoIvaSugerido = (tipoComprobante: string): ModoIva =>
  MODO_IVA_POR_TIPO[tipoComprobante] ?? "sin";

export interface EntradaImporte {
  /** El número final del comprobante, con IVA. */
  total: number | null;
  /** Percepciones de IVA/IIBB. Vienen INCLUIDAS en el total impreso. */
  percepciones: number | null;
  modoIva: ModoIva;
  /** Alícuota, sólo si `modoIva === "tasa"`. */
  tasaIva: number;
  /** Monto de IVA, sólo si `modoIva === "manual"`. */
  ivaManual: number | null;
}

export interface ImporteCompra {
  total: number;
  percepciones: number;
  iva: number;
  /** Lo que va a `p_subtotal_sin_iva`. */
  neto: number;
  /** Inconsistencia entre los números escritos. `null` = están bien. */
  error: string | null;
  /** Hay un importe cargado y es consistente. */
  valido: boolean;
}

/**
 * Pasa a centavos enteros.
 *
 * `toPrecision(15)` mata el ruido binario antes de redondear: sin él,
 * `120000.07 * 100` da 12000006.999999999 y `Math.round` lo salva de casualidad,
 * pero `10000.05 * 1.3 * 100` no. Es el mismo redondeo medio-hacia-arriba que
 * usa `numeric` en Postgres, verificado en su momento sobre 3000 combinaciones
 * (ver el comentario de `r2` en `precios.ts`).
 */
const aCentavos = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Number((n * 100).toPrecision(15)));
};

const aPesos = (centavos: number): number => centavos / 100;

/**
 * Ajusta un número escrito a mano al centavo más cercano.
 *
 * La usa la pantalla en los inputs de plata. Sin esto el campo podía quedar
 * mostrando "1.005" mientras el total calculado, el pago y lo que va a la base
 * decían 1,01: lo que se ve y lo que se guarda tienen que ser el mismo número.
 */
export const redondearACentavos = (v: number | null): number | null =>
  v === null ? null : aPesos(aCentavos(v));

const money = (n: number) =>
  n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Descompone el total en neto + IVA + percepciones.
 *
 * Devuelve el error como texto en vez de tirar: la pantalla lo muestra mientras
 * la persona escribe, y a mitad de tipear los números son inconsistentes todo el
 * tiempo. Un throw acá dejaría la pantalla en blanco.
 *
 * Con el total en 0 NO es un error: es el estado inicial del formulario. Que
 * falte el total lo reporta `faltanteCompra`, que es el que le habla al botón.
 */
export function calcularImporteCompra(e: EntradaImporte): ImporteCompra {
  const totalC = aCentavos(e.total);
  const percC = aCentavos(e.percepciones);
  const vacio = {
    total: aPesos(totalC),
    percepciones: aPesos(percC),
    iva: 0,
    neto: 0,
    valido: false,
  };

  if (totalC < 0) return { ...vacio, error: "El total no puede ser negativo." };
  if (percC < 0) return { ...vacio, error: "Las percepciones no pueden ser negativas." };
  if (percC > totalC) {
    return {
      ...vacio,
      error:
        `Las percepciones ($${money(aPesos(percC))}) no pueden ser más que ` +
        `el total ($${money(aPesos(totalC))}). Las percepciones ya vienen incluidas en el total.`,
    };
  }

  const baseC = totalC - percC;

  let ivaC: number;
  if (e.modoIva === "tasa") {
    const tasa = Number(e.tasaIva);
    // Recomposición: el total ya trae el IVA adentro, así que el IVA es lo que
    // sobra de sacarle la base. Con tasa 0 da 0, igual que "sin desglosar".
    ivaC =
      Number.isFinite(tasa) && tasa > 0
        ? Math.round(Number((baseC - baseC / (1 + tasa / 100)).toPrecision(15)))
        : 0;
  } else if (e.modoIva === "manual") {
    ivaC = aCentavos(e.ivaManual);
  } else {
    ivaC = 0;
  }

  if (ivaC < 0) return { ...vacio, error: "El IVA no puede ser negativo." };
  if (ivaC > baseC) {
    return {
      ...vacio,
      error:
        `El IVA ($${money(aPesos(ivaC))}) no puede ser más que ` +
        `el importe sin percepciones ($${money(aPesos(baseC))}).`,
    };
  }

  // El neto sale por RESTA de enteros, nunca por su propio redondeo: es lo que
  // hace que los tres números sumen el total exacto que se ve en pantalla.
  const netoC = baseC - ivaC;

  return {
    total: aPesos(totalC),
    percepciones: aPesos(percC),
    iva: aPesos(ivaC),
    neto: aPesos(netoC),
    error: null,
    valido: totalC > 0,
  };
}

/** Lo mismo que arriba, listo para mandarle a la RPC `crear_compra`. */
export function paraRpc(i: ImporteCompra) {
  return {
    p_subtotal_sin_iva: i.neto,
    p_iva_total: i.iva,
    p_percepciones: i.percepciones,
  };
}

export interface EstadoCompra {
  sucursalId: string;
  proveedorId: string;
  numero: string;
  fechaComprobante: string;
  importe: ImporteCompra;
  esCtaCte: boolean;
  /** Formas de pago cargadas. Se ignoran en cuenta corriente. */
  pagos: Array<{ forma_pago: string; monto: number | null }>;
}

/**
 * Qué le falta al formulario para poder guardarse, en el orden en que se llena.
 *
 * Existe porque el bug que trajo la clienta fue un botón gris sin explicación:
 * lo que estaba mal (el total en cero) no tenía ningún cartel, y el único texto
 * rojo de la pantalla apuntaba a los pagos, que estaban bien.
 *
 * `null` = se puede guardar.
 */
export function faltanteCompra(e: EstadoCompra): string | null {
  if (!e.sucursalId) return "Elegí la sucursal.";
  if (!e.proveedorId) return "Elegí el proveedor.";
  if (!e.numero.trim()) return "Falta el N° de comprobante.";
  if (!e.fechaComprobante) return "Falta la fecha del comprobante.";
  if (e.importe.error) return e.importe.error;
  if (e.importe.total <= 0) return "Escribí el total del comprobante.";
  if (e.importe.total > TOPE_TOTAL) {
    return `El total ($${money(e.importe.total)}) no parece un monto válido. Revisá los números.`;
  }
  if (e.esCtaCte) return null;

  // Sólo las filas que de verdad se van a mandar. Es el MISMO filtro que aplica
  // el payload (`monto > 0`): pedir la forma de una fila vacía trababa Guardar
  // por algo que el servidor nunca iba a ver.
  const conMonto = e.pagos.filter((p) => Number(p.monto || 0) > 0);

  // Con qué se pagó NO se adivina. Una compra al contado saca la plata de la
  // caja de verdad: dejar "Efectivo" puesto de fábrica haría que apretar Guardar
  // sin mirar registre un egreso en efectivo que quizás fue una transferencia.
  if (conMonto.some((p) => !p.forma_pago)) return "Elegí con qué se pagó la compra.";

  // Sin esto, un total de $0,01 pasaba por la tolerancia con CERO pagos (y la
  // RPC también lo aceptaba): quedaba una compra al contado sin ningún pago
  // registrado, o sea plata que salió de la caja sin rastro de cómo.
  if (conMonto.length === 0) {
    return e.pagos.length === 0
      ? "Cargá con qué se pagó la compra."
      : "Escribí cuánto se pagó.";
  }

  const pagado = conMonto.reduce((a, p) => a + aCentavos(p.monto), 0);
  const dif = pagado - aCentavos(e.importe.total);
  // Misma tolerancia que la RPC (`ABS(v_monto - v_total) > 0.01`): si acá
  // fuéramos más estrictos, la pantalla diría "falta $0,01" con el botón
  // habilitado; si fuéramos más laxos, guardaría y el servidor rechazaría.
  const tol = Math.round(TOLERANCIA_PAGO * 100);
  if (dif < -tol) return `Falta cubrir $${money(aPesos(-dif))} en formas de pago.`;
  if (dif > tol) return `Los pagos se pasan $${money(aPesos(dif))} del total.`;
  return null;
}
