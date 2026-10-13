import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReceptorFiscalFavorito } from "@/lib/fiscal/cola.functions";
import {
  bloqueaAccionesPorConsultaPadron,
  claveConsultaPadronId,
  claveParaConsultaPadron,
  crearControlConsultaPadron,
  cuitParaConsulta,
  estadoConsultaPadronEfectivo,
  esConsultaPadronActual,
  iniciarConsultaPadron,
  invalidarConsultaPadron,
  programarConsultaPadron,
  resultadoConsultaCuitPadronSchema,
} from "./padron-receptor";
import type { ClaveConsultaPadron } from "./padron-receptor";

afterEach(() => vi.useRealTimers());

const CLIENTE = {
  razonSocial: "Cliente comercial",
  documento: "30-71419966-4",
  condicionIva: "CONSUMIDOR_FINAL" as const,
};

const FAVORITO: ReceptorFiscalFavorito = {
  id: "10000000-0000-4000-8000-000000000001",
  sucursal_id: "20000000-0000-4000-8000-000000000001",
  cliente_comercial_id: null,
  tipo_documento: "CUIT",
  numero_documento: "30-71419966-4",
  razon_social: "Nombre guardado viejo",
  condicion_iva: "EXENTO",
  domicilio: null,
};

const RECEPTOR_PADRON = {
  cuit: "30714199664",
  razonSocial: "IDENTIDAD OFICIAL SA",
  domicilioFiscal: "Sarmiento 123, Cordoba",
  estado: "ACTIVO" as const,
  tipoPersona: "JURIDICA" as const,
  condicionIvaConfirmada: "RESPONSABLE_INSCRIPTO" as const,
  verificadoArcaAt: "2026-08-26T12:34:56.000-03:00",
};

const CLAVE_COMERCIAL_A: ClaveConsultaPadron = {
  sucursalId: "20000000-0000-4000-8000-000000000001",
  selector: { origen: "CLIENTE_COMERCIAL" },
  cuit: "30714199664",
};
const CLAVE_COMERCIAL_B: ClaveConsultaPadron = {
  ...CLAVE_COMERCIAL_A,
  sucursalId: "20000000-0000-4000-8000-000000000002",
};
const CLAVE_MANUAL: ClaveConsultaPadron = {
  ...CLAVE_COMERCIAL_A,
  selector: { origen: "MANUAL" },
};

describe("CUIT elegible para consulta visual", () => {
  it("usa el cuit_dni comercial sólo cuando su checksum es válido", () => {
    expect(
      cuitParaConsulta({
        receptor: { origen: "CLIENTE_COMERCIAL" },
        cliente: CLIENTE,
        favoritos: [],
      }),
    ).toBe("30714199664");
    expect(
      cuitParaConsulta({
        receptor: { origen: "CLIENTE_COMERCIAL" },
        cliente: { ...CLIENTE, documento: "30621146314" },
        favoritos: [],
      }),
    ).toBeNull();
  });

  it("usa únicamente un CUIT explícito manual o favorito", () => {
    expect(
      cuitParaConsulta({
        receptor: {
          origen: "MANUAL",
          tipo_documento: "CUIT",
          numero_documento: "30-71419966-4",
          razon_social: "Declarado",
          condicion_iva: "EXENTO",
          domicilio: "",
          guardar_para_proximas: false,
        },
        cliente: CLIENTE,
        favoritos: [],
      }),
    ).toBe("30714199664");
    expect(
      cuitParaConsulta({
        receptor: { origen: "FAVORITO", receptor_fiscal_id: FAVORITO.id },
        cliente: CLIENTE,
        favoritos: [FAVORITO],
      }),
    ).toBe("30714199664");
  });

  it.each([
    ["DNI", "30111222"],
    ["CUIL", "20-71419966-9"],
    ["CDI", "30-71419966-4"],
    ["CUIT", "30621146314"],
    ["CUIT", ""],
  ] as const)("no consulta un documento %s no elegible", (tipo_documento, numero_documento) => {
    expect(
      cuitParaConsulta({
        receptor: {
          origen: "MANUAL",
          tipo_documento,
          numero_documento,
          razon_social: "Declarado",
          condicion_iva: "CONSUMIDOR_FINAL",
          domicilio: "",
          guardar_para_proximas: false,
        },
        cliente: CLIENTE,
        favoritos: [],
      }),
    ).toBeNull();
  });

  it("no consulta un favorito CUIL aunque el número también pase módulo 11", () => {
    expect(
      cuitParaConsulta({
        receptor: { origen: "FAVORITO", receptor_fiscal_id: FAVORITO.id },
        cliente: CLIENTE,
        favoritos: [{ ...FAVORITO, tipo_documento: "CUIL" }],
      }),
    ).toBeNull();
  });
});

