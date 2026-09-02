// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUERY_KEY_CONFIG_FISCAL_ADMIN, type CredencialArcaPublica } from "@/lib/fiscal/config";
import type { ConfigFiscalPublica } from "@/lib/fiscal/config.functions";
import { mensajeCodigoErrorFiscalUsuario } from "@/lib/fiscal/error-usuario";
import { CredencialesArcaConfig } from "./credenciales-arca-config";
import { PadronArcaConfig, estadoVisualPadron } from "./padron-arca-config";

const doblesAdmin = vi.hoisted(() => ({
  cargar: vi.fn(),
  guardarPv: vi.fn(),
  generarCsr: vi.fn(),
  guardarCertificado: vi.fn(),
  probarWsfe: vi.fn(),
  probarPadron: vi.fn(),
  habilitarCredencial: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@tanstack/react-start", () => ({ useServerFn: (serverFn: unknown) => serverFn }));

vi.mock("@/lib/fiscal/config.functions", () => ({
  obtenerConfigFiscal: doblesAdmin.cargar,
  guardarPuntoVenta: doblesAdmin.guardarPv,
  generarCsr: doblesAdmin.generarCsr,
  guardarCertificado: doblesAdmin.guardarCertificado,
  probarConexionAfip: doblesAdmin.probarWsfe,
  probarYActivarPadronArca: doblesAdmin.probarPadron,
  guardarHabilitacionCredencial: doblesAdmin.habilitarCredencial,
}));

vi.mock("sonner", () => ({ toast: doblesAdmin.toast }));

const emisorId = "4d50771a-6bc7-4b84-a5e7-a112f00d6b24";

const configAdmin: ConfigFiscalPublica = {
  mock_mode: false,
  emisores: [
    {
      id: emisorId,
      razon_social: "Quimex Emisor SA",
      nombre_fantasia: "Quimex",
      cuit: "30714199664",
      domicilio_fiscal: "Av. Siempre Viva 123",
      condicion_iva: "RESPONSABLE_INSCRIPTO",
      ingresos_brutos: "901-123456-7",
      inicio_actividades: "2020-01-01",
      factura_a_modalidad: "ESTANDAR_CONFIRMADA",
      factura_a_confirmada_at: "2026-08-20T12:00:00.000Z",
      factura_a_confirmada_por: "56a6ec06-af15-4138-8e67-94bec2b7ab8b",
      factura_a_revalidar_at: "2027-08-20",
      factura_a_evidencia: null,
      sucursales: [
        {
          id: "1649fc79-4733-4139-8022-f23ef50f6b54",
          nombre: "Casa central",
          telefono: null,
          punto_venta: {
            id: "f1297ac0-14b9-4c11-b5cd-3a6a9a71fbb6",
            numero: 5,
            modo: "PRODUCCION",
            activo: true,
          },
        },
      ],
      credenciales: [
        credencial({ ambiente: "HOMOLOGACION" }),
        credencial({ ambiente: "PRODUCCION" }),
      ],
    },
  ],
};

function credencial(cambios: Partial<CredencialArcaPublica> = {}): CredencialArcaPublica {
  return {
    ambiente: "PRODUCCION",
    tiene_clave: true,
    tiene_certificado: true,
    cert_vence_at: "2027-08-26T12:00:00.000Z",
    cert_alias: "quimex-produccion",
    probada_at: "2026-08-25T12:00:00.000Z",
    habilitada: true,
    padron_probado_at: null,
    padron_validacion_activa: false,
    padron_ultimo_error_codigo: null,
    padron_ultimo_error_at: null,
    ...cambios,
  };
}

function renderPadron(
  credencialActual: CredencialArcaPublica,
  cambios: Partial<{
    mockMode: boolean;
    probando: boolean;
  }> = {},
): string {
  return renderToStaticMarkup(
    createElement(PadronArcaConfig, {
      emisorId,
      credencial: credencialActual,
      mockMode: cambios.mockMode ?? false,
      probando: cambios.probando ?? false,
      onProbar: vi.fn(),
    }),
  );
}

function botonPadron(html: string): string {
  const boton = html.match(/<button[^>]*>.*?Probar y activar padrón.*?<\/button>/)?.[0];
  expect(boton).toBeDefined();
  return boton ?? "";
}

function diferida<T>() {
  let resolver!: (value: T) => void;
  let rechazar!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolver = resolve;
    rechazar = reject;
  });
  return { promise, resolver, rechazar };
}

function renderConfigAdmin(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(CredencialesArcaConfig),
    ),
  );
  return queryClient;
}

beforeEach(() => {
  for (const doble of [
    doblesAdmin.cargar,
    doblesAdmin.guardarPv,
    doblesAdmin.generarCsr,
    doblesAdmin.guardarCertificado,
    doblesAdmin.probarWsfe,
    doblesAdmin.probarPadron,
    doblesAdmin.habilitarCredencial,
    doblesAdmin.toast.success,
    doblesAdmin.toast.error,
    doblesAdmin.toast.warning,
  ]) {
    doble.mockReset();
  }
  doblesAdmin.cargar.mockResolvedValue(configAdmin);
});

