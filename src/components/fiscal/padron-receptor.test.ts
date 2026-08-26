import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReceptorFiscalFavorito } from "@/lib/fiscal/cola.functions";
import {
  bloqueaAccionesPorConsultaPadron,
  crearControlConsultaPadron,
  cuitParaConsulta,
  esConsultaPadronActual,
  iniciarConsultaPadron,
  invalidarConsultaPadron,
  programarConsultaPadron,
  resultadoConsultaCuitPadronSchema,
} from "./padron-receptor";

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

describe("fencing monotónico de consultas", () => {
  it("cambiar el documento invalida en el acto el token en vuelo", () => {
    const control = crearControlConsultaPadron();
    const anterior = iniciarConsultaPadron(control, "30714199664");

    invalidarConsultaPadron(control);
    const actual = iniciarConsultaPadron(control, "30621146315");

    expect(esConsultaPadronActual(control, anterior, "30714199664")).toBe(false);
    expect(esConsultaPadronActual(control, actual, "30621146315")).toBe(true);
  });

  it("una respuesta tardía del CUIT anterior no puede ganar aunque reutilice el token", () => {
    const control = crearControlConsultaPadron();
    const token = iniciarConsultaPadron(control, "30714199664");

    expect(esConsultaPadronActual(control, token, "30621146315")).toBe(false);
  });

  it("espera 300 ms y el cleanup impide que una consulta desmontada se ejecute", async () => {
    vi.useFakeTimers();
    const control = crearControlConsultaPadron();
    const consultar = vi.fn(async () => ({ estado: "INACTIVO" as const }));
    const onResultado = vi.fn();
    const onError = vi.fn();
    const primera = programarConsultaPadron(control, "30714199664", {
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

    programarConsultaPadron(control, "30714199664", { consultar, onResultado, onError });
    await vi.advanceTimersByTimeAsync(300);
    expect(consultar).toHaveBeenCalledOnce();
    expect(onResultado).toHaveBeenCalledWith({ estado: "INACTIVO" }, "30714199664");
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
    programarConsultaPadron(control, "30714199664", {
      consultar: async () => anterior,
      onResultado,
      onError,
    });
    await vi.advanceTimersByTimeAsync(300);

    programarConsultaPadron(control, "30621146315", {
      consultar: async () => ({ estado: "INACTIVO" }),
      onResultado,
      onError,
    });
    resolverAnterior({ estado: "INACTIVO" });
    await Promise.resolve();

    expect(onResultado).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("bloquea sincrónicamente el primer render válido y todo pendiente/error activo", () => {
    expect(bloqueaAccionesPorConsultaPadron("30714199664", { estado: "SIN_CUIT" })).toBe(true);
    expect(
      bloqueaAccionesPorConsultaPadron("30714199664", {
        estado: "CONSULTANDO",
        cuit: "30714199664",
        token: 1,
      }),
    ).toBe(true);
    expect(
      bloqueaAccionesPorConsultaPadron("30714199664", {
        estado: "ERROR",
        cuit: "30714199664",
        mensaje: "Mensaje seguro",
      }),
    ).toBe(true);
    expect(
      bloqueaAccionesPorConsultaPadron("30714199664", {
        estado: "VERIFICADO",
        cuit: "30621146315",
        receptor: RECEPTOR_PADRON,
      }),
    ).toBe(true);
    expect(
      bloqueaAccionesPorConsultaPadron("30714199664", {
        estado: "VERIFICADO",
        cuit: "30714199664",
        receptor: RECEPTOR_PADRON,
      }),
    ).toBe(false);
    expect(
      bloqueaAccionesPorConsultaPadron("30714199664", {
        estado: "INACTIVO",
        cuit: "30714199664",
      }),
    ).toBe(false);
  });
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
