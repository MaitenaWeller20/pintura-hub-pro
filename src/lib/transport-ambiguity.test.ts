import { describe, expect, it } from "vitest";
import { esFalloTransporteAmbiguo } from "./transport-ambiguity";

function errorCon(cambios: Record<string, unknown>): Error {
  const error = new Error(typeof cambios.message === "string" ? cambios.message : "envoltura");
  Object.assign(error, cambios);
  return error;
}

describe("clasificador acotado de transporte ambiguo", () => {
  it.each([
    ["Chrome", new TypeError("Failed to fetch")],
    ["Safari", new TypeError("Load failed")],
    ["undici", new TypeError("fetch failed")],
    ["abort", errorCon({ name: "AbortError", message: "The operation was aborted." })],
    ["timeout", errorCon({ name: "TimeoutError", message: "The operation timed out." })],
    ["código anidado", errorCon({ cause: { cause: { code: "ECONNRESET" } } })],
    ["proxy 502", { status: 502 }],
    ["proxy 503 anidado", { cause: { statusCode: 503 } }],
    ["proxy 504", { response: { status: 504 } }],
  ])("clasifica %s", (_caso, cause) => {
    expect(esFalloTransporteAmbiguo(cause)).toBe(true);
  });

  it.each([
    new Error("timeout de caja determinístico"),
    new Error("connection already exists for caja_sesiones"),
    new Error('duplicate key value violates constraint "presupuestos_pkey"'),
    { status: 409, message: "Conflict" },
    { code: "23505", message: "unique_violation" },
  ])("no confunde errores determinísticos de negocio/DB", (cause) => {
    expect(esFalloTransporteAmbiguo(cause)).toBe(false);
  });

  it("acota causas cíclicas y profundidad hostil", () => {
    const cause: Record<string, unknown> = {};
    cause.cause = cause;
    expect(esFalloTransporteAmbiguo(cause)).toBe(false);

    let profunda: Record<string, unknown> = { code: "ECONNRESET" };
    for (let indice = 0; indice < 20; indice += 1) profunda = { cause: profunda };
    expect(esFalloTransporteAmbiguo(profunda)).toBe(false);
  });
});
