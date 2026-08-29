import type {
  FormaPagoReintegro,
  ModalidadNcPeriodo,
  ResolucionNcPeriodo,
} from "./fiscal/nota-credito-periodo";

export type CaminoNotaCredito = "REVERSAR_FACTURA" | "ASOCIAR_PERIODO";

export type EntradaResumenEfectosNcPeriodo = {
  modalidad: ModalidadNcPeriodo;
  resolucion: ResolucionNcPeriodo;
  items: readonly { descripcion: string; cantidad: number }[];
  pagos: readonly { formaPago: FormaPagoReintegro; montoCentavos: number }[];
  totalCentavos: number;
  clienteComercial: string;
  receptorFiscal: string;
};

export type ResumenEfectosNcPeriodo = {
  stock: string;
  liquidacion: string[];
  advertenciaTitular: string | null;
};

export type ItemNcPeriodoUi = { productoId: string; descripcion: string; cantidad: number };

function dineroCentavos(centavos: number): string {
  return `$${(centavos / 100).toFixed(2).replace(".", ",")}`;
}

function formaPago(forma: FormaPagoReintegro): string {
  return (
    {
      EFECTIVO: "efectivo",
      TRANSFERENCIA: "transferencia",
      TARJETA_DEBITO: "tarjeta de débito",
      TARJETA_CREDITO: "tarjeta de crédito",
      MERCADO_PAGO: "Mercado Pago",
      CHEQUE: "cheque",
    } as const
  )[forma];
}

export function resumenEfectosNcPeriodo(
  input: EntradaResumenEfectosNcPeriodo,
): ResumenEfectosNcPeriodo {
  const stock =
    input.modalidad === "DEVOLUCION_PRODUCTOS"
      ? `Después del CAE, aumenta stock: ${input.items
          .map((item) => `${item.cantidad} × ${item.descripcion}`)
          .join(", ")}.`
      : "No modifica stock.";
  const liquidacion =
    input.resolucion === "SALDO_FAVOR"
      ? [`Saldo a favor exacto: ${dineroCentavos(input.totalCentavos)} en la cuenta comercial.`]
      : input.pagos.map(
          (pago) =>
            `Reintegro exacto: ${dineroCentavos(pago.montoCentavos)} por ${formaPago(pago.formaPago)}.`,
        );
  const advertenciaTitular =
    input.resolucion === "SALDO_FAVOR" && input.clienteComercial !== input.receptorFiscal
      ? `El crédito queda en ${input.clienteComercial}; el receptor fiscal es ${input.receptorFiscal}.`
      : null;
  return { stock, liquidacion, advertenciaTitular };
}

export function camposVisiblesNcPeriodo(modalidad: ModalidadNcPeriodo): {
  productos: boolean;
  concepto: boolean;
} {
  return {
    productos: modalidad === "DEVOLUCION_PRODUCTOS",
    concepto: modalidad === "BONIFICACION_AJUSTE",
  };
}

export function puedeIniciarNcPeriodo(input: {
  v2: boolean;
  periodoHabilitado: boolean;
  puedeEmitir: boolean;
}): boolean {
  return input.v2 && input.periodoHabilitado && input.puedeEmitir;
}

export function cambiarModalidadNcPeriodo(
  modalidad: ModalidadNcPeriodo,
  _actual: { productos: readonly ItemNcPeriodoUi[]; concepto: string },
): { productos: ItemNcPeriodoUi[]; concepto: string } {
  return modalidad === "DEVOLUCION_PRODUCTOS"
    ? { productos: [], concepto: "" }
    : { productos: [], concepto: "" };
}

export function cambiarResolucionNcPeriodo(
  resolucion: ResolucionNcPeriodo,
  pagos: readonly { formaPago: FormaPagoReintegro; montoCentavos: number }[],
): { formaPago: FormaPagoReintegro; montoCentavos: number }[] {
  return resolucion === "SALDO_FAVOR" ? [] : [...pagos];
}

export function validarEnvioNcPeriodo(input: {
  receptorConfirmado: boolean;
  liquidacionExacta: boolean;
  confirmaPeriodo: boolean;
}): { ok: true } | { ok: false; mensaje: string } {
  if (!input.receptorConfirmado) {
    return { ok: false, mensaje: "Confirmá el receptor fiscal antes de emitir." };
  }
  if (!input.liquidacionExacta) {
    return { ok: false, mensaje: "El reintegro debe coincidir exactamente con el total." };
  }
  if (!input.confirmaPeriodo) {
    return {
      ok: false,
      mensaje: "Confirmá que el período corresponde a las operaciones ajustadas.",
    };
  }
  return { ok: true };
}

export function esVentaVisibleEnListadoComercial(estado: string): boolean {
  return estado !== "PENDIENTE_FISCAL";
}

/** Conserva las ventas pendientes fiscales fuera de la consulta, antes del límite comercial. */
export function excluirPendientesFiscalesDeConsulta<
  T extends { neq(column: never, value: never): T },
>(query: T): T {
  return query.neq("estado" as never, "PENDIENTE_FISCAL" as never);
}