describe("clave fiscal de la consulta visual", () => {
  it("incluye sucursal, origen, favorito y CUIT canónico", () => {
    expect(
      claveParaConsultaPadron({
        sucursalId: CLAVE_COMERCIAL_A.sucursalId,
        receptor: { origen: "CLIENTE_COMERCIAL" },
        cliente: CLIENTE,
        favoritos: [],
      }),
    ).toEqual(CLAVE_COMERCIAL_A);
    expect(
      claveParaConsultaPadron({
        sucursalId: FAVORITO.sucursal_id,
        receptor: { origen: "FAVORITO", receptor_fiscal_id: FAVORITO.id },
        cliente: CLIENTE,
        favoritos: [FAVORITO],
      }),
    ).toEqual({
      sucursalId: FAVORITO.sucursal_id,
      selector: { origen: "FAVORITO", receptorFiscalId: FAVORITO.id },
      cuit: "30714199664",
    });
    expect(claveConsultaPadronId(CLAVE_COMERCIAL_A)).not.toBe(
      claveConsultaPadronId(CLAVE_COMERCIAL_B),
    );
    expect(claveConsultaPadronId(CLAVE_COMERCIAL_A)).not.toBe(claveConsultaPadronId(CLAVE_MANUAL));
    const otroFavorito = claveParaConsultaPadron({
      sucursalId: FAVORITO.sucursal_id,
      receptor: {
        origen: "FAVORITO",
        receptor_fiscal_id: "10000000-0000-4000-8000-000000000002",
      },
      cliente: CLIENTE,
      favoritos: [
        {
          ...FAVORITO,
          id: "10000000-0000-4000-8000-000000000002",
        },
      ],
    });
    expect(claveConsultaPadronId(otroFavorito)).not.toBe(
      claveConsultaPadronId({
        sucursalId: FAVORITO.sucursal_id,
        selector: { origen: "FAVORITO", receptorFiscalId: FAVORITO.id },
        cuit: "30714199664",
      }),
    );
  });

  it("ignora campos que ARCA no consulta", () => {
    const base = {
      origen: "MANUAL" as const,
      tipo_documento: "CUIT" as const,
      numero_documento: "30-71419966-4",
      razon_social: "Nombre A",
      condicion_iva: "CONSUMIDOR_FINAL" as const,
      domicilio: "Calle A",
      guardar_para_proximas: false,
    };
    const primera = claveParaConsultaPadron({
      sucursalId: CLAVE_COMERCIAL_A.sucursalId,
      receptor: base,
      cliente: CLIENTE,
      favoritos: [],
    });
    const camposNoConsultados = claveParaConsultaPadron({
      sucursalId: CLAVE_COMERCIAL_A.sucursalId,
      receptor: {
        ...base,
        razon_social: "Nombre B",
        condicion_iva: "EXENTO",
        domicilio: "Calle B",
        guardar_para_proximas: true,
      },
      cliente: CLIENTE,
      favoritos: [],
    });

    expect(primera).toEqual(CLAVE_MANUAL);
    expect(claveConsultaPadronId(camposNoConsultados)).toBe(claveConsultaPadronId(primera));
  });
});

