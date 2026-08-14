/**
 * El encabezado de los impresos comerciales: presupuestos y remitos.
 *
 * Pedido de Leo: que salgan los datos —dirección y celular— como salían en el
 * sistema viejo. Antes los dos PDF leían el emisor de `fiscal_config`, que en
 * producción está entero en NULL, así que salían pelados.
 *
 * De dónde salen los datos ahora: de la SUCURSAL y de su emisor
 * (`sucursales.emisor_id` → `emisores`). Son dos personas jurídicas distintas —
 * una SRL y una SAS— y cada local pertenece a una, así que el encabezado no puede
 * mezclar la razón social de una con el teléfono de la otra.
 *
 * OJO: esto NO es para la factura. Una factura con CAE se reimprime desde su
 * `afip_snapshot`, que es lo que se declaró a AFIP, y eso ya lo resuelve
 * `datosFiscalesComprobante`. Meter acá una segunda fuente haría que una factura
 * vieja cambiara de emisor el día que se configure AFIP.
 */

export type EmisorImpreso = {
  razon_social?: string | null;
  cuit?: string | null;
  domicilio_fiscal?: string | null;
  logo?: string | null;
};

export type SucursalImpresa = {
  nombre?: string | null;
  direccion?: string | null;
  telefono?: string | null;
  emisor?: EmisorImpreso | null;
};

export type Encabezado = {
  /** La razón social, o el nombre de la sucursal si todavía no se cargó. */
  titulo: string;
  /** Las líneas de abajo, ya sin las vacías. */
  lineas: string[];
  /** El logo como data URL, si hay. */
  logo: string | null;
};

/**
 * Qué texto va en el encabezado. Separado del dibujo para poder probarlo sin
 * jsPDF.
 *
 * La dirección sale de la sucursal y no del domicilio fiscal del emisor: son el
 * mismo dato hoy, pero el día que difieran, en un presupuesto interesa a dónde ir
 * a buscar la mercadería, no dónde está inscripta la sociedad.
 */
export function armarEncabezado(sucursal: SucursalImpresa | null | undefined): Encabezado {
  const e = sucursal?.emisor ?? null;
  const titulo = (e?.razon_social ?? "").trim() || (sucursal?.nombre ?? "").trim() || "CasaForma";

  const direccion = (sucursal?.direccion ?? e?.domicilio_fiscal ?? "").trim();
  const telefono = (sucursal?.telefono ?? "").trim();
  const cuit = (e?.cuit ?? "").trim();

  const lineas = [
    direccion || null,
    // En una sola línea, como en el impreso viejo. El mail no va: Leo dijo que
    // no hace falta.
    telefono ? `Cel: ${telefono}` : null,
    cuit ? `CUIT: ${cuit}` : null,
    // El nombre del local sólo si aporta algo que no esté ya dicho.
    sucursal?.nombre && sucursal.nombre.trim() !== titulo ? `Sucursal: ${sucursal.nombre}` : null,
  ].filter((l): l is string => !!l);

  return { titulo, lineas, logo: e?.logo?.trim() || null };
}

/** Lo mínimo que necesita este módulo de jsPDF, para no atarse al tipo entero. */
type DocPdf = {
  setFontSize: (n: number) => void;
  text: (t: string, x: number, y: number, o?: Record<string, unknown>) => void;
  splitTextToSize: (t: string, ancho: number) => string[];
  addImage: (dato: string, formato: string, x: number, y: number, w: number, h: number) => void;
};

const ALTO_LOGO = 16;
const ANCHO_LOGO = 32;

/**
 * Dibuja el encabezado y devuelve la Y donde puede seguir el contenido.
 *
 * Devuelve la Y medida y no una constante a propósito: el bloque del emisor
 * tenía alto fijo, y con un logo, un teléfono y una razón social larga se pisaba
 * con lo que venía abajo. Ahora el que llama sigue donde este termina.
 */
export function dibujarEncabezado(
  doc: DocPdf,
  sucursal: SucursalImpresa | null | undefined,
  opciones: { x?: number; y?: number; ancho?: number } = {},
): number {
  const { titulo, lineas, logo } = armarEncabezado(sucursal);
  const x = opciones.x ?? 14;
  const anchoTexto = opciones.ancho ?? 120;
  let y = opciones.y ?? 16;

  if (logo) {
    try {
      doc.addImage(logo, "PNG", x, y - 6, ANCHO_LOGO, ALTO_LOGO);
      y += ALTO_LOGO + 2;
    } catch {
      // Un logo roto no puede impedir que salga el comprobante.
    }
  }

  doc.setFontSize(14);
  // El título también se parte: "Aplicaciones y Servicios SRL" entra, pero una
  // razón social más larga se saldría de la hoja.
  for (const linea of doc.splitTextToSize(titulo, anchoTexto)) {
    doc.text(linea, x, y);
    y += 6;
  }

  doc.setFontSize(9);
  for (const l of lineas) {
    for (const linea of doc.splitTextToSize(l, anchoTexto)) {
      doc.text(linea, x, y);
      y += 4.5;
    }
  }

  return y;
}

/**
 * Lo que hay que pedirle a PostgREST para armar el encabezado.
 *
 * SIN el logo a propósito. El logo es una data URL de hasta 100 KB, y esto se usa
 * en consultas de LISTADO —el listado de remitos trae todos los remitos con su
 * sucursal de origen— así que incluirlo repetía 100 KB por fila y los dejaba en
 * la caché de react-query. Se pide aparte, sólo al momento de imprimir, con
 * `traerLogo`.
 */
export const SELECT_SUCURSAL_IMPRESA =
  "nombre, direccion, telefono, emisor:emisores(id, razon_social, cuit, domicilio_fiscal)";

/**
 * El logo del emisor, pedido en el momento de imprimir y no antes.
 *
 * Devuelve null ante cualquier problema: que no haya logo, o que falle la
 * consulta, no puede impedir que salga el comprobante.
 */
export async function traerLogo(
  supabase: { from: (t: string) => any },
  emisorId: string | null | undefined,
): Promise<string | null> {
  if (!emisorId) return null;
  try {
    const { data } = await supabase.from("emisores").select("logo").eq("id", emisorId).maybeSingle();
    return (data?.logo as string | null) ?? null;
  } catch {
    return null;
  }
}
