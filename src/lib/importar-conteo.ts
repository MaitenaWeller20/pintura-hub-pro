// Llenar el conteo físico desde un archivo, en vez de tipear 1600 renglones.
//
// Esto NO abre una vía nueva de escritura de stock. Desde el 24/07 hay un solo
// camino que toca `stock_sucursal` —las RPC que además escriben kardex— y este
// módulo se limita a llenar el mapa `producto_id → cantidad` que el modo conteo
// de /stock ya le manda a `ajustar_stock_masivo`. Lo que se agrega es una forma
// de cargar el formulario; la salida es la misma de siempre.
// Ver docs/superpowers/specs/2026-08-03-importar-conteo-design.md
//
// El caso que lo motivó: la clienta migra desde 3C Informática y su inventario
// real son dos reportes de ~1600 productos por sucursal.

import { normalizar, parseNumAr } from "./importar-productos";

/** Tope de `ajustar_stock_masivo`. Se replica para avisar ANTES de mandar. */
export const TOPE_ITEMS = 2000;

export type Columnas = {
  codigo: string | null;
  cantidad: string | null;
  /** Opcionales: sólo vienen en los CSV que genera el conversor de PDF. */
  deposito: string | null;
  fecha: string | null;
};

const SINONIMOS_CONTEO: Record<keyof Columnas, string[]> = {
  codigo: ["codigo", "cod", "codarticulo", "articulo", "sku", "codproducto"],
  cantidad: ["existencia", "cantidad", "cant", "stock", "contado", "conteo", "existencias"],
  deposito: ["deposito", "sucursal", "almacen"],
  fecha: ["fechasnapshot", "fecha", "fechareporte", "alafecha"],
};

/**
 * Adivina qué columna es cuál mirando los encabezados.
 *
 * Devuelve `null` en lo que no reconoce: la pantalla ofrece elegirlas a mano.
 * Adivinar mal en silencio sería peor que no adivinar — el código y la cantidad
 * son justamente los dos datos que no se pueden equivocar.
 */
export function detectarColumnas(encabezados: string[]): Columnas {
  const out: Columnas = { codigo: null, cantidad: null, deposito: null, fecha: null };
  for (const campo of Object.keys(SINONIMOS_CONTEO) as Array<keyof Columnas>) {
    const sinonimos = SINONIMOS_CONTEO[campo];
    // Primero coincidencia exacta del encabezado normalizado; recién después
    // "contiene". Sin ese orden, "Cód. Articulo" se llevaría la columna
    // "Articulo" y "Existencia" perdería contra "Días s/ Existencia".
    const exacto = encabezados.find((h) => sinonimos.includes(normalizar(h)));
    out[campo] =
      exacto ?? encabezados.find((h) => sinonimos.some((s) => normalizar(h) === s)) ?? null;
    if (!out[campo]) {
      out[campo] = encabezados.find((h) => sinonimos.some((s) => normalizar(h).startsWith(s))) ?? null;
    }
  }
  return out;
}

export type ProductoCatalogo = { producto_id: string; codigo: string };

export type ItemVolcado = { producto_id: string; codigo: string; cantidad: number };

export type Opciones = {
  /** Los que vienen en negativo se cargan como 0. Default: NO. */
  negativosComoCero: boolean;
  /**
   * El archivo es el inventario COMPLETO de la sucursal: lo que no figura se
   * cuenta como 0. Default: NO (el archivo no afirma nada sobre lo que no lista).
   */
  archivoCompleto: boolean;
};

export type Resultado = {
  filasLeidas: number;
  aVolcar: ItemVolcado[];
  /** Códigos del archivo que no existen en el catálogo de esta sucursal. */
  noEncontrados: Array<{ codigo: string; cantidad: string }>;
  /** Códigos que aparecen más de una vez en el archivo. NUNCA se vuelcan. */
  repetidos: string[];
  /** La cantidad no es un número. */
  ilegibles: Array<{ codigo: string; valor: string }>;
  /** Vienen en negativo. Se vuelcan como 0 sólo si `negativosComoCero`. */
  negativos: Array<{ codigo: string; valor: number }>;
  /** Filas sin código: en el reporte de 3C hay una fila fantasma por archivo. */
  sinCodigo: number;
  /** Del catálogo de la sucursal que NO están en el archivo. */
  faltantesDelCatalogo: number;
  /** Lo que declara el archivo, si trae esas columnas. */
  deposito: string | null;
  fechaSnapshot: string | null;
  /** El archivo mezcla depósitos: es un error, no se puede volcar. */
  depositosMezclados: boolean;
  /** Supera el tope de la RPC. */
  excedeTope: boolean;
};

/** Un código se compara sin espacios de sobra y sin distinguir mayúsculas. */
const claveCodigo = (s: unknown) => String(s ?? "").trim().toLowerCase();

const texto = (v: unknown) => String(v ?? "").trim();

/**
 * Cruza el archivo contra el catálogo y arma el volcado.
 *
 * DELIBERADAMENTE no hace match "flexible" (sacar guiones, puntos o ceros a la
 * izquierda). En el archivo real conviven dos familias de código —`1001-00100` y
 * `101.01.001`— y aplastarlas subiría los matches a costa de poder asignarle el
 * stock al producto equivocado. Un producto sin match se ve en el resumen y se
 * arregla; un match equivocado queda enterrado en el inventario durante meses.
 */
