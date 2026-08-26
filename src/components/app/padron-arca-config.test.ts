import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CredencialArcaPublica } from "@/lib/fiscal/config";
import { mensajeCodigoErrorFiscalUsuario } from "@/lib/fiscal/error-usuario";
import { PadronArcaConfig, estadoVisualPadron } from "./padron-arca-config";

const emisorId = "4d50771a-6bc7-4b84-a5e7-a112f00d6b24";

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
