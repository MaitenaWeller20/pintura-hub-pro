import { describe, expect, it } from "vitest";
import * as fiscalFunctions from "./fiscal.functions";
import {
  consultaCuitPadronInputSchema,
  emitirInputSchema,
  ejecutarConsultaPadronOperador,
  ejecutarFachadaEmisionPostBorrador,
  postBorradorInputSchema,
  proyectarIncidenteFiscal,
} from "./fiscal.functions";
import type { ContextoFiscal } from "./fiscal/contexto";
import type { ReceptorPadronArca } from "./fiscal/padron-arca";
import { codigoErrorFiscalUsuario, crearErrorFiscalUsuario } from "./fiscal/error-usuario";

const INPUT = {
  venta_id: "71000000-0000-4000-8000-000000000001",
  receptor: { origen: "CLIENTE_COMERCIAL" as const },
  letra_solicitada: "B" as const,
  confirma_venta_antigua: false,
  huella_confirmacion_provisional:
    "9df51a2cdbd04aaa392561b214a01a6b8c200ba1762608f23c7fadb111848979",
};

type EsquemaEntrada = { parse(value: unknown): unknown };

function esquemaPreviewFiscal(): EsquemaEntrada {
  const esquema = (fiscalFunctions as unknown as { previewInputSchema?: EsquemaEntrada })
    .previewInputSchema;
  expect(esquema).toBeDefined();
  return esquema!;
}

const RECEPTOR_PADRON: ReceptorPadronArca = {
  cuit: "30714199664",
  razonSocial: "QUIMEX PRUEBA SA",
  domicilioFiscal: "Sarmiento 123, Cordoba",
  estado: "ACTIVO",
  tipoPersona: "JURIDICA",
  condicionIvaConfirmada: "RESPONSABLE_INSCRIPTO",
  verificadoArcaAt: "2026-08-26T12:34:56.000-03:00",
};

function contextoPadron(validacionActiva: boolean): ContextoFiscal {
  return {
    padron: { validacionActiva, probadoAt: validacionActiva ? "2026-08-26T12:00:00Z" : null },
  } as ContextoFiscal;
}

