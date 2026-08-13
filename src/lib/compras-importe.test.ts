import { describe, it, expect } from "vitest";
import {
  calcularImporteCompra,
  faltanteCompra,
  modoIvaSugerido,
  paraRpc,
  redondearACentavos,
  type EntradaImporte,
} from "./compras-importe";

/**
 * Pesos → centavos, sin el ruido binario de `n * 100`.
 *
 * Los valores que devuelve el módulo ya son múltiplos exactos de un centavo, así
 * que esto sólo los pasa a entero para poder sumarlos sin punto flotante.
 */
const cent = (n: number) => Math.round(Number((n * 100).toPrecision(15)));

const entrada = (p: Partial<EntradaImporte> = {}): EntradaImporte => ({
  total: null,
  percepciones: 0,
  modoIva: "sin",
  tasaIva: 21,
  ivaManual: null,
  ...p,
});

describe("calcularImporteCompra", () => {
  it("desglosa el 21% de un total redondo", () => {
    const i = calcularImporteCompra(entrada({ total: 120000, modoIva: "tasa", tasaIva: 21 }));
    expect(i.neto).toBe(99173.55);
    expect(i.iva).toBe(20826.45);
    expect(i.percepciones).toBe(0);
    expect(i.error).toBeNull();
  });

  it("el caso de escuela: 121 con IVA 21 es 100 + 21", () => {
    const i = calcularImporteCompra(entrada({ total: 121, modoIva: "tasa", tasaIva: 21 }));
    expect(i.neto).toBe(100);
    expect(i.iva).toBe(21);
  });

  it("sin desglosar, el total es todo neto", () => {
    const i = calcularImporteCompra(entrada({ total: 100, modoIva: "sin" }));
    expect(i.neto).toBe(100);
    expect(i.iva).toBe(0);
  });

  it("las percepciones se descuentan ANTES de recomponer el IVA", () => {
    // Vienen incluidas en el total impreso: el IVA no se calcula sobre ellas.
    const i = calcularImporteCompra(
      entrada({ total: 121000, percepciones: 1000, modoIva: "tasa", tasaIva: 21 }),
    );
    expect(i.neto).toBe(99173.55);
    expect(i.iva).toBe(20826.45);
    expect(i.percepciones).toBe(1000);
    expect(i.neto + i.iva + i.percepciones).toBe(121000);
  });

  it("soporta 10,5% (la alícuota que rompe los redondeos)", () => {
    const i = calcularImporteCompra(entrada({ total: 110.5, modoIva: "tasa", tasaIva: 10.5 }));
    expect(i.neto + i.iva).toBe(110.5);
    expect(i.neto).toBe(100);
    expect(i.iva).toBe(10.5);
  });

  it("acepta el IVA escrito a mano (facturas con alícuotas mezcladas)", () => {
    const i = calcularImporteCompra(entrada({ total: 1000, modoIva: "manual", ivaManual: 137.5 }));
    expect(i.iva).toBe(137.5);
    expect(i.neto).toBe(862.5);
  });

  it("rechaza percepciones mayores que el total", () => {
    const i = calcularImporteCompra(entrada({ total: 100, percepciones: 150 }));
    expect(i.error).toMatch(/percepciones/i);
    expect(i.valido).toBe(false);
  });

  it("rechaza un IVA a mano mayor que la base", () => {
    const i = calcularImporteCompra(entrada({ total: 100, modoIva: "manual", ivaManual: 150 }));
    expect(i.error).toMatch(/IVA/);
    expect(i.valido).toBe(false);
  });

  it("el total vacío no es un error, es el formulario recién abierto", () => {
    const i = calcularImporteCompra(entrada({ total: null }));
    expect(i.error).toBeNull();
    expect(i.valido).toBe(false);
  });

  it("un total negativo no pasa (defensivo: el input no deja escribirlo)", () => {
    expect(calcularImporteCompra(entrada({ total: -5 })).error).toMatch(/negativo/i);
  });

  // ---------------------------------------------------------------------
  // La invariante que protege la deuda del proveedor.
  //
  // La RPC hace `v_total := ROUND(v_sub + v_iva + v_perc, 2)` y guarda ESE
  // número. Si los tres no suman exactamente el total que se vio en pantalla,
  // la clienta carga 120.000 y el proveedor queda debiendo 119.999,99.
  // ---------------------------------------------------------------------
  it("neto + IVA + percepciones da SIEMPRE el total, exacto", () => {
    const alicuotas = [21, 10.5, 27, 5, 2.5];
    // Casos dirigidos: medio centavo, centavos sueltos, capicúas y el patrón
    // x.xx5 que es donde el punto flotante se cae.
    const totales = [
      0.01, 0.02, 0.03, 0.05, 0.07, 1, 1.01, 1.005, 10.05, 100.5, 999.99, 1000.01, 12345.67,
      99999.99, 120000, 120000.07, 10000.05, 13000.065, 1234567.89, 999999.99,
    ];
    for (const total of totales) {
      for (const tasa of alicuotas) {
        for (const perc of [0, 0.01, 0.5]) {
          if (perc > total) continue;
          const i = calcularImporteCompra(
            entrada({ total, percepciones: perc, modoIva: "tasa", tasaIva: tasa }),
          );
          if (i.error) continue;
          // Contra `i.total`, que es EL número que se muestra en pantalla y del
          // que se derivan los otros tres. Comparar contra el `total` crudo de
          // entrada sería otra cosa: con 1.005 escrito a mano, el importe se
          // normaliza a 1.01 (medio-hacia-arriba, igual que `numeric`), y eso es
          // correcto — lo que no puede pasar nunca es que las partes no sumen
          // el todo.
          expect(cent(i.neto) + cent(i.iva) + cent(i.percepciones)).toBe(cent(i.total));
        }
      }
    }
  });

  it("un total con más de dos decimales se normaliza medio-hacia-arriba", () => {
    // JS a secas da 100 acá (1.005 * 100 === 100.49999999999999). Postgres, que
    // es el que después guarda el número, da 1.01.
    expect(calcularImporteCompra(entrada({ total: 1.005 })).total).toBe(1.01);
    expect(calcularImporteCompra(entrada({ total: 10000.055 })).total).toBe(10000.06);
  });

  it("redondearACentavos deja el input mostrando lo que se va a guardar", () => {
    expect(redondearACentavos(1.005)).toBe(1.01);
    expect(redondearACentavos(120000.004)).toBe(120000);
    expect(redondearACentavos(0.001)).toBe(0);
    expect(redondearACentavos(null)).toBeNull();
    expect(redondearACentavos(120000)).toBe(120000);
  });

  it("la invariante aguanta 5000 totales al azar", () => {
    let semilla = 20260803;
    const rnd = () => {
      // LCG: reproducible. Un test que falla una vez cada tanto no sirve.
      semilla = (semilla * 1103515245 + 12345) % 2147483648;
      return semilla / 2147483648;
    };
    for (let n = 0; n < 5000; n++) {
      // Hasta el tope de la RPC (999.999.999), no sólo montos chicos.
      const total = Math.round(rnd() * 99999999900) / 100;
      const tasa = [21, 10.5, 27, 5, 2.5][n % 5];
      const i = calcularImporteCompra(entrada({ total, modoIva: "tasa", tasaIva: tasa }));
      expect(i.total).toBe(total); // los sorteados ya son exactos a dos decimales
      expect(cent(i.neto) + cent(i.iva)).toBe(cent(i.total));
      expect(i.neto).toBeGreaterThanOrEqual(0);
      expect(i.iva).toBeGreaterThanOrEqual(0);
    }
  });

  it("paraRpc manda exactamente los tres campos que espera crear_compra", () => {
    const i = calcularImporteCompra(entrada({ total: 121, modoIva: "tasa", tasaIva: 21 }));
    expect(paraRpc(i)).toEqual({
      p_subtotal_sin_iva: 100,
      p_iva_total: 21,
      p_percepciones: 0,
    });
  });
});

