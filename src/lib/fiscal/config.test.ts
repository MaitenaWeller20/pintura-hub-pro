import { describe, expect, it } from "vitest";
import { normalizarCredencialesPublicas, validarHabilitacionCredencial } from "./config";

describe("estado público de credenciales ARCA", () => {
  it("si sólo existe producción igual devuelve ambos ambientes sin secretos", () => {
    const resultado = normalizarCredencialesPublicas([
      {
        ambiente: "PRODUCCION",
        arca_key_enc: "clave-cifrada-secreta",
        arca_cert_enc: null,
        cert_vence_at: null,
        cert_alias: "CasaForma",
        probada_at: null,
        habilitada: false,
      },
    ]);

    expect(resultado).toEqual([
      {
        ambiente: "HOMOLOGACION",
        tiene_clave: false,
        tiene_certificado: false,
        cert_vence_at: null,
        cert_alias: null,
        probada_at: null,
        habilitada: false,
      },
      {
        ambiente: "PRODUCCION",
        tiene_clave: true,
        tiene_certificado: false,
        cert_vence_at: null,
        cert_alias: "CasaForma",
        probada_at: null,
        habilitada: false,
      },
    ]);
    expect(resultado.every((fila) => !("arca_key_enc" in fila))).toBe(true);
    expect(resultado.every((fila) => !("arca_cert_enc" in fila))).toBe(true);
  });

  it("sólo habilita una credencial vigente que ya pasó la prueba real", () => {
    const lista = {
      arca_key_enc: "key",
      arca_cert_enc: "cert",
      cert_vence_at: "2027-08-19T00:00:00.000Z",
      probada_at: "2026-08-19T18:00:00.000Z",
    };

    expect(() =>
      validarHabilitacionCredencial(lista, true, new Date("2026-08-19T19:00:00.000Z")),
    ).not.toThrow();
    expect(() =>
      validarHabilitacionCredencial(
        { ...lista, arca_cert_enc: null },
        true,
        new Date("2026-08-19T19:00:00.000Z"),
      ),
    ).toThrow(/certificado/i);
    expect(() =>
      validarHabilitacionCredencial(
        { ...lista, probada_at: null },
        true,
        new Date("2026-08-19T19:00:00.000Z"),
      ),
    ).toThrow(/probar.*conexión/i);
    expect(() =>
      validarHabilitacionCredencial(
        { ...lista, cert_vence_at: "2026-08-18T00:00:00.000Z" },
        true,
        new Date("2026-08-19T19:00:00.000Z"),
      ),
    ).toThrow(/vencido/i);

    expect(() =>
      validarHabilitacionCredencial(
        { arca_key_enc: null, arca_cert_enc: null, cert_vence_at: null, probada_at: null },
        false,
        new Date("2026-08-19T19:00:00.000Z"),
      ),
    ).not.toThrow();
  });

  it("sin filas devuelve ambos ambientes explícitamente deshabilitados", () => {
    expect(normalizarCredencialesPublicas([])).toHaveLength(2);
    expect(normalizarCredencialesPublicas([]).every((fila) => !fila.habilitada)).toBe(true);
  });
});
