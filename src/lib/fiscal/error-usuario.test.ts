import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  codigoCaidaArcaSegunFase,
  codigoErrorFiscalUsuario,
  crearErrorFiscalUsuario,
  mensajeCodigoErrorFiscalUsuario,
  mensajeErrorFiscal,
  parsearEntradaFiscal,
} from "./error-usuario";

describe("mensajes de error de facturación", () => {
  it("distingue una caída previa de la incertidumbre posterior usando la fase persistida", () => {
    expect(codigoCaidaArcaSegunFase("PREFLIGHT")).toBe("ARCA_CAIDA_PRE_REQUEST_NC");
    expect(codigoCaidaArcaSegunFase("RESERVADO")).toBe("ARCA_CAIDA_PRE_REQUEST_NC");
    expect(codigoCaidaArcaSegunFase("REQUEST_INICIADO")).toBe("ARCA_INCIERTA_POST_REQUEST_NC");
    expect(codigoCaidaArcaSegunFase("RESPUESTA_RECIBIDA")).toBe("ARCA_INCIERTA_POST_REQUEST_NC");

    expect(mensajeCodigoErrorFiscalUsuario("ARCA_CAIDA_PRE_REQUEST_NC")).toBe(
      "ARCA está caída. No se pudo emitir la nota de crédito. Intentá nuevamente en otro momento.",
    );
    expect(mensajeCodigoErrorFiscalUsuario("ARCA_INCIERTA_POST_REQUEST_NC")).toBe(
      "ARCA está caída y estamos verificando si autorizó la nota. No vuelvas a emitirla.",
    );
  });

  it.each([
    ["periodo_desde", "Elegí la fecha desde del período asociado."],
    ["periodo_hasta", "Elegí la fecha hasta del período asociado."],
    ["motivo", "Explicá el motivo de la nota de crédito con al menos 5 caracteres."],
    ["modalidad", "Elegí cómo se compone la nota de crédito."],
    ["resolucion", "Elegí qué ocurre con el importe acreditado."],
    ["items", "Revisá los productos o el importe de la nota de crédito."],
    ["pagos", "El reintegro debe coincidir con el total de la nota."],
  ] as const)("traduce la validación inline de %s sin filtrar Zod", (campo, esperado) => {
    const mensaje = mensajeErrorFiscal(
      new Error(
        JSON.stringify({
          issues: [{ code: "custom", path: [campo], message: "raw Zod issue secreto" }],
        }),
      ),
      "REVISION",
    );

    expect(mensaje).toBe(esperado);
    expect(mensaje).not.toMatch(/Zod|custom|issues|raw|path|JSON/i);
  });

  it.each([
    [
      "PERMISO_NC_PERIODO",
      "No tenés permiso para crear notas de crédito por período. Pedile acceso a un administrador.",
    ],
    [
      "FCE_NC_PERIODO_NO_SOPORTADA",
      "Una nota de crédito por período no es compatible con FCE. Asociá los comprobantes puntuales que querés ajustar.",
    ],
    [
      "CERTIFICADO_ARCA_INVALIDO",
      "No se pudo emitir porque el certificado de ARCA está vencido o no autorizado. Un administrador debe corregir la configuración fiscal del emisor.",
    ],
    [
      "CONFLICTO_RECONCILIACION_NC",
      "Los datos recuperados de ARCA no coinciden con la nota reservada. La emisión quedó bloqueada para revisión; no vuelvas a emitirla.",
    ],
  ] as const)("expone una acción segura para %s", (codigo, esperado) => {
    const error = Object.assign(crearErrorFiscalUsuario(codigo), {
      cause: new Error("SOAP SQL certificate PEM raw ARCA"),
    });
    const mensaje = mensajeErrorFiscal(error, "EMISION");

    expect(mensaje).toBe(esperado);
    expect(mensaje).not.toMatch(/SOAP|SQL|PEM|raw/i);
    if (codigo === "CERTIFICADO_ARCA_INVALIDO") expect(mensaje).not.toContain("ARCA está caída");
  });

  it("usa exactamente el mensaje aprobado cuando el padrón está caído", () => {
    const mensaje = mensajeErrorFiscal(crearErrorFiscalUsuario("PADRON_ARCA_CAIDO"), "EMISION");

    expect(mensaje).toBe(
      "ARCA está caído y no pudimos verificar el CUIT. No se emitió ningún comprobante. Intentá nuevamente en otro momento.",
    );
    expect(mensaje).not.toMatch(/no responde|timeout|soap|ticket/i);
  });

  it("extrae únicamente códigos públicos marcados", () => {
    expect(codigoErrorFiscalUsuario(crearErrorFiscalUsuario("PADRON_NO_AUTORIZADO"))).toBe(
      "PADRON_NO_AUTORIZADO",
    );
    expect(
      codigoErrorFiscalUsuario(new Error("SOAPFault: private key and ticket leaked")),
    ).toBeNull();
  });

  it.each([
    [
      "PADRON_NO_AUTORIZADO",
      "El certificado no está habilitado para consultar el padrón de ARCA. Un administrador debe asociarlo al servicio ws_sr_constancia_inscripcion y probar nuevamente la conexión.",
    ],
    [
      "PADRON_CONFIG_INVALIDA",
      "No se pudo usar la configuración del padrón de ARCA. Un administrador debe revisar el certificado y volver a probar la conexión. No se emitió ningún comprobante.",
    ],
    ["CUIT_INVALIDO", "El CUIT ingresado no es válido. Revisá los 11 dígitos y volvé a intentar."],
    [
      "CUIT_NO_ENCONTRADO",
      "ARCA no encontró el CUIT ingresado. Revisalo antes de continuar. No se emitió ningún comprobante.",
    ],
    [
      "CUIT_INACTIVO",
      "El CUIT figura inactivo en ARCA. No se puede emitir el comprobante a ese receptor.",
    ],
    [
      "RESPUESTA_PADRON_INVALIDA",
      "ARCA devolvió datos incompletos o inconsistentes para este CUIT. No se emitió ningún comprobante. Intentá nuevamente o avisale a un administrador.",
    ],
    [
      "CONDICION_FISCAL_INCOMPATIBLE",
      "La condición fiscal informada por ARCA no es compatible con la letra elegida. Revisá la letra del comprobante antes de continuar.",
    ],
    [
      "MANTENIMIENTO_POST_VENTA",
      "La venta quedó registrada y la emisión está en mantenimiento. No repitas la venta ni el cobro; revisá el estado en la cola fiscal.",
    ],
  ] as const)("traduce y redacciona de forma segura el código %s", (codigo, esperado) => {
    const causa = "SOAP SQL certificate PEM ticket supplied raw cause";
    const marcado = Object.assign(crearErrorFiscalUsuario(codigo), {
      cause: new Error(causa),
    });

    expect(mensajeCodigoErrorFiscalUsuario(codigo)).toBe(esperado);
    const mensaje = mensajeErrorFiscal(marcado, "EMISION");
    expect(mensaje).toBe(esperado);
    expect(mensaje).not.toMatch(/SOAP|SQL|certificate PEM|ticket|supplied raw cause/i);
  });

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