export function procesarConteo(
  filas: Array<Record<string, unknown>>,
  cols: Columnas,
  catalogo: ProductoCatalogo[],
  opciones: Opciones,
): Resultado {
  // El índice del catálogo es case-insensitive, así que dos productos que sólo
  // difieran en mayúsculas colisionarían y el segundo pisaría al primero: le
  // asignaríamos el stock al producto equivocado, en silencio. La base sólo
  // garantiza `codigo UNIQUE` (sensible a mayúsculas), así que la barrera va
  // acá: las claves ambiguas se sacan del índice y quedan como "no encontrado",
  // que es visible.
  const porCodigo = new Map<string, ProductoCatalogo>();
  const ambiguos = new Set<string>();
  for (const p of catalogo) {
    const k = claveCodigo(p.codigo);
    if (porCodigo.has(k)) ambiguos.add(k);
    porCodigo.set(k, p);
  }
  for (const k of ambiguos) porCodigo.delete(k);

  const vistos = new Map<string, number>();
  const depositos = new Set<string>();
  let fechaSnapshot: string | null = null;
  let sinCodigo = 0;

  // Primera pasada: contar apariciones para detectar repetidos ANTES de decidir
  // qué se vuelca. Si se resolviera sobre la marcha, el primero entraría y el
  // segundo no, que es exactamente la ambigüedad que se quiere evitar.
  for (const f of filas) {
    const cod = claveCodigo(cols.codigo ? f[cols.codigo] : "");
    if (!cod || cod === "-") continue;
    vistos.set(cod, (vistos.get(cod) ?? 0) + 1);
  }

  const aVolcar: ItemVolcado[] = [];
  const noEncontrados: Resultado["noEncontrados"] = [];
  const ilegibles: Resultado["ilegibles"] = [];
  const negativos: Resultado["negativos"] = [];
  const repetidos = new Set<string>();
  /** Se pudo mandar al conteo. */
  const yaVolcado = new Set<string>();
  /**
   * VINO EN EL ARCHIVO, sin importar si se pudo usar.
   *
   * Es distinto de `yaVolcado` y la diferencia es la que evita borrar stock: un
   * producto repetido, ilegible o negativo-sin-tildar NO se vuelca, pero SÍ
   * estaba en el archivo. Si "inventario completo" se guiara por `yaVolcado`,
   * esos productos caerían en la bolsa de "no vinieron" y se escribirían en 0 —
   * justo los que la pantalla promete no tocar.
   */
  const vinoEnArchivo = new Set<string>();

  for (const f of filas) {
    if (cols.deposito) {
      const d = texto(f[cols.deposito]);
      if (d) depositos.add(d);
    }
    if (cols.fecha && !fechaSnapshot) {
      const v = texto(f[cols.fecha]);
      if (v) fechaSnapshot = v;
    }

    const codBruto = cols.codigo ? texto(f[cols.codigo]) : "";
    const cod = claveCodigo(codBruto);
    // La fila fantasma del reporte de 3C tiene código literal "-" y una cantidad
    // grande y negativa. No es un producto: no es un error, es ruido.
    if (!cod || cod === "-") {
      sinCodigo++;
      continue;
    }

    vinoEnArchivo.add(cod);

    if ((vistos.get(cod) ?? 0) > 1) {
      repetidos.add(codBruto);
      continue;
    }

    const prod = porCodigo.get(cod);
    const crudo = cols.cantidad ? texto(f[cols.cantidad]) : "";
    const n = parseNumAr(crudo);

    if (!Number.isFinite(n)) {
      ilegibles.push({ codigo: codBruto, valor: crudo });
      continue;
    }
    if (!prod) {
      noEncontrados.push({ codigo: codBruto, cantidad: crudo });
      continue;
    }
    if (n < 0) {
      negativos.push({ codigo: codBruto, valor: n });
      if (!opciones.negativosComoCero) continue;
      aVolcar.push({ producto_id: prod.producto_id, codigo: prod.codigo, cantidad: 0 });
      yaVolcado.add(cod);
      continue;
    }

    aVolcar.push({ producto_id: prod.producto_id, codigo: prod.codigo, cantidad: n });
    yaVolcado.add(cod);
  }

  const faltantesDelCatalogo = catalogo.filter(
    (p) => !vinoEnArchivo.has(claveCodigo(p.codigo)),
  ).length;

  // "Inventario completo": lo que el archivo no lista es porque no hay. Sólo si
  // la persona lo afirma explícitamente — por omisión el archivo no dice nada
  // sobre lo que no menciona, y poner ceros por las dudas borraría stock.
  if (opciones.archivoCompleto) {
    for (const p of catalogo) {
      // `vinoEnArchivo`, NO `yaVolcado`: ver el comentario de arriba.
      if (vinoEnArchivo.has(claveCodigo(p.codigo))) continue;
      aVolcar.push({ producto_id: p.producto_id, codigo: p.codigo, cantidad: 0 });
      yaVolcado.add(claveCodigo(p.codigo));
    }
  }

  return {
    filasLeidas: filas.length,
    aVolcar,
    noEncontrados,
    repetidos: [...repetidos],
    ilegibles,
    negativos,
    sinCodigo,
    faltantesDelCatalogo,
    deposito: depositos.size === 1 ? [...depositos][0] : null,
    fechaSnapshot,
    depositosMezclados: depositos.size > 1,
    excedeTope: aVolcar.length > TOPE_ITEMS,
  };
}

/** Para el CSV descargable de "no encontrados". */
export function aCsv(filas: Array<Record<string, string | number>>): string {
  if (filas.length === 0) return "";
  const cols = Object.keys(filas[0]);
  const escapar = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...filas.map((f) => cols.map((c) => escapar(f[c])).join(","))].join("\n");
}
