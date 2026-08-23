import { describe, expect, it, vi } from "vitest";

import {
  crearGestorFixturesAbmc,
  crearRepositorioFixturesAbmcLocalHttp,
  type RepositorioFixturesAbmc,
  type TablaFixtureAbmc,
} from "../../e2e/fixtures/abmc";

type Fila = { id: string; razon_social: string };

const CLIENTE_ID = "11111111-1111-4111-8111-111111111111";
const PROVEEDOR_ID = "22222222-2222-4222-8222-222222222222";

function repositorioEnMemoria(input: Partial<Record<TablaFixtureAbmc, Fila[]>>) {
  const filas: Record<TablaFixtureAbmc, Fila[]> = {
    clientes: structuredClone(input.clientes ?? []),
    proveedores: structuredClone(input.proveedores ?? []),
  };
  const borrados: Array<{ tabla: TablaFixtureAbmc; id: string; razonSocial: string }> = [];
  const repo: RepositorioFixturesAbmc = {
    async buscarPorRazonSocialExacta(tabla, razonSocial) {
      return structuredClone(filas[tabla].filter((fila) => fila.razon_social === razonSocial));
    },
    async leerPorId(tabla, id) {
      return structuredClone(filas[tabla].find((fila) => fila.id === id) ?? null);
    },
    async borrarIdentidadExacta(tabla, id, razonSocial) {
      borrados.push({ tabla, id, razonSocial });
      filas[tabla] = filas[tabla].filter(
        (fila) => fila.id !== id || fila.razon_social !== razonSocial,
      );
    },
    async contarPorId(tabla, id) {
      return filas[tabla].filter((fila) => fila.id === id).length;
    },
  };
  return { repo, filas, borrados };
}

describe("cleanup owned-only de los ABMC E2E", () => {
  it("borra por ID y razón social sólo el fixture registrado y preserva los seeds", async () => {
    const nombre = "ZZ-E2E-CLIENTE-1";
    const { repo, filas, borrados } = repositorioEnMemoria({
      clientes: [
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", razon_social: "CONSUMIDOR FINAL" },
        { id: CLIENTE_ID, razon_social: nombre },
      ],
    });
    const gestor = crearGestorFixturesAbmc(repo);
    const fixture = gestor.reservar("clientes", nombre);

    await expect(fixture.registrar()).resolves.toBe(CLIENTE_ID);
    await expect(gestor.limpiar()).resolves.toBeUndefined();

    expect(filas.clientes).toEqual([
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", razon_social: "CONSUMIDOR FINAL" },
    ]);
    expect(borrados).toEqual([{ tabla: "clientes", id: CLIENTE_ID, razonSocial: nombre }]);
  });

  it("audita la identidad registrada y no borra si el UUID ahora pertenece a otra ficha", async () => {
    const nombre = "ZZ-E2E-PROVEEDOR-1";
    const { repo, filas, borrados } = repositorioEnMemoria({
      proveedores: [{ id: PROVEEDOR_ID, razon_social: nombre }],
    });
    const gestor = crearGestorFixturesAbmc(repo);
    const fixture = gestor.reservar("proveedores", nombre);
    await fixture.registrar();
    filas.proveedores[0].razon_social = "PROVEEDOR REAL";

    await expect(gestor.limpiar()).rejects.toThrow(/identidad.*cambi/i);

    expect(filas.proveedores).toEqual([{ id: PROVEEDOR_ID, razon_social: "PROVEEDOR REAL" }]);
    expect(borrados).toEqual([]);
  });

  it("conserva el registro tras un fallo transitorio y el cleanup se puede reintentar", async () => {
    const nombre = "ZZ-E2E-CLIENTE-RETRY";
    const { repo, filas, borrados } = repositorioEnMemoria({
      clientes: [{ id: CLIENTE_ID, razon_social: nombre }],
    });
    const borrarReal = repo.borrarIdentidadExacta;
    let intentos = 0;
    repo.borrarIdentidadExacta = async (...args) => {
      intentos += 1;
      if (intentos === 1) throw new Error("fallo transitorio local");
      await borrarReal(...args);
    };
    const gestor = crearGestorFixturesAbmc(repo);
    await gestor.reservar("clientes", nombre).registrar();

    await expect(gestor.limpiar()).rejects.toThrow(/fallo transitorio local/i);
    await expect(gestor.limpiar()).resolves.toBeUndefined();
    await expect(gestor.limpiar()).resolves.toBeUndefined();

    expect(filas.clientes).toEqual([]);
    expect(intentos).toBe(2);
    expect(borrados).toEqual([{ tabla: "clientes", id: CLIENTE_ID, razonSocial: nombre }]);
  });

  it("detecta un DELETE silencioso que no dejó cero residuos", async () => {
    const nombre = "ZZ-E2E-CLIENTE-RESIDUO";
    const { repo, filas } = repositorioEnMemoria({
      clientes: [{ id: CLIENTE_ID, razon_social: nombre }],
    });
    repo.borrarIdentidadExacta = async () => {};
    const gestor = crearGestorFixturesAbmc(repo);
    await gestor.reservar("clientes", nombre).registrar();

    await expect(gestor.limpiar()).rejects.toThrow(/residuo/i);
    expect(filas.clientes).toHaveLength(1);
  });

  it("se niega a reservar nombres que no sean marcas propias del E2E", () => {
    const { repo } = repositorioEnMemoria({});
    const gestor = crearGestorFixturesAbmc(repo);

    expect(() => gestor.reservar("clientes", "CONSUMIDOR FINAL")).toThrow(/ZZ-E2E/i);
  });
});

