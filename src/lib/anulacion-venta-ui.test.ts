import { describe, expect, it, vi } from "vitest";
import { crearIntentoAnulacion, solicitudAnulacion } from "./anulacion-venta-ui";

describe("reintento de anulación", () => {
  it("genera una clave al abrir y reutiliza exactamente la misma solicitud", () => {
    const clave = "76000000-0000-4000-8000-000000000001";
    const generar = vi.fn(() => clave);
    const intento = crearIntentoAnulacion({ id: "76000000-0000-4000-8000-000000000002" }, generar);

    expect(generar).toHaveBeenCalledOnce();
    expect(solicitudAnulacion(intento)).toEqual({
      venta_id: "76000000-0000-4000-8000-000000000002",
      idempotency_key: clave,
    });
    expect(solicitudAnulacion(intento)).toEqual(solicitudAnulacion(intento));
    expect(generar).toHaveBeenCalledOnce();
  });
});
