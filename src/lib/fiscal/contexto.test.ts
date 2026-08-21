import { describe, expect, it } from "vitest";
import { construirContextoFiscal } from "./contexto";

const base = {
  sucursal: {
    id: "s-general-paz",
    nombre: "CasaForma General Paz",
    telefono: "3513229459",
    emisor_id: "e-aplicaciones",
  },
  emisor: {
    id: "e-aplicaciones",
    razon_social: "APLICACIONES Y SERVICIOS S.R.L.",
    nombre_fantasia: "CasaForma",
    cuit: "30714199664",
    domicilio_fiscal: "SARMIENTO 1398",
    condicion_iva: "RESPONSABLE_INSCRIPTO" as const,
    ingresos_brutos: "280970280",
    inicio_actividades: "2018-09-01",
  },
  pv: {
    sucursal_id: "s-general-paz",
    emisor_id: "e-aplicaciones",
    numero: 5,
    modo: "PRODUCCION" as const,
    activo: true,
  },
  credencial: {
    emisor_id: "e-aplicaciones",
    ambiente: "PRODUCCION" as const,
    arca_key_enc: "key",
    arca_cert_enc: "cert",
    habilitada: true,
  },
};

describe("contexto fiscal multiemisor", () => {
  it("resuelve CUIT, PV y contacto desde la sucursal", () => {
    const r = construirContextoFiscal(base, { exigirHabilitada: true });

    expect(r.emisor.cuit).toBe("30714199664");
    expect(r.emisorImpreso.telefono).toBe("3513229459");
    expect(r.pv).toEqual({ numero: 5, modo: "PRODUCCION" });
  });

  it("rechaza un PV de otro emisor", () => {
    expect(() =>
      construirContextoFiscal(
        { ...base, pv: { ...base.pv, emisor_id: "e-grupo" } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/punto de venta.*emisor/i);
  });

  it("rechaza el PV de otra sucursal aunque pertenezca al mismo emisor", () => {
    expect(() =>
      construirContextoFiscal(
        { ...base, pv: { ...base.pv, sucursal_id: "s-otra" } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/punto de venta.*sucursal/i);
  });

  it("rechaza una credencial de otro emisor o ambiente", () => {
    expect(() =>
      construirContextoFiscal(
        { ...base, credencial: { ...base.credencial, emisor_id: "e-grupo" } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/credencial.*producción/i);
    expect(() =>
      construirContextoFiscal(
        { ...base, credencial: { ...base.credencial, ambiente: "HOMOLOGACION" } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/credencial.*producción/i);
  });

  it("rechaza credencial ausente, incompleta o deshabilitada", () => {
    expect(() =>
      construirContextoFiscal({ ...base, credencial: null }, { exigirHabilitada: true }),
    ).toThrow(/credencial.*producción/i);
    expect(() =>
      construirContextoFiscal(
        { ...base, credencial: { ...base.credencial, arca_cert_enc: null } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/certificado/i);
    expect(() =>
      construirContextoFiscal(
        { ...base, credencial: { ...base.credencial, habilitada: false } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/deshabilitada/i);
  });

  it("permite inspeccionar una credencial completa aunque todavía esté deshabilitada", () => {
    const r = construirContextoFiscal(
      { ...base, credencial: { ...base.credencial, habilitada: false } },
      { exigirHabilitada: false },
    );

    expect(r.emisor.cuit).toBe("30714199664");
  });

  it("falla cerrado si faltan datos legales o el PV está inactivo", () => {
    expect(() =>
      construirContextoFiscal(
        { ...base, emisor: { ...base.emisor, inicio_actividades: null } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/datos fiscales obligatorios/i);
    expect(() =>
      construirContextoFiscal(
        { ...base, emisor: { ...base.emisor, cuit: "30714199665" } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/CUIT.*inválido/i);
    expect(() =>
      construirContextoFiscal(
        { ...base, pv: { ...base.pv, activo: false } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/inactivo/i);
    expect(() =>
      construirContextoFiscal(
        { ...base, pv: { ...base.pv, numero: 0 } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/número.*punto de venta/i);
  });
});
