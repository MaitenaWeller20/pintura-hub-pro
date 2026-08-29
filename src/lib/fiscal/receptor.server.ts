import { CONDICION_IVA_CLIENTE, cuitValido, type CondicionIva } from "./codigos";
import { crearErrorFiscalUsuario } from "./error-usuario";
import type { ReceptorPadronArca } from "./padron-arca-shared";
import type { AsociacionPreparadaFiscal } from "./emision";
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
  asociacion: AsociacionPreparadaFiscal;
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

function cuitCanonico(valor: string | null): string | null {
  if (!cuitValido(valor)) return null;
  return valor!.replace(/\D/g, "");
}

function receptorDesdePadron(input: {
  padron: ReceptorPadronArca;
  condicionDeclarada: CondicionIva | null;
  letraSolicitada: "A" | "B" | "C" | null;
  origenId: string | null;
  importeTotal: number;
}): ReceptorFiscalConfirmado {
  const confirmada = input.padron.condicionIvaConfirmada;
  if (
    (input.letraSolicitada === "A" && confirmada === null) ||
    (input.letraSolicitada === "B" &&
      (confirmada === "RESPONSABLE_INSCRIPTO" ||
        confirmada === "MONOTRIBUTO" ||
        (confirmada === null &&
          input.condicionDeclarada !== "EXENTO" &&
          input.condicionDeclarada !== "CONSUMIDOR_FINAL")))
  ) {
    throw crearErrorFiscalUsuario("CONDICION_FISCAL_INCOMPATIBLE");
  }
  const condicion =
    confirmada ??
    (input.letraSolicitada === "B" ||
    input.letraSolicitada === "C" ||
    input.letraSolicitada === null
      ? input.condicionDeclarada
      : null);
  if (
    condicion !== "RESPONSABLE_INSCRIPTO" &&
    condicion !== "MONOTRIBUTO" &&
    condicion !== "EXENTO" &&
    condicion !== "CONSUMIDOR_FINAL"
  ) {
    throw crearErrorFiscalUsuario("CONDICION_FISCAL_INCOMPATIBLE");
  }
  return validarReceptorFiscalConfirmado(
    {
      razonSocial: input.padron.razonSocial,
      domicilio: input.padron.domicilioFiscal,
      tipoDocumento: "CUIT",
      numeroDocumento: input.padron.cuit,
      docTipoArca: 80,
      docNroArca: input.padron.cuit,
      condicionIva: condicion,
      origen: "ARCA",
      origenId: input.origenId,
      verificadoArcaAt: input.padron.verificadoArcaAt,
    },
    input.importeTotal,
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
  letraSolicitada: "A" | "B" | "C" | null;
  cargarFavorito(id: string): Promise<FavoritoFiscalRow | null>;
  cargarOriginal(id: string): Promise<OriginalFiscalRow | null>;
  consultarPadron?: (cuit: string) => Promise<ReceptorPadronArca>;
}): Promise<ReceptorFiscalConfirmado> {
  if (input.venta.tipoComprobante === "NOTA_DEBITO") {
    throw new Error("Las notas de débito nuevas no están habilitadas en el motor fiscal v2.");
  }
  const asociacion = input.venta.asociacion;
  if (input.venta.tipoComprobante === "NOTA_CREDITO" && asociacion.tipo === "COMPROBANTE") {
    if (input.selector.origen !== "COMPROBANTE_ORIGINAL") {
      throw new Error("La nota de crédito exige exactamente el selector COMPROBANTE_ORIGINAL.");
    }
    if (!input.venta.comprobanteOriginalId)
      throw new Error("La nota de crédito no tiene comprobante original.");
    const snapshot = snapshotOriginalAprobado(
      await input.cargarOriginal(input.venta.comprobanteOriginalId),
    );
    return snapshot.receptor;
  }
  if (input.venta.tipoComprobante === "NOTA_CREDITO" && asociacion.tipo === "NINGUNA") {
    throw new Error("Una nota fiscal requiere exactamente una asociación.");
  }
  if (
    input.venta.tipoComprobante === "NOTA_CREDITO" &&
    asociacion.tipo === "PERIODO" &&
    input.selector.origen === "COMPROBANTE_ORIGINAL"
  ) {
    throw new Error("Una nota por período no admite COMPROBANTE_ORIGINAL.");
  }
  if (input.selector.origen === "COMPROBANTE_ORIGINAL") {
    throw new Error("COMPROBANTE_ORIGINAL sólo es válido para una nota de crédito.");
  }
  if (input.selector.origen === "CLIENTE_COMERCIAL") {
    const cuit = cuitCanonico(input.venta.cliente?.cuitDni ?? null);
    if (cuit && input.consultarPadron) {
      return receptorDesdePadron({
        padron: await input.consultarPadron(cuit),
        condicionDeclarada: input.venta.cliente
          ? (CONDICION_IVA_CLIENTE[input.venta.cliente.tipo] ?? null)
          : null,
        letraSolicitada: input.letraSolicitada,
        origenId: null,
        importeTotal: input.importeTotal,
      });
    }
    return receptorClienteAnonimo(input.venta, input.importeTotal);
  }
  if (input.selector.origen === "MANUAL") {
    const receptor = confirmarReceptorManual(input.selector, input.importeTotal);
    const cuit = receptor.tipoDocumento === "CUIT" ? cuitCanonico(receptor.numeroDocumento) : null;
    if (cuit && input.consultarPadron) {
      return receptorDesdePadron({
        padron: await input.consultarPadron(cuit),
        condicionDeclarada: receptor.condicionIva,
        letraSolicitada: input.letraSolicitada,
        origenId: null,
        importeTotal: input.importeTotal,
      });
    }
    return { ...receptor };
  }
  const favorito = await input.cargarFavorito(input.selector.receptor_fiscal_id);
  if (!favorito || favorito.sucursalId !== input.venta.sucursalId) {
    throw new Error("Favorito fiscal inexistente, no visible o de otra sucursal.");
  }
  if (!favorito.activo) throw new Error("El favorito fiscal está inactivo.");
  const cuit = favorito.tipoDocumento === "CUIT" ? cuitCanonico(favorito.numeroDocumento) : null;
  if (cuit && input.consultarPadron) {
    return receptorDesdePadron({
      padron: await input.consultarPadron(cuit),
      condicionDeclarada: favorito.condicionIva,
      letraSolicitada: input.letraSolicitada,
      origenId: favorito.id,
      importeTotal: input.importeTotal,
    });
  }
  return { ...receptorFavorito(favorito, input.importeTotal) };
}
