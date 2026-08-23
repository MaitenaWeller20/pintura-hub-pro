import { CONDICION_IVA_CLIENTE, type CondicionIva } from "./codigos";
import {
  confirmarReceptorManual,
  validarReceptorFiscalConfirmado,
  type ReceptorFiscalConfirmado,
  type SelectorReceptorFiscal,
  type TipoDocumentoFiscal,
} from "./receptor";
import { validarSnapshotFiscalV2, type SnapshotFiscalV2 } from "./snapshot";

export type VentaParaReceptor = {
  id: string;
  sucursalId: string;
  cliente: {
    id: string;
    razonSocial: string;
    cuitDni: string | null;
    tipo: string;
    direccion: string | null;
  } | null;
  tipoComprobante: "VENTA" | "NOTA_CREDITO" | "NOTA_DEBITO";
  comprobanteOriginalId: string | null;
};

export type FavoritoFiscalRow = {
  id: string;
  sucursalId: string;
  activo: boolean;
  tipoDocumento: TipoDocumentoFiscal;
  numeroDocumento: string;
  razonSocial: string;
  condicionIva: CondicionIva;
  domicilio: string | null;
};

export type OriginalFiscalRow = {
  id: string;
  estado: string;
  fase: string | null;
  snapshot: unknown;
};

function receptorClienteAnonimo(
  venta: VentaParaReceptor,
  importeTotal: number,
): ReceptorFiscalConfirmado {
  const cliente = venta.cliente;
  const condicion = cliente ? CONDICION_IVA_CLIENTE[cliente.tipo] : "CONSUMIDOR_FINAL";
  if (cliente?.cuitDni?.trim()) {
    throw new Error(
      "El cliente comercial tiene documento sin tipo fiscal explícito; elegí MANUAL o FAVORITO.",
    );
  }
  if (condicion !== "CONSUMIDOR_FINAL") {
    throw new Error(
      "El cliente comercial requiere un receptor MANUAL o FAVORITO con tipo documental explícito.",
    );
  }
  return validarReceptorFiscalConfirmado(
    {
      razonSocial: cliente?.razonSocial?.trim() || "Consumidor Final",
      domicilio: cliente?.direccion?.trim() || null,
      tipoDocumento: "SIN_IDENTIFICAR",
      numeroDocumento: null,
      docTipoArca: 99,
      docNroArca: "0",
      condicionIva: "CONSUMIDOR_FINAL",
      origen: "CLIENTE_COMERCIAL",
      origenId: cliente?.id ?? null,
      verificadoArcaAt: null,
    },
    importeTotal,
  );
}

function receptorFavorito(row: FavoritoFiscalRow, importeTotal: number): ReceptorFiscalConfirmado {
  if (!row.activo) throw new Error("El favorito fiscal está inactivo.");
  return validarReceptorFiscalConfirmado(
    {
      razonSocial: row.razonSocial,
      domicilio: row.domicilio,
      tipoDocumento: row.tipoDocumento,
      numeroDocumento: row.numeroDocumento,
      docTipoArca:
        row.tipoDocumento === "CUIT"
          ? 80
          : row.tipoDocumento === "CUIL"
            ? 86
            : row.tipoDocumento === "CDI"
              ? 87
              : 96,
      docNroArca: row.numeroDocumento,
      condicionIva: row.condicionIva,
      origen: "FAVORITO",
      origenId: row.id,
      verificadoArcaAt: null,
    },
    importeTotal,
  );
}

function snapshotOriginalAprobado(original: OriginalFiscalRow | null): SnapshotFiscalV2 {
  if (!original || original.estado !== "APROBADO" || original.fase !== "PERSISTIDO") {
    throw new Error("La nota de crédito exige un comprobante original APROBADO/PERSISTIDO.");
  }
  return validarSnapshotFiscalV2(original.snapshot);
}

export async function resolverReceptorFiscal(input: {
  selector: SelectorReceptorFiscal;
  venta: VentaParaReceptor;
  importeTotal: number;
  cargarFavorito(id: string): Promise<FavoritoFiscalRow | null>;
  cargarOriginal(id: string): Promise<OriginalFiscalRow | null>;
}): Promise<ReceptorFiscalConfirmado> {
  if (input.venta.tipoComprobante === "NOTA_DEBITO") {
    throw new Error("Las notas de débito nuevas no están habilitadas en el motor fiscal v2.");
  }
  if (input.venta.tipoComprobante === "NOTA_CREDITO") {
    if (input.selector.origen !== "COMPROBANTE_ORIGINAL") {
      throw new Error("La nota de crédito exige exactamente el selector COMPROBANTE_ORIGINAL.");
    }
    if (!input.venta.comprobanteOriginalId)
      throw new Error("La nota de crédito no tiene comprobante original.");
    const snapshot = snapshotOriginalAprobado(
      await input.cargarOriginal(input.venta.comprobanteOriginalId),
    );
    return { ...snapshot.receptor };
  }
  if (input.selector.origen === "COMPROBANTE_ORIGINAL") {
    throw new Error("COMPROBANTE_ORIGINAL sólo es válido para una nota de crédito.");
  }
  if (input.selector.origen === "CLIENTE_COMERCIAL") {
    return receptorClienteAnonimo(input.venta, input.importeTotal);
  }
  if (input.selector.origen === "MANUAL") {
    return { ...confirmarReceptorManual(input.selector, input.importeTotal) };
  }
  const favorito = await input.cargarFavorito(input.selector.receptor_fiscal_id);
  if (!favorito || favorito.sucursalId !== input.venta.sucursalId) {
    throw new Error("Favorito fiscal inexistente, no visible o de otra sucursal.");
  }
  return { ...receptorFavorito(favorito, input.importeTotal) };
}
