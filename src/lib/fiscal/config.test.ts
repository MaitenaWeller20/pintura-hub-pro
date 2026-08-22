import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModalidadFacturaAEditor } from "@/components/app/emisores-config";
import {
  actualizacionModalidadFacturaA,
  autorizarAntesDeClientePrivilegiado,
  confirmacionModalidadFacturaASchema,
  estadoFiscalPublicoMinimo,
  exigirEmisorActualizado,
  normalizarCredencialesPublicas,
  probarAccesoSecuenciasFactura,
  probarConexionSegunModo,
  QUERY_KEY_CONFIG_FISCAL_ADMIN,
  QUERY_KEY_ESTADO_FISCAL_PUBLICO,
  validarHabilitacionCredencial,
} from "./config";

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

  it("la respuesta operativa mínima no entrega emisores, credenciales ni evidencia", () => {
    expect(estadoFiscalPublicoMinimo(true)).toEqual({ mock_mode: true });
    expect(Object.keys(estadoFiscalPublicoMinimo(false))).toEqual(["mock_mode"]);
  });

  it("separa la caché operativa mínima de la configuración administrativa", () => {
    expect(QUERY_KEY_ESTADO_FISCAL_PUBLICO).not.toEqual(QUERY_KEY_CONFIG_FISCAL_ADMIN);
  });
});

describe("prueba read-only de secuencias A/B", () => {
  it("en modo simulado devuelve A/B en cero sin cargar contexto ni credenciales", async () => {
    const ejecutarReal = vi.fn(async () => ({
      secuencia_b: { cbte_tipo: 6 as const, ultimo: 3 },
      secuencia_a: { cbte_tipo: 1 as const, ultimo: 2 },
    }));

    await expect(probarConexionSegunModo(true, ejecutarReal)).resolves.toEqual({
      secuencia_b: { cbte_tipo: 6, ultimo: 0 },
      secuencia_a: { cbte_tipo: 1, ultimo: 0 },
    });
    expect(ejecutarReal).not.toHaveBeenCalled();
  });

  it("consulta por separado B tipo 6 y A tipo 1 y devuelve únicamente ambas secuencias", async () => {
    const tipos: number[] = [];
    const registrarConexion = vi.fn(async () => undefined);

    const resultado = await probarAccesoSecuenciasFactura(
      async (cbteTipo) => {
        tipos.push(cbteTipo);
        return cbteTipo === 6 ? 31 : 7;
      },
      registrarConexion,
      new Date("2026-08-22T16:30:00.000Z"),
    );

    expect(tipos).toEqual([6, 1]);
    expect(resultado).toEqual({
      secuencia_b: { cbte_tipo: 6, ultimo: 31 },
      secuencia_a: { cbte_tipo: 1, ultimo: 7 },
    });
    expect(registrarConexion).toHaveBeenCalledWith({
      probada_at: "2026-08-22T16:30:00.000Z",
    });
  });

  it("no registra conexión si falla cualquiera de las dos consultas", async () => {
    const registrarConexion = vi.fn(async () => undefined);

    await expect(
      probarAccesoSecuenciasFactura(async (cbteTipo) => {
        if (cbteTipo === 1) throw new Error("sin acceso a A");
        return 31;
      }, registrarConexion),
    ).rejects.toThrow(/sin acceso a A/i);
    expect(registrarConexion).not.toHaveBeenCalled();
  });
});

describe("confirmación administrativa de modalidad A", () => {
  const entrada = {
    emisor_id: "36d48748-42ff-4aa5-a7d7-d476572cb429",
    modalidad: "ESTANDAR_CONFIRMADA" as const,
    evidencia: "Constancia de la contadora del 22/08/2026",
    revalidar_at: "2027-08-22",
  };

  it("el esquema es estricto y sólo acepta las dos decisiones soportadas", () => {
    expect(confirmacionModalidadFacturaASchema.parse(entrada)).toEqual(entrada);
    expect(() =>
      confirmacionModalidadFacturaASchema.parse({ ...entrada, modalidad: "DESCONOCIDA" }),
    ).toThrow();
    expect(() =>
      confirmacionModalidadFacturaASchema.parse({ ...entrada, modalidad: "PAGO_CBU" }),
    ).toThrow();
    expect(() =>
      confirmacionModalidadFacturaASchema.parse({ ...entrada, evidencia: "   " }),
    ).toThrow();
    expect(() =>
      confirmacionModalidadFacturaASchema.parse({ ...entrada, revalidar_at: "2026-02-30" }),
    ).toThrow();
    expect(() =>
      confirmacionModalidadFacturaASchema.parse({
        ...entrada,
        confirmada_por: "usuario-del-browser",
      }),
    ).toThrow();
  });

  it("construye usuario y timestamp exclusivamente desde el servidor", () => {
    expect(
      actualizacionModalidadFacturaA(
        entrada,
        "2cfe41cf-06e0-4a29-a315-61c86b9c7019",
        new Date("2026-08-22T17:00:00.000Z"),
      ),
    ).toEqual({
      factura_a_modalidad: "ESTANDAR_CONFIRMADA",
      factura_a_confirmada_at: "2026-08-22T17:00:00.000Z",
      factura_a_confirmada_por: "2cfe41cf-06e0-4a29-a315-61c86b9c7019",
      factura_a_evidencia: "Constancia de la contadora del 22/08/2026",
      factura_a_revalidar_at: "2027-08-22",
    });
  });

  it("autoriza antes de crear o usar el cliente privilegiado", async () => {
    const orden: string[] = [];
    const cliente = { tipo: "service-role" };
    const resultado = await autorizarAntesDeClientePrivilegiado(
      async () => {
        orden.push("autorizar");
      },
      async () => {
        orden.push("crear-admin");
        return cliente;
      },
    );
    expect(orden).toEqual(["autorizar", "crear-admin"]);
    expect(resultado).toBe(cliente);

    const crearDenegado = vi.fn(async () => cliente);
    await expect(
      autorizarAntesDeClientePrivilegiado(async () => {
        throw new Error("Sólo admin");
      }, crearDenegado),
    ).rejects.toThrow(/sólo admin/i);
    expect(crearDenegado).not.toHaveBeenCalled();
  });

  it("falla si la actualización no encontró exactamente al emisor", () => {
    expect(() => exigirEmisorActualizado(null)).toThrow(/emisor.*no existe/i);
    expect(() => exigirEmisorActualizado({ id: entrada.emisor_id })).not.toThrow();
  });

  it("un empleado no recibe evidencia ni controles para editarla", () => {
    const html = renderToStaticMarkup(
      createElement(ModalidadFacturaAEditor, {
        emisor: {
          id: entrada.emisor_id,
          factura_a_modalidad: "ESTANDAR_CONFIRMADA",
          factura_a_confirmada_at: "2026-08-22T17:00:00.000Z",
          factura_a_revalidar_at: "2027-08-22",
          factura_a_evidencia: "SECRETO ADMINISTRATIVO",
        },
        esAdmin: false,
        guardando: false,
        onGuardar: vi.fn(),
      }),
    );

    expect(html).toContain("Factura A estándar");
    expect(html).not.toContain("SECRETO ADMINISTRATIVO");
    expect(html).not.toContain("Fuente o evidencia");
    expect(html).not.toContain("Confirmar modalidad A");
  });
});
