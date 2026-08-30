import { readFileSync } from "node:fs";
import type { Letra } from "./codigos";
import {
  crearSnapshotFiscalV3,
  type SnapshotFiscalV3,
  type SnapshotFiscalV3Input,
} from "./snapshot";

type OpcionesFixtureV3 = {
  letra?: Letra;
  ventaId?: string;
  emisorId?: string;
  emisorCuit?: string;
  sucursalId?: string;
  numero?: number;
  puntoVenta?: number;
  simulado?: boolean;
};

export function crearSnapshotFiscalV3Fixture(opciones: OpcionesFixtureV3 = {}): SnapshotFiscalV3 {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../test/fixtures/fiscal-snapshot-parity-v2.json", import.meta.url),
      "utf8",
    ),
  ) as { input: SnapshotFiscalV3Input & Record<string, unknown> };
  const input = structuredClone(fixture.input);
  delete input.version;
  delete input.hash;
  delete input.origen;
  delete input.comprobanteOriginalId;
  delete input.cbtesAsoc;

  const letra = opciones.letra ?? "B";
  input.venta = {
    ...input.venta,
    id: opciones.ventaId ?? input.venta.id,
    tipoComprobante: "NOTA_CREDITO",
  };
  input.items = input.items.map((item, index) => ({
    ...item,
    productoId:
      item.productoId ?? `71000000-0000-4000-8000-${String(199 + index).padStart(12, "0")}`,
  }));
  input.emisor = {
    ...input.emisor,
    id: opciones.emisorId ?? input.emisor.id,
    cuit: opciones.emisorCuit ?? input.emisor.cuit,
    condicionIva: letra === "C" ? "MONOTRIBUTO" : "RESPONSABLE_INSCRIPTO",
  };
  input.sucursal = { ...input.sucursal, id: opciones.sucursalId ?? input.sucursal.id };
  input.receptor =
    letra === "A"
      ? {
          ...input.receptor,
          razonSocial: "CLIENTE RESPONSABLE INSCRIPTO",
          tipoDocumento: "CUIT",
          numeroDocumento: "30714199664",
          docTipoArca: 80,
          docNroArca: "30714199664",
          condicionIva: "RESPONSABLE_INSCRIPTO",
          condicionIvaReceptorId: 1,
        }
      : input.receptor;
  input.identidad = {
    ...input.identidad,
    numero: opciones.numero ?? input.identidad.numero,
    emisorCuit: opciones.emisorCuit ?? input.identidad.emisorCuit,
    puntoVenta: opciones.puntoVenta ?? input.identidad.puntoVenta,
    cbteTipo: letra === "A" ? 3 : letra === "B" ? 8 : 13,
    simulado: opciones.simulado ?? input.identidad.simulado,
    validez: opciones.simulado ? "SIMULADA" : input.identidad.validez,
  };
  input.letra = letra;
  input.ivaContenido = letra === "C" ? "0.00" : input.ivaContenido;
  input.importeTributos = "0.00";
  input.importeTotal = "1360.00";
  input.tributos = [];
  input.otrosImpuestosNacionalesIndirectos = "0.00";
  input.periodoAsoc = { desde: "2026-08-01", hasta: "2026-08-15" };
  input.notaCredito = {
    modalidad: "DEVOLUCION_PRODUCTOS",
    motivo: "Devolución de productos del período",
  };
  return crearSnapshotFiscalV3(input);
}
