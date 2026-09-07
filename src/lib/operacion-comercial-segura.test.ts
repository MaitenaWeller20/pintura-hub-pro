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
  it("conserva código y cantidades del rechazo real de stock sin exponer el marcador interno", async () => {
    const resultado = await ejecutarOperacionComercialSegura(
      "CONVERTIR_PRESUPUESTO",
      async () => {
        throw new Error(
          "Stock insuficiente de __presupuesto_item__:ee83cdd3e3a64dfb82afc83db9176e5b (113.01.123): hay 0.00, se piden 2.00",
        );
      },
      vi.fn(),
    );
    expect(resultado).toEqual({
      ok: false,
      error: {
        codigo: "STOCK_INSUFICIENTE",
        mensaje: expect.stringContaining("stock"),
        stock: { codigoProducto: "113.01.123", disponible: 0, solicitado: 2 },
      },
    });
    expect(JSON.stringify(resultado)).not.toContain("__presupuesto_item__");
    expect(JSON.stringify(resultado)).not.toContain("ee83cdd3");
  });

  it("reconoce stock antes que palabras de otras validaciones en la descripción", async () => {
    const resultado = await ejecutarOperacionComercialSegura(
      "CONVERTIR_PRESUPUESTO",
      async () => {
        throw {
          message: "Stock insuficiente de Pintura consumidor final (P-1): hay -1.50, se piden 2.25",
        };
      },
      vi.fn(),
    );
    expect(resultado).toMatchObject({
      ok: false,
      error: {
        codigo: "STOCK_INSUFICIENTE",
        stock: { codigoProducto: "P-1", disponible: -1.5, solicitado: 2.25 },
      },
    });
  });

  it("usa un mensaje de stock seguro si el detalle no tiene el formato esperado", async () => {
    const resultado = await ejecutarOperacionComercialSegura(
      "CONVERTIR_PRESUPUESTO",
      async () => {
        throw new Error("Stock insuficiente de producto: detalle interno inesperado");
      },
      vi.fn(),
    );
    expect(resultado).toEqual({
      ok: false,
      error: { codigo: "STOCK_INSUFICIENTE", mensaje: expect.stringContaining("stock") },
    });
    expect(JSON.stringify(resultado)).not.toContain("detalle interno");
  });

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