describe("consulta autorizada del CUIT para el operador", () => {
  it("autoriza la sucursal antes de cargar contexto privilegiado", async () => {
    const orden: string[] = [];

    await expect(
      ejecutarConsultaPadronOperador(
        {
          sucursalId: "71000000-0000-4000-8000-000000000301",
          cuit: "30714199664",
        },
        {
          autorizarSucursal: async () => {
            orden.push("permiso");
            throw new Error("sin permiso");
          },
          cargarContexto: async () => {
            orden.push("service-role");
            throw new Error("no debe ejecutarse");
          },
          consultar: async () => {
            orden.push("ARCA");
            throw new Error("no debe ejecutarse");
          },
        },
      ),
    ).rejects.toThrow(/permiso/i);
    expect(orden).toEqual(["permiso"]);
  });

  it("devuelve INACTIVO sin consultar ARCA", async () => {
    const orden: string[] = [];

    await expect(
      ejecutarConsultaPadronOperador(
        {
          sucursalId: "71000000-0000-4000-8000-000000000301",
          cuit: "30714199664",
        },
        {
          autorizarSucursal: async () => {
            orden.push("permiso");
          },
          cargarContexto: async () => {
            orden.push("contexto");
            return contextoPadron(false);
          },
          consultar: async () => {
            orden.push("ARCA");
            return RECEPTOR_PADRON;
          },
        },
      ),
    ).resolves.toEqual({ estado: "INACTIVO" });
    expect(orden).toEqual(["permiso", "contexto"]);
  });

  it("cuando está activo proyecta únicamente el receptor canónico", async () => {
    const resultado = await ejecutarConsultaPadronOperador(
      {
        sucursalId: "71000000-0000-4000-8000-000000000301",
        cuit: "30714199664",
      },
      {
        autorizarSucursal: async () => undefined,
        cargarContexto: async () => contextoPadron(true),
        consultar: async () => RECEPTOR_PADRON,
      },
    );

    expect(resultado).toEqual({ estado: "VERIFICADO", receptor: RECEPTOR_PADRON });
    expect(JSON.stringify(resultado)).not.toMatch(/cert|key|ticket|soap/i);
  });

  it("cierra fallos privilegiados sin transportar detalles internos", async () => {
    const errorContexto = await ejecutarConsultaPadronOperador(
      {
        sucursalId: "71000000-0000-4000-8000-000000000301",
        cuit: "30714199664",
      },
      {
        autorizarSucursal: async () => undefined,
        cargarContexto: async () => {
          throw new Error("SQL credencial secreta");
        },
        consultar: async () => RECEPTOR_PADRON,
      },
    ).catch((error: unknown) => error);
    expect(codigoErrorFiscalUsuario(errorContexto)).toBe("PADRON_CONFIG_INVALIDA");
    expect(String(errorContexto)).not.toContain("SQL credencial secreta");

    const caida = crearErrorFiscalUsuario("PADRON_ARCA_CAIDO");
    const errorConsulta = await ejecutarConsultaPadronOperador(
      {
        sucursalId: "71000000-0000-4000-8000-000000000301",
        cuit: "30714199664",
      },
      {
        autorizarSucursal: async () => undefined,
        cargarContexto: async () => contextoPadron(true),
        consultar: async () => {
          throw caida;
        },
      },
    ).catch((error: unknown) => error);
    expect(errorConsulta).toBe(caida);
  });

  it("valida una sucursal UUID estricta pero deja el checksum para después de auth", () => {
    expect(
      consultaCuitPadronInputSchema.parse({
        sucursal_id: "71000000-0000-4000-8000-000000000301",
        cuit: "30621146314",
      }),
    ).toEqual({
      sucursal_id: "71000000-0000-4000-8000-000000000301",
      cuit: "30621146314",
    });
    expect(() =>
      consultaCuitPadronInputSchema.parse({
        sucursal_id: "no-es-uuid",
        cuit: "30714199664",
      }),
    ).toThrow();
    expect(() =>
      consultaCuitPadronInputSchema.parse({
        sucursal_id: "71000000-0000-4000-8000-000000000301",
        cuit: "30714199664",
        credencial: "no debe entrar",
      }),
    ).toThrow();
  });
});

