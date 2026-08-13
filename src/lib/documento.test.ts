import { describe, it, expect } from "vitest";
import { fmtDocumento, coincideDocumento, filtroIlikeOr } from "./documento";

describe("fmtDocumento", () => {
  it("muestra el CUIT con guiones aunque esté guardado en dígitos", () => {
    expect(fmtDocumento("30715826077")).toBe("30-71582607-7");
  });

  it("acepta un CUIT que ya viene con guiones y lo deja prolijo", () => {
    expect(fmtDocumento("30-71582607-7")).toBe("30-71582607-7");
  });

  it("deja el DNI tal cual: nadie lo escribe con guiones", () => {
    expect(fmtDocumento("12345678")).toBe("12345678");
    expect(fmtDocumento("1234567")).toBe("1234567");
  });

  it("no toca los documentos con letras (pasaportes, placeholders legacy)", () => {
    expect(fmtDocumento("S/D")).toBe("S/D");
    expect(fmtDocumento("AAB123456")).toBe("AAB123456");
  });

  it("sin documento muestra el guión largo", () => {
    expect(fmtDocumento(null)).toBe("—");
    expect(fmtDocumento(undefined)).toBe("—");
    expect(fmtDocumento("")).toBe("—");
    expect(fmtDocumento("   ")).toBe("—");
  });
});

describe("coincideDocumento", () => {
  // El bug que originó todo esto: la ficha migrada estaba guardada
  // "30-71582607-7" y buscar "30715826077" no la encontraba, mientras el índice
  // único SÍ la veía como duplicada. Tiene que andar en los dos sentidos, sin
  // importar en qué formato quedó el dato ni cómo lo escriba la usuaria.
  const jvs = { razon_social: "JVS SRL", cuit_dni: "30715826077" };
  const migrado = { razon_social: "PERE LACHAISE SA", cuit_dni: "30-70804341-5" };

  it("encuentra por CUIT en dígitos un dato guardado en dígitos", () => {
    expect(coincideDocumento(jvs, "30715826077")).toBe(true);
  });

  it("encuentra por CUIT con guiones un dato guardado en dígitos", () => {
    expect(coincideDocumento(jvs, "30-71582607-7")).toBe(true);
  });

  it("encuentra por CUIT en dígitos un dato que quedó con guiones", () => {
    expect(coincideDocumento(migrado, "30708043415")).toBe(true);
  });

  it("encuentra por los dígitos del medio", () => {
    expect(coincideDocumento(jvs, "71582607")).toBe(true);
  });

  it("sigue encontrando por nombre, sin importar mayúsculas", () => {
    expect(coincideDocumento(jvs, "jvs")).toBe(true);
    expect(coincideDocumento(jvs, "SRL")).toBe(true);
  });

  it("no confunde a un cliente con otro", () => {
    expect(coincideDocumento(jvs, "30708043415")).toBe(false);
    expect(coincideDocumento(jvs, "PERE")).toBe(false);
  });

  it("con la búsqueda vacía entran todos", () => {
    expect(coincideDocumento(jvs, "")).toBe(true);
    expect(coincideDocumento(jvs, "   ")).toBe(true);
  });

  it("tolera fichas sin documento", () => {
    expect(coincideDocumento({ razon_social: "MOSTRADOR", cuit_dni: null }, "MOSTRADOR")).toBe(
      true,
    );
    expect(coincideDocumento({ razon_social: "MOSTRADOR", cuit_dni: null }, "30715826077")).toBe(
      false,
    );
  });

  it("un nombre con puntos no se confunde con un documento", () => {
    expect(coincideDocumento({ razon_social: "J.V.S. SRL", cuit_dni: null }, "J.V.S.")).toBe(true);
  });

  // El buscador viejo concatenaba "nombre documento" en un solo string. Eso se
  // conserva, si no se perderían las consultas que cruzan los dos campos cuando
  // el documento es alfanumérico y no aporta dígitos para comparar.
  it("sigue encontrando una consulta que cruza nombre y documento", () => {
    const alfa = { razon_social: "ACME", cuit_dni: "AAB123456" };
    expect(coincideDocumento(alfa, "ACME AAB")).toBe(true);
    expect(coincideDocumento(jvs, "JVS SRL 307")).toBe(true); // cruza los dos campos
    expect(coincideDocumento(jvs, "SRL 307")).toBe(true); // por dígitos
    expect(coincideDocumento(alfa, "ACME 999")).toBe(false); // no cruza nada
  });
});

describe("filtroIlikeOr", () => {
  it("arma el OR de PostgREST con el valor entre comillas", () => {
    expect(filtroIlikeOr([{ campo: "razon_social", valor: "JVS" }])).toBe(
      'razon_social.ilike."%JVS%"',
    );
  });

  it("combina varios campos con coma", () => {
    expect(
      filtroIlikeOr([
        { campo: "razon_social", valor: "JVS" },
        { campo: "cuit_dni", valor: "30715826077" },
      ]),
    ).toBe('razon_social.ilike."%JVS%",cuit_dni.ilike."%30715826077%"');
  });

  // Hoy "SANCHEZ, JUAN" rompe la búsqueda: la coma se interpola cruda en la
  // expresión del filtro y PostgREST la lee como separador de condiciones.
  it("una coma en el nombre no parte la expresión", () => {
    expect(filtroIlikeOr([{ campo: "razon_social", valor: "SANCHEZ, JUAN" }])).toBe(
      'razon_social.ilike."%SANCHEZ, JUAN%"',
    );
  });

  it("escapa las comillas dobles", () => {
    expect(filtroIlikeOr([{ campo: "razon_social", valor: 'EL "PINTOR"' }])).toBe(
      String.raw`razon_social.ilike."%EL \"PINTOR\"%"`,
    );
  });

  // Dos escapados encadenados: primero el comodín de LIKE, después la gramática
  // de PostgREST. Verificado contra un PostgREST real: sin el primero, buscar
  // "A_B" traía además "A\B" y "AXB", y "A\BARRA" no traía nada.
  it("escapa los comodines de LIKE para que se busquen literales", () => {
    expect(filtroIlikeOr([{ campo: "razon_social", valor: "A\\B" }])).toBe(
      String.raw`razon_social.ilike."%A\\\\B%"`,
    );
    expect(filtroIlikeOr([{ campo: "razon_social", valor: "A_B" }])).toBe(
      String.raw`razon_social.ilike."%A\\_B%"`,
    );
    expect(filtroIlikeOr([{ campo: "razon_social", valor: "50%DTO" }])).toBe(
      String.raw`razon_social.ilike."%50\\%DTO%"`,
    );
  });

  it("no se rompe con el resto de la sintaxis reservada de PostgREST", () => {
    for (const v of ["(", ")", ".", ":", "*", "%", "_", "a,b(c).d"]) {
      const f = filtroIlikeOr([{ campo: "razon_social", valor: v }]);
      expect(f.startsWith('razon_social.ilike."%')).toBe(true);
      expect(f.endsWith('%"')).toBe(true);
    }
  });

  it("descarta los campos sin valor en vez de traer todo", () => {
    expect(
      filtroIlikeOr([
        { campo: "razon_social", valor: "JVS" },
        { campo: "cuit_dni", valor: "" },
      ]),
    ).toBe('razon_social.ilike."%JVS%"');
    expect(filtroIlikeOr([{ campo: "razon_social", valor: "" }])).toBe("");
  });
});
