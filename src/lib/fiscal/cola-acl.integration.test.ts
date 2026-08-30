/* eslint-disable @typescript-eslint/no-explicit-any -- cliente PostgreSQL dinámico acotado a integración local */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearSnapshotFiscalV2, type SnapshotFiscalV2Input } from "./snapshot";
import { crearSnapshotFiscalV3Fixture } from "./snapshot-v3.test-fixture";

const RUN = process.env.RUN_COLA_FISCAL_ACL_INTEGRATION === "true";
const suite = RUN ? describe : describe.skip;

suite("ACL de cola fiscal v2/v3 contra PostgreSQL local", () => {
  const ids = {
    autorizado: "a7100000-0000-4000-8000-000000000001",
    sinCapacidad: "a7100000-0000-4000-8000-000000000002",
    sinSucursal: "a7100000-0000-4000-8000-000000000003",
    cliente: "b7100000-0000-4000-8000-000000000001",
    ventaV2: "c7100000-0000-4000-8000-000000000001",
    ventaV3: "c7100000-0000-4000-8000-000000000002",
  };
  let sql: any;
  let sucursalId = "";

  async function comoUsuario(userId: string) {
    return sql.begin(async (tx: any) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: userId, role: "authenticated" })},true)`;
      return tx`
        select * from public.cola_fiscal_lectura(
          'emitidas',1,20,null::date,null::date,null::uuid,null::uuid,
          null::text,null::text,null::uuid
        )
      `;
    });
  }

  async function cleanup() {
    if (!sql) return;
    await sql`delete from public.ventas where id in (${ids.ventaV2},${ids.ventaV3})`;
    await sql`delete from public.clientes where id=${ids.cliente}`;
    await sql`delete from auth.users where id in (${ids.autorizado},${ids.sinCapacidad},${ids.sinSucursal})`;
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL ?? process.env.DB_URL;
    if (!databaseUrl) throw new Error("La integración ACL de cola exige DB_URL local.");
    const parsed = new URL(databaseUrl);
    if (!/^(127\.0\.0\.1|localhost)$/.test(parsed.hostname)) {
      throw new Error("La integración ACL de cola sólo admite PostgreSQL local.");
    }
    const postgresModule = await import("postgres");
    sql = postgresModule.default(databaseUrl, { max: 2 });
    await cleanup();

    const [contexto] = await sql`
      select s.id as sucursal_id,e.id as emisor_id,e.cuit,pv.numero as punto_venta
        from public.sucursales s
        join public.emisores e on e.id=s.emisor_id
        join public.puntos_venta pv on pv.sucursal_id=s.id and pv.activo
       where s.activa
       order by s.numero,pv.numero
       limit 1
    `;
    if (!contexto) throw new Error("La integración ACL exige una sucursal fiscal activa.");
    sucursalId = contexto.sucursal_id;

    await sql`
      insert into auth.users(
        id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
      ) values
        (${ids.autorizado},'00000000-0000-0000-0000-000000000000','authenticated','authenticated','acl-autorizado@test.local','x',now(),now(),now()),
        (${ids.sinCapacidad},'00000000-0000-0000-0000-000000000000','authenticated','authenticated','acl-sin-capacidad@test.local','x',now(),now(),now()),
        (${ids.sinSucursal},'00000000-0000-0000-0000-000000000000','authenticated','authenticated','acl-sin-sucursal@test.local','x',now(),now(),now())
    `;
    await sql.begin(async (tx: any) => {
      await tx`set local session_replication_role='replica'`;
      await tx`
        update public.profiles
           set activo=true,
               sucursal_id=case when id=${ids.sinSucursal} then null else ${sucursalId}::uuid end,
               puede_facturar=(id in (${ids.autorizado},${ids.sinSucursal}))
         where id in (${ids.autorizado},${ids.sinCapacidad},${ids.sinSucursal})
      `;
    });
    await sql`
      insert into public.profile_sucursales(profile_id,sucursal_id)
      values (${ids.autorizado},${sucursalId}),(${ids.sinCapacidad},${sucursalId})
      on conflict do nothing
    `;
    await sql`
      insert into public.clientes(id,razon_social,cuit_dni,tipo)
      values (${ids.cliente},'CLIENTE ACL V2 V3','30123456','CONSUMIDOR_FINAL')
    `;

    const receptor = {
      razonSocial: "CLIENTE ACL V2 V3",
      domicilio: "Domicilio ACL",
      tipoDocumento: "DNI" as const,
      numeroDocumento: "30123456",
      docTipoArca: 96 as const,
      docNroArca: "30123456",
      condicionIva: "CONSUMIDOR_FINAL" as const,
      origen: "MANUAL" as const,
      origenId: null,
      verificadoArcaAt: null,
      condicionIvaReceptorId: 5 as const,
    };
    const item = {
      id: "d7100000-0000-4000-8000-000000000001",
      productoId: null,
      codigo: "ACL",
      descripcion: "Item ACL",
      cantidad: "1.00",
      precioUnitarioSinIva: "100.00",
      descuentoPorcentaje: "0.00",
      ivaPorcentaje: "21.00",
      subtotalNeto: "100.00",
      importeIva: "21.00",
      subtotalTotal: "121.00",
    };
    const snapshotV2 = crearSnapshotFiscalV2({
      venta: {
        id: ids.ventaV2,
        numeroComercial: "ACL-V2",
        tipoComprobante: "VENTA",
        condicionVenta: "CONTADO",
        fechaComercial: "2026-08-29T12:00:00.000Z",
      },
      items: [item],
      emisor: {
        id: contexto.emisor_id,
        razonSocial: "EMISOR ACL",
        nombreFantasia: null,
        cuit: contexto.cuit,
        domicilioFiscal: "Domicilio emisor",
        condicionIva: "RESPONSABLE_INSCRIPTO",
        ingresosBrutos: null,
        inicioActividades: "2020-01-01",
        telefono: null,
      },
      sucursal: {
        id: sucursalId,
        nombre: "SUCURSAL ACL",
        direccion: "Domicilio sucursal",
        telefono: null,
      },
      receptor,
      identidad: {
        numero: 971001,
        emisorCuit: contexto.cuit,
        puntoVenta: contexto.punto_venta,
        cbteTipo: 6,
        modo: "PRODUCCION",
        simulado: false,
        validez: "PRODUCCION",
      },
      letra: "B",
      concepto: 1,
      fechaComprobante: "2026-08-29",
      importeNeto: "100.00",
      importeExento: "0.00",
      importeNoGravado: "0.00",
      importeIva: "21.00",
      importeTributos: "0.00",
      importeTotal: "121.00",
      alicuotasIva: [{ id: 5, baseImponible: "100.00", importe: "21.00" }],
      tributos: [],
      moneda: "PES",
      cotizacion: "1.000000",
      ivaContenido: "21.00",
      otrosImpuestosNacionalesIndirectos: "0.00",
      origen: "VENTA",
      comprobanteOriginalId: null,
      cbtesAsoc: [],
    } satisfies SnapshotFiscalV2Input);
    const snapshotV3 = crearSnapshotFiscalV3Fixture({
      letra: "B",
      ventaId: ids.ventaV3,
      emisorId: contexto.emisor_id,
      emisorCuit: contexto.cuit,
      sucursalId,
      numero: 971002,
      puntoVenta: contexto.punto_venta,
    });

    await sql.begin(async (tx: any) => {
      await tx`set local session_replication_role='replica'`;
      await tx`
        insert into public.ventas(
          id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,
          subtotal_sin_iva,iva_total,total,total_pagado,afip_estado,afip_fase,afip_version,
          afip_numero,afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_modo,afip_simulado,
          afip_validez,afip_fecha_comprobante,afip_imp_total,afip_snapshot_hash,afip_snapshot,
          cae,cae_vencimiento
        ) values (
          ${ids.ventaV2},${sucursalId},${ids.cliente},${ids.autorizado},'ACL-V2','VENTA',now(),
          100,21,121,121,'APROBADO','PERSISTIDO',2,971001,${contexto.cuit},${contexto.punto_venta},
          6,'PRODUCCION',false,'PRODUCCION','2026-08-29',121,${snapshotV2.hash},${sql.json(snapshotV2)},
          '74123456789011','2026-09-08'
        )
      `;
      await tx`
        insert into public.ventas(
          id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,
          condicion_venta,subtotal_sin_iva,iva_total,total,total_pagado,estado,estado_pago,
          afip_estado,afip_fase,afip_version,afip_numero,afip_emisor_cuit,afip_punto_venta,
          afip_cbte_tipo,afip_modo,afip_simulado,afip_validez,afip_fecha_comprobante,
          afip_imp_total,afip_snapshot_hash,afip_snapshot,cae,cae_vencimiento,
          periodo_asoc_desde,periodo_asoc_hasta,nc_periodo_modalidad,motivo_nota_credito,
          nc_resolucion,nc_periodo_payload_hash
        ) values (
          ${ids.ventaV3},${sucursalId},${ids.cliente},${ids.autorizado},'ACL-V3','NOTA_CREDITO',now(),
          'CONTADO',-1150,-210,-1360,0,'ACTIVA','PENDIENTE','APROBADO','PERSISTIDO',2,
          971002,${contexto.cuit},${contexto.punto_venta},8,'PRODUCCION',false,'PRODUCCION','2026-08-22',
          1360,${snapshotV3.hash},${sql.json(snapshotV3)},'74123456789012','2026-09-08',
          '2026-08-01','2026-08-15','DEVOLUCION_PRODUCTOS','Devolución de productos del período',
          'REINTEGRO',${"b".repeat(64)}
        )
      `;
    });
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("permite leer filas v2/v3 a un usuario autorizado sin exponer reintegros", async () => {
    const [respuesta] = await comoUsuario(ids.autorizado);
    const filas = respuesta.filas.filter((fila: any) =>
      [ids.ventaV2, ids.ventaV3].includes(fila.venta_id),
    );
    expect(filas.map((fila: any) => fila.venta_id).sort()).toEqual(
      [ids.ventaV2, ids.ventaV3].sort(),
    );
    expect(filas.every((fila: any) => !("reintegrosIntencion" in fila))).toBe(true);
    const recorrer = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(recorrer);
      if (!value || typeof value !== "object") return [];
      return Object.entries(value).flatMap(([key, child]) => [key, ...recorrer(child)]);
    };
    const claves = recorrer(respuesta);
    expect(
      claves.filter((clave) =>
        /snapshot|hash|claim|idempotency|payload|raw|secret|service_role/i.test(clave),
      ),
    ).toEqual([]);
    expect(filas.every((fila: any) => "reclamo_vencido" in fila)).toBe(true);
  });

  it("mantiene bloqueados a usuarios sin capacidad o sucursal", async () => {
    await expect(comoUsuario(ids.sinCapacidad)).rejects.toMatchObject({ code: "42501" });
    await expect(comoUsuario(ids.sinSucursal)).rejects.toMatchObject({ code: "42501" });
  });
});
