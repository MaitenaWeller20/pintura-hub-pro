import { z } from "zod";
import { cuitValido } from "@/lib/fiscal/codigos";
import { receptorPadronArcaSchema, type ReceptorPadronArca } from "@/lib/fiscal/padron-arca";
import type { ReceptorFiscalFavorito } from "@/lib/fiscal/cola.functions";
import type { ClienteComercialFiscal } from "./dialogo-emision-validacion";
import type { ReceptorFormulario } from "./receptor-fiscal-form";

export type EstadoConsultaPadronUi =
  | { estado: "SIN_CUIT" }
  | { estado: "CONSULTANDO"; clave: ClaveConsultaPadron; token: number }
  | { estado: "INACTIVO"; clave: ClaveConsultaPadron }
  | { estado: "VERIFICADO"; clave: ClaveConsultaPadron; receptor: ReceptorPadronArca }
  | { estado: "ERROR"; clave: ClaveConsultaPadron; mensaje: string };

export type SelectorConsultaPadron =
  | { origen: "CLIENTE_COMERCIAL" }
  | { origen: "FAVORITO"; receptorFiscalId: string }
  | { origen: "MANUAL" };

export type ClaveConsultaPadron = Readonly<{
  sucursalId: string;
  selector: SelectorConsultaPadron;
  cuit: string;
}>;

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

export function claveParaConsultaPadron(input: {
  sucursalId: string;
  receptor: ReceptorFormulario;
  cliente: ClienteComercialFiscal;
  favoritos: ReceptorFiscalFavorito[];
}): ClaveConsultaPadron | null {
  const cuit = cuitParaConsulta(input);
  if (!cuit || input.receptor.origen === "COMPROBANTE_ORIGINAL") return null;

  const selector: SelectorConsultaPadron =
    input.receptor.origen === "FAVORITO"
      ? { origen: "FAVORITO", receptorFiscalId: input.receptor.receptor_fiscal_id }
      : { origen: input.receptor.origen };
  return { sucursalId: input.sucursalId, selector, cuit };
}

export function claveConsultaPadronId(clave: ClaveConsultaPadron | null): string | null {
  if (!clave) return null;
  return [
    clave.sucursalId,
    clave.selector.origen,
    clave.selector.origen === "FAVORITO" ? clave.selector.receptorFiscalId : "",
    clave.cuit,
  ].join("\u0000");
}

export function mismaClaveConsultaPadron(
  izquierda: ClaveConsultaPadron | null,
  derecha: ClaveConsultaPadron | null,
): boolean {
  return claveConsultaPadronId(izquierda) === claveConsultaPadronId(derecha);
}

export type ControlConsultaPadron = {
  secuencia: number;
  clave: ClaveConsultaPadron | null;
};

export function crearControlConsultaPadron(): ControlConsultaPadron {
  return { secuencia: 0, clave: null };
}

export function iniciarConsultaPadron(
  control: ControlConsultaPadron,
  clave: ClaveConsultaPadron,
): number {
  control.secuencia += 1;
  control.clave = clave;
  return control.secuencia;
}

export function invalidarConsultaPadron(control: ControlConsultaPadron): void {
  control.secuencia += 1;
  control.clave = null;
}

export function esConsultaPadronActual(
  control: ControlConsultaPadron,
  token: number,
  clave: ClaveConsultaPadron,
): boolean {
  return control.secuencia === token && mismaClaveConsultaPadron(control.clave, clave);
}

export function programarConsultaPadron(
  control: ControlConsultaPadron,
  clave: ClaveConsultaPadron,
  deps: {
    consultar(): Promise<ResultadoConsultaCuitPadronPublico>;
    onResultado(resultado: ResultadoConsultaCuitPadronPublico, clave: ClaveConsultaPadron): void;
    onError(cause: unknown, clave: ClaveConsultaPadron): void;
  },
): { token: number; cancelar(): void } {
  const token = iniciarConsultaPadron(control, clave);
  const timer = setTimeout(() => {
    void deps
      .consultar()
      .then((resultado) => {
        if (esConsultaPadronActual(control, token, clave)) {
          deps.onResultado(resultado, clave);
        }
      })
      .catch((cause: unknown) => {
        if (esConsultaPadronActual(control, token, clave)) deps.onError(cause, clave);
      });
  }, 300);

  return {
    token,
    cancelar() {
      clearTimeout(timer);
      if (esConsultaPadronActual(control, token, clave)) invalidarConsultaPadron(control);
    },
  };
}

/**
 * Bloqueo derivado durante render: evita que el primer click con un CUIT recién
 * válido se adelante al effect que inicia la consulta.
 */
export function bloqueaAccionesPorConsultaPadron(
  claveActual: ClaveConsultaPadron | null,
  estado: EstadoConsultaPadronUi,
): boolean {
  if (!claveActual) return false;
  if (estado.estado === "INACTIVO") return !mismaClaveConsultaPadron(estado.clave, claveActual);
  if (estado.estado !== "VERIFICADO") return true;
  return (
    !mismaClaveConsultaPadron(estado.clave, claveActual) ||
    estado.receptor.cuit !== claveActual.cuit
  );
}
