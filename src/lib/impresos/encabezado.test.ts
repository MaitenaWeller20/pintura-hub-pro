import { describe, it, expect, vi } from "vitest";
import { armarEncabezado, dibujarEncabezado } from "./encabezado";

const generalPaz = {
  nombre: "CasaForma General Paz",
  direccion: "Sarmiento 1398 - B° Gral Paz - Córdoba",
  telefono: "3513229459",
  emisor: { razon_social: "Aplicaciones y Servicios SRL" },
};

const ohiggins = {
  nombre: "CasaForma O'Higgins",
  direccion: "O'Higgins 5450 - Córdoba",
  telefono: "3512146766",
  emisor: { razon_social: "Grupo Casa Forma SAS" },
};

describe("armarEncabezado", () => {
  it("pone la razón social de la sucursal, no un nombre fijo", () => {
    expect(armarEncabezado(generalPaz).titulo).toBe("Aplicaciones y Servicios SRL");
    expect(armarEncabezado(ohiggins).titulo).toBe("Grupo Casa Forma SAS");
  });

  it("saca la dirección y el celular, que es lo que pidió Leo", () => {
    const { lineas } = armarEncabezado(generalPaz);
    expect(lineas).toContain("Sarmiento 1398 - B° Gral Paz - Córdoba");
    expect(lineas).toContain("Cel: 3513229459");
  });

  // Cada sucursal pertenece a UN emisor, así que esto no puede pasar por
  // construcción — pero es la garantía que importa: el impreso no puede decir
  // "Aplicaciones y Servicios SRL" con el teléfono de la otra sociedad.
  it("nunca mezcla los datos de las dos sociedades", () => {
    const gp = armarEncabezado(generalPaz);
    expect(gp.lineas.join(" ")).not.toContain("3512146766");
    expect(gp.lineas.join(" ")).not.toContain("O'Higgins 5450");

    const oh = armarEncabezado(ohiggins);
    expect(oh.lineas.join(" ")).not.toContain("3513229459");
    expect(oh.lineas.join(" ")).not.toContain("Sarmiento");
  });

  it("el mail no va: Leo dijo que no hace falta", () => {
    const conMail = { ...generalPaz, emisor: { ...generalPaz.emisor, email: "info@casa-forma.com" } };
    expect(JSON.stringify(armarEncabezado(conMail))).not.toContain("info@");
  });

  it("muestra el CUIT cuando esté cargado, y no una línea vacía cuando no", () => {
    expect(armarEncabezado(generalPaz).lineas.some((l) => l.startsWith("CUIT"))).toBe(false);
    const conCuit = { ...generalPaz, emisor: { ...generalPaz.emisor, cuit: "30712345678" } };
    expect(armarEncabezado(conCuit).lineas).toContain("CUIT: 30712345678");
  });

  it("no repite el nombre del local si ya es el título", () => {
    const igual = { nombre: "ACME", direccion: "Calle 1", telefono: null, emisor: null };
    expect(armarEncabezado(igual).lineas.some((l) => l.startsWith("Sucursal"))).toBe(false);
  });

  it("aguanta que todavía no haya emisor cargado", () => {
    const sinEmisor = { nombre: "CasaForma O'Higgins", direccion: null, telefono: null };
    expect(armarEncabezado(sinEmisor).titulo).toBe("CasaForma O'Higgins");
    expect(armarEncabezado(sinEmisor).lineas).toEqual([]);
  });

  it("aguanta que no haya nada", () => {
    expect(armarEncabezado(null).titulo).toBe("CasaForma");
    expect(armarEncabezado(undefined).lineas).toEqual([]);
  });
});

/** Un doble de jsPDF que anota lo que se le pidió dibujar. */
function docFalso() {
  const escrito: Array<{ t: string; y: number }> = [];
  return {
    escrito,
    imagenes: [] as string[],
    setFontSize: () => {},
    text: (t: string, _x: number, y: number) => escrito.push({ t, y }),
    // Parte cada 30 caracteres, que alcanza para ver que mide.
    splitTextToSize: (t: string) => t.match(/.{1,30}/g) ?? [t],
    addImage: function (dato: string) {
      this.imagenes.push(dato);
    },
  };
}

describe("dibujarEncabezado", () => {
  it("devuelve la Y donde termina, para que el contenido no se pise", () => {
    const doc = docFalso();
    const fin = dibujarEncabezado(doc, generalPaz, { y: 16 });
    const ultima = Math.max(...doc.escrito.map((e) => e.y));
    expect(fin).toBeGreaterThanOrEqual(ultima);
  });

  // El bloque tenía alto fijo: con una razón social larga, el contenido de abajo
  // se le montaba encima. Ahora tiene que empujar.
  it("una razón social larga empuja el contenido hacia abajo", () => {
    const corto = dibujarEncabezado(docFalso(), generalPaz, { y: 16 });
    const largo = dibujarEncabezado(
      docFalso(),
      { ...generalPaz, emisor: { razon_social: "A".repeat(120) } },
      { y: 16 },
    );
    expect(largo).toBeGreaterThan(corto);
  });

  it("y el logo también", () => {
    const sin = dibujarEncabezado(docFalso(), generalPaz, { y: 16 });
    const con = dibujarEncabezado(
      docFalso(),
      { ...generalPaz, emisor: { ...generalPaz.emisor, logo: "data:image/png;base64,AAAA" } },
      { y: 16 },
    );
    expect(con).toBeGreaterThan(sin);
  });

  // Que no salga el comprobante por un logo corrupto sería peor que el logo.
  it("un logo roto no impide que salga el comprobante", () => {
    const doc = docFalso();
    doc.addImage = vi.fn(() => {
      throw new Error("imagen inválida");
    });
    expect(() =>
      dibujarEncabezado(doc, { ...generalPaz, emisor: { ...generalPaz.emisor, logo: "roto" } }),
    ).not.toThrow();
    expect(doc.escrito.some((e) => e.t.includes("Aplicaciones"))).toBe(true);
  });
});
