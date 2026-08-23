import { describe, expect, it, vi } from "vitest";
import { cargarDetalleVentaCompleto } from "./detalle-venta";
import { prepararDescargaVenta, requiereDatosFiscalesVenta } from "./preparar-descarga-venta";

describe("lectura completa del detalle comercial", () => {
  it("propaga el error de ítems en vez de convertirlo en una lista vacía", async () => {
    await expect(
      cargarDetalleVentaCompleto({
        cargarItems: async () => ({ data: null, error: { message: "items no disponibles" } }),
        cargarPagos: async () => ({ data: [{ id: "pago-1" }], error: null }),
      }),
    ).rejects.toThrow("No se pudieron cargar los ítems de la venta: items no disponibles");
  });

  it("propaga el error de pagos en vez de habilitar un PDF con detalle incompleto", async () => {
    await expect(
      cargarDetalleVentaCompleto({
        cargarItems: async () => ({ data: [{ id: "item-1" }], error: null }),
        cargarPagos: async () => ({ data: null, error: { message: "pagos no disponibles" } }),
      }),
    ).rejects.toThrow("No se pudieron cargar los pagos de la venta: pagos no disponibles");
  });

  it("entrega el detalle sólo cuando ambas lecturas están completas", async () => {
    await expect(
      cargarDetalleVentaCompleto({
        cargarItems: async () => ({ data: [{ id: "item-1" }], error: null }),
        cargarPagos: async () => ({ data: [{ id: "pago-1" }], error: null }),
      }),
    ).resolves.toEqual({ items: [{ id: "item-1" }], pagos: [{ id: "pago-1" }] });
  });
});

describe("descarga fail-closed del detalle de venta", () => {
  it.each([
    [
      "CAE con NC sin asociación",
      { cae: "74123456789012", tipo_comprobante: "NOTA_CREDITO", afip_cbte_asoc_id: null },
    ],
    [
      "CAE con tipo desconocido",
      { cae: "74123456789012", tipo_comprobante: "DESCONOCIDO", afip_cbte_asoc_id: null },
    ],
    ["APROBADO sin CAE", { cae: null, afip_estado: "APROBADO", tipo_comprobante: "VENTA" }],
    [
      "snapshot sin CAE",
      { cae: null, afip_estado: "ERROR_CORREGIBLE", afip_snapshot: { version: 2 } },
    ],
  ])("%s obliga la lectura fiscal", (_caso, venta) => {
    expect(requiereDatosFiscalesVenta(venta)).toBe(true);
  });

  it("propaga el error fiscal y no genera un PDF interno si la lectura o el QR fallan", async () => {
    const cargarFiscal = vi.fn(async () => {
      throw new Error("QR_FISCAL_OBLIGATORIO");
    });
    const generar = vi.fn();

    await expect(
      prepararDescargaVenta(
        {
          venta: {
            id: "71000000-0000-4000-8000-000000000001",
            cae: "74123456789012",
          },
          items: [],
        },
        { cargarFiscal, generar },
      ),
    ).rejects.toThrow("QR_FISCAL_OBLIGATORIO");
    expect(generar).not.toHaveBeenCalled();
  });

  it("un documento sin autorización fiscal conserva la impresión interna explícita", async () => {
    const cargarFiscal = vi.fn();
    const generar = vi.fn(() => ({ nombre: "venta-interna.pdf" }));
    const venta = { id: "71000000-0000-4000-8000-000000000002", cae: null };

    await expect(
      prepararDescargaVenta({ venta, items: [{ id: "item-1" }] }, { cargarFiscal, generar }),
    ).resolves.toEqual({ nombre: "venta-interna.pdf" });
    expect(cargarFiscal).not.toHaveBeenCalled();
    expect(generar).toHaveBeenCalledWith(venta, [{ id: "item-1" }], null);
  });
});
