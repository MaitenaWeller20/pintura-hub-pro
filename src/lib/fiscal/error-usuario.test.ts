import { describe, expect, it } from "vitest";
import { z } from "zod";
import { crearErrorFiscalUsuario, mensajeErrorFiscal, parsearEntradaFiscal } from "./error-usuario";

describe("mensajes de error de facturación", () => {
  it("explica una razón social faltante sin mostrar la validación serializada", () => {
    const error = new Error(
      JSON.stringify([
        {
          code: "too_small",
          minimum: 1,
          type: "string",
          inclusive: true,
          exact: false,
          message: "String must contain at least 1 character(s)",
          path: ["receptor", "razon_social"],
        },
      ]),
    );

    const mensaje = mensajeErrorFiscal(error, "REVISION");

    expect(mensaje).toContain("Completá la razón social del receptor");
    expect(mensaje).toContain("ARCA");
    expect(mensaje).not.toMatch(/too_small|minimum|path|String must|\[\{/);
  });

  it("no expone detalles de PostgREST o SQL durante la revisión", () => {
    const mensaje = mensajeErrorFiscal(
      new Error('PGRST204: column "razon_social" of relation "ventas" does not exist'),
      "REVISION",
    );

    expect(mensaje).toContain("La emisión no comenzó");
    expect(mensaje).toContain("volvé a intentar");
    expect(mensaje).not.toMatch(/PGRST|column|relation|ventas/i);
  });

  it("ante una conexión incierta al emitir indica revisar la cola antes de reintentar", () => {
    const mensaje = mensajeErrorFiscal(new TypeError("Failed to fetch"), "EMISION");

    expect(mensaje).toContain("No pudimos confirmar la respuesta de ARCA");
    expect(mensaje).toContain("revisá su estado en la cola fiscal");
    expect(mensaje).not.toContain("Failed to fetch");
  });

  it("en configuración fiscal indica verificar el estado sin exponer SQL", () => {
    const mensaje = mensajeErrorFiscal(
      new Error('PGRST204: column "certificado_enc" does not exist'),
      "CONFIGURACION",
    );

    expect(mensaje).toContain("configuración fiscal");
    expect(mensaje).toContain("Volvé a cargar");
    expect(mensaje).not.toMatch(/PGRST|column|certificado_enc/i);
  });

  it("oculta SQL aunque venga precedido por una frase aparentemente amigable", () => {
    const mensaje = mensajeErrorFiscal(
      new Error("No se pudo guardar el receptor fiscal: permission denied for table receptores"),
      "REVISION",
    );

    expect(mensaje).toContain("La emisión no comenzó");
    expect(mensaje).not.toMatch(/permission denied|table|receptores/i);
  });

  it("sólo conserva rechazos explícitamente marcados como mensaje de dominio", () => {
    const mensaje = mensajeErrorFiscal(crearErrorFiscalUsuario("ARCA_RECHAZO"), "EMISION");

    expect(mensaje).toContain("ARCA rechazó el comprobante");
    expect(mensaje).toContain("Revisá los datos fiscales");
  });

  it.each([
    "No se pudo guardar: value too long for type character varying(120)",
    "No se pudo guardar: numeric field overflow",
    "No se pudo guardar: EAI_AGAIN getaddrinfo api.arca.gob.ar",
    "No se pudo guardar. Revisá SUPABASE_SERVICE_ROLE_KEY y DATABASE_URL.",
    "No se pudo guardar\n    at guardarReceptor (/app/fiscal.ts:42:7)",
  ])("jamás confía en un Error.message no marcado: %s", (detalleTecnico) => {
    const mensaje = mensajeErrorFiscal(new Error(detalleTecnico), "CONFIGURACION");

    expect(mensaje).toContain("configuración fiscal");
    expect(mensaje).not.toContain(detalleTecnico);
    expect(mensaje).not.toMatch(
      /value too long|numeric field overflow|EAI_AGAIN|getaddrinfo|SERVICE_ROLE|DATABASE_URL|fiscal\.ts/i,
    );
  });

  it("convierte la validación del servidor en un error seguro antes de transportarlo", () => {
    const schema = z.object({
      receptor: z.object({ razon_social: z.string().min(1) }),
    });

    let capturado: unknown;
    try {
      parsearEntradaFiscal(schema, { receptor: { razon_social: "" } });
    } catch (error) {
      capturado = error;
      expect(mensajeErrorFiscal(error, "REVISION")).toContain(
        "Completá la razón social del receptor",
      );
      expect(String(error)).not.toMatch(/too_small|minimum|path|String must|ZodError/);
    }
    expect(capturado).toBeDefined();
  });
});
