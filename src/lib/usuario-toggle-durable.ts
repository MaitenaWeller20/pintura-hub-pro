export type AlmacenClaveValor = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type EstadoToggleUsuario = {
  tipo: "pendiente" | "requiere_reintento" | "supersedida";
  activoDeseado: boolean;
};

type OperacionTogglePersistida = {
  userId: string;
  activoDeseado: boolean;
  operacionId: string;
};

type DocumentoOperaciones = {
  version: 1;
  operaciones: Record<string, OperacionTogglePersistida>;
};

const CLAVE_ALMACEN = "quimex:usuarios:toggle:v1";

function claveOperacion(userId: string, activoDeseado: boolean): string {
  return `${userId}:${activoDeseado ? "activo" : "inactivo"}`;
}

function esOperacionPersistida(value: unknown): value is OperacionTogglePersistida {
  if (typeof value !== "object" || value === null) return false;
  const operacion = value as Record<string, unknown>;
  return (
    typeof operacion.userId === "string" &&
    typeof operacion.activoDeseado === "boolean" &&
    typeof operacion.operacionId === "string" &&
    operacion.operacionId.length > 0
  );
}

function leerDocumento(almacen: AlmacenClaveValor | null): DocumentoOperaciones {
  if (!almacen) return { version: 1, operaciones: {} };
  try {
    const crudo = almacen.getItem(CLAVE_ALMACEN);
    if (!crudo) return { version: 1, operaciones: {} };
    const value = JSON.parse(crudo) as unknown;
    if (typeof value !== "object" || value === null) {
      return { version: 1, operaciones: {} };
    }
    const documento = value as Record<string, unknown>;
    if (documento.version !== 1 || typeof documento.operaciones !== "object") {
      return { version: 1, operaciones: {} };
    }
    const operaciones = Object.fromEntries(
      Object.entries(documento.operaciones as Record<string, unknown>).filter(([, operacion]) =>
        esOperacionPersistida(operacion),
      ),
    ) as Record<string, OperacionTogglePersistida>;
    return { version: 1, operaciones };
  } catch {
    return { version: 1, operaciones: {} };
  }
}

function mensajeError(error: unknown): string {
  if (error instanceof Error) return error.message.toLocaleLowerCase("es");
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message.toLocaleLowerCase("es");
  }
  return String(error ?? "").toLocaleLowerCase("es");
}

function esSupersedidaTerminal(error: unknown): boolean {
  const mensaje = mensajeError(error);
  if (mensaje.includes("reintent") || mensaje.includes("pendiente")) return false;
  return mensaje.includes("reemplazad") || mensaje.includes("supersedid");
}

/**
 * Conserva la clave idempotente antes de llamar al servidor. El documento vive
 * en sessionStorage para sobrevivir recargas; si el navegador lo bloquea, el
 * registro mantiene la misma clave mientras esta instancia siga montada.
 */
export class RegistroOperacionesToggleUsuario {
  private documento: DocumentoOperaciones;

  constructor(
    private readonly almacen: AlmacenClaveValor | null,
    private readonly generarOperacionId: () => string,
  ) {
    this.documento = leerDocumento(almacen);
  }

  obtenerOCrear(userId: string, activoDeseado: boolean): string {
    const clave = claveOperacion(userId, activoDeseado);
    const existente = this.documento.operaciones[clave];
    if (existente) return existente.operacionId;

    const operacionId = this.generarOperacionId();
    this.documento.operaciones[clave] = { userId, activoDeseado, operacionId };
    this.persistir();
    return operacionId;
  }

  confirmarExito(userId: string, activoDeseado: boolean): void {
    this.borrar(userId, activoDeseado);
  }

  resolverError(
    userId: string,
    activoDeseado: boolean,
    error: unknown,
  ): "requiere_reintento" | "supersedida" {
    if (esSupersedidaTerminal(error)) {
      this.borrar(userId, activoDeseado);
      return "supersedida";
    }
    return "requiere_reintento";
  }

  listarPendientes(): OperacionTogglePersistida[] {
    return Object.values(this.documento.operaciones);
  }

  private borrar(userId: string, activoDeseado: boolean): void {
    delete this.documento.operaciones[claveOperacion(userId, activoDeseado)];
    this.persistir();
  }

  private persistir(): void {
    if (!this.almacen) return;
    try {
      if (Object.keys(this.documento.operaciones).length === 0) {
        this.almacen.removeItem(CLAVE_ALMACEN);
      } else {
        this.almacen.setItem(CLAVE_ALMACEN, JSON.stringify(this.documento));
      }
    } catch {
      // sessionStorage puede estar deshabilitado. La copia en memoria sigue
      // garantizando una clave estable durante la vida de esta pantalla.
    }
  }
}

export function almacenSesionToggleUsuario(): AlmacenClaveValor | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function estadoInicialToggleUsuario(
  registro: RegistroOperacionesToggleUsuario,
): Record<string, EstadoToggleUsuario> {
  return Object.fromEntries(
    registro
      .listarPendientes()
      .map((operacion) => [
        operacion.userId,
        { tipo: "requiere_reintento", activoDeseado: operacion.activoDeseado },
      ]),
  );
}

export function objetivoToggleUsuario(
  activoActual: boolean,
  estado: EstadoToggleUsuario | undefined,
): boolean {
  return estado?.tipo === "requiere_reintento" ? estado.activoDeseado : !activoActual;
}

// Una operación fail-safe puede conservar la clave original mientras drena
// una intención más nueva e incluso opuesta. La UI no debe prometer que el
// retry "activa" o "desactiva": primero reconcilia el estado vigente.
const ETIQUETA_RECONCILIACION = {
  estado: "Acceso pendiente de reconciliar",
  accion: "Reconciliar acceso pendiente",
} as const;

export function etiquetaReconciliacionToggleUsuario(): typeof ETIQUETA_RECONCILIACION {
  return ETIQUETA_RECONCILIACION;
}