describe("contrato público de letra fiscal solicitada", () => {
  const emision = {
    venta_id: INPUT.venta_id,
    receptor: INPUT.receptor,
    letra_solicitada: "B" as const,
    confirma_venta_antigua: false,
    huella_confirmacion: INPUT.huella_confirmacion_provisional,
  };

  it("exige letra_solicitada en toda emisión v2 regular", () => {
    const { letra_solicitada: _omitida, ...sinLetra } = emision;

    expect(emitirInputSchema.parse(emision)).toEqual(emision);
    expect(() => emitirInputSchema.parse(sinLetra)).toThrow();
  });

  it("exige letra_solicitada en la emisión inmediata post-borrador", () => {
    const { letra_solicitada: _omitida, ...sinLetra } = INPUT;

    expect(postBorradorInputSchema.parse(INPUT)).toEqual(INPUT);
    expect(() => postBorradorInputSchema.parse(sinLetra)).toThrow();
  });

  it.each(["C", "X", "", 1, null])(
    "rechaza la letra solicitada fuera de A/B: %j",
    (letra_solicitada) => {
      expect(() => emitirInputSchema.parse({ ...emision, letra_solicitada })).toThrow();
      expect(() => postBorradorInputSchema.parse({ ...INPUT, letra_solicitada })).toThrow();
    },
  );

  it("rechaza una razón social vacía aunque el cliente omita la validación visual", () => {
    expect(() =>
      emitirInputSchema.parse({
        ...emision,
        receptor: {
          origen: "MANUAL",
          tipo_documento: "SIN_IDENTIFICAR",
          numero_documento: null,
          razon_social: "   ",
          condicion_iva: "CONSUMIDOR_FINAL",
          domicilio: null,
          guardar_para_proximas: false,
          confirma_datos_manuales: true,
        },
      }),
    ).toThrow();
  });

  it("exige A/B también al previsualizar borrador o venta ya registrada", () => {
    const esquema = esquemaPreviewFiscal();
    const ventaExistente = {
      origen: "VENTA_EXISTENTE",
      venta_id: INPUT.venta_id,
      receptor: INPUT.receptor,
      letra_solicitada: "A",
    };
    const borrador = {
      origen: "BORRADOR",
      sucursal_id: "71000000-0000-4000-8000-000000000301",
      cliente_id: "71000000-0000-4000-8000-000000000401",
      fecha_comercial: "2026-08-24T15:00:00.000Z",
      items: [
        {
          producto_id: "71000000-0000-4000-8000-000000000501",
          cantidad: 1,
          descuento_porcentaje: 0,
        },
      ],
      pagos: [],
      percepciones: 0,
      receptor: INPUT.receptor,
      letra_solicitada: "B",
    };

    expect(esquema.parse(ventaExistente)).toEqual(ventaExistente);
    expect(esquema.parse(borrador)).toEqual(borrador);
    expect(() => {
      const { letra_solicitada: _omitida, ...sinLetra } = ventaExistente;
      esquema.parse(sinLetra);
    }).toThrow();
    expect(() => esquema.parse({ ...borrador, letra_solicitada: "C" })).toThrow();
  });
});

describe("fachada post-borrador", () => {
  it("exige una huella canónica en toda emisión v2 regular", () => {
    const v2 = {
      venta_id: INPUT.venta_id,
      receptor: INPUT.receptor,
      letra_solicitada: INPUT.letra_solicitada,
      confirma_venta_antigua: false,
      huella_confirmacion: INPUT.huella_confirmacion_provisional,
    };
    expect(emitirInputSchema.parse(v2)).toEqual(v2);
    expect(() => emitirInputSchema.parse({ ...v2, huella_confirmacion: undefined })).toThrow();
    expect(() => emitirInputSchema.parse({ ...v2, huella_confirmacion: "a" })).toThrow();
  });

  it("rechaza claves desconocidas y huellas no canónicas antes del handler", () => {
    expect(postBorradorInputSchema).toBeDefined();
    expect(postBorradorInputSchema.parse(INPUT)).toEqual(INPUT);
    expect(() => postBorradorInputSchema.parse({ ...INPUT, extra: "no" })).toThrow();
    expect(() =>
      postBorradorInputSchema.parse({ ...INPUT, huella_confirmacion_provisional: "ABC" }),
    ).toThrow();
  });

  it("fencea por autenticación y permiso antes de flags/preview/engine", async () => {
    const orden: string[] = [];

    await expect(
      ejecutarFachadaEmisionPostBorrador(INPUT, {
        asegurarAutenticacion: async () => {
          orden.push("auth");
          throw new Error("sin sesión");
        },
        autorizar: async () => orden.push("permiso"),
        cargarFlags: async () => {
          orden.push("flags");
          return {
            facturacion_receptor_v2_enabled: true,
            facturacion_legacy_writer_enabled: false,
          };
        },
        ejecutar: async () => {
          orden.push("engine");
          throw new Error("no debe llegar");
        },
      }),
    ).rejects.toThrow(/sesión/i);
    expect(orden).toEqual(["auth"]);

    orden.length = 0;
    await expect(
      ejecutarFachadaEmisionPostBorrador(INPUT, {
        asegurarAutenticacion: async () => orden.push("auth"),
        autorizar: async () => {
          orden.push("permiso");
          throw new Error("sin capacidad");
        },
        cargarFlags: async () => {
          orden.push("flags");
          return {
            facturacion_receptor_v2_enabled: true,
            facturacion_legacy_writer_enabled: false,
          };
        },
        ejecutar: async () => {
          orden.push("engine");
          throw new Error("no debe llegar");
        },
      }),
    ).rejects.toThrow(/capacidad/i);
    expect(orden).toEqual(["auth", "permiso"]);
  });

  it("respeta maintenance/legacy fencing y sólo ejecuta con el cuadrante v2", async () => {
    let ejecuciones = 0;
    const base = {
      asegurarAutenticacion: async () => undefined,
      autorizar: async () => undefined,
      ejecutar: async () => {
        ejecuciones += 1;
        return { estado: "APROBADO" as const };
      },
    };

    await expect(
      ejecutarFachadaEmisionPostBorrador(INPUT, {
        ...base,
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: true,
        }),
      }),
    ).rejects.toThrow(/v2.*habilitado|receptor v2/i);
    expect(ejecuciones).toBe(0);

    await expect(
      ejecutarFachadaEmisionPostBorrador(INPUT, {
        ...base,
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: false,
        }),
      }),
    ).resolves.toMatchObject({ estado: "MANTENIMIENTO" });
    expect(ejecuciones).toBe(0);

    await expect(
      ejecutarFachadaEmisionPostBorrador(INPUT, {
        ...base,
        cargarFlags: async () => ({
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: false,
        }),
      }),
    ).resolves.toEqual({ estado: "APROBADO" });
    expect(ejecuciones).toBe(1);
  });
});

