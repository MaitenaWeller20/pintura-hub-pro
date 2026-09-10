// La cadena de precios, en un solo lugar.
//
// Hasta el 29/07/2026 esta fórmula estaba copiada en cuatro lados (la importación,
// el diálogo de alta/edición, la tabla de productos y el markup masivo), cada uno
// con su propia versión y su propio fallback del markup default. Por eso el precio
// de venta podía salir distinto según por dónde pasara.
//
// Cambio de fondo del 29/07: el precio de venta sale del PRECIO SUGERIDO AL
// PÚBLICO que publica el proveedor, no del costo. La lista de Quimex trae esa
// columna y el sistema la ignoraba, así que la góndola quedaba por debajo del
// precio que el propio proveedor sugiere.
// Ver docs/superpowers/specs/2026-07-29-precios-sugerido-publico-design.md
//
//   precio_lista (s/IVA)  ──costoDeLista──▶  precio_fabrica (COSTO, s/IVA)
//                                              × (1 + iva)  ▶ lo que se le paga al proveedor
//
//   precio_sugerido_publico (C/IVA)  × (1 + markup)  ▶ precio de venta al público
//                                    ÷ (1 + iva)     ▶ precio_sin_iva  ← lo que se factura
//
//   sin sugerido:  precio_fabrica × (1 + markup)     ▶ precio_sin_iva  (el cálculo viejo)

/** Markup del negocio. Sólo se usa si `settings.markup_default_porcentaje` no está disponible. */
export const MARKUP_DEFAULT = 30;
/** Sin descuento: fallback seguro cuando no hay producto, proveedor ni settings. */
export const DESCUENTO_PROVEEDOR_DEFAULT = 0;
/** Las únicas alícuotas que acepta AFIP (y el CHECK de la tabla). */
export const ALICUOTAS_IVA = [0, 2.5, 5, 10.5, 21, 27] as const;

/** Dos productos con el mismo precio pueden diferir un centavo por redondeo. */
const CENTAVO = 0.01;

/**
 * Redondeo a dos decimales que coincide con `round(numeric, 2)` de Postgres.
 *
 * `toFixed(2)` redondea el double BINARIO, y para muchos `x.xx5` cae un centavo
 * abajo (10000.05 × 1.3 da 13000.064999999999 en binario → "13000.06", cuando el
 * decimal exacto es 13000.065 → 13000.07). Postgres opera sobre `numeric`, que es
 * decimal exacto, y redondea medio-hacia-arriba.
 *
 * Esa diferencia de un centavo importa porque la RPC `cambiar_precios_masivo`
 * calcula en SQL y este archivo es su ESPEJO para la vista previa: los dos deciden
 * si un precio "coincide con la fórmula" con tolerancia de un centavo, así que un
 * centavo de diferencia los daba vuelta en direcciones opuestas. La pantalla
 * prometía no tocar un precio puesto a mano y el SQL lo pisaba (+16% en el caso
 * reproducido), o al revés: mostraba un cambio que nunca ocurría.
 *
 * `toPrecision(15)` mata el ruido binario antes de redondear. Verificado contra
 * Postgres sobre 3000 combinaciones: 0 diferencias (con toFixed eran 123).
 */
const r2 = (n: number) => Math.round(Number((n * 100).toPrecision(15))) / 100;

const num = (v: unknown, def: number): number => {
  if (v === null || v === undefined || v === "") return def;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : def;
};

/**
 * El descuento comercial que corresponde aplicarle a un producto.
 *
 * Escalera: **el del producto, si no el del proveedor, si no el global de
 * settings, si no 0%.** Es la misma forma que ya tiene el markup
 * (`producto ?? settings ?? default`), para no inventar un concepto nuevo.
 *
 * El escalón del PRODUCTO se agregó el 04/08/2026: la clienta avisó que "no
 * todos es el 42%". Quimex publica una lista sola pero no descuenta igual todos
 * los renglones, así que existe además el override por producto.
 *
 * Pregunta por `null`, NO por falsy: un descuento de **0 es válido** —comprarle a
 * un proveedor a precio de lista, sin descuento— y no puede caer al global. Es el
 * mismo error que antes convertía un markup de 0% en 30%.
 *
 * ESPEJO: la misma escalera está en SQL, en el COALESCE de
 * `cambiar_precios_masivo`. Si divergen, manda el SQL y esto es un bug.
 */
