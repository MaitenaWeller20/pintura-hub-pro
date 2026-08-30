import { describe, expect, it, vi } from "vitest";
import {
  ejecutarOperacionComercialSegura,
  mensajeErrorOperacion,
} from "./operacion-comercial-segura";

function valoresRecursivos(value: unknown, vistos = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null || vistos.has(value)) return [];
  vistos.add(value);
  return Reflect.ownKeys(value).flatMap((key) => {
    const nombre = typeof key === "string" ? key : (key.description ?? "");
    let contenido: unknown;
    try {
      contenido = Reflect.get(value, key);
    } catch {
      contenido = "";
    }
    return [nombre, ...valoresRecursivos(contenido, vistos)];
  });
}

describe("frontera cerrada de operaciones comerciales", () => {
  it("devuelve un éxito cerrado sin alterar el valor", async () => {
    await expect(
      ejecutarOperacionComercialSegura("CREAR_PRESUPUESTO", async () => ({ numero: "P-1" })),
    ).resolves.toEqual({ ok: true, valor: { numero: "P-1" } });
  });

  it.each([
    ["caja", new Error("No hay una única caja abierta"), "CAJA_NO_DISPONIBLE"],
    ["cliente", new Error("Cliente inexistente o inactivo"), "CLIENTE_INVALIDO"],
    ["estado", new Error("Este presupuesto ya está convertido"), "PRESUPUESTO_NO_EDITABLE"],
    [
      "estado de edición",
      new Error("Este presupuesto ya se convirtió en la venta P-1"),
      "PRESUPUESTO_NO_EDITABLE",
    ],
    ["acceso", new Error("Presupuesto inexistente o sin acceso"), "PRESUPUESTO_SIN_ACCESO"],
    ["idempotencia", new Error("ya fue convertido con otros datos"), "CONFLICTO_REINTENTO"],
    [
      "Consumidor Final",
      new Error("No hay un único Consumidor Final global activo"),
      "CONSUMIDOR_FINAL_INVALIDO",
    ],
    ["validación", new Error("La descripción puede tener hasta 160 caracteres"), "DATOS_INVALIDOS"],
    [
      "producto repetido",
      new Error("Hay un producto repetido: juntá las cantidades en una sola línea"),
      "DATOS_INVALIDOS",
    ],
  ] as const)("mapea %s a un código seguro", async (_caso, cause, codigo) => {
    const resultado = await ejecutarOperacionComercialSegura(
      "CONVERTIR_PRESUPUESTO",
      async () => {
        throw cause;
      },
      vi.fn(),
    );
    expect(resultado).toMatchObject({ ok: false, error: { codigo } });
    if (resultado.ok) throw new Error("fixture incorrecto");
    expect(resultado.error.mensaje).toBe(mensajeErrorOperacion(resultado.error.codigo));
  });

  it("registra la causa en servidor pero no serializa constraint, tabla, función ni cause", async () => {
    const registrar = vi.fn();
    const causa = {
      message: 'duplicate key value violates constraint "ventas_idempotency_key_key"',
      code: "23505",
      details: "Key (conversion_payload_hash) already exists in presupuestos",
      hint: "function convertir_presupuesto_en_venta_neutral",
      cause: new Error("password=supersecreto"),
    };
    const resultado = await ejecutarOperacionComercialSegura(
      "CONVERTIR_PRESUPUESTO",
      async () => {
        throw causa;
      },
      registrar,
    );

    expect(registrar).toHaveBeenCalledWith("CONVERTIR_PRESUPUESTO", causa);
    expect(resultado).toMatchObject({ ok: false, error: { codigo: "ERROR_INTERNO" } });
    const serializadoProfundo = valoresRecursivos(resultado).join(" ").toLowerCase();
    for (const token of [
      "constraint",
      "ventas_idempotency_key_key",
      "presupuestos",
      "convertir_presupuesto_en_venta_neutral",
      "cause",
      "supersecreto",
      "23505",
    ]) {
      expect(serializadoProfundo).not.toContain(token);
    }
  });
});
