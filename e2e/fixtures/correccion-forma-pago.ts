import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

if (typeof window !== "undefined") {
  throw new Error("El fixture de corrección de pagos no puede cargarse en browser.");
}

const VENTA_ID = "e4020000-0000-4000-8000-000000000001";
const PAGO_ID = "f4020000-0000-4000-8000-000000000001";
export const NUMERO_VENTA_CORRECCION_PAGO_E2E = "E2E-CORR-FP-1";
export const MOTIVO_CORRECCION_PAGO_E2E = "Se informó efectivo en vez de transferencia";

let postgresLocal: Sql | null = null;

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
    throw new Error("No se pudo leer el Supabase local para el fixture de pagos.");
  }

  const dbUrl = /^DB_URL="([^"]+)"$/m.exec(estadoLocal)?.[1];
  if (!dbUrl) throw new Error("Supabase local no informó DB_URL para el fixture de pagos.");

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
    throw new Error("El fixture de pagos se negó a usar PostgreSQL fuera de local.");
  }

  postgresLocal = postgres(dbUrl, { max: 1, prepare: false });
  return postgresLocal;
}

async function limpiar(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    const ventas = await tx<{ numero: string }[]>`
      SELECT numero_comprobante AS numero
        FROM public.ventas
       WHERE id=${VENTA_ID}::uuid
    `;
    if (ventas.some((venta) => venta.numero !== NUMERO_VENTA_CORRECCION_PAGO_E2E)) {
      throw new Error("El UUID reservado de la venta de corrección pertenece a otro registro.");
    }
    const pagos = await tx<{ venta_id: string }[]>`
      SELECT venta_id::text
        FROM public.venta_pagos
       WHERE id=${PAGO_ID}::uuid
    `;
    if (pagos.some((pago) => pago.venta_id !== VENTA_ID)) {
      throw new Error("El UUID reservado del pago de corrección pertenece a otro registro.");
    }

    // La auditoría es inmutable por trigger en producción. El único borrado es
    // el teardown controlado de este fixture local y usa UUIDs reservados.
    await tx.unsafe("SET LOCAL session_replication_role=replica");
    await tx`
      DELETE FROM public.venta_pago_correcciones
       WHERE venta_pago_id=${PAGO_ID}::uuid
          OR venta_id=${VENTA_ID}::uuid
    `;
    await tx`DELETE FROM public.venta_pagos WHERE id=${PAGO_ID}::uuid`;
    await tx`DELETE FROM public.ventas WHERE id=${VENTA_ID}::uuid`;
    await tx.unsafe("SET LOCAL session_replication_role=origin");
  });
}

export async function prepararCorreccionFormaPagoE2E(): Promise<void> {
  const sql = conexionPostgresLocal();
  await limpiar(sql);
  try {
    await sql.begin(async (tx) => {
      const actores = await tx<{ usuario_id: string; sucursal_id: string; cliente_id: string }[]>`
        SELECT u.id::text AS usuario_id,
               p.sucursal_id::text,
               (SELECT c.id::text FROM public.clientes AS c ORDER BY c.created_at,c.id LIMIT 1) AS cliente_id
          FROM auth.users AS u
          JOIN public.profiles AS p ON p.id=u.id
         WHERE u.email='admin@local.test'
           AND p.activo
           AND EXISTS (
             SELECT 1 FROM public.user_roles AS ur
              WHERE ur.user_id=u.id AND ur.role='admin'
           )
      `;
      if (actores.length !== 1 || !actores[0].cliente_id) {
        throw new Error("El fixture de pagos necesita el admin y un cliente locales.");
      }
      const actor = actores[0];

      await tx.unsafe("SET LOCAL session_replication_role=replica");
      await tx`
        INSERT INTO public.ventas(
          id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
          condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
          estado_pago,estado,observaciones,afip_estado
        ) VALUES (
          ${VENTA_ID}::uuid,${actor.sucursal_id}::uuid,${actor.cliente_id}::uuid,
          ${actor.usuario_id}::uuid,${NUMERO_VENTA_CORRECCION_PAGO_E2E},'VENTA',
          'CONTADO',100,21,0,121,121,'PAGADO','ACTIVA',
          'Fixture E2E corrección de forma de pago','NO_APLICA'
        )
      `;
      await tx.unsafe("SET LOCAL session_replication_role=origin");
      await tx`
        INSERT INTO public.venta_pagos(id,venta_id,forma_pago,monto,detalle)
        VALUES (
          ${PAGO_ID}::uuid,${VENTA_ID}::uuid,'EFECTIVO',121,
          '{"referencia":"dato del medio anterior"}'::jsonb
        )
      `;
    });
  } catch (error) {
    try {
      await limpiar(sql);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Fallaron la preparación y el cleanup del fixture de corrección de pagos.",
      );
    }
    throw error;
  }
}

export async function verificarCorreccionFormaPagoE2E(): Promise<void> {
  const sql = conexionPostgresLocal();
  const filas = await sql<
    {
      forma_pago: string;
      monto: number;
      correccion_version: number;
      detalle: Record<string, unknown>;
      correcciones: number;
    }[]
  >`
    SELECT vp.forma_pago::text,
           vp.monto::float8 AS monto,
           vp.correccion_version,
           vp.detalle,
           (SELECT count(*)::integer
              FROM public.venta_pago_correcciones AS c
             WHERE c.venta_pago_id=vp.id
               AND c.forma_pago_anterior='EFECTIVO'
               AND c.forma_pago_nueva='TRANSFERENCIA'
               AND c.monto=121
               AND c.motivo=${MOTIVO_CORRECCION_PAGO_E2E}) AS correcciones
      FROM public.venta_pagos AS vp
     WHERE vp.id=${PAGO_ID}::uuid
  `;
  if (
    filas.length !== 1 ||
    filas[0].forma_pago !== "TRANSFERENCIA" ||
    filas[0].monto !== 121 ||
    filas[0].correccion_version !== 1 ||
    Object.keys(filas[0].detalle).length !== 0 ||
    filas[0].correcciones !== 1
  ) {
    throw new Error("La UI no dejó una única corrección auditada sin alterar el importe.");
  }
}

export async function limpiarCorreccionFormaPagoE2E(): Promise<void> {
  const sql = conexionPostgresLocal();
  try {
    await limpiar(sql);
  } finally {
    postgresLocal = null;
    await sql.end({ timeout: 5 });
  }
}