describe("adaptador HTTP local del cleanup ABMC", () => {
  it("captura, audita, borra y verifica sólo mediante filtros exactos", async () => {
    const nombre = "ZZ-E2E-HTTP-1";
    let fila: Fila | null = { id: CLIENTE_ID, razon_social: nombre };
    const solicitudes: Array<{ method: string; url: URL }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(typeof request === "string" ? request : request.toString());
      const method = init?.method ?? "GET";
      solicitudes.push({ method, url });

      if (method === "DELETE") {
        if (
          url.searchParams.get("id") === `eq.${CLIENTE_ID}` &&
          url.searchParams.get("razon_social") === `eq.${nombre}`
        ) {
          fila = null;
        }
        return new Response(null, { status: 204 });
      }

      const coincideId =
        !url.searchParams.has("id") || url.searchParams.get("id") === `eq.${fila?.id}`;
      const coincideNombre =
        !url.searchParams.has("razon_social") ||
        url.searchParams.get("razon_social") === `eq.${fila?.razon_social}`;
      return new Response(JSON.stringify(fila && coincideId && coincideNombre ? [fila] : []), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const repo = crearRepositorioFixturesAbmcLocalHttp(
      {
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-local",
      },
      fetchImpl,
    );
    const gestor = crearGestorFixturesAbmc(repo);

    await gestor.reservar("clientes", nombre).registrar();
    await gestor.limpiar();

    expect(solicitudes.map(({ method }) => method)).toEqual(["GET", "GET", "DELETE", "GET"]);
    expect(solicitudes[0].url.searchParams.get("razon_social")).toBe(`eq.${nombre}`);
    expect(solicitudes[1].url.searchParams.get("id")).toBe(`eq.${CLIENTE_ID}`);
    expect(solicitudes[2].url.searchParams.get("id")).toBe(`eq.${CLIENTE_ID}`);
    expect(solicitudes[2].url.searchParams.get("razon_social")).toBe(`eq.${nombre}`);
    expect(solicitudes[3].url.searchParams.get("id")).toBe(`eq.${CLIENTE_ID}`);
    expect(solicitudes.every(({ url }) => !/[~*]|\b(?:like|ilike)\b/i.test(url.search))).toBe(true);
  });

  it("rechaza una URL remota antes de crear un cliente service-role", () => {
    expect(() =>
      crearRepositorioFixturesAbmcLocalHttp({
        SUPABASE_URL: "https://proyecto.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "no-debe-usarse",
      }),
    ).toThrow(/sólo.*local/i);
  });
});
