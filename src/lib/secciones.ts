// Qué pantallas ve cada usuario.
//
// Hasta ahora había exactamente DOS menús posibles en todo el sistema —el de
// admin y el de empleado—, decididos por un booleano `adminOnly` hardcodeado en
// `_authenticated/route.tsx`. No había forma de que un empleado viera Ventas
// pero no Compras sin tocar el código y desplegar.
// Ver docs/superpowers/specs/2026-08-03-permisos-por-seccion-design.md
//
// ESTO ES VISIBILIDAD, NO UNA FRONTERA DE SEGURIDAD. Lo que protege los datos es
// RLS y los `is_admin()` adentro de las RPC. Esconder una pantalla del menú no
// impide que alguien con la sesión abierta consulte PostgREST a mano. Sirve para
// ordenar la aplicación —que cada uno vea lo suyo y no se equivoque de
// pantalla—, y la propia pantalla de permisos lo dice con todas las letras.
//
// Este archivo es la ÚNICA lista. La usan el menú, el guard de ruta y la
// pantalla de usuarios. Tenerla en un solo lugar es lo que evita el bug clásico
// de esta feature: que el permiso oculte el link pero la URL escrita a mano siga
// entrando.

export type Seccion = {
  /** Lo que se guarda en `profiles.secciones`. */
  key: string;
  ruta: string;
  label: string;
  grupo: string;
  /**
   * No se puede otorgar a un empleado.
   *
   * No es una preferencia: estas tres rutas ya rechazan a los no-admin en su
   * propio `beforeLoad`, y sus acciones son server functions con `is_admin`.
   * Ofrecerlas en la lista de permisos prometería algo que el servidor no va a
   * cumplir — el usuario rebotaría antes de ver la pantalla, o entraría a una
   * donde todo falla.
   */
  soloAdmin?: boolean;
};

export const SECCIONES: Seccion[] = [
  { key: "dashboard", ruta: "/", label: "Dashboard", grupo: "Operación" },
  { key: "ventas", ruta: "/ventas", label: "Ventas", grupo: "Operación" },
  { key: "presupuestos", ruta: "/presupuestos", label: "Presupuestos", grupo: "Operación" },
  { key: "remitos", ruta: "/remitos", label: "Remitos", grupo: "Operación" },

  { key: "productos", ruta: "/productos", label: "Productos", grupo: "Catálogo" },
  { key: "stock", ruta: "/stock", label: "Stock", grupo: "Catálogo" },
  { key: "clientes", ruta: "/clientes", label: "Clientes", grupo: "Catálogo" },

  { key: "compras", ruta: "/compras", label: "Compras", grupo: "Compras" },
  {
    key: "ingresos_mercaderia",
    ruta: "/ingresos-mercaderia",
    label: "Ingresos de mercadería",
    grupo: "Compras",
  },
  { key: "proveedores", ruta: "/proveedores", label: "Proveedores", grupo: "Compras" },
  {
    key: "pagos_proveedores",
    ruta: "/pagos-proveedores",
    label: "Pagos a proveedores",
    grupo: "Compras",
  },
  { key: "gastos", ruta: "/gastos", label: "Gastos varios", grupo: "Compras" },

  { key: "pagos", ruta: "/pagos", label: "Pagos", grupo: "Cobranzas" },
  {
    key: "cuentas_corrientes",
    ruta: "/cuentas-corrientes",
    label: "Cuentas corrientes",
    grupo: "Cobranzas",
  },
  { key: "arqueo", ruta: "/arqueo", label: "Rendición de caja", grupo: "Cobranzas" },

  { key: "reportes", ruta: "/reportes", label: "Reportes", grupo: "Administración", soloAdmin: true },
  {
    key: "facturacion",
    ruta: "/facturacion",
    label: "Facturación AFIP",
    grupo: "Administración",
    soloAdmin: true,
  },
  { key: "usuarios", ruta: "/usuarios", label: "Usuarios", grupo: "Administración", soloAdmin: true },
];

/** Las secciones que se pueden marcar en la pantalla de permisos. */
export const SECCIONES_OTORGABLES = SECCIONES.filter((s) => !s.soloAdmin);

/**
 * Lo que ve un empleado si nadie le tocó los permisos.
 *
 * Es EXACTAMENTE el menú de hoy. Un test lo verifica: si alguien agrega una
 * sección al catálogo sin pensar, canta antes de llegar a producción.
 */
export const SECCIONES_DEFAULT: string[] = SECCIONES_OTORGABLES.map((s) => s.key);

export const GRUPOS: string[] = [...new Set(SECCIONES.map((s) => s.grupo))];

/**
 * Qué sección corresponde a una URL.
 *
 * Se ordena de ruta MÁS LARGA a más corta y se exige que el corte caiga en un
 * separador. Sin las dos cosas, `/pagos-proveedores` matchearía `/pagos` (un
 * `startsWith` pelado dice que sí) y el permiso de Pagos abriría o cerraría por
 * error la pantalla de Pagos a proveedores, que son cosas opuestas: una es plata
 * que entra y la otra plata que sale.
 */
const POR_LARGO = [...SECCIONES].sort((a, b) => b.ruta.length - a.ruta.length);

export function seccionDeRuta(path: string): Seccion | undefined {
  // El dashboard es "/" y `startsWith("/")` matchea todo: sólo la ruta exacta.
  if (path === "/") return SECCIONES.find((s) => s.ruta === "/");
  return POR_LARGO.find(
    (s) => s.ruta !== "/" && (path === s.ruta || path.startsWith(s.ruta + "/")),
  );
}

export type UsuarioPermisos = {
  isAdmin: boolean;
  /** `null` = "las de siempre". Ver la tabla de la spec §4.2. */
  secciones?: string[] | null;
};

/**
 * Las secciones efectivas de un usuario, ya resueltas.
 *
 * Un admin ve TODO siempre, tenga lo que tenga guardado en la columna: no se
 * puede quedar afuera de su propio sistema.
 */
export function seccionesDe(cu: UsuarioPermisos): string[] {
  if (cu.isAdmin) return SECCIONES.map((s) => s.key);
  const propias = cu.secciones ?? SECCIONES_DEFAULT;
  // Se filtra contra el catálogo: una key vieja o basura guardada en la base no
  // puede abrir nada ni romper el menú.
  return SECCIONES_OTORGABLES.filter((s) => propias.includes(s.key)).map((s) => s.key);
}

export function puedeVer(key: string, cu: UsuarioPermisos): boolean {
  return seccionesDe(cu).includes(key);
}

/** A dónde mandarlo al entrar, si no tiene el dashboard. `null` = no tiene nada. */
export function primeraSeccion(cu: UsuarioPermisos): Seccion | null {
  const permitidas = new Set(seccionesDe(cu));
  return SECCIONES.find((s) => permitidas.has(s.key)) ?? null;
}

/**
 * Limpia una lista de secciones antes de guardarla.
 *
 * `null` entra y sale como `null` (es "las de siempre", no una lista vacía).
 * Descarta keys inexistentes y las `soloAdmin`, para que no se guarde en la base
 * algo que después nadie sabe de dónde salió.
 */
export function normalizarSecciones(v: unknown): string[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return null;
  const validas = new Set(SECCIONES_OTORGABLES.map((s) => s.key));
  return [...new Set(v.filter((k): k is string => typeof k === "string" && validas.has(k)))];
}
