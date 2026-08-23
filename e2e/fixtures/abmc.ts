export type TablaFixtureAbmc = "clientes" | "proveedores";

export type IdentidadFixtureAbmc = {
  id: string;
  razon_social: string;
};

export type RepositorioFixturesAbmc = {
  buscarPorRazonSocialExacta(
    tabla: TablaFixtureAbmc,
    razonSocial: string,
  ): Promise<IdentidadFixtureAbmc[]>;
  leerPorId(tabla: TablaFixtureAbmc, id: string): Promise<IdentidadFixtureAbmc | null>;
  borrarIdentidadExacta(tabla: TablaFixtureAbmc, id: string, razonSocial: string): Promise<void>;
  contarPorId(tabla: TablaFixtureAbmc, id: string): Promise<number>;
};

type RegistroFixtureAbmc = {
  tabla: TablaFixtureAbmc;
  razonSocial: string;
  id: string | null;
};

export type ReservaFixtureAbmc = {
  registrar(): Promise<string>;
};

export type GestorFixturesAbmc = {
  reservar(tabla: TablaFixtureAbmc, razonSocial: string): ReservaFixtureAbmc;
  limpiar(): Promise<void>;
};

type EntornoSupabaseAbmc = {
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

const MARCA_PROPIA = /^ZZ-E2E-[A-Z0-9-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function claveDe(registro: Pick<RegistroFixtureAbmc, "tabla" | "razonSocial">): string {
  return `${registro.tabla}:${registro.razonSocial}`;
}

function exigirMarcaPropia(razonSocial: string): void {
  if (!MARCA_PROPIA.test(razonSocial)) {
    throw new Error(`El cleanup ABMC sólo admite marcas propias ZZ-E2E-*, no ${razonSocial}.`);
  }
}

function exigirUuidPropio(id: string): void {
  if (!UUID.test(id))
    throw new Error(`Supabase devolvió un ID inválido para el fixture ABMC: ${id}.`);
}

function detalleError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function crearGestorFixturesAbmc(repo: RepositorioFixturesAbmc): GestorFixturesAbmc {
  const registros = new Map<string, RegistroFixtureAbmc>();

  async function capturar(registro: RegistroFixtureAbmc, permitirAusente: boolean) {
    if (registro.id) return registro.id;
    const encontrados = await repo.buscarPorRazonSocialExacta(registro.tabla, registro.razonSocial);
    if (encontrados.length === 0 && permitirAusente) return null;
    if (encontrados.length !== 1) {
      throw new Error(
        `Se esperó exactamente una ficha ${registro.tabla} ${registro.razonSocial} y se encontraron ${encontrados.length}.`,
      );
    }
    const [identidad] = encontrados;
    exigirUuidPropio(identidad.id);
    if (identidad.razon_social !== registro.razonSocial) {
      throw new Error(`La captura de ${registro.razonSocial} devolvió una identidad distinta.`);
    }
    registro.id = identidad.id;
    return registro.id;
  }

  async function limpiarRegistro(registro: RegistroFixtureAbmc): Promise<void> {
    const id = await capturar(registro, true);
    if (!id) {
      registros.delete(claveDe(registro));
      return;
    }

    // El nombre localiza el alta, pero jamás autoriza por sí solo un DELETE.
    // Antes de borrar se vuelve a auditar el UUID exacto que quedó registrado.
    const identidadActual = await repo.leerPorId(registro.tabla, id);
    if (identidadActual && identidadActual.razon_social !== registro.razonSocial) {
      throw new Error(
        `La identidad del fixture ${registro.tabla} ${id} cambió: se preservó sin borrar.`,
      );
    }
    if (identidadActual) {
      await repo.borrarIdentidadExacta(registro.tabla, id, registro.razonSocial);
    }

    const residuos = await repo.contarPorId(registro.tabla, id);
    if (residuos !== 0) {
      throw new Error(`El cleanup ABMC dejó ${residuos} residuo(s) para ${registro.tabla} ${id}.`);
    }
    registros.delete(claveDe(registro));
  }

  return {
    reservar(tabla, razonSocial) {
      exigirMarcaPropia(razonSocial);
      const clave = claveDe({ tabla, razonSocial });
      const registro = registros.get(clave) ?? { tabla, razonSocial, id: null };
      registros.set(clave, registro);
      return {
        async registrar() {
          const id = await capturar(registro, false);
          if (!id) throw new Error(`No se pudo registrar el UUID de ${razonSocial}.`);
          return id;
        },
      };
    },
    async limpiar() {
      const errores: unknown[] = [];
      for (const registro of [...registros.values()]) {
        try {
          await limpiarRegistro(registro);
        } catch (error) {
          errores.push(error);
        }
      }
      if (errores.length > 0) {
        throw new AggregateError(
          errores,
          `Falló el cleanup ABMC; puede reintentarse: ${errores.map(detalleError).join(" | ")}`,
        );
      }
    },
  };
}

function urlSupabaseLocal(entorno: EntornoSupabaseAbmc): string {
  const value = entorno.SUPABASE_URL ?? entorno.VITE_SUPABASE_URL;
  if (!value) throw new Error("Falta SUPABASE_URL local para el cleanup ABMC E2E.");
  const url = new URL(value);
  if (!/^(127\.0\.0\.1|localhost)$/.test(url.hostname)) {
    throw new Error("El cleanup ABMC E2E sólo puede usar un Supabase local.");
  }
  return url.toString().replace(/\/$/, "");
}

function parametros(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function exigirIdentidades(value: unknown): IdentidadFixtureAbmc[] {
  if (!Array.isArray(value)) throw new Error("Supabase devolvió una respuesta ABMC inválida.");
  return value.map((fila) => {
    if (
      typeof fila !== "object" ||
      fila === null ||
      typeof (fila as IdentidadFixtureAbmc).id !== "string" ||
      typeof (fila as IdentidadFixtureAbmc).razon_social !== "string"
    ) {
      throw new Error("Supabase devolvió una identidad ABMC inválida.");
    }
    return fila as IdentidadFixtureAbmc;
  });
}

/** Adaptador service-role cercado a localhost; no se importa desde la aplicación. */
export function crearRepositorioFixturesAbmcLocalHttp(
  entorno: EntornoSupabaseAbmc,
  fetchImpl: typeof fetch = fetch,
): RepositorioFixturesAbmc {
  const baseUrl = urlSupabaseLocal(entorno);
  const serviceRoleValue = entorno.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleValue) {
    throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY local para el cleanup ABMC.");
  }
  const serviceRole: string = serviceRoleValue;

  async function request(method: "GET" | "DELETE", path: string): Promise<unknown> {
    const respuesta = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        apikey: serviceRole,
        Authorization: `Bearer ${serviceRole}`,
        Accept: "application/json",
      },
    });
    const texto = await respuesta.text();
    if (!respuesta.ok) {
      throw new Error(`${method} ${path} -> ${respuesta.status}: ${texto.slice(0, 300)}`);
    }
    return texto ? JSON.parse(texto) : undefined;
  }

  function ruta(tabla: TablaFixtureAbmc, filtros: Record<string, string>): string {
    return `/rest/v1/${tabla}?${parametros(filtros)}`;
  }

  async function listar(tabla: TablaFixtureAbmc, filtros: Record<string, string>) {
    return exigirIdentidades(
      await request("GET", ruta(tabla, { select: "id,razon_social", ...filtros })),
    );
  }

  return {
    buscarPorRazonSocialExacta(tabla, razonSocial) {
      return listar(tabla, { razon_social: `eq.${razonSocial}` });
    },
    async leerPorId(tabla, id) {
      exigirUuidPropio(id);
      const encontrados = await listar(tabla, { id: `eq.${id}` });
      if (encontrados.length > 1) throw new Error(`El UUID ${id} devolvió más de una ficha ABMC.`);
      return encontrados[0] ?? null;
    },
    async borrarIdentidadExacta(tabla, id, razonSocial) {
      exigirUuidPropio(id);
      exigirMarcaPropia(razonSocial);
      await request("DELETE", ruta(tabla, { id: `eq.${id}`, razon_social: `eq.${razonSocial}` }));
    },
    async contarPorId(tabla, id) {
      exigirUuidPropio(id);
      return (await listar(tabla, { id: `eq.${id}` })).length;
    },
  };
}