export function descuentoEfectivo(
  producto?: { descuento_porcentaje?: number | null } | null,
  proveedor?: { descuento_porcentaje?: number | null } | null,
  settings?: { descuento_proveedor_porcentaje?: number | null } | null,
): number {
  if (producto?.descuento_porcentaje != null) return Number(producto.descuento_porcentaje);
  if (proveedor?.descuento_porcentaje != null) return Number(proveedor.descuento_porcentaje);
  if (settings?.descuento_proveedor_porcentaje != null)
    return Number(settings.descuento_proveedor_porcentaje);
  return DESCUENTO_PROVEEDOR_DEFAULT;
}

/**
 * Costo (precio de fábrica) desde el precio de lista del proveedor.
 *
 * Se llama SÓLO donde se ingiere una lista: la importación y el campo "Precio de
 * lista" del diálogo. Deliberadamente NO vive dentro de `calcularPrecios`: el
 * diálogo permite editar el costo a mano aunque el producto tenga precio de lista,
 * y si el cálculo de venta re-derivara el costo, el markup masivo le pisaría ese
 * valor editado sin que nadie lo pida.
 */
export const costoDeLista = (lista: unknown, descuento: unknown): number =>
  r2(num(lista, 0) * (1 - num(descuento, DESCUENTO_PROVEEDOR_DEFAULT) / 100));

/**
 * Devuelve una alícuota de IVA válida, o 21 si el valor no lo es.
 *
 * Importa más que antes: el IVA pasó a ser un DIVISOR (el sugerido viene c/IVA y
 * hay que sacarle el IVA para guardar el neto). Con el cálculo viejo un IVA basura
 * sólo ensuciaba la vista; ahora corrompe el número que se factura. El caso real:
 * la columna "Sugerido al público C/IVA" mapeada por error al campo "IVA %".
 *
 * OJO: espera un NÚMERO. No parsea el formato argentino ("10,5") — eso es trabajo
 * de quien lee la planilla, que tiene `parseNumAr`. Si se le pasa "10,5" crudo lo
 * descarta y devuelve 21, que es exactamente el bug que se quiere evitar.
 */
export function normalizarIva(v: unknown): number {
  const n = num(v, NaN);
  return (ALICUOTAS_IVA as readonly number[]).includes(n) ? n : 21;
}

export type OrigenPrecio = "sugerido" | "costo" | "manual";

export type EntradaPrecio = {
  /** Costo s/IVA, ya resuelto (ver `costoDeLista`). */
  precio_fabrica?: number | null;
  /** Sugerido al público del proveedor, CON IVA. null/0 = la lista no lo trae. */
  precio_sugerido_publico?: number | null;
  /** Override explícito del neto de venta (columna mapeada en la planilla). */
  precio_sin_iva?: number | null;
  /** null = usa el default del negocio. */
  markup_porcentaje?: number | null;
  iva_porcentaje?: number | null;
};

export type PrecioCalculado = {
  /** Costo con IVA: lo que realmente se le paga al proveedor. Sólo para mostrar. */
  costo_c_iva: number;
  /** El neto de venta. Es lo que se guarda y lo que se factura. */
  precio_sin_iva: number;
  /** Precio de góndola. Derivado de `precio_sin_iva` para que coincida con la factura. */
  venta_c_iva: number;
  /** El markup efectivo (el propio del producto, o el default). */
  markup: number;
  origen: OrigenPrecio;
};

type Parametros = { markupDefault?: number | null };

const markupEfectivo = (e: EntradaPrecio, p: Parametros) =>
  num(e.markup_porcentaje, num(p.markupDefault, MARKUP_DEFAULT));

/**
 * Calcula el precio de venta. Precedencia (de más específico a menos):
 *
 *   1. `precio_sin_iva` explícito > 0   → se respeta tal cual (la planilla lo trajo)
 *   2. `precio_sugerido_publico` > 0    → sugerido × (1 + markup) ÷ (1 + iva)
 *   3. `precio_fabrica` > 0             → costo × (1 + markup)          [el cálculo viejo]
 *
 * `venta_c_iva` siempre se deriva del `precio_sin_iva` redondeado, nunca del
 * `sugerido × markup` crudo: lo que se ve en pantalla tiene que coincidir con lo
 * que va a salir en la factura, aunque eso cueste un centavo contra la
 * multiplicación directa.
 */
