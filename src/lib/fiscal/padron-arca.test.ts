import { describe, expect, it, vi } from "vitest";
import { cuitValido } from "./codigos";
import { codigoErrorFiscalUsuario } from "./error-usuario";
import {
  consultarPadronArca,
  receptorPadronArcaSchema,
  type DependenciasPadronArca,
} from "./padron-arca";

const CUIT_JURIDICA = "30714199664";
const CUIT_FISICA = "20329642330";
const FECHA_VERIFICACION = new Date("2026-08-26T15:30:00.000Z");

function juridicaRi(): unknown {
  return {
    idPersona: 30714199664,
    tipoPersona: "JURIDICA",
    estadoClave: "ACTIVO",
    datosGenerales: {
      idPersona: 30714199664,
      tipoPersona: "JURIDICA",
      estadoClave: "ACTIVO",
      razonSocial: "APLICACIONES Y SERVICIOS S.R.L.",
      domicilioFiscal: {
        direccion: "Sarmiento 1398",
        localidad: "Córdoba",
        descripcionProvincia: "Córdoba",
        codPostal: "5000",
      },
    },
    datosRegimenGeneral: {
      impuesto: [{ idImpuesto: 30, estadoImpuesto: "AC" }],
    },
  };
}

function fisicaMonotributo(): unknown {
  return {
    idPersona: 20329642330,
    tipoPersona: "FISICA",
    estadoClave: "ACTIVO",
    datosGenerales: {
      apellido: "Pérez",
      nombre: "Ana",
      domicilioFiscal: { direccion: "San Martín 10" },
    },
    datosMonotributo: {
      impuesto: [{ idImpuesto: 20, estadoImpuesto: "AC" }],
    },
  };
}

function modificarFixture(
  fixture: unknown,
  modificar: (persona: Record<string, unknown>) => void,
): unknown {
  const persona = structuredClone(fixture) as Record<string, unknown>;
  modificar(persona);
  return persona;
}

function dependencias(
  respuesta: unknown,
  ahora = FECHA_VERIFICACION,
): DependenciasPadronArca & {
  obtenerContribuyente: ReturnType<typeof vi.fn>;
} {
  return {
    obtenerContribuyente: vi.fn(async () => respuesta),
    ahora: () => ahora,
  };
}

async function codigoDeRechazo(promesa: Promise<unknown>) {
  const error = await promesa.catch((cause) => cause);
  return codigoErrorFiscalUsuario(error);
}

async function capturarError(promesa: Promise<unknown>): Promise<Error> {
  return (await promesa.catch((cause) => cause)) as Error;
}

