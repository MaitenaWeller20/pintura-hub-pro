import { z } from "zod";
import { cuitValido } from "@/lib/fiscal/codigos";
import { receptorPadronArcaSchema, type ReceptorPadronArca } from "@/lib/fiscal/padron-arca";
import type { ReceptorFiscalFavorito } from "@/lib/fiscal/cola.functions";
import type { ClienteComercialFiscal } from "./dialogo-emision-validacion";
import type { ReceptorFormulario } from "./receptor-fiscal-form";

export type EstadoConsultaPadronUi =
  | { estado: "SIN_CUIT" }
  | { estado: "CONSULTANDO"; cuit: string; token: number }
  | { estado: "INACTIVO"; cuit: string }
  | { estado: "VERIFICADO"; cuit: string; receptor: ReceptorPadronArca }
  | { estado: "ERROR"; cuit: string; mensaje: string };

export const resultadoConsultaCuitPadronSchema = z.discriminatedUnion("estado", [
  z.object({ estado: z.literal("INACTIVO") }).strict(),
  z
    .object({
      estado: z.literal("VERIFICADO"),
      receptor: receptorPadronArcaSchema,
    })
    .strict(),
]);

export type ResultadoConsultaCuitPadronPublico = z.infer<typeof resultadoConsultaCuitPadronSchema>;

export function cuitParaConsulta(input: {
  receptor: ReceptorFormulario;
  cliente: ClienteComercialFiscal;
  favoritos: ReceptorFiscalFavorito[];
}): string | null {
  if (input.receptor.origen === "CLIENTE_COMERCIAL") {
    return cuitValido(input.cliente.documento) ? input.cliente.documento!.replace(/\D/g, "") : null;
  }
  if (input.receptor.origen === "FAVORITO") {
    const receptorFiscalId = input.receptor.receptor_fiscal_id;
    const favorito = input.favoritos.find((item) => item.id === receptorFiscalId);
    return favorito?.tipo_documento === "CUIT" && cuitValido(favorito.numero_documento)
      ? favorito.numero_documento.replace(/\D/g, "")
      : null;
  }
  if (
    input.receptor.origen === "MANUAL" &&
    input.receptor.tipo_documento === "CUIT" &&
    cuitValido(input.receptor.numero_documento)
  ) {
    return input.receptor.numero_documento.replace(/\D/g, "");
  }
  return null;
}

export type ControlConsultaPadron = {
  secuencia: number;
  cuit: string | null;
};

export function crearControlConsultaPadron(): ControlConsultaPadron {
  return { secuencia: 0, cuit: null };
}

export function iniciarConsultaPadron(control: ControlConsultaPadron, cuit: string): number {
  control.secuencia += 1;
  control.cuit = cuit;
  return control.secuencia;
}

export function invalidarConsultaPadron(control: ControlConsultaPadron): void {
  control.secuencia += 1;
  control.cuit = null;
}

export function esConsultaPadronActual(
  control: ControlConsultaPadron,
  token: number,
  cuit: string,
): boolean {
  return control.secuencia === token && control.cuit === cuit;
}

export function programarConsultaPadron(
  control: ControlConsultaPadron,
  cuit: string,
  deps: {
    consultar(): Promise<ResultadoConsultaCuitPadronPublico>;
    onResultado(resultado: ResultadoConsultaCuitPadronPublico, cuit: string): void;
    onError(cause: unknown, cuit: string): void;
  },
): { token: number; cancelar(): void } {
  const token = iniciarConsultaPadron(control, cuit);
  const timer = setTimeout(() => {
    void deps
      .consultar()
      .then((resultado) => {
        if (esConsultaPadronActual(control, token, cuit)) {
          deps.onResultado(resultado, cuit);
        }
      })
      .catch((cause: unknown) => {
        if (esConsultaPadronActual(control, token, cuit)) deps.onError(cause, cuit);
      });
  }, 300);

  return {
    token,
    cancelar() {
      clearTimeout(timer);
      if (esConsultaPadronActual(control, token, cuit)) invalidarConsultaPadron(control);
    },
  };
}

/**
 * Bloqueo derivado durante render: evita que el primer click con un CUIT recién
 * válido se adelante al effect que inicia la consulta.
 */
export function bloqueaAccionesPorConsultaPadron(
  cuitActual: string | null,
  estado: EstadoConsultaPadronUi,
): boolean {
  if (!cuitActual) return false;
  if (estado.estado === "INACTIVO") return estado.cuit !== cuitActual;
  if (estado.estado !== "VERIFICADO") return true;
  return estado.cuit !== cuitActual || estado.receptor.cuit !== cuitActual;
}
