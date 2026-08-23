import { describe, expect, it } from "vitest";
import {
  RegistroOperacionesToggleUsuario,
  estadoInicialToggleUsuario,
  etiquetaReconciliacionToggleUsuario,
  objetivoToggleUsuario,
  type AlmacenClaveValor,
} from "./usuario-toggle-durable";

class AlmacenEnMemoria implements AlmacenClaveValor {
  private readonly valores = new Map<string, string>();

  getItem(key: string): string | null {
    return this.valores.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.valores.set(key, value);
  }

  removeItem(key: string): void {
    this.valores.delete(key);
  }
}

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OP_BAJA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP_ALTA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("RegistroOperacionesToggleUsuario", () => {
  it("separa las operaciones del mismo usuario según el estado deseado", () => {
    const almacen = new AlmacenEnMemoria();
    const ids = [OP_BAJA, OP_ALTA];
    const registro = new RegistroOperacionesToggleUsuario(almacen, () => ids.shift()!);

    expect(registro.obtenerOCrear(USER_ID, false)).toBe(OP_BAJA);
    expect(registro.obtenerOCrear(USER_ID, true)).toBe(OP_ALTA);
    expect(registro.obtenerOCrear(USER_ID, false)).toBe(OP_BAJA);
  });

  it("reutiliza la misma operación después de un error ambiguo y de recargar la pantalla", () => {
    const almacen = new AlmacenEnMemoria();
    const primero = new RegistroOperacionesToggleUsuario(almacen, () => OP_BAJA);

    expect(primero.obtenerOCrear(USER_ID, false)).toBe(OP_BAJA);
    expect(primero.resolverError(USER_ID, false, new Error("timeout después del COMMIT"))).toBe(
      "requiere_reintento",
    );

    const trasRecarga = new RegistroOperacionesToggleUsuario(almacen, () => OP_ALTA);
    expect(trasRecarga.obtenerOCrear(USER_ID, false)).toBe(OP_BAJA);
    expect(estadoInicialToggleUsuario(trasRecarga)).toEqual({
      [USER_ID]: { tipo: "requiere_reintento", activoDeseado: false },
    });
  });

  it("borra la operación únicamente cuando el servidor confirma el éxito", () => {
    const almacen = new AlmacenEnMemoria();
    let siguiente = OP_BAJA;
    const registro = new RegistroOperacionesToggleUsuario(almacen, () => siguiente);

    expect(registro.obtenerOCrear(USER_ID, false)).toBe(OP_BAJA);
    registro.confirmarExito(USER_ID, false);
    siguiente = OP_ALTA;

    expect(registro.obtenerOCrear(USER_ID, false)).toBe(OP_ALTA);
  });

  it("un error terminal supersedido borra la clave y se muestra como reemplazado", () => {
    const almacen = new AlmacenEnMemoria();
    const registro = new RegistroOperacionesToggleUsuario(almacen, () => OP_BAJA);
    registro.obtenerOCrear(USER_ID, false);

    expect(
      registro.resolverError(
        USER_ID,
        false,
        new Error("La operación fue reemplazada por un cambio más nuevo"),
      ),
    ).toBe("supersedida");
    expect(registro.listarPendientes()).toEqual([]);
  });

  it("no confunde un cierre fail-closed que pide reintento con un supersedido terminal", () => {
    const almacen = new AlmacenEnMemoria();
    const registro = new RegistroOperacionesToggleUsuario(almacen, () => OP_BAJA);
    registro.obtenerOCrear(USER_ID, false);

    expect(
      registro.resolverError(
        USER_ID,
        false,
        new Error(
          "La operación fue reemplazada varias veces. El acceso quedó cerrado y pendiente; reintentá la misma acción.",
        ),
      ),
    ).toBe("requiere_reintento");
    expect(registro.listarPendientes()).toHaveLength(1);
  });

  it("conserva la clave en memoria si el almacenamiento del navegador no está disponible", () => {
    const almacenRoto: AlmacenClaveValor = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const registro = new RegistroOperacionesToggleUsuario(almacenRoto, () => OP_BAJA);

    expect(registro.obtenerOCrear(USER_ID, false)).toBe(OP_BAJA);
    expect(registro.obtenerOCrear(USER_ID, false)).toBe(OP_BAJA);
  });
});

describe("estado de fila del toggle", () => {
  it("describe un retry ambiguo sin prometer activar ni desactivar", () => {
    expect(etiquetaReconciliacionToggleUsuario()).toEqual({
      estado: "Acceso pendiente de reconciliar",
      accion: "Reconciliar acceso pendiente",
    });
  });

  it("reintenta una baja ambigua aunque el perfil ya aparezca inactivo", () => {
    expect(
      objetivoToggleUsuario(false, {
        tipo: "requiere_reintento",
        activoDeseado: false,
      }),
    ).toBe(false);
  });

  it("sin una operación ambigua cambia al estado opuesto al perfil visible", () => {
    expect(objetivoToggleUsuario(false, undefined)).toBe(true);
    expect(objetivoToggleUsuario(true, { tipo: "supersedida", activoDeseado: false })).toBe(false);
  });
});
