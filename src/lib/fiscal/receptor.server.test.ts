import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { validarSnapshotFiscalV2 } from "./snapshot";
import type { ReceptorPadronArca } from "./padron-arca";
import { resolverReceptorFiscal } from "./receptor.server";

const venta = {
  id: "00000000-0000-4000-8000-000000000001",
  sucursalId: "00000000-0000-4000-8000-000000000002",
  cliente: {
    id: "cliente",
    razonSocial: "Consumidor Final",
    cuitDni: null,
    tipo: "CONSUMIDOR_FINAL" as const,
    direccion: null,
  },
  tipoComprobante: "VENTA" as const,
  comprobanteOriginalId: null,
};

const receptorPadron = (
  cambios: Partial<ReceptorPadronArca> = {},
): ReceptorPadronArca => ({
  cuit: "30714199664",
  razonSocial: "IDENTIDAD OFICIAL S.A.",
  domicilioFiscal: "Domicilio ARCA",
  estado: "ACTIVO",
  tipoPersona: "JURIDICA",
  condicionIvaConfirmada: "RESPONSABLE_INSCRIPTO",
  verificadoArcaAt: "2026-08-26T12:00:00.000Z",
  ...cambios,
});

const snapshotOriginal = validarSnapshotFiscalV2(
  JSON.parse(
    readFileSync(
      new URL("../../../test/fixtures/fiscal-snapshot-parity-v2.json", import.meta.url),
      "utf8",
    ),
  ).input,
);

