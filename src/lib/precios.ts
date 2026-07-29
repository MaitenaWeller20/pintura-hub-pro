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
/** Descuento comercial de Quimex. Sólo se usa si `settings` no está disponible. */
export const DESCUENTO_PROVEEDOR_DEFAULT = 42;
/** Las únicas alícuotas que acepta AFIP (y el CHECK de la tabla). */
export const ALICUOTAS_IVA = [0, 2.5, 5, 10.5, 21, 27] as const;

/** Dos productos con el mismo precio pueden diferir un centavo por redondeo. */
const CENTAVO = 0.01;

const r2 = (n: number) => +n.toFixed(2);

const num = (v: unknown, def: number): number => {
  if (v === null || v === undefined || v === "") return def;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : def;
};

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

  let precio_sin_iva: number;
  if (explicito > 0) precio_sin_iva = r2(explicito);
  else if (sugerido > 0) precio_sin_iva = r2((sugerido * factorMk) / factorIva);
  else precio_sin_iva = r2(costo * factorMk);

  return {
    costo_c_iva: r2(costo * factorIva),
    precio_sin_iva,
    venta_c_iva: r2(precio_sin_iva * factorIva),
    markup,
    // El origen se DECIDE comparando, no suponiendo: así un precio explícito que
    // igual coincide con la fórmula se reporta como derivado, y uno que no
    // coincide se reporta como manual. Una sola definición de "de dónde salió".
    origen: origenDelPrecio({ ...e, precio_sin_iva }, p),
  };
}

const coincide = (a: number, b: number) => Math.abs(r2(a) - r2(b)) <= CENTAVO + 1e-9;

/**
 * Qué explica el precio YA guardado de un producto.
 *
 * No es lo mismo que "tiene sugerido". El diálogo de productos deja escribir el
 * precio de venta a mano y el alta rápida de Ingresos de mercadería crea productos
 * poniendo el neto directo, sin lista ni costo ni sugerido: los dos son caminos
 * legítimos. Lo que no puede pasar es que la tabla muestre "sug." sobre un precio
 * que el sugerido no explica. Por eso se compara contra la fórmula en vez de
 * asumir.
 */
export function origenDelPrecio(
  e: EntradaPrecio & { precio_sin_iva?: number | null },
  p: Parametros = {},
): OrigenPrecio {
  const markup = markupEfectivo(e, p);
  const iva = normalizarIva(e.iva_porcentaje);
  const factorIva = 1 + iva / 100;
  const factorMk = 1 + markup / 100;

  const actual = num(e.precio_sin_iva, 0);
  const sugerido = num(e.precio_sugerido_publico, 0);
  const costo = num(e.precio_fabrica, 0);

  if (sugerido > 0 && coincide(actual, (sugerido * factorMk) / factorIva)) return "sugerido";
  if (costo > 0 && coincide(actual, costo * factorMk)) return "costo";
  return "manual";
}

export const ORIGEN_LABEL: Record<OrigenPrecio, string> = {
  sugerido: "sug.",
  costo: "costo",
  manual: "manual",
};
