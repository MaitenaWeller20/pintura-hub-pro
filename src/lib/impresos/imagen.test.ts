import { describe, it, expect } from "vitest";
import { bytesDeDataUrl, medirImagen } from "./imagen";

/** Un data URL de PNG con el ancho y alto que se le pidan. */
function pngFalso(ancho: number, alto: number, opciones: { ihdr?: boolean } = {}): string {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // firma
  b.set([0, 0, 0, 13], 8); // largo del chunk
  b.set(
    opciones.ihdr === false ? [0x74, 0x45, 0x58, 0x74] : [0x49, 0x48, 0x44, 0x52], // "IHDR" o "tEXt"
    12,
  );
  const escribir32 = (n: number, o: number) => {
    b[o] = (n >>> 24) & 255;
    b[o + 1] = (n >>> 16) & 255;
    b[o + 2] = (n >>> 8) & 255;
    b[o + 3] = n & 255;
  };
  escribir32(ancho, 16);
  escribir32(alto, 20);
  return "data:image/png;base64," + btoa(String.fromCharCode(...b));
}

/** Un JPEG mínimo con un SOF0 que declara el tamaño. */
function jpegFalso(ancho: number, alto: number): string {
  const b = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]; // SOI + APP0 vacío
  b.push(
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (alto >> 8) & 255,
    alto & 255,
    (ancho >> 8) & 255,
    ancho & 255,
  );
  return "data:image/jpeg;base64," + btoa(String.fromCharCode(...b));
}

describe("medirImagen", () => {
  it("saca el tamaño de un PNG", () => {
    expect(medirImagen(bytesDeDataUrl(pngFalso(800, 600)))).toEqual({
      ancho: 800,
      alto: 600,
      tipo: "png",
    });
  });

  it("saca el tamaño de un JPEG", () => {
    expect(medirImagen(bytesDeDataUrl(jpegFalso(1024, 768)))).toEqual({
      ancho: 1024,
      alto: 768,
      tipo: "jpeg",
    });
  });

  // El agujero que tenía la primera versión del validador: miraba sólo los
  // primeros bytes, así que basura con la firma correcta pasaba y se guardaba.
  it("rechaza basura que arranca con la firma de PNG", () => {
    const b = new Uint8Array(40);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b.fill(0x41, 8); // "AAAA…": firma válida, contenido inventado
    const url = "data:image/png;base64," + btoa(String.fromCharCode(...b));
    expect(medirImagen(bytesDeDataUrl(url))).toBeNull();
  });

  it("rechaza un PNG cuyo primer chunk no es el IHDR", () => {
    expect(medirImagen(bytesDeDataUrl(pngFalso(10, 10, { ihdr: false })))).toBeNull();
  });

  it("rechaza un PNG que dice medir cero", () => {
    expect(medirImagen(bytesDeDataUrl(pngFalso(0, 100)))).toBeNull();
  });

  it("rechaza lo que no es imagen", () => {
    expect(medirImagen(bytesDeDataUrl("data:image/png;base64," + btoa("hola mundo")))).toBeNull();
    expect(medirImagen(bytesDeDataUrl("data:text/plain;base64," + btoa("x")))).toBeNull();
  });

  it("no se cuelga con un base64 roto ni con datos cortos", () => {
    expect(bytesDeDataUrl("data:image/png;base64,@@@no-es-base64@@@")).toBeNull();
    expect(bytesDeDataUrl("sin coma")).toBeNull();
    expect(medirImagen(null)).toBeNull();
    expect(medirImagen(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  // Un JPEG con una longitud de segmento inválida haría un bucle infinito si no
  // se corta: el índice no avanzaría.
  it("no entra en bucle con un JPEG de segmento inválido", () => {
    const b = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const url = "data:image/jpeg;base64," + btoa(String.fromCharCode(...b));
    expect(medirImagen(bytesDeDataUrl(url))).toBeNull();
  });

  it("sirve para frenar un logo gigante, que es para lo que se usa", () => {
    const enorme = medirImagen(bytesDeDataUrl(pngFalso(4000, 3000)))!;
    expect(Math.max(enorme.ancho, enorme.alto)).toBeGreaterThan(1000);
  });
});
