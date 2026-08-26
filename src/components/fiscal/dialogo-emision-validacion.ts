import type { SelectorReceptorFiscal } from "@/lib/fiscal/receptor";
import { documentoFiscalArca } from "@/lib/fiscal/receptor";
import type { ReceptorFiscalFavorito } from "@/lib/fiscal/cola.functions";
import type { CondicionIva } from "@/lib/fiscal/codigos";
import type { ReceptorFormulario } from "./receptor-fiscal-form";
import type { LetraSolicitada } from "./dialogo-emision-state";

export type CampoReceptorFiscal =
  | "cliente_comercial"
  | "receptor"
  | "tipo_documento"
  | "numero_documento"
  | "razon_social"
  | "condicion_iva"
  | "confirmacion";

export type ResultadoValidacionSelector =
  | { ok: true; selector: SelectorReceptorFiscal }
  | { ok: false; campo: CampoReceptorFiscal; mensaje: string };

export type ClienteComercialFiscal = {
  razonSocial: string;
  documento: string | null;
  condicionIva: CondicionIva | null;
};

function error(
  campo: CampoReceptorFiscal,
  mensaje: string,
): Extract<ResultadoValidacionSelector, { ok: false }> {
  return { ok: false, campo, mensaje };
}

export function validarSelectorReceptorFiscal({
  value,
  confirmaDatosManuales,
  letraSolicitada,
  clienteComercial,
  favoritos = [],
}: {
  value: ReceptorFormulario;
  confirmaDatosManuales: boolean;
  letraSolicitada: LetraSolicitada;
  clienteComercial?: ClienteComercialFiscal;
  favoritos?: ReceptorFiscalFavorito[];
}): ResultadoValidacionSelector {
  if (value.origen === "COMPROBANTE_ORIGINAL") {
    return { ok: true, selector: value };
  }
  if (value.origen === "CLIENTE_COMERCIAL") {
    if (letraSolicitada === "A") {
      return error(
        "cliente_comercial",
        "Cliente comercial se factura como Consumidor Final sin identificar y sólo permite factura B. Para una factura A elegí Otro receptor e ingresá su CUIT y condición de IVA.",
      );
    }
    if (clienteComercial?.documento?.trim()) {
      return error(
        "cliente_comercial",
        "El cliente tiene un documento comercial, pero falta confirmar su tipo fiscal. Elegí Otro receptor para indicar CUIT, CUIL, DNI o CDI.",
      );
    }
    if (clienteComercial?.condicionIva !== "CONSUMIDOR_FINAL") {
      return error(
        "cliente_comercial",
        "Cliente comercial sólo se puede usar para un Consumidor Final sin identificar. Elegí Otro receptor o un receptor guardado para confirmar los datos fiscales.",
      );
    }
    return { ok: true, selector: value };
  }
  if (value.origen === "FAVORITO") {
    const favorito = favoritos.find((item) => item.id === value.receptor_fiscal_id.trim());
    if (!favorito) return error("receptor", "Elegí un receptor guardado antes de continuar.");
    if ((favorito.tipo_documento as string) === "SIN_IDENTIFICAR") {
      return error(
        "receptor",
        "El receptor guardado no puede estar sin identificar. Elegí Otro receptor y completá un documento válido.",
      );
    }
    if (!favorito.razon_social.trim()) {
      return error(
        "receptor",
        "El receptor guardado no tiene razón social. Elegí Otro receptor y completá sus datos fiscales.",
      );
    }
    try {
      documentoFiscalArca(favorito.tipo_documento, favorito.numero_documento);
    } catch {
      return error(
        "receptor",
        "El documento del receptor guardado no es válido. Elegí Otro receptor y cargalo nuevamente.",
      );
    }
    if (
      letraSolicitada === "A" &&
      (favorito.tipo_documento !== "CUIT" ||
        (favorito.condicion_iva !== "RESPONSABLE_INSCRIPTO" &&
          favorito.condicion_iva !== "MONOTRIBUTO"))
    ) {
      return error(
        "receptor",
        "El receptor guardado no es compatible con factura A: necesita CUIT y condición Responsable Inscripto o Monotributista.",
      );
    }
    if (
      letraSolicitada === "B" &&
      favorito.condicion_iva !== "CONSUMIDOR_FINAL" &&
      favorito.condicion_iva !== "EXENTO"
    ) {
      return error(
        "receptor",
        "El receptor guardado corresponde a factura A por su condición de IVA. Elegí factura A u Otro receptor.",
      );
    }
    return { ok: true, selector: value };
  }

  const razonSocial = value.razon_social.trim();
  if (!razonSocial) {
    return error(
      "razon_social",
      "Completá la razón social del receptor. ARCA la necesita para identificar a quién se emite el comprobante.",
    );
  }

  if (letraSolicitada === "A" && value.tipo_documento !== "CUIT") {
    return error(
      "numero_documento",
      "La factura A requiere el CUIT del receptor. Elegí factura B si corresponde a Consumidor Final o Exento.",
    );
  }

  const sinDocumento = value.tipo_documento === "SIN_IDENTIFICAR" || !value.numero_documento.trim();
  if (letraSolicitada === "B" && sinDocumento && value.condicion_iva !== "CONSUMIDOR_FINAL") {
    return error(
      value.tipo_documento === "SIN_IDENTIFICAR" ? "tipo_documento" : "numero_documento",
      value.condicion_iva === "EXENTO"
        ? "Un receptor Exento debe identificarse con un documento válido. Elegí el tipo e ingresá el número antes de continuar."
        : "Un receptor sin documento sólo puede ser Consumidor Final. Revisá la condición de IVA o ingresá un documento válido.",
    );
  }

  const sinIdentificacion = letraSolicitada === "B" && sinDocumento;
  if (!sinIdentificacion) {
    try {
      documentoFiscalArca(value.tipo_documento, value.numero_documento);
    } catch {
      return error(
        "numero_documento",
        letraSolicitada === "A"
          ? "Revisá el CUIT del receptor: debe tener 11 dígitos y un dígito verificador válido para emitir una factura A."
          : "Revisá el documento del receptor: el tipo elegido y la cantidad de dígitos no coinciden.",
      );
    }
  }

  if (
    letraSolicitada === "A" &&
    value.condicion_iva !== "RESPONSABLE_INSCRIPTO" &&
    value.condicion_iva !== "MONOTRIBUTO"
  ) {
    return error(
      "condicion_iva",
      "La factura A sólo corresponde a un receptor Responsable Inscripto o Monotributista.",
    );
  }
  if (
    letraSolicitada === "B" &&
    value.condicion_iva !== "CONSUMIDOR_FINAL" &&
    value.condicion_iva !== "EXENTO"
  ) {
    return error(
      "condicion_iva",
      "La factura B sólo corresponde a un receptor Consumidor Final o Exento.",
    );
  }
  if (!confirmaDatosManuales) {
    return error(
      "confirmacion",
      "Confirmá que revisaste los datos fiscales ingresados antes de continuar.",
    );
  }

  return {
    ok: true,
    selector: {
      origen: "MANUAL",
      tipo_documento: sinIdentificacion ? "SIN_IDENTIFICAR" : value.tipo_documento,
      numero_documento: sinIdentificacion ? null : value.numero_documento.replace(/\D/g, ""),
      razon_social: razonSocial,
      condicion_iva: value.condicion_iva,
      domicilio: value.domicilio.trim() || null,
      guardar_para_proximas: sinIdentificacion ? false : value.guardar_para_proximas,
      confirma_datos_manuales: true,
    },
  };
}
