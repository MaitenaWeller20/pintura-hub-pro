import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  SECCIONES,
  SECCIONES_DEFAULT,
  SECCIONES_OTORGABLES,
  normalizarSecciones,
  primeraSeccion,
  puedeVer,
  seccionDeRuta,
  seccionesDe,
  puedeAbrirRuta,
} from "./secciones";

const admin = {
  isAdmin: true,
  secciones: null,
  puedeFacturar: true,
  facturacionV2Habilitada: false,
};
const empleado = (
  secciones: string[] | null = null,
  fiscal: { puedeFacturar?: boolean; facturacionV2Habilitada?: boolean } = {},
) => ({ isAdmin: false, secciones, ...fiscal });

describe("el catálogo", () => {
  it("no tiene keys ni rutas repetidas", () => {
    expect(new Set(SECCIONES.map((s) => s.key)).size).toBe(SECCIONES.length);
    expect(new Set(SECCIONES.map((s) => s.ruta)).size).toBe(SECCIONES.length);
  });

  it("las keys son aptas para guardar en la base", () => {
    // El CHECK de la migración exige ^[a-z_]{2,40}$.
    for (const s of SECCIONES) expect(s.key).toMatch(/^[a-z_]{2,40}$/);
  });

  it("SECCIONES_DEFAULT es exactamente el menú que ve hoy un empleado", () => {
    // Este test es el contrato de compatibilidad. Si alguien agrega una sección
    // al catálogo sin decidir si un empleado debería verla, esto falla acá y no
    // en producción.
    expect(SECCIONES_DEFAULT).toEqual([
      "dashboard",
      "ventas",
      "presupuestos",
      "remitos",
      "productos",
      "stock",
      "clientes",
      "compras",
      "ingresos_mercaderia",
      "proveedores",
      "pagos_proveedores",
      "gastos",
      "pagos",
      "cuentas_corrientes",
      "arqueo",
    ]);
  });

  it("las pantallas administrativas y la capacidad fiscal no son otorgables como secciones", () => {
    const otorgables = SECCIONES_OTORGABLES.map((s) => s.key);
    expect(otorgables).not.toContain("reportes");
    expect(otorgables).not.toContain("facturacion");
    expect(otorgables).not.toContain("usuarios");
  });
});

// ---------------------------------------------------------------------------
// El guard de ruta falla cerrado si `seccionDeRuta` no reconoce la URL. Esta
// cobertura además obliga a catalogar cada pantalla nueva, para que no aparezca
// como un 403 inesperado recién en producción.
// ---------------------------------------------------------------------------
describe("el catálogo cubre todas las rutas del router", () => {
  /** Rutas que existen pero NO son secciones, con el motivo. */
  const NO_SON_SECCIONES: Record<string, string> = {
    caja: "sólo redirige a /arqueo desde su beforeLoad; no renderiza nada",
    route: "es el layout, no una pantalla",
  };

  const rutasDelRouter = () =>
    readdirSync(join(process.cwd(), "src/routes/_authenticated"))
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => f.replace(/\.tsx$/, ""))
      // "compras.nueva" -> "compras";  "productos.$id.seguimiento" -> "productos"
      .map((f) => f.split(".")[0])
      .filter((f) => !(f in NO_SON_SECCIONES));

  it("cada pantalla del router cae en una sección del catálogo", () => {
    const huerfanas = [...new Set(rutasDelRouter())].filter((f) => {
      const path = f === "index" ? "/" : `/${f}`;
      return !seccionDeRuta(path);
    });
    expect(huerfanas).toEqual([]);
  });

  it("cada sección del catálogo apunta a una ruta que existe", () => {
    const archivos = new Set(
      readdirSync(join(process.cwd(), "src/routes/_authenticated"))
        .filter((f) => f.endsWith(".tsx"))
        .map((f) => f.replace(/\.tsx$/, "").split(".")[0]),
    );
    const inventadas = SECCIONES.filter((s) => {
      const esperado = s.ruta === "/" ? "index" : s.ruta.slice(1);
      return !archivos.has(esperado);
    }).map((s) => s.key);
    expect(inventadas).toEqual([]);
  });
});

