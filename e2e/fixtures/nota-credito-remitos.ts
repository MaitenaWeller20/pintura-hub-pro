import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

if (typeof window !== "undefined") {
  throw new Error("El fixture de notas y remitos no puede cargarse en browser.");
}

const CLIENTE_ID = "e2160000-0000-4000-8000-000000000001";
const PRODUCTO_NC_ID = "e2160000-0000-4000-8000-000000000002";
const PRODUCTO_REMITO_A_ID = "e2160000-0000-4000-8000-000000000003";
const PRODUCTO_REMITO_B_ID = "e2160000-0000-4000-8000-000000000004";
const STOCK_BASE = 20;

export const CLIENTE_NOTAS_E2E = "T14 E2E NOTAS CLIENTE";
export const CLIENTE_DOCUMENTO_NOTAS_E2E = "20222222223";
export const PRODUCTO_NC_CODIGO_E2E = "T14-NC-CLEAN";
export const PRODUCTO_NC_NOMBRE_E2E = "T14 E2E producto nota de crédito";
export const PRODUCTO_REMITO_A_CODIGO_E2E = "T14-REM-A";
export const PRODUCTO_REMITO_A_NOMBRE_E2E = "T14 E2E producto remito original";
export const PRODUCTO_REMITO_B_CODIGO_E2E = "T14-REM-B";
export const PRODUCTO_REMITO_B_NOMBRE_E2E = "T14 E2E producto remito reemplazo";
export const MARCA_VENTA_NC_E2E = "T14-E2E-NOTAS-NC-GUARDADA";
export const MARCA_REMITO_VER_E2E = "T14-E2E-NOTAS-REMITO-VER";
export const MARCA_REMITO_EDITAR_E2E = "T14-E2E-NOTAS-REMITO-EDITAR";

const PRODUCTOS = [
  {
    id: PRODUCTO_NC_ID,
    codigo: PRODUCTO_NC_CODIGO_E2E,
    nombre: PRODUCTO_NC_NOMBRE_E2E,
    precio: 100,
  },
  {
    id: PRODUCTO_REMITO_A_ID,
    codigo: PRODUCTO_REMITO_A_CODIGO_E2E,
    nombre: PRODUCTO_REMITO_A_NOMBRE_E2E,
    precio: 200,
  },
  {
    id: PRODUCTO_REMITO_B_ID,
    codigo: PRODUCTO_REMITO_B_CODIGO_E2E,
    nombre: PRODUCTO_REMITO_B_NOMBRE_E2E,
    precio: 300,
  },
] as const;

export type FixtureNotasRemitosE2E = {
  sucursalOrigenId: string;
  sucursalOrigenNombre: string;
  sucursalDestinoId: string;
  sucursalDestinoNombre: string;
};

export type RegistroFixtureE2E = {
  id: string;
  numero: string;
};

let postgresLocal: Sql | null = null;
let flagsFacturacionOriginales: {
  v2: boolean;
  legacy: boolean;
} | null = null;