export function calcularPrecios(e: EntradaPrecio, p: Parametros = {}): PrecioCalculado {
  const markup = markupEfectivo(e, p);
  const iva = normalizarIva(e.iva_porcentaje);
  const factorIva = 1 + iva / 100;
  const factorMk = 1 + markup / 100;

  const costo = num(e.precio_fabrica, 0);
  const sugerido = num(e.precio_sugerido_publico, 0);
  const explicito = num(e.precio_sin_iva, 0);

  // `origen` acá es POR QUÉ RAMA salió este número, que es lo que necesita el
  // resumen de la importación ("N desde el sugerido, N desde el costo, N con el
  // precio que trae la planilla"). Para etiquetar un producto ya guardado se usa
  // `baseDelPrecio`, que es otra pregunta.
  let precio_sin_iva: number;
  let origen: OrigenPrecio;
  if (explicito > 0) {
    precio_sin_iva = r2(explicito);
    origen = "manual";
  } else if (sugerido > 0) {
    precio_sin_iva = r2((sugerido * factorMk) / factorIva);
    origen = "sugerido";
  } else {
    precio_sin_iva = r2(costo * factorMk);
    origen = "costo";
  }

  return {
    costo_c_iva: r2(costo * factorIva),
    precio_sin_iva,
    venta_c_iva: r2(precio_sin_iva * factorIva),
    markup,
    origen,
  };
}

const coincide = (a: number, b: number) => Math.abs(r2(a) - r2(b)) <= CENTAVO + 1e-9;

/**
 * De qué dato SALE el precio de un producto. Es un hecho sobre lo que tiene
 * cargado, no una deducción: nunca puede mentir.
 */
export function baseDelPrecio(e: EntradaPrecio): OrigenPrecio {
  if (num(e.precio_sugerido_publico, 0) > 0) return "sugerido";
  if (num(e.precio_fabrica, 0) > 0) return "costo";
  return "manual";
}

/**
 * ¿El precio guardado es el que da la fórmula HOY?
 *
 * Separado de `baseDelPrecio` a propósito. Cuando no coinciden puede ser porque
 * alguien escribió el precio a mano, o porque el precio se calculó con un markup
 * anterior — y no hay forma de distinguirlos sin guardar la procedencia. Llamar
 * "manual" a lo segundo es acusar: cambiar el markup default deja ~1100 productos
 * sin coincidir de un saque, y ninguno fue tocado por nadie.
 *
 * Lo que sí es cierto en los dos casos, y es lo que se muestra: este precio no
 * sale de la fórmula actual, así que conviene mirarlo.
 */
export function coincideConFormula(
  e: EntradaPrecio & { precio_sin_iva?: number | null },
  p: Parametros = {},
): boolean {
  const guardado = num(e.precio_sin_iva, 0);
  if (guardado <= 0) return false;
  if (baseDelPrecio(e) === "manual") return false;
  // Sin `precio_sin_iva`: si se lo pasáramos, `calcularPrecios` tomaría la rama
  // del override explícito y el precio coincidiría siempre consigo mismo.
  return coincide(guardado, calcularPrecios({ ...e, precio_sin_iva: null }, p).precio_sin_iva);
}

export const ORIGEN_LABEL: Record<OrigenPrecio, string> = {
  sugerido: "sugerido",
  costo: "costo",
  manual: "a mano",
};

export const ORIGEN_AYUDA: Record<OrigenPrecio, string> = {
  sugerido: "El precio de venta sale del precio sugerido al público + el markup.",
  costo: "El producto no tiene precio sugerido, así que la venta sale del costo + el markup.",
  manual: "El producto no tiene ni sugerido ni costo cargado: el precio está puesto a mano.",
};

// ---------------------------------------------------------------------------
// Operaciones masivas de precio
//
// El cálculo REAL lo hace la RPC `cambiar_precios_masivo` en SQL, en una
// transacción. Esto de acá es el ESPEJO para la vista previa: le muestra a la
// persona qué va a pasar antes de apretar el botón. Los dos tienen que dar lo
// mismo; si divergen, el que manda es el SQL y esto es un bug.
// Ver docs/superpowers/specs/2026-07-29-proveedor-en-productos-design.md §6.
// ---------------------------------------------------------------------------

export type OperacionPrecio = "MARKUP" | "AUMENTO" | "RECALCULAR_COSTO";

