import { describe, expect, it, vi } from "vitest";
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

describe("resolución server de receptor fiscal", () => {
  it("sólo permite cliente comercial como CF anónimo seguro", async () => {
    const receptor = await resolverReceptorFiscal({
      selector: { origen: "CLIENTE_COMERCIAL" },
      venta,
      importeTotal: 100,
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
        cargarFavorito: vi.fn(),
        cargarOriginal: vi.fn(),
      }),
    ).rejects.toThrow(/manual o favorito/i);
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
      cargarFavorito: vi.fn(),
      cargarOriginal: vi.fn(),
    });
    expect(manual).toMatchObject({ numeroDocumento: "12345678", origen: "MANUAL" });

    const favorito = await resolverReceptorFiscal({
      selector: { origen: "FAVORITO", receptor_fiscal_id: "favorito" },
      venta,
      importeTotal: 100,
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
        ...deps,
      }),
    ).rejects.toThrow(/COMPROBANTE_ORIGINAL/);
  });
});