function conexionPostgresLocal(): Sql {
  if (postgresLocal) return postgresLocal;

  const raizProyecto = fileURLToPath(new URL("../..", import.meta.url));
  let estadoLocal: string;
  try {
    estadoLocal = execFileSync("npx", ["supabase", "status", "-o", "env"], {
      cwd: raizProyecto,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("No se pudo leer el Supabase local para el fixture de notas y remitos.");
  }

  const dbUrl = /^DB_URL="([^"]+)"$/m.exec(estadoLocal)?.[1];
  if (!dbUrl) throw new Error("Supabase local no informó DB_URL para el fixture E2E.");

  const parsed = new URL(dbUrl);
  const config = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8");
  const seccionDb = /\[db\]([\s\S]*?)(?:\n\[|$)/.exec(config)?.[1] ?? "";
  const puertoEsperado = /^port\s*=\s*(\d+)\s*$/m.exec(seccionDb)?.[1] ?? "54322";
  if (
    !/^(127\.0\.0\.1|localhost)$/.test(parsed.hostname) ||
    parsed.port !== puertoEsperado ||
    parsed.pathname !== "/postgres" ||
    parsed.username !== "postgres"
  ) {
    throw new Error("El fixture de notas y remitos se negó a usar PostgreSQL fuera de local.");
  }

  postgresLocal = postgres(dbUrl, { max: 1, prepare: false });
  return postgresLocal;
}

async function cerrarPostgresLocal(): Promise<void> {
  const sql = postgresLocal;
  postgresLocal = null;
  if (sql) await sql.end({ timeout: 5 });
}

async function habilitarFacturacionV2ParaFixture(sql: Sql): Promise<void> {
  if (flagsFacturacionOriginales) {
    throw new Error("El fixture de notas ya había capturado los flags fiscales.");
  }
  const flags = await sql<{ v2: boolean; legacy: boolean }[]>`
    SELECT facturacion_receptor_v2_enabled AS v2,
           facturacion_legacy_writer_enabled AS legacy
      FROM public.settings
     WHERE id=true
  `;
  flagsFacturacionOriginales = exigirUno(flags, "El fixture necesita settings fiscales");
  await sql`
    UPDATE public.settings
       SET facturacion_receptor_v2_enabled=true,
           facturacion_legacy_writer_enabled=false
     WHERE id=true
  `;
}

async function restaurarFlagsFacturacion(sql: Sql): Promise<void> {
  const flags = flagsFacturacionOriginales;
  if (!flags) return;
  await sql`
    UPDATE public.settings
       SET facturacion_receptor_v2_enabled=${flags.v2},
           facturacion_legacy_writer_enabled=${flags.legacy}
     WHERE id=true
  `;
  flagsFacturacionOriginales = null;
}

function exigirUno<T>(filas: T[], contexto: string): T {
  if (filas.length !== 1) {
    throw new Error(
      `${contexto}: se esperaba exactamente un registro y aparecieron ${filas.length}.`,
    );
  }
  return filas[0];
}

async function exigirPropiedadBase(sql: Sql): Promise<void> {
  const clientes = await sql<{ id: string; razon_social: string; cuit_dni: string | null }[]>`
    SELECT id::text, razon_social, cuit_dni
      FROM public.clientes
     WHERE id=${CLIENTE_ID}::uuid
  `;
  if (
    clientes.some(
      (cliente) =>
        cliente.razon_social !== CLIENTE_NOTAS_E2E ||
        cliente.cuit_dni !== CLIENTE_DOCUMENTO_NOTAS_E2E,
    )
  ) {
    throw new Error("El UUID reservado del cliente T14 pertenece a otro registro.");
  }

  for (const producto of PRODUCTOS) {
    const filas = await sql<{ codigo: string; nombre: string }[]>`
      SELECT codigo, nombre
        FROM public.productos
       WHERE id=${producto.id}::uuid
    `;
    if (filas.some((fila) => fila.codigo !== producto.codigo || fila.nombre !== producto.nombre)) {
      throw new Error(
        `El UUID reservado del producto ${producto.codigo} pertenece a otro registro.`,
      );
    }
  }
}

async function limpiarFixture(input: { preservarBase: boolean }): Promise<void> {
  const sql = conexionPostgresLocal();
  await sql.begin(async (tx) => {
    await exigirPropiedadBase(tx);

    const ventasAjenas = await tx<{ id: string; numero: string }[]>`
      SELECT DISTINCT v.id::text, v.numero_comprobante AS numero
        FROM public.ventas AS v
        LEFT JOIN public.venta_items AS vi ON vi.venta_id=v.id
       WHERE (
              v.cliente_id=${CLIENTE_ID}::uuid
              OR v.observaciones=${MARCA_VENTA_NC_E2E}
              OR vi.producto_id=${PRODUCTO_NC_ID}::uuid
             )
         AND NOT (
           v.cliente_id=${CLIENTE_ID}::uuid
           AND v.observaciones=${MARCA_VENTA_NC_E2E}
           AND v.tipo_comprobante='NOTA_CREDITO'
           AND EXISTS (
             SELECT 1
               FROM public.venta_items AS propia
              WHERE propia.venta_id=v.id
                AND propia.producto_id=${PRODUCTO_NC_ID}::uuid
           )
           AND NOT EXISTS (
             SELECT 1
               FROM public.venta_items AS ajena
              WHERE ajena.venta_id=v.id
                AND ajena.producto_id IS DISTINCT FROM ${PRODUCTO_NC_ID}::uuid
           )
         )
    `;
    if (ventasAjenas.length > 0) {
      throw new Error(
        `El fixture se negó a borrar ${ventasAjenas.length} venta(s) que no son íntegramente propias.`,
      );
    }

    const remitosAjenos = await tx<{ id: string; numero: string }[]>`
      SELECT DISTINCT r.id::text, r.numero
        FROM public.remitos AS r
        LEFT JOIN public.remito_items AS ri ON ri.remito_id=r.id
       WHERE (
              r.observaciones LIKE 'T14-E2E-NOTAS-REMITO-%'
              OR ri.producto_id IN (
                ${PRODUCTO_REMITO_A_ID}::uuid,
                ${PRODUCTO_REMITO_B_ID}::uuid
              )
             )
         AND NOT (
           r.observaciones LIKE 'T14-E2E-NOTAS-REMITO-%'
           AND EXISTS (SELECT 1 FROM public.remito_items AS propia WHERE propia.remito_id=r.id)
           AND NOT EXISTS (
             SELECT 1
               FROM public.remito_items AS ajena
              WHERE ajena.remito_id=r.id
                AND ajena.producto_id NOT IN (
                  ${PRODUCTO_REMITO_A_ID}::uuid,
                  ${PRODUCTO_REMITO_B_ID}::uuid
                )
           )
         )
    `;
    if (remitosAjenos.length > 0) {
      throw new Error(
        `El fixture se negó a borrar ${remitosAjenos.length} remito(s) que no son íntegramente propios.`,
      );
    }

    await tx`
      CREATE TEMP TABLE _t14_notas_ventas ON COMMIT DROP AS
      SELECT id, numero_comprobante
        FROM public.ventas
       WHERE cliente_id=${CLIENTE_ID}::uuid
         AND observaciones=${MARCA_VENTA_NC_E2E}
    `;
    await tx`
      CREATE TEMP TABLE _t14_notas_remitos ON COMMIT DROP AS
      SELECT id, numero
        FROM public.remitos
       WHERE observaciones LIKE 'T14-E2E-NOTAS-REMITO-%'
    `;

    await tx`
      DELETE FROM public.caja_movimientos AS cm
       WHERE EXISTS (
         SELECT 1
           FROM _t14_notas_ventas AS v
          WHERE pg_catalog.strpos(cm.descripcion,v.numero_comprobante)>0
       )
    `;
    await tx`
      DELETE FROM public.cuenta_corriente_movimientos
       WHERE cliente_id=${CLIENTE_ID}::uuid
          OR venta_id IN (SELECT id FROM _t14_notas_ventas)
    `;
    await tx`
      DELETE FROM public.cobranzas_cta_cte
       WHERE cliente_id=${CLIENTE_ID}::uuid
    `;
    await tx`
      DELETE FROM public.emision_fiscal_intentos
       WHERE venta_id IN (SELECT id FROM _t14_notas_ventas)
    `;
    await tx`
      DELETE FROM public.venta_pagos
       WHERE venta_id IN (SELECT id FROM _t14_notas_ventas)
    `;
    await tx`
      DELETE FROM public.stock_movimientos
       WHERE producto_id IN (
         ${PRODUCTO_NC_ID}::uuid,
         ${PRODUCTO_REMITO_A_ID}::uuid,
         ${PRODUCTO_REMITO_B_ID}::uuid
       )
          OR referencia_id IN (SELECT id FROM _t14_notas_ventas)
          OR referencia_id IN (SELECT id FROM _t14_notas_remitos)
    `;
    await tx`
      DELETE FROM public.venta_items
       WHERE venta_id IN (SELECT id FROM _t14_notas_ventas)
    `;
    await tx`
      DELETE FROM public.ventas
       WHERE id IN (SELECT id FROM _t14_notas_ventas)
    `;
    await tx`
      DELETE FROM public.remito_items
       WHERE remito_id IN (SELECT id FROM _t14_notas_remitos)
    `;
    await tx`
      DELETE FROM public.remitos
       WHERE id IN (SELECT id FROM _t14_notas_remitos)
    `;

    await tx`
      DELETE FROM public.stock_sucursal
       WHERE producto_id IN (
         ${PRODUCTO_NC_ID}::uuid,
         ${PRODUCTO_REMITO_A_ID}::uuid,
         ${PRODUCTO_REMITO_B_ID}::uuid
       )
    `;
    if (input.preservarBase) {
      await tx`
        INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
        SELECT p.id,s.id,${STOCK_BASE}
          FROM public.productos AS p
          CROSS JOIN public.sucursales AS s
         WHERE p.id IN (
           ${PRODUCTO_NC_ID}::uuid,
           ${PRODUCTO_REMITO_A_ID}::uuid,
           ${PRODUCTO_REMITO_B_ID}::uuid
         )
           AND s.activa
        ON CONFLICT (producto_id,sucursal_id)
        DO UPDATE SET cantidad=EXCLUDED.cantidad
      `;
    } else {
      await tx`
        DELETE FROM public.receptores_fiscales
         WHERE cliente_comercial_id=${CLIENTE_ID}::uuid
      `;
      await tx`
        DELETE FROM public.productos
         WHERE id IN (
           ${PRODUCTO_NC_ID}::uuid,
           ${PRODUCTO_REMITO_A_ID}::uuid,
           ${PRODUCTO_REMITO_B_ID}::uuid
         )
      `;
      await tx`
        DELETE FROM public.clientes
         WHERE id=${CLIENTE_ID}::uuid
      `;
    }

    const [residuos] = await tx<
      {
        ventas: number;
        venta_items: number;
        venta_pagos: number;
        deuda: number;
        cobranzas: number;
        stock_movimientos: number;
        remitos: number;
        remito_items: number;
        caja_movimientos: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::integer
           FROM public.ventas
          WHERE cliente_id=${CLIENTE_ID}::uuid
             OR observaciones=${MARCA_VENTA_NC_E2E}) AS ventas,
        (SELECT count(*)::integer
           FROM public.venta_items
          WHERE producto_id=${PRODUCTO_NC_ID}::uuid) AS venta_items,
        (SELECT count(*)::integer
           FROM public.venta_pagos
          WHERE venta_id IN (SELECT id FROM _t14_notas_ventas)) AS venta_pagos,
        (SELECT count(*)::integer
           FROM public.cuenta_corriente_movimientos
          WHERE cliente_id=${CLIENTE_ID}::uuid) AS deuda,
        (SELECT count(*)::integer
           FROM public.cobranzas_cta_cte
          WHERE cliente_id=${CLIENTE_ID}::uuid) AS cobranzas,
        (SELECT count(*)::integer
           FROM public.stock_movimientos
          WHERE producto_id IN (
            ${PRODUCTO_NC_ID}::uuid,
            ${PRODUCTO_REMITO_A_ID}::uuid,
            ${PRODUCTO_REMITO_B_ID}::uuid
          )) AS stock_movimientos,
        (SELECT count(*)::integer
           FROM public.remitos
          WHERE observaciones LIKE 'T14-E2E-NOTAS-REMITO-%') AS remitos,
        (SELECT count(*)::integer
           FROM public.remito_items
          WHERE producto_id IN (
            ${PRODUCTO_REMITO_A_ID}::uuid,
            ${PRODUCTO_REMITO_B_ID}::uuid
          )) AS remito_items,
        (SELECT count(*)::integer
           FROM public.caja_movimientos AS cm
          WHERE EXISTS (
            SELECT 1
              FROM _t14_notas_ventas AS v
             WHERE pg_catalog.strpos(cm.descripcion,v.numero_comprobante)>0
          )) AS caja_movimientos
    `;
    const pendientes = Object.entries(residuos).filter(([, cantidad]) => cantidad !== 0);
    if (pendientes.length > 0) {
      throw new Error(
        `El cleanup de notas/remitos dejó residuos: ${pendientes
          .map(([tabla, cantidad]) => `${tabla}=${cantidad}`)
          .join(", ")}.`,
      );
    }
  });
}

export async function prepararFixtureNotasRemitosE2E(): Promise<FixtureNotasRemitosE2E> {
  await limpiarFixture({ preservarBase: false });
  const sql = conexionPostgresLocal();
  try {
    await habilitarFacturacionV2ParaFixture(sql);
    return await sql.begin(async (tx) => {
      const usuarios = await tx<{ id: string; sucursal_id: string; sucursal_nombre: string }[]>`
        SELECT u.id::text,
               p.sucursal_id::text,
               s.nombre AS sucursal_nombre
          FROM auth.users AS u
          JOIN public.profiles AS p ON p.id=u.id
          JOIN public.sucursales AS s ON s.id=p.sucursal_id
         WHERE u.email='admin@local.test'
           AND p.activo
           AND s.activa
           AND EXISTS (
             SELECT 1
               FROM public.user_roles AS ur
              WHERE ur.user_id=u.id
                AND ur.role='admin'
           )
      `;
      const usuario = exigirUno(usuarios, "El fixture necesita el admin local activo");
      const destinos = await tx<{ id: string; nombre: string }[]>`
        SELECT id::text, nombre
          FROM public.sucursales
         WHERE activa
           AND id<>${usuario.sucursal_id}::uuid
         ORDER BY numero,id
         LIMIT 1
      `;
      const destino = exigirUno(destinos, "El fixture necesita otra sucursal activa");

      const colisiones = await tx<{ codigo: string; id: string }[]>`
        SELECT codigo, id::text
          FROM public.productos
         WHERE codigo IN (
           ${PRODUCTO_NC_CODIGO_E2E},
           ${PRODUCTO_REMITO_A_CODIGO_E2E},
           ${PRODUCTO_REMITO_B_CODIGO_E2E}
         )
      `;
      if (colisiones.length > 0) {
        throw new Error("Los códigos reservados T14 ya pertenecen a productos ajenos.");
      }

      await tx`
        INSERT INTO public.clientes(
          id,razon_social,cuit_dni,tipo,sucursal_habitual_id,
          limite_credito,condicion_cta_cte,activo
        ) VALUES (
          ${CLIENTE_ID}::uuid,
          ${CLIENTE_NOTAS_E2E},
          ${CLIENTE_DOCUMENTO_NOTAS_E2E},
          'CONSUMIDOR_FINAL',
          ${usuario.sucursal_id}::uuid,
          1000000,
          true,
          true
        )
      `;
      for (const producto of PRODUCTOS) {
        await tx`
          INSERT INTO public.productos(
            id,codigo,nombre,unidad_medida,precio_sin_iva,iva_porcentaje,
            stock_minimo,activo,archivado,precio_fabrica,precio_lista
          ) VALUES (
            ${producto.id}::uuid,
            ${producto.codigo},
            ${producto.nombre},
            'unidad',
            ${producto.precio},
            21,
            0,
            true,
            false,
            ${producto.precio},
            ${producto.precio}
          )
        `;
      }
      await tx`
        INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
        SELECT p.id,s.id,${STOCK_BASE}
          FROM public.productos AS p
          CROSS JOIN public.sucursales AS s
         WHERE p.id IN (
           ${PRODUCTO_NC_ID}::uuid,
           ${PRODUCTO_REMITO_A_ID}::uuid,
           ${PRODUCTO_REMITO_B_ID}::uuid
         )
           AND s.activa
      `;

      return {
        sucursalOrigenId: usuario.sucursal_id,
        sucursalOrigenNombre: usuario.sucursal_nombre,
        sucursalDestinoId: destino.id,
        sucursalDestinoNombre: destino.nombre,
      };
    });
  } catch (error) {
    try {
      try {
        await limpiarFixture({ preservarBase: false });
      } finally {
        await restaurarFlagsFacturacion(sql);
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Fallaron la preparación y el cleanup del fixture de notas/remitos.",
      );
    }
    throw error;
  }
}

export async function limpiarEfectosNotasRemitosE2E(): Promise<void> {
  await limpiarFixture({ preservarBase: true });
}

export async function limpiarFixtureNotasRemitosE2E(): Promise<void> {
  const sql = conexionPostgresLocal();
  try {
    await limpiarFixture({ preservarBase: false });
  } finally {
    try {
      await restaurarFlagsFacturacion(sql);
    } finally {
      await cerrarPostgresLocal();
    }
  }
}

export async function leerVentaNotaCreditoE2E(): Promise<RegistroFixtureE2E> {
  const filas = await conexionPostgresLocal()<RegistroFixtureE2E[]>`
    SELECT v.id::text, v.numero_comprobante AS numero
      FROM public.ventas AS v
     WHERE v.cliente_id=${CLIENTE_ID}::uuid
       AND v.observaciones=${MARCA_VENTA_NC_E2E}
       AND v.tipo_comprobante='NOTA_CREDITO'
       AND v.afip_cbte_asoc_id IS NULL
       AND v.afip_estado='NO_APLICA'
       AND v.cae IS NULL
       AND v.afip_numero IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.emision_fiscal_intentos AS e
          WHERE e.venta_id=v.id
       )
       AND EXISTS (
         SELECT 1
           FROM public.venta_items AS vi
          WHERE vi.venta_id=v.id
            AND vi.producto_id=${PRODUCTO_NC_ID}::uuid
       )
  `;
  return exigirUno(filas, "La UI debía crear una única nota de crédito T14");
}

export async function leerRemitoE2E(marca: string): Promise<RegistroFixtureE2E> {
  if (![MARCA_REMITO_VER_E2E, MARCA_REMITO_EDITAR_E2E].includes(marca)) {
    throw new Error("La marca solicitada no pertenece al fixture de remitos T14.");
  }
  const filas = await conexionPostgresLocal()<RegistroFixtureE2E[]>`
    SELECT id::text, numero
      FROM public.remitos
     WHERE observaciones=${marca}
  `;
  return exigirUno(filas, `La UI debía crear un único remito con marca ${marca}`);
}