describe("fencing monotónico de consultas", () => {
  it("proyecta CONSULTANDO durante render si el estado almacenado pertenece a otro scope", () => {
    const estadosViejos = [
      { estado: "SIN_CUIT" as const },
      { estado: "CONSULTANDO" as const, clave: CLAVE_COMERCIAL_A, token: 8 },
      { estado: "INACTIVO" as const, clave: CLAVE_COMERCIAL_A },
      {
        estado: "VERIFICADO",
        clave: CLAVE_COMERCIAL_A,
        receptor: RECEPTOR_PADRON,
      } as const,
      { estado: "ERROR" as const, clave: CLAVE_COMERCIAL_A, mensaje: "Seguro" },
    ];
    for (const estadoViejo of estadosViejos) {
      expect(estadoConsultaPadronEfectivo(CLAVE_COMERCIAL_B, estadoViejo)).toEqual({
        estado: "CONSULTANDO",
        clave: CLAVE_COMERCIAL_B,
        token: 0,
      });
    }
    expect(
      estadoConsultaPadronEfectivo(null, {
        estado: "VERIFICADO",
        clave: CLAVE_COMERCIAL_A,
        receptor: RECEPTOR_PADRON,
      }),
    ).toEqual({ estado: "SIN_CUIT" });
    const verificadoActual = {
      estado: "VERIFICADO" as const,
      clave: CLAVE_COMERCIAL_B,
      receptor: RECEPTOR_PADRON,
    };
    expect(estadoConsultaPadronEfectivo(CLAVE_COMERCIAL_B, verificadoActual)).toBe(
      verificadoActual,
    );
  });

  it("cambiar el documento invalida en el acto el token en vuelo", () => {
    const control = crearControlConsultaPadron();
    const anterior = iniciarConsultaPadron(control, CLAVE_COMERCIAL_A);

    invalidarConsultaPadron(control);
    const claveActual = { ...CLAVE_COMERCIAL_A, cuit: "30621146315" };
    const actual = iniciarConsultaPadron(control, claveActual);

    expect(esConsultaPadronActual(control, anterior, CLAVE_COMERCIAL_A)).toBe(false);
    expect(esConsultaPadronActual(control, actual, claveActual)).toBe(true);
  });

  it("una respuesta tardía de otra sucursal no puede ganar aunque conserve el CUIT", () => {
    const control = crearControlConsultaPadron();
    const token = iniciarConsultaPadron(control, CLAVE_COMERCIAL_A);

    expect(esConsultaPadronActual(control, token, CLAVE_COMERCIAL_B)).toBe(false);
  });

  it("espera 300 ms y el cleanup impide que una consulta desmontada se ejecute", async () => {
    vi.useFakeTimers();
    const control = crearControlConsultaPadron();
    const consultar = vi.fn(async () => ({ estado: "INACTIVO" as const }));
    const onResultado = vi.fn();
    const onError = vi.fn();
    const primera = programarConsultaPadron(control, CLAVE_COMERCIAL_A, {
      consultar,
      onResultado,
      onError,
    });

    await vi.advanceTimersByTimeAsync(299);
    expect(consultar).not.toHaveBeenCalled();
    primera.cancelar();
    await vi.advanceTimersByTimeAsync(1);
    expect(consultar).not.toHaveBeenCalled();
    expect(onResultado).not.toHaveBeenCalled();

    programarConsultaPadron(control, CLAVE_COMERCIAL_A, { consultar, onResultado, onError });
    await vi.advanceTimersByTimeAsync(300);
    expect(consultar).toHaveBeenCalledOnce();
    expect(onResultado).toHaveBeenCalledWith({ estado: "INACTIVO" }, CLAVE_COMERCIAL_A);
    expect(onError).not.toHaveBeenCalled();
  });

  it("no entrega una respuesta vieja que llega después de programar otro CUIT", async () => {
    vi.useFakeTimers();
    const control = crearControlConsultaPadron();
    let resolverAnterior!: (value: { estado: "INACTIVO" }) => void;
    const anterior = new Promise<{ estado: "INACTIVO" }>((resolve) => {
      resolverAnterior = resolve;
    });
    const onResultado = vi.fn();
    const onError = vi.fn();
    programarConsultaPadron(control, CLAVE_COMERCIAL_A, {
      consultar: async () => anterior,
      onResultado,
      onError,
    });
    await vi.advanceTimersByTimeAsync(300);

    programarConsultaPadron(control, CLAVE_COMERCIAL_B, {
      consultar: async () => ({ estado: "INACTIVO" }),
      onResultado,
      onError,
    });
    resolverAnterior({ estado: "INACTIVO" });
    await Promise.resolve();

    expect(onResultado).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("no entrega un error viejo que llega después de cambiar de sucursal", async () => {
    vi.useFakeTimers();
    const control = crearControlConsultaPadron();
    let rechazarAnterior!: (cause: unknown) => void;
    const anterior = new Promise<never>((_resolve, reject) => {
      rechazarAnterior = reject;
    });
    const onResultado = vi.fn();
    const onError = vi.fn();
    programarConsultaPadron(control, CLAVE_COMERCIAL_A, {
      consultar: async () => anterior,
      onResultado,
      onError,
    });
    await vi.advanceTimersByTimeAsync(300);

    programarConsultaPadron(control, CLAVE_COMERCIAL_B, {
      consultar: async () => ({ estado: "INACTIVO" }),
      onResultado,
      onError,
    });
    rechazarAnterior(new Error("transporte viejo"));
    await Promise.resolve();

    expect(onResultado).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("bloquea sincrónicamente el primer render válido y todo pendiente/error activo", () => {
    expect(bloqueaAccionesPorConsultaPadron(CLAVE_COMERCIAL_A, { estado: "SIN_CUIT" })).toBe(true);
    expect(
      bloqueaAccionesPorConsultaPadron(CLAVE_COMERCIAL_A, {
        estado: "CONSULTANDO",
        clave: CLAVE_COMERCIAL_A,
        token: 1,
      }),
    ).toBe(true);
    expect(
      bloqueaAccionesPorConsultaPadron(CLAVE_COMERCIAL_A, {
        estado: "ERROR",
        clave: CLAVE_COMERCIAL_A,
        mensaje: "Mensaje seguro",
      }),
    ).toBe(true);
    expect(
      bloqueaAccionesPorConsultaPadron(CLAVE_COMERCIAL_A, {
        estado: "VERIFICADO",
        clave: CLAVE_COMERCIAL_B,
        receptor: RECEPTOR_PADRON,
      }),
    ).toBe(true);
    expect(
      bloqueaAccionesPorConsultaPadron(CLAVE_COMERCIAL_A, {
        estado: "VERIFICADO",
        clave: CLAVE_COMERCIAL_A,
        receptor: RECEPTOR_PADRON,
      }),
    ).toBe(false);
    expect(
      bloqueaAccionesPorConsultaPadron(CLAVE_COMERCIAL_A, {
        estado: "INACTIVO",
        clave: CLAVE_COMERCIAL_A,
      }),
    ).toBe(false);
  });

  it.each(["INACTIVO", "VERIFICADO"] as const)(
    "bloquea un estado %s de otra sucursal con el mismo CUIT",
    (estado) => {
      expect(
        bloqueaAccionesPorConsultaPadron(
          CLAVE_COMERCIAL_B,
          estado === "INACTIVO"
            ? { estado, clave: CLAVE_COMERCIAL_A }
            : { estado, clave: CLAVE_COMERCIAL_A, receptor: RECEPTOR_PADRON },
        ),
      ).toBe(true);
    },
  );
});

describe("parser público del resultado", () => {
  it("acepta sólo el receptor canónico estricto", () => {
    expect(
      resultadoConsultaCuitPadronSchema.parse({ estado: "VERIFICADO", receptor: RECEPTOR_PADRON }),
    ).toEqual({ estado: "VERIFICADO", receptor: RECEPTOR_PADRON });
    expect(() =>
      resultadoConsultaCuitPadronSchema.parse({
        estado: "VERIFICADO",
        receptor: { ...RECEPTOR_PADRON, respuestaSoap: "secreto" },
      }),
    ).toThrow();
  });

  it("rechaza checksum y timestamp malformados", () => {
    expect(() =>
      resultadoConsultaCuitPadronSchema.parse({
        estado: "VERIFICADO",
        receptor: { ...RECEPTOR_PADRON, cuit: "30621146314" },
      }),
    ).toThrow();
    expect(() =>
      resultadoConsultaCuitPadronSchema.parse({
        estado: "VERIFICADO",
        receptor: { ...RECEPTOR_PADRON, verificadoArcaAt: "26/08/2026 12:34" },
      }),
    ).toThrow();
    expect(() =>
      resultadoConsultaCuitPadronSchema.parse({ estado: "INACTIVO", credencial: "secreto" }),
    ).toThrow();
  });
});
