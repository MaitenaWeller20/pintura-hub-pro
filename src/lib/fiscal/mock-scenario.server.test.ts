import { afterEach, describe, expect, it, vi } from "vitest";

import {
  esFingerprintServidorFiscalE2E,
  esFingerprintPinturaGest,
  validarEntornoServidorE2E,
} from "../../../e2e/verificar-servidor";
import { normalizarEntornoSupabaseLocalE2E } from "../../../e2e/entorno-supabase-local";

const entornoOriginal = {
  NODE_ENV: process.env.NODE_ENV,
  INVOICING_MOCK_TEST_RUNNER: process.env.INVOICING_MOCK_TEST_RUNNER,
  VITEST: process.env.VITEST,
  INVOICING_MOCK_MODE: process.env.INVOICING_MOCK_MODE,
  INVOICING_MOCK_SCENARIO: process.env.INVOICING_MOCK_SCENARIO,
};

function restaurar(nombre: keyof typeof entornoOriginal) {
  const value = entornoOriginal[nombre];
  if (value === undefined) delete process.env[nombre];
  else process.env[nombre] = value;
}

afterEach(() => {
  restaurar("NODE_ENV");
  restaurar("INVOICING_MOCK_TEST_RUNNER");
  restaurar("VITEST");
  restaurar("INVOICING_MOCK_MODE");
  restaurar("INVOICING_MOCK_SCENARIO");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("escenarios fiscales exclusivos del servidor de pruebas", () => {
  it.each(["OK", "RECHAZO_DEFINITIVO", "TIMEOUT_POST_REQUEST", "QR_ERROR"] as const)(
    "acepta únicamente el escenario %s cuando test y mock están activos",
    async (scenario) => {
      const { resolverEscenarioMockFiscal } = await import("./mock-scenario.server");
      expect(
        resolverEscenarioMockFiscal({
          NODE_ENV: "test",
          VITEST: "true",
          INVOICING_MOCK_MODE: "true",
          INVOICING_MOCK_SCENARIO: scenario,
        }),
      ).toBe(scenario);
    },
  );

  it("ignora el selector fuera de test y rechaza valores no enumerados dentro de test", async () => {
    const { resolverEscenarioMockFiscal } = await import("./mock-scenario.server");
    expect(
      resolverEscenarioMockFiscal({
        NODE_ENV: "production",
        INVOICING_MOCK_MODE: "true",
        INVOICING_MOCK_SCENARIO: "RECHAZO_DEFINITIVO",
      }),
    ).toBe("OK");
    expect(() =>
      resolverEscenarioMockFiscal({
        NODE_ENV: "test",
        VITEST: "true",
        INVOICING_MOCK_MODE: "true",
        INVOICING_MOCK_SCENARIO: "DESDE_HEADER",
      }),
    ).toThrow(/escenario fiscal.*inválido/i);
  });

  it.each([
    ["test", "true", "true", "RECHAZO_DEFINITIVO"],
    ["development", "true", "true", "OK"],
    ["production", "true", "true", "OK"],
    ["test", undefined, "true", "OK"],
    ["test", "true", undefined, "OK"],
  ] as const)(
    "NODE_ENV=%s runner=%s mock=%s resuelve %s",
    async (nodeEnv, playwright, modo, esperado) => {
      const { resolverEscenarioMockFiscal } = await import("./mock-scenario.server");
      expect(
        resolverEscenarioMockFiscal({
          NODE_ENV: nodeEnv,
          INVOICING_MOCK_TEST_RUNNER: playwright === "true" ? "playwright" : playwright,
          INVOICING_MOCK_MODE: modo,
          INVOICING_MOCK_SCENARIO: "RECHAZO_DEFINITIVO",
        }),
      ).toBe(esperado);
    },
  );

  it("no habilita el motor mock fuera de un runner de test aunque quede la variable activa", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.INVOICING_MOCK_TEST_RUNNER;
    delete process.env.VITEST;
    process.env.INVOICING_MOCK_MODE = "true";
    process.env.INVOICING_MOCK_SCENARIO = "OK";
    vi.resetModules();

    const { MOCK } = await import("./arca");

    expect(MOCK).toBe(false);
  });

  it("no habilita MOCK en Vite development aunque tenga runner y flags completos", async () => {
    process.env.NODE_ENV = "development";
    process.env.INVOICING_MOCK_TEST_RUNNER = "playwright";
    process.env.INVOICING_MOCK_MODE = "true";
    process.env.INVOICING_MOCK_SCENARIO = "OK";
    delete process.env.VITEST;
    vi.resetModules();

    const { MOCK } = await import("./arca");

    expect(MOCK).toBe(false);
  });

  it.each([
    ["OK", "APROBADA"],
    ["RECHAZO_DEFINITIVO", "RECHAZO"],
    ["TIMEOUT_POST_REQUEST", "TIMEOUT"],
    ["QR_ERROR", "APROBADA"],
  ] as const)("%s no abre SDK, red ni credenciales (%s)", async (scenario, esperado) => {
    process.env.NODE_ENV = "test";
    process.env.INVOICING_MOCK_MODE = "true";
    process.env.INVOICING_MOCK_SCENARIO = scenario;
    vi.resetModules();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const arca = await import("./arca");
    const accion = arca.solicitarCaeConPayload(
      { cuit: "30714199664", arca_key_enc: null, arca_cert_enc: null },
      { numero: 5, modo: "HOMOLOGACION" },
      { CbteTipo: 6 },
      1,
      null,
    );

    if (esperado === "APROBADA") {
      await expect(accion).resolves.toMatchObject({ cae: expect.stringMatching(/^\d{14}$/) });
    } else if (esperado === "RECHAZO") {
      await expect(accion).rejects.toBeInstanceOf(arca.ArcaRechazoDefinitivo);
    } else {
      await expect(accion).rejects.toMatchObject({ name: "AfipTimeout" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("fingerprint del servidor Playwright", () => {
  it("el endpoint sólo publica fingerprint con el gate Playwright completo", async () => {
    const { crearFingerprintServidorFiscalE2E } = await import("./mock-scenario.server");
    expect(
      crearFingerprintServidorFiscalE2E({
        NODE_ENV: "test",
        INVOICING_MOCK_TEST_RUNNER: "playwright",
        INVOICING_MOCK_MODE: "true",
        INVOICING_MOCK_SCENARIO: "QR_ERROR",
      }),
    ).toEqual({
      app: "PinturaGest",
      nodeEnv: "test",
      runner: "playwright",
      mockMode: true,
      scenario: "QR_ERROR",
    });
    expect(
      crearFingerprintServidorFiscalE2E({
        NODE_ENV: "production",
        INVOICING_MOCK_TEST_RUNNER: "playwright",
        INVOICING_MOCK_MODE: "true",
        INVOICING_MOCK_SCENARIO: "QR_ERROR",
      }),
    ).toBeNull();
    expect(
      crearFingerprintServidorFiscalE2E({
        NODE_ENV: "development",
        INVOICING_MOCK_TEST_RUNNER: "playwright",
        INVOICING_MOCK_MODE: "true",
        INVOICING_MOCK_SCENARIO: "QR_ERROR",
      }),
    ).toBeNull();
    expect(
      crearFingerprintServidorFiscalE2E({
        NODE_ENV: "test",
        INVOICING_MOCK_MODE: "true",
        INVOICING_MOCK_SCENARIO: "QR_ERROR",
      }),
    ).toBeNull();
  });

  it("el verificador exige runner, mock y escenario esperados en la respuesta real", () => {
    const cuerpo = JSON.stringify({
      app: "PinturaGest",
      nodeEnv: "test",
      runner: "playwright",
      mockMode: true,
      scenario: "OK",
    });
    expect(esFingerprintServidorFiscalE2E(200, cuerpo, "OK")).toBe(true);
    expect(esFingerprintServidorFiscalE2E(200, cuerpo, "QR_ERROR")).toBe(false);
    expect(esFingerprintServidorFiscalE2E(404, cuerpo, "OK")).toBe(false);
    expect(esFingerprintServidorFiscalE2E(200, "{}", "OK")).toBe(false);
  });

  it("exige NODE_ENV test, marker Playwright, modo mock y escenario enumerado", () => {
    expect(() =>
      validarEntornoServidorE2E({
        NODE_ENV: "test",
        INVOICING_MOCK_TEST_RUNNER: "playwright",
        INVOICING_MOCK_MODE: "true",
        INVOICING_MOCK_SCENARIO: "OK",
      }),
    ).not.toThrow();
    for (const incompleto of [
      {
        NODE_ENV: "development",
        INVOICING_MOCK_TEST_RUNNER: "playwright",
        INVOICING_MOCK_MODE: "true",
      },
      { NODE_ENV: "test", INVOICING_MOCK_MODE: "true" },
      { NODE_ENV: "test", INVOICING_MOCK_TEST_RUNNER: "playwright" },
    ]) {
      expect(() => validarEntornoServidorE2E(incompleto)).toThrow(/aislado/i);
    }
    expect(() =>
      validarEntornoServidorE2E({
        NODE_ENV: "test",
        INVOICING_MOCK_TEST_RUNNER: "playwright",
        INVOICING_MOCK_MODE: "true",
        INVOICING_MOCK_SCENARIO: "DESCONOCIDO",
      }),
    ).toThrow(/escenario.*inválido/i);
  });

  it("acepta sólo HTTP 200 con la marca PinturaGest", () => {
    expect(esFingerprintPinturaGest(200, "<title>PinturaGest</title>")).toBe(true);
    expect(esFingerprintPinturaGest(503, "<title>PinturaGest</title>")).toBe(false);
    expect(esFingerprintPinturaGest(200, "<title>Otro servidor</title>")).toBe(false);
  });
});

describe("entorno Supabase local de Playwright", () => {
  it("normaliza el alias anon para browser, SSR y fixture sin cambiar su valor", () => {
    expect(
      normalizarEntornoSupabaseLocalE2E({
        VITE_SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_ANON_KEY: "anon-local",
        SUPABASE_SERVICE_ROLE_KEY: "service-local",
      }),
    ).toEqual({
      SUPABASE_URL: "http://127.0.0.1:54321",
      VITE_SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_PUBLISHABLE_KEY: "anon-local",
      VITE_SUPABASE_PUBLISHABLE_KEY: "anon-local",
      SUPABASE_ANON_KEY: "anon-local",
      SUPABASE_SERVICE_ROLE_KEY: "service-local",
    });
  });

  it("rechaza URL remota o credenciales locales incompletas sin incluir sus valores", () => {
    expect(() =>
      normalizarEntornoSupabaseLocalE2E({
        SUPABASE_URL: "https://proyecto.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "anon-secreto",
        SUPABASE_SERVICE_ROLE_KEY: "service-secreto",
      }),
    ).toThrow(/sólo.*local/i);
    expect(() =>
      normalizarEntornoSupabaseLocalE2E({
        SUPABASE_URL: "http://localhost:54321",
        SUPABASE_PUBLISHABLE_KEY: "anon-secreto",
      }),
    ).toThrow(/service-role/i);
    try {
      normalizarEntornoSupabaseLocalE2E({
        SUPABASE_URL: "http://localhost:54321",
        SUPABASE_PUBLISHABLE_KEY: "anon-secreto",
      });
    } catch (error) {
      expect(String(error)).not.toContain("anon-secreto");
    }
  });
});
