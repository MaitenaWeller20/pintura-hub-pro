import { describe, expect, it } from "vitest";
import {
  calcularCambiosCorreccionIngreso,
  puedeAbrirCorreccionIngreso,
  prepararSolicitudCorreccionIngreso,
} from "./correccion-ingreso";

const INGRESO_ID = "e2140000-0000-4000-8000-000000000002";
const IDEMPOTENCY_KEY = "e2140000-0000-4000-8000-000000000003";

describe("corrección auditable de un ingreso confirmado", () => {
  it("sólo permite que un administrador abra la corrección de un ingreso confirmado", () => {
    expect(puedeAbrirCorreccionIngreso({ isAdmin: true, estado: "CONFIRMADO" })).toBe(true);

    expect(puedeAbrirCorreccionIngreso({ isAdmin: false, estado: "CONFIRMADO" })).toBe(false);
    expect(puedeAbrirCorreccionIngreso({ isAdmin: true, estado: "BORRADOR" })).toBe(false);
    expect(puedeAbrirCorreccionIngreso({ isAdmin: true, estado: "ANULADO" })).toBe(false);
  });

  it("calcula cantidad anterior, nueva y delta; permite corregir una línea a cero", () => {
    expect(
      calcularCambiosCorreccionIngreso([
        {
          itemId: "item-techos",
          descripcion: "Techos atérmicos x1 kg",
          cantidadAnterior: 4,
          cantidadNueva: 2,
        },
        {
          itemId: "item-sin-cambio",
          descripcion: "Masilla x4 lts",
          cantidadAnterior: 2,
          cantidadNueva: 2,
        },
        {
          itemId: "item-cargado-por-error",
          descripcion: "Látex x20 lts",
          cantidadAnterior: 3,
          cantidadNueva: 0,
        },
      ]),
    ).toEqual([
      {
        itemId: "item-techos",
        descripcion: "Techos atérmicos x1 kg",
        cantidadAnterior: 4,
        cantidadNueva: 2,
        delta: -2,
      },
      {
        itemId: "item-cargado-por-error",
        descripcion: "Látex x20 lts",
        cantidadAnterior: 3,
        cantidadNueva: 0,
        delta: -3,
      },
    ]);
  });

  it("exige un motivo y envía al RPC únicamente los IDs realmente modificados", () => {
    const items = [
      {
        itemId: "item-techos",
        descripcion: "Techos atérmicos x1 kg",
        cantidadAnterior: 4,
        cantidadNueva: 2,
      },
      {
        itemId: "item-sin-cambio",
        descripcion: "Masilla x4 lts",
        cantidadAnterior: 2,
        cantidadNueva: 2,
      },
      {
        itemId: "item-cargado-por-error",
        descripcion: "Látex x20 lts",
        cantidadAnterior: 3,
        cantidadNueva: 0,
      },
    ];

    expect(() =>
      prepararSolicitudCorreccionIngreso({
        ingresoId: INGRESO_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        motivo: "   ",
        items,
      }),
    ).toThrow(/motivo/i);

    expect(
      prepararSolicitudCorreccionIngreso({
        ingresoId: INGRESO_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        motivo: "  El remito traía dos unidades, no cuatro.  ",
        items,
      }),
    ).toEqual({
      p_ingreso_id: INGRESO_ID,
      p_idempotency_key: IDEMPOTENCY_KEY,
      p_motivo: "El remito traía dos unidades, no cuatro.",
      p_items: [
        { item_id: "item-techos", cantidad_nueva: 2 },
        { item_id: "item-cargado-por-error", cantidad_nueva: 0 },
      ],
    });
  });

  it("acepta hasta dos decimales y rechaza cantidades inválidas o una corrección sin cambios", () => {
    expect(
      calcularCambiosCorreccionIngreso([
        {
          itemId: "item-decimal",
          descripcion: "Producto fraccionable",
          cantidadAnterior: 2,
          cantidadNueva: 1.5,
        },
      ]),
    ).toEqual([
      {
        itemId: "item-decimal",
        descripcion: "Producto fraccionable",
        cantidadAnterior: 2,
        cantidadNueva: 1.5,
        delta: -0.5,
      },
    ]);

    for (const cantidadNueva of [-1, 1.001, Number.NaN]) {
      expect(() =>
        calcularCambiosCorreccionIngreso([
          {
            itemId: "item-invalido",
            descripcion: "Producto",
            cantidadAnterior: 4,
            cantidadNueva,
          },
        ]),
      ).toThrow(/cantidad/i);
    }

    expect(() =>
      prepararSolicitudCorreccionIngreso({
        ingresoId: INGRESO_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        motivo: "Control del remito",
        items: [
          {
            itemId: "item-sin-cambio",
            descripcion: "Producto",
            cantidadAnterior: 2,
            cantidadNueva: 2,
          },
        ],
      }),
    ).toThrow(/cambio/i);
  });
});
