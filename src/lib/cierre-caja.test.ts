import { describe, expect, it } from "vitest";
import {
  calcularCorreccionCierre,
  calcularEfectivoCierre,
  generarCierreCajaPdf,
  mensajeErrorCorreccionCaja,
  validarCorreccionCierre,
} from "./cierre-caja";

function textoDelPdf(doc: ReturnType<typeof generarCierreCajaPdf>): string {
  const raw = doc.output("arraybuffer");
  const bytes = new Uint8Array(raw);
  let texto = "";
  for (const byte of bytes) texto += String.fromCharCode(byte);
  return texto.replace(/\\(\d{3})/g, (_match, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

describe("cierre de efectivo", () => {
  // Rompería si el retiro se confundiera otra vez con un faltante de caja.
  it("separa retiro, efectivo dejado y diferencia real", () => {
    expect(calcularEfectivoCierre(125_933.17, 125_933.17, 25_933.17)).toEqual({
      diferencia: 0,
      retirado: 100_000,
      dejadoValido: true,
    });
  });

  // Reproduce exactamente el cierre reportado: nunca se puede dejar más plata
  // de la que se declaró haber contado.
  it("rechaza un efectivo dejado mayor que el contado", () => {
    expect(calcularEfectivoCierre(125_933.17, 12_533.17, 25_933.17)).toEqual({
      diferencia: -113_400,
      retirado: -13_400,
      dejadoValido: false,
    });
  });
});

describe("corrección auditada de un cierre", () => {
  it("recalcula diferencias y totales sin modificar lo contado en otras formas", () => {
    expect(
      calcularCorreccionCierre({
        esperado: {
          EFECTIVO: { neto: 125_933.17 },
          CHEQUE: { neto: 2_000_000 },
        },
        contadoActual: { EFECTIVO: 12_533.17, CHEQUE: 1_999_000 },
        efectivoContado: 125_933.17,
        efectivoDejado: 25_933.17,
      }),
    ).toEqual({
      contado: { EFECTIVO: 125_933.17, CHEQUE: 1_999_000 },
      diferencia: { EFECTIVO: 0, CHEQUE: -1_000 },
      totalEsperado: 2_125_933.17,
      totalContado: 2_124_933.17,
      totalDiferencia: -1_000,
      efectivoRetirado: 100_000,
    });
  });

  it("exige motivo y no deja alterar el fondo que ya originó un turno posterior", () => {
    expect(
      validarCorreccionCierre({
        efectivoContadoActual: 100,
        efectivoDejadoActual: 20,
        efectivoContado: 110,
        efectivoDejado: 30,
        motivo: "",
        tieneTurnoPosterior: false,
      }),
    ).toContain("motivo");

    expect(
      validarCorreccionCierre({
        efectivoContadoActual: 100,
        efectivoDejadoActual: 20,
        efectivoContado: 110,
        efectivoDejado: 30,
        motivo: "Corrección del conteo informado",
        tieneTurnoPosterior: true,
      }),
    ).toContain("turno posterior");
  });

  it("conserva errores operativos y oculta detalles técnicos", () => {
    expect(
      mensajeErrorCorreccionCaja(
        new Error(
          "Otra persona corrigió este cierre. Cerrá esta ventana, revisá los cambios y volvé a intentarlo.",
        ),
      ),
    ).toContain("Otra persona corrigió");
    expect(mensajeErrorCorreccionCaja(new Error('PGRST204: column "contado" does not exist'))).toBe(
      "No pudimos guardar la corrección. El cierre no fue modificado; actualizá la página y volvé a intentar.",
    );
    expect(
      mensajeErrorCorreccionCaja(
        new Error(
          "No se pudo guardar la corrección: value too long for type character varying(20)",
        ),
      ),
    ).toBe(
      "No pudimos guardar la corrección. El cierre no fue modificado; actualizá la página y volvé a intentar.",
    );
  });
});

describe("PDF del cierre", () => {
  const sesion = {
    id: "00000000-0000-0000-0000-000000000001",
    abierta_en: "2026-08-21T12:46:39.108Z",
    cerrada_en: "2026-08-21T20:50:45.331Z",
    fondo_inicial: 32_304.02,
    esperado: {
      EFECTIVO: { neto: 125_933.17, entra: 125_933.17, sale: 0 },
      CHEQUE: { neto: 2_000_000, entra: 2_000_000, sale: 0 },
    },
    contado: { EFECTIVO: 125_933.17, CHEQUE: 2_000_000 },
    diferencia: { EFECTIVO: 0, CHEQUE: 0 },
    total_esperado: 2_125_933.17,
    total_contado: 2_125_933.17,
    total_diferencia: 0,
    efectivo_dejado: 25_933.17,
    notas: null,
  };

  const cobranzas = [
    {
      fecha: "2026-08-21T17:46:45.029Z",
      monto: 2_000_000,
      forma_pago: "CHEQUE",
      detalle: { banco: "Bancor", numero: "21826" },
      observaciones: null,
      cliente: { razon_social: "2305 DIEGO SCABOLINI - CAMPO CHICO" },
    },
  ];

  // Rompería si el PDF volviera a mostrar sólo ventas aunque el arqueo incluya
  // plata cobrada contra una cuenta corriente.
  it("detalla la cobranza y los datos del cheque que integran el arqueo", () => {
    const texto = textoDelPdf(
      generarCierreCajaPdf({
        sesion,
        sucursalNombre: "CasaForma O'Higgins",
        ventas: [],
        cobranzas,
      }),
    );

    expect(texto).toContain("Cobranzas de cuenta corriente");
    expect(texto).toContain("2305 DIEGO SCABOLINI - CAMPO CHICO");
    expect(texto).toContain("Banco: Bancor");
    expect(texto).toContain("N° 21826");
    expect(texto).toContain("2.000.000,00");
  });

  it("explica cuánto efectivo se retiró al cerrar", () => {
    const texto = textoDelPdf(
      generarCierreCajaPdf({
        sesion,
        sucursalNombre: "CasaForma O'Higgins",
        ventas: [],
        cobranzas,
      }),
    );

    expect(texto).toContain("Efectivo retirado al cierre");
    expect(texto).toContain("100.000,00");
    expect(texto).toContain("Efectivo dejado para mañana");
    expect(texto).toContain("25.933,17");
  });
});