describe("seccionDeRuta", () => {
  it("resuelve la ruta exacta", () => {
    expect(seccionDeRuta("/ventas")?.key).toBe("ventas");
    expect(seccionDeRuta("/stock")?.key).toBe("stock");
  });

  it("resuelve las rutas hijas", () => {
    expect(seccionDeRuta("/compras/nueva")?.key).toBe("compras");
    expect(seccionDeRuta("/productos/abc-123/seguimiento")?.key).toBe("productos");
    expect(seccionDeRuta("/ingresos-mercaderia/nuevo")?.key).toBe("ingresos_mercaderia");
  });

  it("NO confunde /pagos con /pagos-proveedores", () => {
    // Un startsWith pelado dice que "/pagos-proveedores".startsWith("/pagos").
    // Son cosas opuestas: una es plata que entra, la otra plata que sale.
    expect(seccionDeRuta("/pagos")?.key).toBe("pagos");
    expect(seccionDeRuta("/pagos-proveedores")?.key).toBe("pagos_proveedores");
    expect(seccionDeRuta("/pagos-proveedores/loquesea")?.key).toBe("pagos_proveedores");
  });

  it("el dashboard es sólo la raíz exacta", () => {
    // "/" es prefijo de TODO: sin el caso especial, /ventas caería en dashboard.
    expect(seccionDeRuta("/")?.key).toBe("dashboard");
    expect(seccionDeRuta("/ventas")?.key).not.toBe("dashboard");
  });

  it("una ruta desconocida no resuelve nada", () => {
    expect(seccionDeRuta("/no-existe")).toBeUndefined();
    // /caja redirige a /arqueo en su beforeLoad y no es una sección.
    expect(seccionDeRuta("/caja")).toBeUndefined();
  });
});

