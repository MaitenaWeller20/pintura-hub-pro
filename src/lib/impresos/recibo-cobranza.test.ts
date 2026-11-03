import { describe, expect, it } from "vitest";
import { generarReciboCobranzaPdf, type ReciboCobranza } from "./recibo-cobranza";

const recibo: ReciboCobranza = {
  numero: "GPZ-RX-0001",
  emitido_at: "2026-11-03T14:00:00Z",
  anulado: false,
  datos: {
    cobranza_id: "aaaabbbb-cccc-dddd-eeee-ffffffffffff",
    fecha_cobro: "2026-10-30T15:00:00Z",
    monto: 200000.64,
    forma_pago: "TRANSFERENCIA",
    detalle: { banco: "Macro" },
    observaciones: null,
    cliente: { razon_social: "Juan Atala", cuit_dni: "", direccion: null },
    sucursal: {
      nombre: "CasaForma General Paz",
      numero: "0003",
      direccion: "General Paz",
      telefono: null,
    },
    emisor: {
      razon_social: "Aplicaciones y Servicios SRL",
      cuit: "30-71419966-4",
      domicilio_fiscal: "Córdoba",
      condicion_iva: "RESPONSABLE_INSCRIPTO",
      ingresos_brutos: null,
      inicio_actividades: null,
      logo: null,
    },
  },
};

describe("Recibo X de cobranza", () => {
  it("documenta un cobro existente y conserva su referencia sin atribuir facturas", () => {
    const { doc, nombre } = generarReciboCobranzaPdf(recibo);
    const pdf = doc.output();
    expect(nombre).toBe("recibo-x-GPZ-RX-0001.pdf");
    expect(pdf).toContain("(RECIBO X)");
    expect(pdf.includes("Recibimos de: Juan Atala")).toBe(true);
    expect(pdf.includes("N° GPZ-RX-0001")).toBe(true);
    expect(pdf.includes("Macro")).toBe(true);
    expect(pdf).not.toContain("FAIV");
  });

  it("marca la reimpresión de un cobro anulado", () => {
    const { doc } = generarReciboCobranzaPdf({ ...recibo, anulado: true });
    expect(doc.output()).toContain("(ANULADO)");
  });

  it("rechaza un cobro inválido antes de producir un PDF", () => {
    expect(() =>
      generarReciboCobranzaPdf({ ...recibo, datos: { ...recibo.datos, monto: -1 } }),
    ).toThrow("datos incompletos");
  });

  it("continúa observaciones largas en otra página sin pisar el pie", () => {
    const { doc } = generarReciboCobranzaPdf({
      ...recibo,
      datos: { ...recibo.datos, observaciones: "Detalle del pago. ".repeat(650) },
    });
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    expect(doc.output()).toContain("Cobro registrado:");
  });
});
