/**
 * Mirar una imagen sin decodificarla.
 *
 * El validador del logo miraba sólo los primeros bytes: una cadena que empezara
 * con la firma de PNG y siguiera con basura pasaba igual y se guardaba. Y un PNG
 * legítimo de 4000×4000 también pasaba, aunque después infle cada PDF.
 *
 * Esto lee las cabeceras de verdad —el chunk IHDR de PNG, el marcador SOFn de
 * JPEG— y saca el ancho y el alto. No decodifica los píxeles: no hace falta para
 * lo que se quiere saber, y evita meter una dependencia de imágenes en el
 * servidor.
 */

export type Medidas = { ancho: number; alto: number; tipo: "png" | "jpeg" };

/** Los bytes de un data URL `data:image/...;base64,...`. */
export function bytesDeDataUrl(dataUrl: string): Uint8Array | null {
  const coma = dataUrl.indexOf(",");
  if (coma < 0) return null;
  try {
    const bin = atob(dataUrl.slice(coma + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const FIRMA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Ancho y alto, o null si no es un PNG/JPEG que se pueda leer.
 *
 * Devolver null es la respuesta correcta para "esto no es una imagen": el que
 * llama decide si eso es un error.
 */
export function medirImagen(bytes: Uint8Array | null): Medidas | null {
  if (!bytes || bytes.length < 16) return null;

  // ---- PNG: la firma, y después el chunk IHDR con el tamaño en big-endian.
  if (FIRMA_PNG.every((b, i) => bytes[i] === b)) {
    // El IHDR tiene que ser el PRIMER chunk. Si no está, el archivo está roto
    // aunque la firma esté bien — que es justamente el caso que se escapaba.
    const esIhdr =
      bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
    if (!esIhdr || bytes.length < 24) return null;
    const leer32 = (o: number) =>
      ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    const ancho = leer32(16);
    const alto = leer32(20);
    if (!ancho || !alto) return null;
    return { ancho, alto, tipo: "png" };
  }

  // ---- JPEG: se recorren los marcadores hasta encontrar un SOFn, que trae el
  // tamaño. Los SOF válidos son C0..CF menos C4 (Huffman), C8 y CC.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    // i + 8 y no i + 9: el byte más lejano que se lee de un SOF es bytes[i + 8]
    // (el low del ancho). Con i + 9 se rechazaba un JPEG mínimo válido, que es
    // justo el que usa la prueba.
    while (i + 8 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marca = bytes[i + 1];
      if (marca >= 0xc0 && marca <= 0xcf && marca !== 0xc4 && marca !== 0xc8 && marca !== 0xcc) {
        const alto = (bytes[i + 5] << 8) | bytes[i + 6];
        const ancho = (bytes[i + 7] << 8) | bytes[i + 8];
        if (!ancho || !alto) return null;
        return { ancho, alto, tipo: "jpeg" };
      }
      const largo = (bytes[i + 2] << 8) | bytes[i + 3];
      if (largo < 2) return null; // longitud inválida: archivo roto
      i += 2 + largo;
    }
    return null;
  }

  return null;
}