describe("seccionesDe / puedeVer", () => {
  it("un admin ve todo, incluso con la columna vacía", () => {
    expect(seccionesDe({ isAdmin: true, secciones: [] })).toEqual(SECCIONES.map((s) => s.key));
    expect(puedeVer("usuarios", { isAdmin: true, secciones: [] })).toBe(true);
    expect(puedeVer("reportes", admin)).toBe(true);
  });

  it("null = las de siempre (comportamiento de hoy, sin cambios)", () => {
    expect(seccionesDe(empleado(null))).toEqual(SECCIONES_DEFAULT);
    expect(puedeVer("ventas", empleado(null))).toBe(true);
    expect(puedeVer("reportes", empleado(null))).toBe(false);
  });

  it("una lista vacía es un usuario sin ninguna pantalla", () => {
    expect(seccionesDe(empleado([]))).toEqual([]);
    expect(puedeVer("ventas", empleado([]))).toBe(false);
  });

  it("una lista concreta es exactamente esa lista", () => {
    const e = empleado(["ventas", "stock"]);
    expect(seccionesDe(e)).toEqual(["ventas", "stock"]);
    expect(puedeVer("ventas", e)).toBe(true);
    expect(puedeVer("compras", e)).toBe(false);
    expect(puedeVer("dashboard", e)).toBe(false);
  });

  it("un empleado no ve una sección soloAdmin ni aunque se la hayan guardado", () => {
    // Defensa contra un PATCH directo a la base o una key vieja.
    expect(puedeVer("usuarios", empleado(["usuarios"]))).toBe(false);
    expect(puedeVer("reportes", empleado(["ventas", "reportes"]))).toBe(false);
  });

  it("una key basura guardada en la base se ignora sin romper", () => {
    expect(seccionesDe(empleado(["ventas", "seccion_que_no_existe"]))).toEqual(["ventas"]);
  });

  it("respeta el orden del catálogo, no el orden en que se guardó", () => {
    expect(seccionesDe(empleado(["stock", "ventas"]))).toEqual(["ventas", "stock"]);
  });

  it("mantiene Facturación fuera del menú normal y sólo la habilita con capacidad fiscal efectiva", () => {
    expect(seccionesDe(empleado(null))).toEqual(SECCIONES_DEFAULT);
    expect(
      seccionesDe(empleado(null, { puedeFacturar: true, facturacionV2Habilitada: false })),
    ).not.toContain("facturacion");
    expect(
      seccionesDe(empleado(null, { puedeFacturar: false, facturacionV2Habilitada: true })),
    ).not.toContain("facturacion");
    expect(
      seccionesDe(empleado(null, { puedeFacturar: true, facturacionV2Habilitada: true })),
    ).toContain("facturacion");
  });

  it("el admin conserva configuración con v2 apagado y suma la cola con v2 encendido", () => {
    expect(puedeAbrirRuta("/facturacion/configuracion", admin)).toBe(true);
    expect(puedeAbrirRuta("/facturacion/cola", admin)).toBe(false);
    expect(puedeAbrirRuta("/facturacion/cola", { ...admin, facturacionV2Habilitada: true })).toBe(
      true,
    );
  });

  it("el empleado fiscal accede sólo a la cola y nunca a configuración", () => {
    const fiscal = empleado(null, {
      puedeFacturar: true,
      facturacionV2Habilitada: true,
    });
    expect(puedeAbrirRuta("/facturacion", fiscal)).toBe(true);
    expect(puedeAbrirRuta("/facturacion/", fiscal)).toBe(true);
    expect(puedeAbrirRuta("/facturacion/cola", fiscal)).toBe(true);
    expect(puedeAbrirRuta("/facturacion/configuracion", fiscal)).toBe(false);
  });

  it("falla cerrado para rutas y capacidades desconocidas, salvo el alias /caja", () => {
    expect(puedeAbrirRuta("/pantalla-que-no-existe", admin)).toBe(false);
    expect(
      puedeAbrirRuta("/facturacion/ruta-no-reconocida", {
        ...admin,
        facturacionV2Habilitada: true,
      }),
    ).toBe(false);
    expect(puedeAbrirRuta("/caja", empleado(["arqueo"]))).toBe(true);
    expect(puedeAbrirRuta("/caja", empleado([]))).toBe(false);
  });
});

describe("primeraSeccion", () => {
  it("manda al dashboard cuando lo tiene", () => {
    expect(primeraSeccion(empleado(null))?.ruta).toBe("/");
  });

  it("manda a la primera que tenga si no tiene dashboard", () => {
    expect(primeraSeccion(empleado(["stock", "arqueo"]))?.ruta).toBe("/stock");
  });

  it("devuelve null si no tiene ninguna", () => {
    expect(primeraSeccion(empleado([]))).toBeNull();
  });
});

describe("normalizarSecciones", () => {
  it("null y undefined quedan en null (= las de siempre)", () => {
    expect(normalizarSecciones(null)).toBeNull();
    expect(normalizarSecciones(undefined)).toBeNull();
  });

  it("descarta keys inexistentes, soloAdmin y capacidades independientes", () => {
    expect(
      normalizarSecciones(["ventas", "usuarios", "reportes", "facturacion", "../../etc"]),
    ).toEqual(["ventas"]);
  });

  it("desduplica", () => {
    expect(normalizarSecciones(["ventas", "ventas", "stock"])).toEqual(["ventas", "stock"]);
  });

  it("una lista vacía se conserva (es 'ninguna sección', no 'las de siempre')", () => {
    expect(normalizarSecciones([])).toEqual([]);
  });

  it("basura que no es lista cae en null", () => {
    expect(normalizarSecciones("ventas")).toBeNull();
    expect(normalizarSecciones(42)).toBeNull();
  });
});