describe("resolución server de receptor fiscal", () => {
  it("sólo permite cliente comercial como CF anónimo seguro", async () => {
    const receptor = await resolverReceptorFiscal({
      selector: { origen: "CLIENTE_COMERCIAL" },
      venta,
      importeTotal: 100,
      letraSolicitada: "B",
      cargarFavorito: vi.fn(),
      cargarOriginal: vi.fn(),
    });
    expect(receptor).toMatchObject({
      tipoDocumento: "SIN_IDENTIFICAR",
      docTipoArca: 99,
      docNroArca: "0",
      origen: "CLIENTE_COMERCIAL",
    });

    await expect(
      resolverReceptorFiscal({
        selector: { origen: "CLIENTE_COMERCIAL" },
        venta: { ...venta, cliente: { ...venta.cliente, cuitDni: "30712345678" } },
        importeTotal: 100,
        letraSolicitada: "B",
        cargarFavorito: vi.fn(),
        cargarOriginal: vi.fn(),
      }),
    ).rejects.toThrow(/manual o favorito/i);
  });

  it("consulta una vez el CUIT válido del cliente comercial y usa la identidad ARCA", async () => {
    const consultarPadron = vi.fn(async () => receptorPadron());

    const receptor = await resolverReceptorFiscal({
      selector: { origen: "CLIENTE_COMERCIAL" },
      venta: {
        ...venta,
        cliente: {
          ...venta.cliente,
          cuitDni: "30-71419966-4",
          razonSocial: "Nombre inventado",
          direccion: "Dirección inventada",
          tipo: "RESPONSABLE_INSCRIPTO",
        },
      },
      importeTotal: 100,
      letraSolicitada: "A",
      cargarFavorito: vi.fn(),
      cargarOriginal: vi.fn(),
      consultarPadron,
    });

    expect(receptor).toMatchObject({
      razonSocial: "IDENTIDAD OFICIAL S.A.",
      domicilio: "Domicilio ARCA",
      tipoDocumento: "CUIT",
      numeroDocumento: "30714199664",
      docTipoArca: 80,
      docNroArca: "30714199664",
      origen: "ARCA",
      origenId: null,
    });
    expect(receptor.razonSocial).not.toBe("Nombre inventado");
    expect(receptor.verificadoArcaAt).toBe("2026-08-26T12:00:00.000Z");
    expect(consultarPadron).toHaveBeenCalledTimes(1);
    expect(consultarPadron).toHaveBeenCalledWith("30714199664");
  });

  it("reemplaza los datos manuales de un CUIT por la identidad oficial ARCA", async () => {
    const receptor = await resolverReceptorFiscal({
      selector: {
        origen: "MANUAL",
        tipo_documento: "CUIT",
        numero_documento: "30-71419966-4",
        razon_social: "Nombre inventado",
        condicion_iva: "RESPONSABLE_INSCRIPTO",
        domicilio: "Dirección inventada",
        guardar_para_proximas: false,
        confirma_datos_manuales: true,
      },
      venta,
      importeTotal: 100,
      letraSolicitada: "A",
      cargarFavorito: vi.fn(),
      cargarOriginal: vi.fn(),
      consultarPadron: async () => receptorPadron(),
    });

    expect(receptor).toMatchObject({
      razonSocial: "IDENTIDAD OFICIAL S.A.",
      domicilio: "Domicilio ARCA",
      tipoDocumento: "CUIT",
      numeroDocumento: "30714199664",
      docTipoArca: 80,
      docNroArca: "30714199664",
      origen: "ARCA",
      origenId: null,
    });
    expect(receptor.razonSocial).not.toBe("Nombre inventado");
    expect(receptor.verificadoArcaAt).toBe("2026-08-26T12:00:00.000Z");
  });

  it("conserva sólo el id de un favorito CUIT como origenId de ARCA", async () => {
    const receptor = await resolverReceptorFiscal({
      selector: { origen: "FAVORITO", receptor_fiscal_id: "favorito" },
      venta,
      importeTotal: 100,
      letraSolicitada: "A",
      cargarFavorito: async () => ({
        id: "favorito",
        sucursalId: venta.sucursalId,
        activo: true,
        tipoDocumento: "CUIT",
        numeroDocumento: "30714199664",
        razonSocial: "Nombre guardado inventado",
        condicionIva: "RESPONSABLE_INSCRIPTO",
        domicilio: "Dirección guardada inventada",
      }),
      cargarOriginal: vi.fn(),
      consultarPadron: async () => receptorPadron(),
    });

    expect(receptor).toMatchObject({
      razonSocial: "IDENTIDAD OFICIAL S.A.",
      domicilio: "Domicilio ARCA",
      origen: "ARCA",
      origenId: "favorito",
    });
    expect(receptor.razonSocial).not.toBe("Nombre guardado inventado");
  });

  it.each([
    [
      "MANUAL",
      {
        origen: "MANUAL" as const,
        tipo_documento: "DNI" as const,
        numero_documento: "12345678",
        razon_social: "Persona",
        condicion_iva: "CONSUMIDOR_FINAL" as const,
        domicilio: null,
        guardar_para_proximas: false,
        confirma_datos_manuales: true as const,
      },
      undefined,
    ],
    ["FAVORITO", { origen: "FAVORITO" as const, receptor_fiscal_id: "favorito-dni" }, "favorito-dni"],
  ] as const)("no consulta ARCA para un receptor %s con DNI", async (_origen, selector, favoritoId) => {
    const consultarPadron = vi.fn(async () => receptorPadron());

    const receptor = await resolverReceptorFiscal({
      selector,
      venta,
      importeTotal: 100,
      letraSolicitada: "B",
      cargarFavorito: async (id) =>
        id === favoritoId
          ? {
              id,
              sucursalId: venta.sucursalId,
              activo: true,
              tipoDocumento: "DNI",
              numeroDocumento: "12345678",
              razonSocial: "Persona",
              condicionIva: "CONSUMIDOR_FINAL",
              domicilio: null,
            }
          : null,
      cargarOriginal: vi.fn(),
      consultarPadron,
    });

    expect(receptor).toMatchObject({ tipoDocumento: "DNI", origen: _origen });
    expect(consultarPadron).not.toHaveBeenCalled();
  });

  it("preserva el receptor CUIT actual cuando no se inyecta consulta de padrón", async () => {
    const receptor = await resolverReceptorFiscal({
      selector: {
        origen: "MANUAL",
        tipo_documento: "CUIT",
        numero_documento: "30-71419966-4",
        razon_social: "Nombre manual conservado",
        condicion_iva: "RESPONSABLE_INSCRIPTO",
        domicilio: "Domicilio manual conservado",
        guardar_para_proximas: false,
        confirma_datos_manuales: true,
      },
      venta,
      importeTotal: 100,
      letraSolicitada: "A",
      cargarFavorito: vi.fn(),
      cargarOriginal: vi.fn(),
    });

    expect(receptor).toMatchObject({
      razonSocial: "Nombre manual conservado",
      domicilio: "Domicilio manual conservado",
      origen: "MANUAL",
      verificadoArcaAt: null,
    });
  });

  it("no infiere un CUIT comercial inválido ni consulta ARCA", async () => {
    const consultarPadron = vi.fn(async () => receptorPadron());

    await expect(
      resolverReceptorFiscal({
        selector: { origen: "CLIENTE_COMERCIAL" },
        venta: {
          ...venta,
          cliente: { ...venta.cliente, cuitDni: "30-71419966-5" },
        },
        importeTotal: 100,
        letraSolicitada: "A",
        cargarFavorito: vi.fn(),
        cargarOriginal: vi.fn(),
        consultarPadron,
      }),
    ).rejects.toThrow(/manual o favorito/i);
    expect(consultarPadron).not.toHaveBeenCalled();
  });

  it("falla cerrado una A sin condición IVA confirmada por ARCA", async () => {
    await expect(
      resolverReceptorFiscal({
        selector: {
          origen: "MANUAL",
          tipo_documento: "CUIT",
          numero_documento: "30-71419966-4",
          razon_social: "Nombre inventado",
          condicion_iva: "RESPONSABLE_INSCRIPTO",
          domicilio: null,
          guardar_para_proximas: false,
          confirma_datos_manuales: true,
        },
        venta,
        importeTotal: 100,
        letraSolicitada: "A",
        cargarFavorito: vi.fn(),
        cargarOriginal: vi.fn(),
        consultarPadron: async () => receptorPadron({ condicionIvaConfirmada: null }),
      }),
    ).rejects.toMatchObject({ codigoFiscalUsuario: "CONDICION_FISCAL_INCOMPATIBLE" });
  });

  it.each(["RESPONSABLE_INSCRIPTO", "MONOTRIBUTO"] as const)(
    "falla cerrado una B confirmada por ARCA como %s",
    async (condicionIvaConfirmada) => {
      await expect(
        resolverReceptorFiscal({
          selector: {
            origen: "MANUAL",
            tipo_documento: "CUIT",
            numero_documento: "30-71419966-4",
            razon_social: "Nombre inventado",
            condicion_iva: "CONSUMIDOR_FINAL",
            domicilio: null,
            guardar_para_proximas: false,
            confirma_datos_manuales: true,
          },
          venta,
          importeTotal: 100,
          letraSolicitada: "B",
          cargarFavorito: vi.fn(),
          cargarOriginal: vi.fn(),
          consultarPadron: async () => receptorPadron({ condicionIvaConfirmada }),
        }),
      ).rejects.toMatchObject({ codigoFiscalUsuario: "CONDICION_FISCAL_INCOMPATIBLE" });
    },
  );

  it("retiene en B sólo la condición declarada válida cuando ARCA no puede confirmarla", async () => {
    const receptor = await resolverReceptorFiscal({
      selector: {
        origen: "MANUAL",
        tipo_documento: "CUIT",
        numero_documento: "30-71419966-4",
        razon_social: "Nombre inventado",
        condicion_iva: "EXENTO",
        domicilio: null,
        guardar_para_proximas: false,
        confirma_datos_manuales: true,
      },
      venta,
      importeTotal: 100,
      letraSolicitada: "B",
      cargarFavorito: vi.fn(),
      cargarOriginal: vi.fn(),
      consultarPadron: async () => receptorPadron({ condicionIvaConfirmada: null }),
    });

    expect(receptor).toMatchObject({ condicionIva: "EXENTO", origen: "ARCA" });
  });

  it.each(["RESPONSABLE_INSCRIPTO", "MONOTRIBUTO"] as const)(
    "falla cerrado una B declarada como %s cuando ARCA no confirma la condición",
    async (condicionIva) => {
      await expect(
        resolverReceptorFiscal({
          selector: {
            origen: "MANUAL",
            tipo_documento: "CUIT",
            numero_documento: "30-71419966-4",
            razon_social: "Nombre inventado",
            condicion_iva: condicionIva,
            domicilio: null,
            guardar_para_proximas: false,
            confirma_datos_manuales: true,
          },
          venta,
          importeTotal: 100,
          letraSolicitada: "B",
          cargarFavorito: vi.fn(),
          cargarOriginal: vi.fn(),
          consultarPadron: async () => receptorPadron({ condicionIvaConfirmada: null }),
        }),
      ).rejects.toMatchObject({ codigoFiscalUsuario: "CONDICION_FISCAL_INCOMPATIBLE" });
    },
  );

  it("devuelve el receptor congelado del comprobante original sin consultar ARCA", async () => {
    const consultarPadron = vi.fn(async () => receptorPadron());
    const receptor = await resolverReceptorFiscal({
      selector: { origen: "COMPROBANTE_ORIGINAL" },
      venta: {
        ...venta,
        tipoComprobante: "NOTA_CREDITO",
        comprobanteOriginalId: "original",
      },
      importeTotal: 100,
      letraSolicitada: "B",
      cargarFavorito: vi.fn(),
      cargarOriginal: async () => ({
        id: "original",
        estado: "APROBADO",
        fase: "PERSISTIDO",
        snapshot: snapshotOriginal,
      }),
      consultarPadron,
    });

    expect(receptor).toEqual(snapshotOriginal.receptor);
    expect(Object.isFrozen(receptor)).toBe(true);
    expect(consultarPadron).not.toHaveBeenCalled();
  });

  it("valida manual y favorito explícitos sin tocar el cliente comercial", async () => {
    const manual = await resolverReceptorFiscal({
      selector: {
        origen: "MANUAL",
        tipo_documento: "DNI",
        numero_documento: "12.345.678",
        razon_social: "Persona",
        condicion_iva: "CONSUMIDOR_FINAL",
        domicilio: "Calle 1",
        guardar_para_proximas: false,
        confirma_datos_manuales: true,
      },
      venta,
      importeTotal: 100,
      letraSolicitada: "B",
      cargarFavorito: vi.fn(),
      cargarOriginal: vi.fn(),
    });
    expect(manual).toMatchObject({ numeroDocumento: "12345678", origen: "MANUAL" });

    const favorito = await resolverReceptorFiscal({
      selector: { origen: "FAVORITO", receptor_fiscal_id: "favorito" },
      venta,
      importeTotal: 100,
      letraSolicitada: "B",
      cargarFavorito: async () => ({
        id: "favorito",
        sucursalId: venta.sucursalId,
        activo: true,
        tipoDocumento: "DNI",
        numeroDocumento: "12345678",
        razonSocial: "Persona",
        condicionIva: "CONSUMIDOR_FINAL",
        domicilio: null,
      }),
      cargarOriginal: vi.fn(),
    });
    expect(favorito).toMatchObject({ origen: "FAVORITO", origenId: "favorito" });
  });

  it("rechaza ND y para NC acepta sólo el snapshot v2 aprobado original", async () => {
    const deps = { cargarFavorito: vi.fn(), cargarOriginal: vi.fn() };
    await expect(
      resolverReceptorFiscal({
        selector: { origen: "COMPROBANTE_ORIGINAL" },
        venta: { ...venta, tipoComprobante: "NOTA_DEBITO" as never },
        importeTotal: 100,
        letraSolicitada: "B",
        ...deps,
      }),
    ).rejects.toThrow(/débito/i);

    await expect(
      resolverReceptorFiscal({
        selector: {
          origen: "MANUAL",
          tipo_documento: "DNI",
          numero_documento: "12345678",
          razon_social: "x",
          condicion_iva: "CONSUMIDOR_FINAL",
          domicilio: null,
          guardar_para_proximas: false,
          confirma_datos_manuales: true,
        },
        venta: { ...venta, tipoComprobante: "NOTA_CREDITO", comprobanteOriginalId: "original" },
        importeTotal: 100,
        letraSolicitada: "B",
        ...deps,
      }),
    ).rejects.toThrow(/COMPROBANTE_ORIGINAL/);
  });
});