describe("normalizador del padrón ARCA", () => {
  it("normaliza una persona jurídica RI en la identidad canónica", async () => {
    const deps = dependencias(juridicaRi());

    await expect(consultarPadronArca("30-71419966-4", deps)).resolves.toEqual({
      cuit: CUIT_JURIDICA,
      razonSocial: "APLICACIONES Y SERVICIOS S.R.L.",
      domicilioFiscal: "Sarmiento 1398, Córdoba, 5000",
      estado: "ACTIVO",
      tipoPersona: "JURIDICA",
      condicionIvaConfirmada: "RESPONSABLE_INSCRIPTO",
      verificadoArcaAt: "2026-08-26T15:30:00.000Z",
    });
  });

  it("normaliza una persona física monotributista desde apellido y nombre", async () => {
    await expect(
      consultarPadronArca(CUIT_FISICA, dependencias(fisicaMonotributo())),
    ).resolves.toEqual({
      cuit: CUIT_FISICA,
      razonSocial: "Pérez Ana",
      domicilioFiscal: "San Martín 10",
      estado: "ACTIVO",
      tipoPersona: "FISICA",
      condicionIvaConfirmada: "MONOTRIBUTO",
      verificadoArcaAt: "2026-08-26T15:30:00.000Z",
    });
  });

  it("mantiene la ausencia de impuestos activos como condición nula", async () => {
    const sinImpuestos = modificarFixture(juridicaRi(), (persona) => {
      delete persona.datosRegimenGeneral;
    });

    await expect(
      consultarPadronArca(CUIT_JURIDICA, dependencias(sinImpuestos)),
    ).resolves.toMatchObject({
      condicionIvaConfirmada: null,
    });
  });

  it("rechaza impuestos activos incompatibles", async () => {
    const ambosActivos = modificarFixture(juridicaRi(), (persona) => {
      persona.datosMonotributo = {
        impuesto: [{ idImpuesto: 20, estadoImpuesto: "AC" }],
      };
    });

    await expect(
      codigoDeRechazo(consultarPadronArca(CUIT_JURIDICA, dependencias(ambosActivos))),
    ).resolves.toBe("RESPUESTA_PADRON_INVALIDA");
  });

  it.each([
    [
      "CUIT remoto distinto",
      () => modificarFixture(juridicaRi(), (persona) => (persona.idPersona = 30714199663)),
    ],
    [
      "tipo de persona no permitido",
      () =>
        modificarFixture(juridicaRi(), (persona) => {
          persona.tipoPersona = "OTRA";
          (persona.datosGenerales as Record<string, unknown>).tipoPersona = "OTRA";
        }),
    ],
    [
      "identidad jurídica vacía",
      () =>
        modificarFixture(juridicaRi(), (persona) => {
          (persona.datosGenerales as Record<string, unknown>).razonSocial = "   ";
        }),
    ],
    [
      "lista de impuestos malformada",
      () =>
        modificarFixture(juridicaRi(), (persona) => {
          (persona.datosRegimenGeneral as Record<string, unknown>).impuesto = {
            idImpuesto: 30,
            estadoImpuesto: "AC",
          };
        }),
    ],
  ])("rechaza respuesta %s", async (_caso, crearRespuesta) => {
    await expect(
      codigoDeRechazo(consultarPadronArca(CUIT_JURIDICA, dependencias(crearRespuesta()))),
    ).resolves.toBe("RESPUESTA_PADRON_INVALIDA");
  });

  it("rechaza un índice accessor del array remoto sin ejecutar su texto", async () => {
    let accessorEjecutado = false;
    const conAccessor = modificarFixture(juridicaRi(), (persona) => {
      const impuesto: unknown[] = [];
      Object.defineProperty(impuesto, "0", {
        enumerable: true,
        get() {
          accessorEjecutado = true;
          throw new Error("SENSITIVE-PADRON-ARRAY-GETTER");
        },
      });
      (persona.datosRegimenGeneral as Record<string, unknown>).impuesto = impuesto;
    });

    const error = await capturarError(
      consultarPadronArca(CUIT_JURIDICA, dependencias(conAccessor)),
    );

    expect(codigoErrorFiscalUsuario(error)).toBe("RESPUESTA_PADRON_INVALIDA");
    expect(error.message).not.toContain("SENSITIVE-PADRON-ARRAY-GETTER");
    expect(accessorEjecutado).toBe(false);
  });

  it("rechaza un proxy revocado del array remoto sin filtrar su causa", async () => {
    const revocable = Proxy.revocable([], {});
    revocable.revoke();
    const conProxyRevocado = modificarFixture(juridicaRi(), (persona) => {
      (persona.datosRegimenGeneral as Record<string, unknown>).impuesto = revocable.proxy;
    });

    const error = await capturarError(
      consultarPadronArca(CUIT_JURIDICA, dependencias(conProxyRevocado)),
    );

    expect(codigoErrorFiscalUsuario(error)).toBe("RESPUESTA_PADRON_INVALIDA");
    expect(error.message).not.toContain("revoked");
  });

  it("reemplaza un marcador fiscal falsificado por un error público nuevo", async () => {
    const atacante = Object.assign(new Error("SENSITIVE-PADRON-SPOOFED-MARKER"), {
      codigoFiscalUsuario: "RESPUESTA_PADRON_INVALIDA",
    });
    const impuesto = new Proxy([], {
      getPrototypeOf() {
        throw atacante;
      },
    });
    const conMarcadorFalsificado = modificarFixture(juridicaRi(), (persona) => {
      (persona.datosRegimenGeneral as Record<string, unknown>).impuesto = impuesto;
    });

    const error = await capturarError(
      consultarPadronArca(CUIT_JURIDICA, dependencias(conMarcadorFalsificado)),
    );

    expect(codigoErrorFiscalUsuario(error)).toBe("RESPUESTA_PADRON_INVALIDA");
    expect(error).not.toBe(atacante);
    expect(error.message).not.toContain("SENSITIVE-PADRON-SPOOFED-MARKER");
  });

  it("rechaza un contribuyente inactivo", async () => {
    const inactivo = modificarFixture(juridicaRi(), (persona) => {
      persona.estadoClave = "INACTIVO";
      (persona.datosGenerales as Record<string, unknown>).estadoClave = "INACTIVO";
    });

    await expect(
      codigoDeRechazo(consultarPadronArca(CUIT_JURIDICA, dependencias(inactivo))),
    ).resolves.toBe("CUIT_INACTIVO");
  });

  it("traduce una ausencia remota a CUIT_NO_ENCONTRADO", async () => {
    await expect(
      codigoDeRechazo(consultarPadronArca(CUIT_JURIDICA, dependencias(null))),
    ).resolves.toBe("CUIT_NO_ENCONTRADO");
  });

  it("rechaza un reloj inválido en lugar de fabricar una marca de tiempo", async () => {
    await expect(
      codigoDeRechazo(
        consultarPadronArca(CUIT_JURIDICA, dependencias(juridicaRi(), new Date("invalid"))),
      ),
    ).resolves.toBe("RESPUESTA_PADRON_INVALIDA");
  });

  it("valida el checksum antes de invocar la dependencia remota", async () => {
    const deps = dependencias(juridicaRi());
    const cuitInvalido = "30714199663";

    expect(cuitValido(cuitInvalido)).toBe(false);
    await expect(codigoDeRechazo(consultarPadronArca(cuitInvalido, deps))).resolves.toBe(
      "CUIT_INVALIDO",
    );
    expect(deps.obtenerContribuyente).not.toHaveBeenCalled();
  });

  it("emite solamente resultados que satisfacen el contrato público estricto", async () => {
    const resultado = await consultarPadronArca(CUIT_JURIDICA, dependencias(juridicaRi()));

    expect(receptorPadronArcaSchema.safeParse(resultado).success).toBe(true);
  });
});
