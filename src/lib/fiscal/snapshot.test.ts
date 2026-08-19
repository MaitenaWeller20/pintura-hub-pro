import { expect, it } from "vitest";
import { crearSnapshotFiscal, identidadReservaCoincide } from "./snapshot";

it("congela CUIT e información del emisor correcto", () => {
  const entrada = {
    emisor: {
      razon_social: "GRUPO CASA FORMA S.A.S.",
      nombre_fantasia: "CasaForma",
      cuit: "30717322467",
      domicilio_fiscal: "BERNARDO O'HIGGINS 5450",
      condicion_iva: "RESPONSABLE_INSCRIPTO" as const,
      ingresos_brutos: "286447821",
      inicio_actividades: "2025-09-01",
      telefono: "3512146766",
    },
    receptor: {
      razon_social: "Consumidor Final",
      cuit_dni: null,
      doc_tipo: 99,
      doc_nro: 0,
      condicion_iva: "CONSUMIDOR_FINAL" as const,
      domicilio: null,
    },
    fecha: "2026-08-19T15:00:00.000Z",
    totales: { neto: 100, iva: 21, tributos: 0, total: 121, alicuotas: [] },
    condicion_venta: "CONTADO",
    lineas: [
      {
        codigo: "P-1",
        descripcion: "Pintura",
        cantidad: 1,
        precio_unitario_sin_iva: 100,
        descuento_porcentaje: 0,
        iva_porcentaje: 21,
        subtotal_con_iva: 121,
      },
    ],
  };

  const snapshot = crearSnapshotFiscal(entrada);
  entrada.emisor.cuit = "30714199664";
  entrada.lineas[0].descripcion = "CAMBIADA";

  expect(snapshot.emisor.cuit).toBe("30717322467");
  expect(snapshot.emisor.telefono).toBe("3512146766");
  expect(snapshot.lineas[0].descripcion).toBe("Pintura");
  expect(snapshot.version).toBe(1);
});

it("considera el CUIT parte de la identidad de una reserva", () => {
  const actual = {
    cuit: "30714199664",
    punto_venta: 5,
    cbte_tipo: 6,
    ambiente: "PRODUCCION" as const,
  };

  expect(identidadReservaCoincide(actual, actual)).toBe(true);
  expect(identidadReservaCoincide({ ...actual, cuit: "30717322467" }, actual)).toBe(false);
});
