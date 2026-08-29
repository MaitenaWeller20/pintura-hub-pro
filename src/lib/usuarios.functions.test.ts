import { describe, expect, it } from "vitest";
import * as usuariosFunctions from "./usuarios.functions";
import {
  ejecutarSetPuedeGestionarCreditoClientes,
  ejecutarSetPuedeFacturar,
  ejecutarToggleUsuarioActivo,
  type OperacionesToggleUsuario,
} from "./usuarios.functions";

const ADMIN = "a0000000-0000-4000-8000-000000000001";
const EMPLEADO = "e0000000-0000-4000-8000-000000000002";
const OP_BAJA = "10000000-0000-4000-8000-000000000001";
const OP_ALTA = "10000000-0000-4000-8000-000000000002";
const OP_RECONCILIAR = "10000000-0000-4000-8000-000000000003";
const OP_FAIL_SAFE = "10000000-0000-4000-8000-000000000004";
const OP_BAJA_POSTERIOR = "10000000-0000-4000-8000-000000000005";

type EjecutarAdministrarNcPeriodo = (
  input: { actorId: string; user_id: string; value: boolean },
  supabase: {
    rpc(
      nombre: string,
      args: Record<string, unknown>,
    ): Promise<{ data: unknown; error: { message?: string } | null }>;
  },
) => Promise<{ ok: true }>;

function administrarNcPeriodo(): EjecutarAdministrarNcPeriodo {
  const modulo = usuariosFunctions as unknown as {
    administrarPuedeEmitirNcPeriodo?: unknown;
    ejecutarAdministrarPuedeEmitirNcPeriodo?: EjecutarAdministrarNcPeriodo;
  };
  expect(modulo.administrarPuedeEmitirNcPeriodo).toBeDefined();
  expect(modulo.ejecutarAdministrarPuedeEmitirNcPeriodo).toBeDefined();
  return modulo.ejecutarAdministrarPuedeEmitirNcPeriodo!;
}

