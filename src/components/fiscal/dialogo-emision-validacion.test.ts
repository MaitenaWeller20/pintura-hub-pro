import { describe, expect, it } from "vitest";
import type { ReceptorFiscalFavorito } from "@/lib/fiscal/cola.functions";
import { validarSelectorReceptorFiscal } from "./dialogo-emision-validacion";

describe("validación del receptor antes de consultar al servidor", () => {
  it("impide usar el cliente comercial para factura A antes de consultar al servidor", () => {
    const resultado = validarSelectorReceptorFiscal({
      value: { origen: "CLIENTE_COMERCIAL" },
      confirmaDatosManuales: false,
      letraSolicitada: "A",
      clienteComercial: {
        razonSocial: "Cliente comercial",
        documento: null,
        condicionIva: "CONSUMIDOR_FINAL",
      },
    });

    expect(resultado).toMatchObject({ ok: false, campo: "cliente_comercial" });
    if (!resultado.ok) expect(resultado.mensaje).toContain("sólo permite factura B");
  });

  it("explica que un documento comercial necesita tipo fiscal explícito", () => {
    const resultado = validarSelectorReceptorFiscal({
      value: { origen: "CLIENTE_COMERCIAL" },
      confirmaDatosManuales: false,
      letraSolicitada: "B",
      clienteComercial: {
        razonSocial: "Cliente con documento",
        documento: "30-71419966-4",
        condicionIva: "CONSUMIDOR_FINAL",
      },
    });

    expect(resultado).toMatchObject({ ok: false, campo: "cliente_comercial" });
    if (!resultado.ok) expect(resultado.mensaje).toContain("falta confirmar su tipo fiscal");
  });

  it("valida documento, condición y letra del receptor guardado", () => {
    const favorito = {
      id: "10000000-0000-4000-8000-000000000001",
      sucursal_id: "20000000-0000-4000-8000-000000000001",
      cliente_comercial_id: null,
      tipo_documento: "DNI" as const,
      numero_documento: "30111222",
      razon_social: "Receptor guardado",
      condicion_iva: "CONSUMIDOR_FINAL" as const,
      domicilio: null,
    };
    const resultado = validarSelectorReceptorFiscal({
      value: { origen: "FAVORITO", receptor_fiscal_id: favorito.id },
      confirmaDatosManuales: false,
      letraSolicitada: "A",
      favoritos: [favorito],
    });

    expect(resultado).toMatchObject({ ok: false, campo: "receptor" });
    if (!resultado.ok) expect(resultado.mensaje).toContain("no es compatible con factura A");
  });

  it("impide continuar con un favorito sin identificar", () => {
    const favoritoAnonimo = {
      id: "10000000-0000-4000-8000-000000000001",
      sucursal_id: "20000000-0000-4000-8000-000000000001",
      cliente_comercial_id: null,
      tipo_documento: "SIN_IDENTIFICAR",
      numero_documento: "",
      razon_social: "Consumidor final",
      condicion_iva: "CONSUMIDOR_FINAL",
      domicilio: null,
    } as unknown as ReceptorFiscalFavorito;
    const resultado = validarSelectorReceptorFiscal({
      value: { origen: "FAVORITO", receptor_fiscal_id: favoritoAnonimo.id },
      confirmaDatosManuales: false,
      letraSolicitada: "B",
      favoritos: [favoritoAnonimo],
    });

    expect(resultado).toMatchObject({ ok: false, campo: "receptor" });
    if (!resultado.ok) expect(resultado.mensaje).toContain("no puede estar sin identificar");
  });

  it("señala la razón social vacía antes de enviar datos fiscales", () => {
    const resultado = validarSelectorReceptorFiscal({
      value: {
        origen: "MANUAL",
        tipo_documento: "SIN_IDENTIFICAR",
        numero_documento: "",
        razon_social: "   ",
        condicion_iva: "CONSUMIDOR_FINAL",
        domicilio: "",
        guardar_para_proximas: false,
      },
      confirmaDatosManuales: true,
      letraSolicitada: "B",
    });

    expect(resultado).toEqual({
      ok: false,
      campo: "razon_social",
      mensaje:
        "Completá la razón social del receptor. ARCA la necesita para identificar a quién se emite el comprobante.",
    });
  });

  it("explica que un CUIT inválido impide emitir factura A", () => {
    const resultado = validarSelectorReceptorFiscal({
      value: {
        origen: "MANUAL",
        tipo_documento: "CUIT",
        numero_documento: "30621146314",
        razon_social: "Receptor de prueba",
        condicion_iva: "RESPONSABLE_INSCRIPTO",
        domicilio: "Córdoba 123",
        guardar_para_proximas: false,
      },
      confirmaDatosManuales: true,
      letraSolicitada: "A",
    });

    expect(resultado).toEqual({
      ok: false,
      campo: "numero_documento",
      mensaje:
        "Revisá el CUIT del receptor: debe tener 11 dígitos y un dígito verificador válido para emitir una factura A.",
    });
  });

  it.each([
    {
      tipo_documento: "SIN_IDENTIFICAR" as const,
      numero_documento: "",
      campo: "tipo_documento" as const,
    },
    {
      tipo_documento: "CUIT" as const,
      numero_documento: "",
      campo: "numero_documento" as const,
    },
  ])(
    "exige identificar a un receptor Exento en factura B ($tipo_documento)",
    ({ tipo_documento, numero_documento, campo }) => {
      const resultado = validarSelectorReceptorFiscal({
        value: {
          origen: "MANUAL",
          tipo_documento,
          numero_documento,
          razon_social: "Receptor exento",
          condicion_iva: "EXENTO",
          domicilio: "",
          guardar_para_proximas: false,
        },
        confirmaDatosManuales: true,
        letraSolicitada: "B",
      });

      expect(resultado).toMatchObject({ ok: false, campo });
      if (!resultado.ok) expect(resultado.mensaje).toContain("Exento debe identificarse");
    },
  );

  it("exige la confirmación manual después de validar los campos", () => {
    const resultado = validarSelectorReceptorFiscal({
      value: {
        origen: "MANUAL",
        tipo_documento: "SIN_IDENTIFICAR",
        numero_documento: "",
        razon_social: "Consumidor final",
        condicion_iva: "CONSUMIDOR_FINAL",
        domicilio: "",
        guardar_para_proximas: false,
      },
      confirmaDatosManuales: false,
      letraSolicitada: "B",
    });

    expect(resultado).toEqual({
      ok: false,
      campo: "confirmacion",
      mensaje: "Confirmá que revisaste los datos fiscales ingresados antes de continuar.",
    });
  });

  it("normaliza un receptor manual válido antes de enviarlo", () => {
    const resultado = validarSelectorReceptorFiscal({
      value: {
        origen: "MANUAL",
        tipo_documento: "SIN_IDENTIFICAR",
        numero_documento: "",
        razon_social: "  Consumidor final  ",
        condicion_iva: "CONSUMIDOR_FINAL",
        domicilio: "  Ruta 9 km 10  ",
        guardar_para_proximas: false,
      },
      confirmaDatosManuales: true,
      letraSolicitada: "B",
    });

    expect(resultado).toEqual({
      ok: true,
      selector: {
        origen: "MANUAL",
        tipo_documento: "SIN_IDENTIFICAR",
        numero_documento: null,
        razon_social: "Consumidor final",
        condicion_iva: "CONSUMIDOR_FINAL",
        domicilio: "Ruta 9 km 10",
        guardar_para_proximas: false,
        confirma_datos_manuales: true,
      },
    });
  });
});