afterEach(() => cleanup());

describe("configuración visual del padrón ARCA", () => {
  it.each([
    {
      nombre: "sin certificado",
      entrada: credencial({ tiene_certificado: false }),
      estado: "NO_CONFIGURADO" as const,
      etiqueta: "No configurado",
    },
    {
      nombre: "con certificado todavía no probado",
      entrada: credencial(),
      estado: "FALTA_PROBAR" as const,
      etiqueta: "Falta probar",
    },
    {
      nombre: "con prueba vigente y validación activa",
      entrada: credencial({
        padron_probado_at: "2026-08-26T12:00:00.000Z",
        padron_validacion_activa: true,
      }),
      estado: "ACTIVO" as const,
      etiqueta: "Activo",
    },
    {
      nombre: "con la última prueba fallida e inactivo",
      entrada: credencial({
        padron_ultimo_error_codigo: "PADRON_NO_AUTORIZADO",
        padron_ultimo_error_at: "2026-08-26T12:00:00.000Z",
      }),
      estado: "PRUEBA_FALLIDA" as const,
      etiqueta: "Prueba fallida",
    },
  ])("muestra el estado $etiqueta para una credencial $nombre", ({ entrada, estado, etiqueta }) => {
    const html = renderPadron(entrada);

    expect(estadoVisualPadron(entrada)).toBe(estado);
    expect(html).toContain(`>${etiqueta}<`);
    expect(html).toContain('role="status"');
    expect(html).toContain("ws_sr_constancia_inscripcion");
    expect(html).toContain("Probar y activar padrón");
  });

  it.each([
    {
      nombre: "sin certificado aunque conserve estado contradictorio",
      entrada: credencial({
        tiene_certificado: false,
        padron_validacion_activa: true,
        padron_probado_at: "2026-08-26T12:00:00.000Z",
        padron_ultimo_error_codigo: "PADRON_NO_AUTORIZADO",
      }),
      esperado: "NO_CONFIGURADO" as const,
    },
    {
      nombre: "con prueba, activa y error simultáneos",
      entrada: credencial({
        padron_validacion_activa: true,
        padron_probado_at: "2026-08-26T12:00:00.000Z",
        padron_ultimo_error_codigo: "PADRON_ARCA_CAIDO",
      }),
      esperado: "PRUEBA_FALLIDA" as const,
    },
    {
      nombre: "activa sin prueba pero con error",
      entrada: credencial({
        padron_validacion_activa: true,
        padron_probado_at: null,
        padron_ultimo_error_codigo: "RESPUESTA_PADRON_INVALIDA",
      }),
      esperado: "PRUEBA_FALLIDA" as const,
    },
    {
      nombre: "activa sin prueba y sin error",
      entrada: credencial({
        padron_validacion_activa: true,
        padron_probado_at: null,
        padron_ultimo_error_codigo: null,
      }),
      esperado: "FALTA_PROBAR" as const,
    },
    {
      nombre: "inactiva con prueba vieja y sin error",
      entrada: credencial({
        padron_validacion_activa: false,
        padron_probado_at: "2026-08-26T12:00:00.000Z",
        padron_ultimo_error_codigo: null,
      }),
      esperado: "FALTA_PROBAR" as const,
    },
  ])("resuelve de forma segura una credencial $nombre", ({ entrada, esperado }) => {
    expect(estadoVisualPadron(entrada)).toBe(esperado);
  });

  it("explica el requisito externo y la prueba sobre el CUIT del emisor", () => {
    const html = renderPadron(credencial());

    expect(html).toContain(
      "Asociá el certificado actual al servicio ws_sr_constancia_inscripcion en ARCA.",
    );
    expect(html).toContain(
      "La prueba consulta el CUIT del propio emisor y recién entonces activa la validación.",
    );
  });

  it.each([
    { nombre: "modo simulado", cred: credencial(), props: { mockMode: true } },
    {
      nombre: "credencial sin certificado",
      cred: credencial({ tiene_certificado: false }),
      props: {},
    },
    { nombre: "prueba pendiente", cred: credencial(), props: { probando: true } },
  ])("deshabilita la acción en $nombre y conserva su nombre accesible", ({ cred, props }) => {
    const boton = botonPadron(renderPadron(cred, props));

    expect(boton).toMatch(/\sdisabled(?:=""|>)/);
    expect(boton).toContain("Probar y activar padrón");
  });

  it("habilita la acción con certificado, fuera de modo simulado y sin prueba pendiente", () => {
    const boton = botonPadron(renderPadron(credencial()));

    expect(boton).not.toMatch(/\sdisabled(?:=""|>)/);
  });

  it("traduce el código cerrado de una prueba fallida y nunca muestra material técnico", () => {
    const entradaConSecretos = {
      ...credencial({
        padron_ultimo_error_codigo: "PADRON_NO_AUTORIZADO",
        padron_ultimo_error_at: "2026-08-26T12:00:00.000Z",
      }),
      arca_key_enc: "CLAVE_PRIVADA_NO_MOSTRAR",
      arca_cert_enc: "CERTIFICADO_PEM_NO_MOSTRAR",
      ticket: "TICKET_WSAA_NO_MOSTRAR",
      raw_error: "SQL service_role SOAP stack trace NO_MOSTRAR",
    } as CredencialArcaPublica;

    const html = renderPadron(entradaConSecretos);

    expect(html).toContain(mensajeCodigoErrorFiscalUsuario("PADRON_NO_AUTORIZADO"));
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("CLAVE_PRIVADA_NO_MOSTRAR");
    expect(html).not.toContain("CERTIFICADO_PEM_NO_MOSTRAR");
    expect(html).not.toContain("TICKET_WSAA_NO_MOSTRAR");
    expect(html).not.toContain("SQL service_role SOAP stack trace NO_MOSTRAR");
  });
});

