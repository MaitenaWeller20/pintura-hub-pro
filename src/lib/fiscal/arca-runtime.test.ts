import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptString } from "./crypto";

vi.mock("@arcasdk/core", () => ({
  Arca: class {
    electronicBillingService = {
      getLastVoucher: async () => ({ cbteNro: 42 }),
    };

    constructor(context: { ticketPath?: string }) {
      // @arcasdk/core 2.0.0 evalúa __dirname al ser empaquetado como ESM si
      // ticketPath llega vacío, aun cuando recibe un ticketStorage propio.
      if (!context.ticketPath) throw new ReferenceError("__dirname is not defined");
    }
  },
}));

describe("cliente ARCA en el runtime ESM de Vercel", () => {
  const encryptionKeyAnterior = process.env.ARCA_ENCRYPTION_KEY;
  const mockModeAnterior = process.env.INVOICING_MOCK_MODE;

  beforeEach(() => {
    process.env.ARCA_ENCRYPTION_KEY = "clave-de-prueba-para-arca-de-32-caracteres";
    delete process.env.INVOICING_MOCK_MODE;
    vi.resetModules();
  });

  afterEach(() => {
    if (encryptionKeyAnterior === undefined) delete process.env.ARCA_ENCRYPTION_KEY;
    else process.env.ARCA_ENCRYPTION_KEY = encryptionKeyAnterior;

    if (mockModeAnterior === undefined) delete process.env.INVOICING_MOCK_MODE;
    else process.env.INVOICING_MOCK_MODE = mockModeAnterior;
  });

  it("inicializa el SDK sin depender de __dirname", async () => {
    const { ultimoAutorizado } = await import("./arca");

    const ultimo = await ultimoAutorizado(
      {
        cuit: "30-71419966-4",
        arca_key_enc: encryptString("PRIVATE KEY"),
        arca_cert_enc: encryptString("CERTIFICATE"),
      },
      { numero: 5, modo: "PRODUCCION" },
      6,
      {},
    );

    expect(ultimo).toBe(42);
  });
});