describe("administrarPuedeEmitirNcPeriodo", () => {
  it("rechaza a un empleado antes de intentar la mutación de capacidad", async () => {
    const llamadas: string[] = [];

    await expect(
      administrarNcPeriodo()(
        { actorId: EMPLEADO, user_id: EMPLEADO, value: true },
        {
          async rpc(nombre) {
            llamadas.push(nombre);
            return nombre === "is_admin"
              ? { data: false, error: null }
              : { data: null, error: null };
          },
        },
      ),
    ).rejects.toThrow(/solo admin/i);
    expect(llamadas).toEqual(["is_admin"]);
  });

  it("revalida al admin y usa sólo la RPC segura con su firma exacta", async () => {
    const llamadas: Array<{ nombre: string; args: Record<string, unknown> }> = [];

    await expect(
      administrarNcPeriodo()(
        { actorId: ADMIN, user_id: EMPLEADO, value: true },
        {
          async rpc(nombre, args) {
            llamadas.push({ nombre, args });
            return nombre === "is_admin"
              ? { data: true, error: null }
              : { data: null, error: null };
          },
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(llamadas).toEqual([
      { nombre: "is_admin", args: { _user_id: ADMIN } },
      {
        nombre: "administrar_puede_emitir_nc_periodo",
        args: { p_profile_id: EMPLEADO, p_habilitado: true },
      },
    ]);
  });
});

describe("setPuedeFacturar", () => {
  it("rechaza a quien no es admin antes de intentar cambiar la capacidad", async () => {
    const llamadas: string[] = [];
    await expect(
      ejecutarSetPuedeFacturar(
        { actorId: EMPLEADO, user_id: EMPLEADO, value: true },
        {
          async rpc(nombre) {
            llamadas.push(nombre);
            return nombre === "is_admin"
              ? { data: false, error: null }
              : { data: null, error: null };
          },
        },
      ),
    ).rejects.toThrow(/solo admin/i);
    expect(llamadas).toEqual(["is_admin"]);
  });

  it("usa la RPC JWT-bound exacta después de revalidar al admin", async () => {
    const llamadas: Array<{ nombre: string; args: Record<string, unknown> }> = [];
    await expect(
      ejecutarSetPuedeFacturar(
        { actorId: ADMIN, user_id: EMPLEADO, value: true },
        {
          async rpc(nombre, args) {
            llamadas.push({ nombre, args });
            return nombre === "is_admin"
              ? { data: true, error: null }
              : { data: null, error: null };
          },
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(llamadas).toEqual([
      { nombre: "is_admin", args: { _user_id: ADMIN } },
      {
        nombre: "administrar_puede_facturar",
        args: { p_profile_id: EMPLEADO, p_puede_facturar: true },
      },
    ]);
  });

  it("propaga un fallo de la RPC sin informar éxito", async () => {
    await expect(
      ejecutarSetPuedeFacturar(
        { actorId: ADMIN, user_id: EMPLEADO, value: false },
        {
          async rpc(nombre) {
            return nombre === "is_admin"
              ? { data: true, error: null }
              : { data: null, error: { message: "permiso denegado" } };
          },
        },
      ),
    ).rejects.toThrow("permiso denegado");
  });
});

describe("setPuedeGestionarCreditoClientes", () => {
  it("rechaza a quien no es admin antes de intentar cambiar el permiso", async () => {
    const llamadas: string[] = [];

    await expect(
      ejecutarSetPuedeGestionarCreditoClientes(
        { actorId: EMPLEADO, user_id: EMPLEADO, value: true },
        {
          async rpc(nombre) {
            llamadas.push(nombre);
            return nombre === "is_admin"
              ? { data: false, error: null }
              : { data: null, error: null };
          },
        },
      ),
    ).rejects.toThrow(/solo admin/i);

    expect(llamadas).toEqual(["is_admin"]);
  });

  it("usa la RPC administrativa exacta después de revalidar al admin", async () => {
    const llamadas: Array<{ nombre: string; args: Record<string, unknown> }> = [];

    await expect(
      ejecutarSetPuedeGestionarCreditoClientes(
        { actorId: ADMIN, user_id: EMPLEADO, value: true },
        {
          async rpc(nombre, args) {
            llamadas.push({ nombre, args });
            return nombre === "is_admin"
              ? { data: true, error: null }
              : { data: null, error: null };
          },
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(llamadas).toEqual([
      { nombre: "is_admin", args: { _user_id: ADMIN } },
      {
        nombre: "administrar_puede_gestionar_credito_clientes",
        args: { p_profile_id: EMPLEADO, p_puede: true },
      },
    ]);
  });

  it("propaga un fallo de la RPC sin informar éxito", async () => {
    await expect(
      ejecutarSetPuedeGestionarCreditoClientes(
        { actorId: ADMIN, user_id: EMPLEADO, value: false },
        {
          async rpc(nombre) {
            return nombre === "is_admin"
              ? { data: true, error: null }
              : { data: null, error: { message: "permiso denegado" } };
          },
        },
      ),
    ).rejects.toThrow("permiso denegado");
  });
});

type EstadoDoble = {
  version: number;
  activoDeseado: boolean;
  operacionId: string | null;
  pendiente: boolean;
  perfilActivo: boolean;
  authBloqueado: boolean;
};

class ToggleCasDouble {
  estado: EstadoDoble = {
    version: 0,
    activoDeseado: true,
    operacionId: null,
    pendiente: false,
    perfilActivo: true,
    authBloqueado: false,
  };
  ids = [OP_RECONCILIAR];
  iniciarCalls = 0;
  finalizarCalls = 0;
  forzarCalls = 0;
  authCalls: Array<"none" | "876000h"> = [];
  antesDeAuth: ((ban: "none" | "876000h") => Promise<void>) | null = null;
  antesDeFinalizar: ((version: number, operacionId: string) => Promise<void>) | null = null;
  operacionesConsumidas = new Map<string, { version: number; activoDeseado: boolean }>();

  private respuesta(extra: Record<string, unknown> = {}) {
    return {
      version: this.estado.version,
      activo_deseado: this.estado.activoDeseado,
      operacion_id: this.estado.operacionId,
      pendiente: this.estado.pendiente,
      activo_actual: this.estado.perfilActivo,
      ...extra,
    };
  }

  operaciones(): OperacionesToggleUsuario {
    return {
      iniciar: async (_userId, activo, operacionId) => {
        this.iniciarCalls += 1;
        const consumida = this.operacionesConsumidas.get(operacionId);
        if (consumida) {
          if (consumida.activoDeseado !== activo) {
            return { data: null, error: { message: "idempotencia incompatible" } };
          }
          const vigente =
            consumida.version === this.estado.version && this.estado.operacionId === operacionId;
          return {
            data: this.respuesta({ idempotente: true, supersedida: !vigente }),
            error: null,
          };
        }
        if (this.estado.operacionId !== operacionId) {
          this.estado.version += 1;
          this.estado.activoDeseado = activo;
          this.estado.operacionId = operacionId;
          this.estado.pendiente = true;
          this.estado.perfilActivo = false;
          this.operacionesConsumidas.set(operacionId, {
            version: this.estado.version,
            activoDeseado: activo,
          });
        }
        return { data: this.respuesta(), error: null };
      },
      finalizar: async (_userId, version, operacionId) => {
        this.finalizarCalls += 1;
        await this.antesDeFinalizar?.(version, operacionId);
        if (this.estado.version === version && this.estado.operacionId === operacionId) {
          if (this.estado.pendiente) {
            this.estado.perfilActivo = this.estado.activoDeseado;
            this.estado.pendiente = false;
          }
          return {
            data: this.respuesta({ aplicada: true, supersedida: false }),
            error: null,
          };
        }
        return {
          data: this.respuesta({ aplicada: false, supersedida: true }),
          error: null,
        };
      },
      reclamarReconciliacion: async (_userId, versionObservada, operacionId) => {
        let reclamada = false;
        const consumida = this.operacionesConsumidas.get(operacionId);
        if (consumida) {
          reclamada =
            consumida.version === this.estado.version && this.estado.operacionId === operacionId;
        } else if (this.estado.version === versionObservada && !this.estado.pendiente) {
          this.estado.version += 1;
          this.estado.operacionId = operacionId;
          this.estado.pendiente = true;
          this.estado.perfilActivo = false;
          this.operacionesConsumidas.set(operacionId, {
            version: this.estado.version,
            activoDeseado: this.estado.activoDeseado,
          });
          reclamada = true;
        }
        return { data: this.respuesta({ reclamada }), error: null };
      },
      forzarCierreFailSafe: async (_userId, operacionId) => {
        this.forzarCalls += 1;
        const consumida = this.operacionesConsumidas.get(operacionId);
        if (consumida) {
          const vigente =
            consumida.version === this.estado.version && this.estado.operacionId === operacionId;
          if (!vigente) {
            return {
              data: this.respuesta({ forzada: false, supersedida: true, replay: true }),
              error: null,
            };
          }
        } else {
          this.estado.version += 1;
          this.estado.operacionId = operacionId;
          this.operacionesConsumidas.set(operacionId, {
            version: this.estado.version,
            activoDeseado: this.estado.activoDeseado,
          });
        }
        this.estado.pendiente = true;
        this.estado.perfilActivo = false;
        return {
          data: this.respuesta({ forzada: true, supersedida: false, replay: !!consumida }),
          error: null,
        };
      },
      actualizarAuth: async (_userId, banDuration) => {
        this.authCalls.push(banDuration);
        await this.antesDeAuth?.(banDuration);
        this.estado.authBloqueado = banDuration !== "none";
        return { error: null };
      },
      leerAuthBloqueado: async () => ({
        bloqueado: this.estado.authBloqueado,
        error: null,
      }),
      generarOperacionId: () => {
        const id = this.ids.shift();
        if (!id) throw new Error("Falta id de reconciliación en el doble");
        return id;
      },
    };
  }
}

describe("toggleUsuarioActivo", () => {
  it("si falla iniciar la transición no toca Auth ni informa éxito", async () => {
    const doble = new ToggleCasDouble();
    const operaciones = doble.operaciones();
    operaciones.iniciar = async () => ({
      data: null,
      error: { message: "perfil inexistente" },
    });
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
        operaciones,
      ),
    ).rejects.toThrow("perfil inexistente");
    expect(doble.authCalls).toEqual([]);
    expect(doble.estado.perfilActivo).toBe(true);
  });

  it("inactiva de forma fail-safe y sólo publica el perfil después de bloquear Auth", async () => {
    const doble = new ToggleCasDouble();
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
        doble.operaciones(),
      ),
    ).resolves.toEqual({ ok: true });
    expect(doble.estado).toMatchObject({
      version: 1,
      activoDeseado: false,
      pendiente: false,
      perfilActivo: false,
      authBloqueado: true,
    });
  });

  it("reactiva Auth antes de publicar el perfil como activo", async () => {
    const doble = new ToggleCasDouble();
    doble.estado.perfilActivo = false;
    doble.estado.activoDeseado = false;
    doble.estado.authBloqueado = true;
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: true, operacion_id: OP_ALTA },
        doble.operaciones(),
      ),
    ).resolves.toEqual({ ok: true });
    expect(doble.estado).toMatchObject({
      activoDeseado: true,
      pendiente: false,
      perfilActivo: true,
      authBloqueado: false,
    });
  });

  it("reintenta con la misma operación si se pierde la respuesta posterior al COMMIT inicial", async () => {
    const doble = new ToggleCasDouble();
    const operaciones = doble.operaciones();
    const iniciarReal = operaciones.iniciar;
    let perder = true;
    operaciones.iniciar = async (...args) => {
      const respuesta = await iniciarReal(...args);
      if (perder) {
        perder = false;
        throw new Error("timeout después del commit");
      }
      return respuesta;
    };
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
        operaciones,
      ),
    ).resolves.toEqual({ ok: true });
    expect(doble.iniciarCalls).toBe(2);
    expect(doble.estado.version).toBe(1);
    expect(doble.authCalls).toEqual(["876000h"]);
  });

  it("recupera idempotentemente si se pierde la respuesta posterior al COMMIT final", async () => {
    const doble = new ToggleCasDouble();
    const operaciones = doble.operaciones();
    const finalizarReal = operaciones.finalizar;
    let perder = true;
    operaciones.finalizar = async (...args) => {
      const respuesta = await finalizarReal(...args);
      if (perder) {
        perder = false;
        throw new Error("timeout después del commit");
      }
      return respuesta;
    };
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: true, operacion_id: OP_ALTA },
        operaciones,
      ),
    ).resolves.toEqual({ ok: true });
    expect(doble.finalizarCalls).toBe(2);
    expect(doble.estado).toMatchObject({
      version: 1,
      pendiente: false,
      perfilActivo: true,
      authBloqueado: false,
    });
  });

  it("deja el perfil cerrado si GoTrue falla en ambos intentos", async () => {
    const doble = new ToggleCasDouble();
    const operaciones = doble.operaciones();
    operaciones.actualizarAuth = async () => ({ error: { message: "GoTrue no responde" } });
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: true, operacion_id: OP_ALTA },
        operaciones,
      ),
    ).rejects.toThrow("GoTrue no responde");
    expect(doble.estado).toMatchObject({ pendiente: true, perfilActivo: false });
  });

  it("si falla finalizar después de abrir Auth conserva el perfil cerrado y devuelve el error real", async () => {
    const doble = new ToggleCasDouble();
    doble.estado.perfilActivo = false;
    doble.estado.activoDeseado = false;
    doble.estado.authBloqueado = true;
    const operaciones = doble.operaciones();
    operaciones.finalizar = async () => ({
      data: null,
      error: { message: "falló finalizar CAS" },
    });
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: true, operacion_id: OP_ALTA },
        operaciones,
      ),
    ).rejects.toThrow("falló finalizar CAS");
    expect(doble.estado).toMatchObject({
      pendiente: true,
      perfilActivo: false,
      authBloqueado: false,
    });
  });

  it("rechaza una respuesta RPC incompleta antes de tocar Auth", async () => {
    const doble = new ToggleCasDouble();
    const operaciones = doble.operaciones();
    operaciones.iniciar = async () => ({ data: { version: 1 }, error: null });
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: true, operacion_id: OP_ALTA },
        operaciones,
      ),
    ).rejects.toThrow(/iniciar el cambio de acceso/i);
    expect(doble.authCalls).toEqual([]);
  });

  it("una baja vieja reconcilia el alta más nueva y termina supersedida, nunca como segundo éxito", async () => {
    const doble = new ToggleCasDouble();
    let liberarBan!: () => void;
    let avisoBanIniciado!: () => void;
    const banIniciado = new Promise<void>((resolve) => {
      avisoBanIniciado = resolve;
    });
    const banPuedeTerminar = new Promise<void>((resolve) => {
      liberarBan = resolve;
    });
    doble.antesDeAuth = async (banDuration) => {
      if (banDuration === "876000h" && doble.authCalls.length === 1) {
        avisoBanIniciado();
        await banPuedeTerminar;
      }
    };
    const operaciones = doble.operaciones();
    const baja = ejecutarToggleUsuarioActivo(
      { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
      operaciones,
    );
    await banIniciado;
    const alta = ejecutarToggleUsuarioActivo(
      { user_id: EMPLEADO, activo: true, operacion_id: OP_ALTA },
      operaciones,
    );
    await expect(alta).resolves.toEqual({ ok: true });
    liberarBan();
    await expect(baja).rejects.toThrow(/reemplazada.*estado más reciente/i);
    expect(doble.estado).toMatchObject({
      activoDeseado: true,
      pendiente: false,
      perfilActivo: true,
      authBloqueado: false,
    });
    expect(doble.authCalls).toEqual(["876000h", "none", "none"]);
  });

  it("una alta vieja repara la baja nueva aunque la transición más reciente todavía esté pendiente", async () => {
    const doble = new ToggleCasDouble();
    doble.estado.perfilActivo = false;
    doble.estado.activoDeseado = false;
    doble.estado.authBloqueado = true;

    let liberarAltaVieja!: () => void;
    let avisarAltaVieja!: () => void;
    const altaViejaEnAuth = new Promise<void>((resolve) => {
      avisarAltaVieja = resolve;
    });
    const altaViejaPuedeEscribir = new Promise<void>((resolve) => {
      liberarAltaVieja = resolve;
    });
    doble.antesDeAuth = async (banDuration) => {
      if (banDuration === "none" && doble.authCalls.length === 1) {
        avisarAltaVieja();
        await altaViejaPuedeEscribir;
      }
    };

    let liberarFinalBaja!: () => void;
    let avisarFinalBaja!: () => void;
    const bajaEscribioAuth = new Promise<void>((resolve) => {
      avisarFinalBaja = resolve;
    });
    const bajaPuedeFinalizar = new Promise<void>((resolve) => {
      liberarFinalBaja = resolve;
    });
    let primerFinalBaja = true;
    doble.antesDeFinalizar = async (version, operacionId) => {
      if (version === 2 && operacionId === OP_BAJA && primerFinalBaja) {
        primerFinalBaja = false;
        avisarFinalBaja();
        await bajaPuedeFinalizar;
      }
    };

    const operaciones = doble.operaciones();
    const altaVieja = ejecutarToggleUsuarioActivo(
      { user_id: EMPLEADO, activo: true, operacion_id: OP_ALTA },
      operaciones,
    );
    await altaViejaEnAuth;

    const bajaNueva = ejecutarToggleUsuarioActivo(
      { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
      operaciones,
    );
    await bajaEscribioAuth;
    expect(doble.estado).toMatchObject({
      version: 2,
      activoDeseado: false,
      pendiente: true,
      perfilActivo: false,
      authBloqueado: true,
    });

    // La escritura vieja ocurre después del ban nuevo pero antes de su COMMIT DB.
    liberarAltaVieja();
    await expect(altaVieja).rejects.toThrow(/reemplazada.*estado más reciente/i);
    liberarFinalBaja();
    await expect(bajaNueva).resolves.toEqual({ ok: true });

    expect(doble.estado).toMatchObject({
      version: 2,
      activoDeseado: false,
      pendiente: false,
      perfilActivo: false,
      authBloqueado: true,
    });
    expect(doble.authCalls).toEqual(["none", "876000h", "876000h"]);
  });

  it("un retry tardío con una clave vieja queda supersedido sin tocar Auth ni revivir su intención", async () => {
    const doble = new ToggleCasDouble();
    const operaciones = doble.operaciones();
    await ejecutarToggleUsuarioActivo(
      { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
      operaciones,
    );
    await ejecutarToggleUsuarioActivo(
      { user_id: EMPLEADO, activo: true, operacion_id: OP_ALTA },
      operaciones,
    );
    expect(doble.authCalls).toEqual(["876000h", "none"]);

    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
        operaciones,
      ),
    ).rejects.toThrow(/reemplazada.*estado más reciente/i);
    expect(doble.authCalls).toEqual(["876000h", "none"]);
    expect(doble.estado).toMatchObject({
      version: 2,
      activoDeseado: true,
      pendiente: false,
      perfilActivo: true,
      authBloqueado: false,
    });
  });

  it("relee el CAS tras timeouts finales y un retry supersedido repara Auth al deseo vigente", async () => {
    const doble = new ToggleCasDouble();
    doble.ids = [OP_RECONCILIAR, "10000000-0000-4000-8000-000000000006"];
    doble.estado.perfilActivo = false;
    doble.estado.activoDeseado = false;
    doble.estado.authBloqueado = true;

    let liberarAltaVieja!: () => void;
    let avisarAltaVieja!: () => void;
    const altaViejaEnAuth = new Promise<void>((resolve) => {
      avisarAltaVieja = resolve;
    });
    const altaViejaPuedeEscribir = new Promise<void>((resolve) => {
      liberarAltaVieja = resolve;
    });
    doble.antesDeAuth = async (banDuration) => {
      if (banDuration === "none" && doble.authCalls.length === 1) {
        avisarAltaVieja();
        await altaViejaPuedeEscribir;
      }
    };

    const operaciones = doble.operaciones();
    const finalizarReal = operaciones.finalizar;
    operaciones.finalizar = async (...args) => {
      await finalizarReal(...args);
      throw new Error("timeout posterior al COMMIT final");
    };

    const altaVieja = ejecutarToggleUsuarioActivo(
      { user_id: EMPLEADO, activo: true, operacion_id: OP_ALTA },
      operaciones,
    );
    await altaViejaEnAuth;

    // La baja nueva escribe Auth y estabiliza el deseo opuesto, pero pierde las
    // dos respuestas de finalizar. El estado DB ya está confirmado.
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
        operaciones,
      ),
    ).resolves.toEqual({ ok: true });
    expect(doble.estado).toMatchObject({
      activoDeseado: false,
      pendiente: false,
      perfilActivo: false,
      authBloqueado: true,
    });

    // La escritura vieja aterriza después y también pierde ambas respuestas.
    // Antes del fix dejaba DB=false estable pero Auth abierto.
    liberarAltaVieja();
    await expect(altaVieja).rejects.toThrow(/reemplazada.*estado más reciente/i);
    expect(doble.estado).toMatchObject({
      activoDeseado: false,
      pendiente: false,
      perfilActivo: false,
      authBloqueado: true,
    });

    // Un retry histórico nunca puede confiar sólo en profile/desired: vuelve a
    // imponer el bloqueo vigente antes de informar que fue supersedido.
    doble.estado.authBloqueado = false;
    operaciones.finalizar = finalizarReal;
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: true, operacion_id: OP_ALTA },
        operaciones,
      ),
    ).rejects.toThrow(/reemplazada.*estado más reciente/i);
    expect(doble.estado.authBloqueado).toBe(true);
    expect(doble.authCalls.at(-1)).toBe("876000h");
  });

  it("cierra perfil y Auth si también fallan las lecturas posteriores a un finalizar ambiguo", async () => {
    const doble = new ToggleCasDouble();
    doble.ids = [OP_FAIL_SAFE];
    doble.estado.perfilActivo = false;
    doble.estado.activoDeseado = false;
    doble.estado.authBloqueado = true;

    const operaciones = doble.operaciones();
    const iniciarReal = operaciones.iniciar;
    let lecturas = 0;
    operaciones.iniciar = async (...args) => {
      lecturas += 1;
      if (lecturas === 1) return iniciarReal(...args);
      return { data: null, error: { message: "actor inactivo durante la recuperación" } };
    };
    operaciones.finalizar = async () => {
      // Una baja posterior ya quedó estable en DB. La escritura Auth vieja
      // aterrizó después y abrió GoTrue; además se pierden ambas respuestas de
      // finalizar y ya no se puede releer con el actor original.
      doble.estado.version = 2;
      doble.estado.activoDeseado = false;
      doble.estado.operacionId = OP_BAJA;
      doble.estado.pendiente = false;
      doble.estado.perfilActivo = false;
      doble.operacionesConsumidas.set(OP_BAJA, {
        version: 2,
        activoDeseado: false,
      });
      return { data: null, error: { message: "timeout final ambiguo" } };
    };

    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: true, operacion_id: OP_ALTA },
        operaciones,
      ),
    ).rejects.toThrow(/recuperación|cerrar|reconciliar/i);

    expect(doble.forzarCalls).toBe(1);
    expect(doble.estado).toMatchObject({
      activoDeseado: false,
      pendiente: true,
      perfilActivo: false,
      authBloqueado: true,
    });
    expect(doble.authCalls).toEqual(["none", "876000h"]);
  });

  it("impone cierre fail-safe si no puede leer Auth de un retry supersedido", async () => {
    const doble = new ToggleCasDouble();
    const operaciones = doble.operaciones();
    await ejecutarToggleUsuarioActivo(
      { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
      operaciones,
    );
    await ejecutarToggleUsuarioActivo(
      { user_id: EMPLEADO, activo: true, operacion_id: OP_ALTA },
      operaciones,
    );
    doble.ids = [OP_FAIL_SAFE];
    operaciones.leerAuthBloqueado = async () => ({
      bloqueado: null,
      error: { message: "GoTrue no permite verificar" },
    });

    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
        operaciones,
      ),
    ).rejects.toThrow(/verificar|cerrar|reconciliar/i);

    expect(doble.forzarCalls).toBe(1);
    expect(doble.estado).toMatchObject({
      activoDeseado: true,
      pendiente: true,
      perfilActivo: false,
      authBloqueado: true,
    });
    expect(doble.authCalls.at(-1)).toBe("876000h");
  });

  it("agota el churn de versiones en estado fail-closed y exige reintento", async () => {
    const doble = new ToggleCasDouble();
    doble.ids = [OP_FAIL_SAFE];
    const operaciones = doble.operaciones();
    const finalizarReal = operaciones.finalizar;
    operaciones.finalizar = async (...args) => {
      await finalizarReal(...args);
      // Cada confirmación pierde contra una intención posterior. La intención
      // alterna para demostrar que la reparación nunca repone el pedido viejo.
      const nuevaId = `30000000-0000-4000-8000-${String(doble.estado.version + 1).padStart(12, "0")}`;
      doble.estado.version += 1;
      doble.estado.activoDeseado = !doble.estado.activoDeseado;
      doble.estado.operacionId = nuevaId;
      doble.estado.pendiente = true;
      doble.estado.perfilActivo = false;
      doble.operacionesConsumidas.set(nuevaId, {
        version: doble.estado.version,
        activoDeseado: doble.estado.activoDeseado,
      });
      return {
        data: {
          version: doble.estado.version,
          activo_deseado: doble.estado.activoDeseado,
          operacion_id: doble.estado.operacionId,
          pendiente: true,
          activo_actual: false,
          aplicada: false,
          supersedida: true,
        },
        error: null,
      };
    };

    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
        operaciones,
      ),
    ).rejects.toThrow(/cerrado y pendiente.*reintent/i);
    expect(doble.forzarCalls).toBe(1);
    expect(doble.estado).toMatchObject({
      operacionId: OP_FAIL_SAFE,
      activoDeseado: true,
      pendiente: true,
      perfilActivo: false,
    });
    expect(doble.authCalls).toHaveLength(10);
    expect(doble.authCalls.at(-1)).toBe("876000h");

    operaciones.finalizar = finalizarReal;
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
        operaciones,
      ),
    ).rejects.toThrow(/reemplazada.*estado más reciente/i);
    expect(doble.estado).toMatchObject({
      operacionId: OP_FAIL_SAFE,
      activoDeseado: true,
      pendiente: false,
      perfilActivo: true,
      authBloqueado: false,
    });

    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA_POSTERIOR },
        operaciones,
      ),
    ).resolves.toEqual({ ok: true });
    expect(doble.estado).toMatchObject({
      operacionId: OP_BAJA_POSTERIOR,
      activoDeseado: false,
      pendiente: false,
      perfilActivo: false,
      authBloqueado: true,
    });
  });

  it("el retry de la misma intención adopta y finaliza la reconciliación fail-safe vigente", async () => {
    const doble = new ToggleCasDouble();
    doble.ids = [OP_FAIL_SAFE];
    const operaciones = doble.operaciones();
    const finalizarReal = operaciones.finalizar;
    operaciones.finalizar = async (...args) => {
      await finalizarReal(...args);
      const nuevaId = `40000000-0000-4000-8000-${String(doble.estado.version + 1).padStart(12, "0")}`;
      doble.estado.version += 1;
      doble.estado.activoDeseado = false;
      doble.estado.operacionId = nuevaId;
      doble.estado.pendiente = true;
      doble.estado.perfilActivo = false;
      doble.operacionesConsumidas.set(nuevaId, {
        version: doble.estado.version,
        activoDeseado: false,
      });
      return {
        data: {
          version: doble.estado.version,
          activo_deseado: false,
          operacion_id: nuevaId,
          pendiente: true,
          activo_actual: false,
          aplicada: false,
          supersedida: true,
        },
        error: null,
      };
    };

    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
        operaciones,
      ),
    ).rejects.toThrow(/cerrado y pendiente.*reintent/i);
    expect(doble.estado).toMatchObject({
      operacionId: OP_FAIL_SAFE,
      activoDeseado: false,
      pendiente: true,
      perfilActivo: false,
    });

    operaciones.finalizar = finalizarReal;
    await expect(
      ejecutarToggleUsuarioActivo(
        { user_id: EMPLEADO, activo: false, operacion_id: OP_BAJA },
        operaciones,
      ),
    ).resolves.toEqual({ ok: true });
    expect(doble.estado).toMatchObject({
      operacionId: OP_FAIL_SAFE,
      activoDeseado: false,
      pendiente: false,
      perfilActivo: false,
      authBloqueado: true,
    });
  });
});