export const OPERACION_LABEL: Record<OperacionPrecio, string> = {
  MARKUP: "Poner markup",
  AUMENTO: "Aumentar los precios",
  RECALCULAR_COSTO: "Recalcular el costo",
};

export type ProductoOperable = EntradaPrecio & {
  precio_lista?: number | null;
  precio_sin_iva?: number | null;
  /** El del producto. null = hereda el del proveedor. */
  descuento_porcentaje?: number | null;
  proveedor?: { descuento_porcentaje?: number | null } | null;
};

export type ResultadoOperacion = {
  precio_lista: number;
  precio_fabrica: number;
  precio_sugerido_publico: number | null;
  precio_sin_iva: number;
  venta_c_iva: number;
  /** Tiene alguna base sobre la que operar. Si no, se saltea. */
  con_base: boolean;
  /** El precio guardado lo explicaba la fórmula (o sea: no estaba puesto a mano). */
  derivado: boolean;
  /** Esta operación le cambia algo. La RPC cuenta aparte los que no cambian. */
  cambia: boolean;
};

export function simularOperacion(
  p: ProductoOperable,
  op: OperacionPrecio,
  pct: number,
  ctx: { markupDefault?: number | null; descuentoGlobal?: number | null } = {},
): ResultadoOperacion {
  const factor = 1 + num(pct, 0) / 100;
  const lista = num(p.precio_lista, 0);
  const costo = num(p.precio_fabrica, 0);
  const sugerido = num(p.precio_sugerido_publico, 0);
  const descuento = descuentoEfectivo(p, p.proveedor, {
    descuento_proveedor_porcentaje: ctx.descuentoGlobal,
  });
  const markupViejo = markupEfectivo(p, { markupDefault: ctx.markupDefault });
  const markupNuevo = op === "MARKUP" ? num(pct, markupViejo) : markupViejo;

  const con_base = lista > 0 || costo > 0 || sugerido > 0;
  const derivado = coincideConFormula(p, { markupDefault: ctx.markupDefault });

  const listaNueva = op === "AUMENTO" && lista > 0 ? r2(lista * factor) : lista;
  const sugeridoNuevo =
    op === "AUMENTO" && sugerido > 0
      ? r2(sugerido * factor)
      : p.precio_sugerido_publico == null
        ? null
        : sugerido;

  // El costo se RE-DERIVA desde la lista siempre que haya lista: multiplicar el
  // costo guardado propagaría cualquier error que ya tuviera (un descuento
  // equivocado, una edición a mano). Sin lista, la única base es el costo.
  let costoNuevo = costo;
  if ((op === "AUMENTO" || op === "RECALCULAR_COSTO") && listaNueva > 0) {
    costoNuevo = costoDeLista(listaNueva, descuento);
  } else if (op === "AUMENTO" && lista === 0 && costo > 0) {
    costoNuevo = r2(costo * factor);
  }

  const calc = calcularPrecios(
    {
      precio_fabrica: costoNuevo,
      precio_sugerido_publico: sugeridoNuevo,
      markup_porcentaje: markupNuevo,
      iva_porcentaje: p.iva_porcentaje,
    },
    { markupDefault: ctx.markupDefault },
  );

  // Un precio puesto a mano se conserva: la operación mueve los precios que
  // vienen del proveedor, no la decisión comercial de quien lo escribió.
  const ventaNueva =
    derivado && calc.precio_sin_iva > 0 ? calc.precio_sin_iva : num(p.precio_sin_iva, 0);
  const iva = normalizarIva(p.iva_porcentaje);

  const aplica = con_base || op === "MARKUP";
  const salida = {
    precio_lista: aplica ? listaNueva : lista,
    precio_fabrica: aplica ? costoNuevo : costo,
    precio_sugerido_publico: aplica ? sugeridoNuevo : (p.precio_sugerido_publico ?? null),
    precio_sin_iva: aplica ? ventaNueva : num(p.precio_sin_iva, 0),
  };
  return {
    ...salida,
    venta_c_iva: r2(salida.precio_sin_iva * (1 + iva / 100)),
    con_base,
    derivado,
    cambia:
      salida.precio_lista !== lista ||
      salida.precio_fabrica !== costo ||
      salida.precio_sugerido_publico !== (p.precio_sugerido_publico ?? null) ||
      salida.precio_sin_iva !== num(p.precio_sin_iva, 0) ||
      (op === "MARKUP" && num(pct, markupViejo) !== num(p.markup_porcentaje, NaN)),
  };
}