describe("modoIvaSugerido", () => {
  it("la Factura A discrimina IVA; el resto no", () => {
    expect(modoIvaSugerido("FACTURA_A")).toBe("tasa");
    expect(modoIvaSugerido("FACTURA_B")).toBe("sin");
    expect(modoIvaSugerido("FACTURA_C")).toBe("sin");
    expect(modoIvaSugerido("REMITO")).toBe("sin");
    expect(modoIvaSugerido("OTRO")).toBe("sin");
  });

  it("un tipo desconocido no rompe: no desglosa", () => {
    expect(modoIvaSugerido("LO_QUE_SEA")).toBe("sin");
  });
});

describe("faltanteCompra", () => {
  const ok = {
    sucursalId: "s",
    proveedorId: "p",
    numero: "0001-2345",
    fechaComprobante: "2026-08-03",
    importe: calcularImporteCompra(entrada({ total: 120000, modoIva: "tasa", tasaIva: 21 })),
    esCtaCte: false,
    pagos: [{ forma_pago: "EFECTIVO", monto: 120000 }],
  };

  it("con todo cargado no falta nada", () => {
    expect(faltanteCompra(ok)).toBeNull();
  });

  it("reproduce la foto de la clienta: pago cargado, total en cero", () => {
    // Éste es EL bug: el botón quedaba gris y el único cartel rojo hablaba de
    // los pagos, que estaban bien. Ahora dice lo que realmente falta.
    const falta = faltanteCompra({
      ...ok,
      importe: calcularImporteCompra(entrada({ total: null })),
      pagos: [{ forma_pago: "EFECTIVO", monto: 120000 }],
    });
    expect(falta).toBe("Escribí el total del comprobante.");
  });

  it("cuenta corriente no pide formas de pago", () => {
    expect(faltanteCompra({ ...ok, esCtaCte: true, pagos: [] })).toBeNull();
  });

  it("no adivina con qué se pagó", () => {
    expect(faltanteCompra({ ...ok, pagos: [{ forma_pago: "", monto: 120000 }] })).toMatch(
      /con qué se pagó/,
    );
  });

  it("avisa cuánto falta y cuánto sobra", () => {
    expect(faltanteCompra({ ...ok, pagos: [{ forma_pago: "EFECTIVO", monto: 100000 }] })).toMatch(
      /Falta cubrir \$20\.000,00/,
    );
    expect(faltanteCompra({ ...ok, pagos: [{ forma_pago: "EFECTIVO", monto: 130000 }] })).toMatch(
      /se pasan \$10\.000,00/,
    );
  });

  it("usa la MISMA tolerancia de un centavo que la RPC", () => {
    // Más estricto que el servidor => "falta $0,01" con el botón habilitado.
    // Más laxo => guarda y el servidor lo rechaza. Tiene que ser igual.
    expect(faltanteCompra({ ...ok, pagos: [{ forma_pago: "EFECTIVO", monto: 119999.99 }] })).toBeNull();
    expect(faltanteCompra({ ...ok, pagos: [{ forma_pago: "EFECTIVO", monto: 120000.01 }] })).toBeNull();
    expect(faltanteCompra({ ...ok, pagos: [{ forma_pago: "EFECTIVO", monto: 119999.98 }] })).not.toBeNull();
  });

  it("frena el cero de más con el MISMO tope que la RPC", () => {
    // crear_compra: LIMITE constant numeric := 999999999.
    const justo = calcularImporteCompra(entrada({ total: 999999999 }));
    const pasado = calcularImporteCompra(entrada({ total: 1000000000 }));
    expect(faltanteCompra({ ...ok, importe: justo, pagos: [{ forma_pago: "EFECTIVO", monto: 999999999 }] })).toBeNull();
    expect(
      faltanteCompra({ ...ok, importe: pasado, pagos: [{ forma_pago: "EFECTIVO", monto: 1000000000 }] }),
    ).toMatch(/no parece un monto válido/);
  });

  it("una compra al contado no se guarda sin ningún pago, ni por un centavo", () => {
    // La tolerancia de un centavo dejaba pasar un total de $0,01 con CERO pagos
    // (y la RPC también): plata que salía de la caja sin rastro de cómo.
    const chico = calcularImporteCompra(entrada({ total: 0.01 }));
    expect(faltanteCompra({ ...ok, importe: chico, pagos: [] })).toMatch(/con qué se pagó/);
  });

  it("una fila de pago vacía no traba el guardado (tampoco se manda)", () => {
    // El payload filtra `monto > 0`. Pedir la forma de una fila de $0 trababa
    // Guardar por algo que el servidor nunca iba a ver.
    expect(
      faltanteCompra({
        ...ok,
        pagos: [
          { forma_pago: "EFECTIVO", monto: 120000 },
          { forma_pago: "", monto: 0 },
        ],
      }),
    ).toBeNull();
  });

  it("varias formas de pago suman", () => {
    expect(
      faltanteCompra({
        ...ok,
        pagos: [
          { forma_pago: "EFECTIVO", monto: 20000 },
          { forma_pago: "TRANSFERENCIA", monto: 100000 },
        ],
      }),
    ).toBeNull();
  });

  it("un monto vacío pide el monto, no la forma (la forma ya está elegida)", () => {
    expect(faltanteCompra({ ...ok, pagos: [{ forma_pago: "EFECTIVO", monto: null }] })).toBe(
      "Escribí cuánto se pagó.",
    );
  });

  it("pide los datos en el orden en que se llena el formulario", () => {
    expect(faltanteCompra({ ...ok, sucursalId: "", proveedorId: "" })).toMatch(/sucursal/i);
    expect(faltanteCompra({ ...ok, proveedorId: "" })).toMatch(/proveedor/i);
    expect(faltanteCompra({ ...ok, numero: "   " })).toMatch(/comprobante/i);
  });

  it("el error del importe gana sobre el resto", () => {
    const falta = faltanteCompra({
      ...ok,
      importe: calcularImporteCompra(entrada({ total: 100, percepciones: 500 })),
    });
    expect(falta).toMatch(/percepciones/i);
  });
});
