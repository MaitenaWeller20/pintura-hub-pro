import { TIPOS_C } from "./codigos";
import type { SnapshotFiscalPersistido } from "./snapshot";

export type ProyeccionFiscalArca = {
  importeTotal: string;
  importeNoGravado: string;
  importeNeto: string;
  importeExento: string;
  importeIva: string;
  importeTributos: string;
  alicuotasIva: SnapshotFiscalPersistido["alicuotasIva"];
  tributos: SnapshotFiscalPersistido["tributos"];
};

/**
 * Proyección única de importes declarables y reconciliables. El snapshot
 * conserva el desglose comercial; un comprobante C no lo discrimina ante ARCA.
 */
export function proyectarSnapshotParaArca(
  snapshot: SnapshotFiscalPersistido,
): ProyeccionFiscalArca {
  if (!TIPOS_C.has(snapshot.identidad.cbteTipo)) {
    return {
      importeTotal: snapshot.importeTotal,
      importeNoGravado: snapshot.importeNoGravado,
      importeNeto: snapshot.importeNeto,
      importeExento: snapshot.importeExento,
      importeIva: snapshot.importeIva,
      importeTributos: snapshot.importeTributos,
      alicuotasIva: snapshot.alicuotasIva,
      tributos: snapshot.tributos,
    };
  }
  return {
    importeTotal: snapshot.importeTotal,
    importeNoGravado: "0.00",
    importeNeto: snapshot.importeTotal,
    importeExento: "0.00",
    importeIva: "0.00",
    importeTributos: "0.00",
    alicuotasIva: [],
    tributos: [],
  };
}