describe("detalle readonly de un incidente fiscal", () => {
  it("conserva diferencias únicas del último intento sin exponer el resumen crudo", () => {
    expect(
      proyectarIncidenteFiscal(
        {
          id: INPUT.venta_id,
          afip_estado: "BLOQUEADO",
          afip_fase: "REQUEST_INICIADO",
          afip_error: "La respuesta no coincide con la reserva.",
          afip_error_clase: "INTEGRIDAD",
          afip_error_codigo: "RESPUESTA_DIVERGENTE",
          afip_error_fase: "RESPUESTA_RECIBIDA",
          afip_ultimo_error_at: "2026-08-23T15:00:00.000Z",
        },
        {
          resultado: "BLOQUEADO",
          respuesta_resumen: {
            diagnostico: {
              diferencias: { campos: ["importeTotal", "receptor.docNroArca", "importeTotal"] },
            },
            soap_crudo: "NO DEBE SALIR",
          },
        },
      ),
    ).toEqual({
      venta_id: INPUT.venta_id,
      estado: "BLOQUEADO",
      fase: "REQUEST_INICIADO",
      mensaje: {
        tipo: "ERROR_FISCAL_USUARIO_V1",
        codigo: "INCIDENTE_INTEGRIDAD",
      },
      clase: "INTEGRIDAD",
      codigo: "RESPUESTA_DIVERGENTE",
      fase_error: "RESPUESTA_RECIBIDA",
      fecha: "2026-08-23T15:00:00.000Z",
      diferencias: ["importeTotal", "receptor.docNroArca"],
      legacy: false,
    });
  });

  it("marca un incidente legacy sin inventar diferencias", () => {
    const incidente = proyectarIncidenteFiscal(
      {
        id: INPUT.venta_id,
        afip_estado: "ERROR",
        afip_fase: null,
        afip_error: "Error heredado",
        afip_error_clase: null,
        afip_error_codigo: null,
        afip_error_fase: null,
        afip_ultimo_error_at: null,
      },
      null,
    );

    expect(incidente).toMatchObject({
      legacy: true,
      diferencias: [],
      mensaje: {
        tipo: "ERROR_FISCAL_USUARIO_V1",
        codigo: "INCIDENTE_LEGACY_ERROR",
      },
    });
    expect(JSON.stringify(incidente)).not.toContain("Error heredado");
  });
});