describe("cableado administrativo del padrón ARCA", () => {
  it("prueba una sola vez el bloque elegido, informa el éxito y refresca la configuración", async () => {
    const solicitud = diferida<{
      cuit: string;
      razon_social: string;
      probado_at: string;
    }>();
    doblesAdmin.probarPadron.mockReturnValueOnce(solicitud.promise);

    const queryClient = renderConfigAdmin();
    const invalidar = vi.spyOn(queryClient, "invalidateQueries");
    const botones = await screen.findAllByRole("button", {
      name: "Probar y activar padrón",
    });
    const botonProduccion = botones[1] as HTMLButtonElement;

    fireEvent.click(botonProduccion);

    await waitFor(() => expect(botonProduccion.disabled).toBe(true));
    fireEvent.click(botonProduccion);
    expect(doblesAdmin.probarPadron).toHaveBeenCalledTimes(1);
    expect(doblesAdmin.probarPadron).toHaveBeenCalledWith({
      data: { emisor_id: emisorId, ambiente: "PRODUCCION" },
    });
    expect(doblesAdmin.probarWsfe).not.toHaveBeenCalled();
    expect(doblesAdmin.habilitarCredencial).not.toHaveBeenCalled();
    expect(doblesAdmin.guardarPv).not.toHaveBeenCalled();
    expect(doblesAdmin.generarCsr).not.toHaveBeenCalled();
    expect(doblesAdmin.guardarCertificado).not.toHaveBeenCalled();

    await act(async () => {
      solicitud.resolver({
        cuit: "30714199664",
        razon_social: "Quimex verificada SA",
        probado_at: "2026-08-26T20:30:00.000Z",
      });
      await solicitud.promise;
    });

    await waitFor(() =>
      expect(doblesAdmin.toast.success).toHaveBeenCalledWith(
        "Padrón activo. ARCA verificó Quimex verificada SA.",
      ),
    );
    await waitFor(() =>
      expect(invalidar).toHaveBeenCalledWith({ queryKey: QUERY_KEY_CONFIG_FISCAL_ADMIN }),
    );
    await waitFor(() => expect(doblesAdmin.cargar).toHaveBeenCalledTimes(2));
    expect(doblesAdmin.toast.error).not.toHaveBeenCalled();
  });

  it("traduce un rechazo técnico a copy seguro sin mezclar otras acciones", async () => {
    const detalleTecnico = "SQL service_role CERTIFICATE PRIVATE KEY SOAP stack trace";
    doblesAdmin.probarPadron.mockRejectedValueOnce(new Error(detalleTecnico));

    renderConfigAdmin();
    const botones = await screen.findAllByRole("button", {
      name: "Probar y activar padrón",
    });
    fireEvent.click(botones[0]);

    await waitFor(() =>
      expect(doblesAdmin.toast.error).toHaveBeenCalledWith(
        "No pudimos completar la configuración fiscal. Volvé a cargar la pantalla y verificá el estado; si continúa, avisale a un administrador técnico.",
        { duration: 10_000 },
      ),
    );
    expect(JSON.stringify(doblesAdmin.toast.error.mock.calls)).not.toContain(detalleTecnico);
    expect(document.body.textContent).not.toContain(detalleTecnico);
    expect(doblesAdmin.probarPadron).toHaveBeenCalledTimes(1);
    expect(doblesAdmin.probarPadron).toHaveBeenCalledWith({
      data: { emisor_id: emisorId, ambiente: "HOMOLOGACION" },
    });
    expect(doblesAdmin.probarWsfe).not.toHaveBeenCalled();
    expect(doblesAdmin.habilitarCredencial).not.toHaveBeenCalled();
    expect(doblesAdmin.guardarPv).not.toHaveBeenCalled();
    expect(doblesAdmin.generarCsr).not.toHaveBeenCalled();
    expect(doblesAdmin.guardarCertificado).not.toHaveBeenCalled();
    expect(doblesAdmin.toast.success).not.toHaveBeenCalled();
    expect(doblesAdmin.cargar).toHaveBeenCalledTimes(1);
  });
});
