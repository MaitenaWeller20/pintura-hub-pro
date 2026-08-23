import { describe, expect, it, vi } from "vitest";
import { prepararDescargaVenta } from "./preparar-descarga-venta";

describe("descarga fail-closed del detalle de venta", () => {
  it("propaga el error fiscal y no genera un PDF interno si la lectura o el QR fallan", async () => {
    const cargarFiscal = vi.fn(async () => {
      throw new Error("QR_FISCAL_OBLIGATORIO");
    });
    const generar = vi.fn();

    await expect(
      prepararDescargaVenta(
        {
          venta: { id: "71000000-0000-4000-8000-000000000001" },
          items: [],
          requiereDatosFiscales: true,
        },
        { cargarFiscal, generar },
      ),
    ).rejects.toThrow("QR_FISCAL_OBLIGATORIO");
    expect(generar).not.toHaveBeenCalled();
  });

  it("un documento sin autorización fiscal conserva la impresión interna explícita", async () => {
    const cargarFiscal = vi.fn();
    const generar = vi.fn(() => ({ nombre: "venta-interna.pdf" }));
    const venta = { id: "71000000-0000-4000-8000-000000000002" };

    await expect(
      prepararDescargaVenta(
        { venta, items: [{ id: "item-1" }], requiereDatosFiscales: false },
        { cargarFiscal, generar },
      ),
    ).resolves.toEqual({ nombre: "venta-interna.pdf" });
    expect(cargarFiscal).not.toHaveBeenCalled();
    expect(generar).toHaveBeenCalledWith(venta, [{ id: "item-1" }], null);
  });
});
