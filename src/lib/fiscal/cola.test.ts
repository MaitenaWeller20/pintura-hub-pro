/* eslint-disable @typescript-eslint/no-explicit-any -- los dobles aíslan únicamente el borde Supabase */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  colaFiscalQuerySchema,
  crearServicioColaFiscal,
  type ColaFiscalRpcArgs,
} from "./cola.functions";
import { leerFlagsFacturacion } from "./feature.server";
import { crearSnapshotFiscalV2 } from "./snapshot";

const UUID = {
  user: "11000000-0000-4000-8000-000000000001",
  branchA: "11000000-0000-4000-8000-000000000002",
  branchB: "11000000-0000-4000-8000-000000000003",
  emitter: "11000000-0000-4000-8000-000000000004",
  sale: "11000000-0000-4000-8000-000000000005",
  client: "11000000-0000-4000-8000-000000000006",
  favorite: "11000000-0000-4000-8000-000000000007",
} as const;

const safeRow = {
  venta_id: UUID.sale,
  tipo_comprobante: "VENTA",
  numero_comprobante: "V-00001",
  fecha_comercial: "2026-08-20T15:00:00+00:00",
  fecha_fiscal: null,
  cliente_id: UUID.client,
  cliente_razon_social: "Comprador",
  documento_comercial: "20123456789",
  receptor_razon_social: "Receptor",
  receptor_tipo_documento: "CUIT",
  receptor_numero_documento: "30714199664",
  receptor_condicion_iva: "RESPONSABLE_INSCRIPTO",
  emisor_id: UUID.emitter,
  emisor_razon_social: "Emisor",
  emisor_cuit: "30714199664",
  sucursal_id: UUID.branchA,
  sucursal_nombre: "General Paz",
  total: "1210.00",
  total_pagado: "1000.00",
  saldo: "210.00",
  afip_estado: "SIN_FACTURAR",
  afip_fase: null,
  afip_legacy_incompleto: false,
  claim_vencido: false,
  venta_antigua: false,
  afip_validez: null,
  afip_punto_venta: null,
  afip_cbte_tipo: null,
  afip_numero: null,
  cae: null,
  cae_vencimiento: null,
  tab: "pendientes",
};

function rpcPage(filas: unknown[] = [safeRow]) {
  return [
    {
      filas,
      pagina: 1,
      tamano_pagina: 20,
      total: filas.length,
      paginas: filas.length ? 1 : 0,
      conteo_pendientes: filas.length,
      conteo_revisar: 0,
      conteo_emitidas: 0,
      conteo_historial: 0,
      filtros_disponibles: {
        sucursales: [{ id: UUID.branchA, nombre: "General Paz" }],
        emisores: [{ id: UUID.emitter, razon_social: "Emisor", cuit: "30714199664" }],
      },
    },
  ];
}

const FLAGS_V2 = [
  {
    id: true,
    facturacion_receptor_v2_enabled: true,
    facturacion_legacy_writer_enabled: false,
  },
];

describe("rollout autoritativo de la cola fiscal", () => {
  const flagsInvalidos = [
    ["fila ausente", []],
    [
      "tipo inválido",
      [
        {
          id: true,
          facturacion_receptor_v2_enabled: "true",
          facturacion_legacy_writer_enabled: false,
        },
      ],
    ],
    [
      "ambos escritores activos",
      [
        {
          id: true,
          facturacion_receptor_v2_enabled: true,
          facturacion_legacy_writer_enabled: true,
        },
      ],
    ],
    [
      "sólo legacy",
      [
        {
          id: true,
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: true,
        },
      ],
    ],
    [
      "mantenimiento",
      [
        {
          id: true,
          facturacion_receptor_v2_enabled: false,
          facturacion_legacy_writer_enabled: false,
        },
      ],
    ],
  ] as const;

  const operaciones = [
    {
      nombre: "listar cola",
      ejecutar: (servicio: ReturnType<typeof crearServicioColaFiscal>) =>
        servicio.listarColaFiscal(UUID.user, { tab: "pendientes", page: 1, pageSize: 20 }),
    },
    {
      nombre: "listar favoritos",
      ejecutar: (servicio: ReturnType<typeof crearServicioColaFiscal>) =>
        servicio.listarReceptoresFiscales(UUID.user, {}),
    },
    {
      nombre: "guardar favorito",
      ejecutar: (servicio: ReturnType<typeof crearServicioColaFiscal>) =>
        servicio.guardarReceptorFiscal(UUID.user, { venta_id: UUID.sale }),
    },
    {
      nombre: "desactivar favorito",
      ejecutar: (servicio: ReturnType<typeof crearServicioColaFiscal>) =>
        servicio.desactivarReceptorFiscal(UUID.user, { receptor_id: UUID.favorite }),
    },
  ] as const;

  const casosRollout = operaciones.flatMap((operacion) =>
    flagsInvalidos.map(([configuracion, rawFlags]) => ({ operacion, configuracion, rawFlags })),
  );

  it.each(casosRollout)(
    "$operacion.nombre rechaza $configuracion antes de consultar o mutar datos",
    async ({ operacion, rawFlags }) => {
      const autorizar = vi.fn(async () => ({
        userId: UUID.user,
        esAdmin: true,
        sucursalId: null,
      }));
      const consultarCola = vi.fn(async () => rpcPage());
      const listarFavoritos = vi.fn(async () => []);
      const guardarFavoritoDesdeVenta = vi.fn(async () => safeRow);
      const desactivarFavorito = vi.fn(async () => undefined);
      const servicio = crearServicioColaFiscal({
        cargarFlags: () => leerFlagsFacturacion(async () => rawFlags),
        autorizar,
        consultarCola,
        listarFavoritos,
        guardarFavoritoDesdeVenta,
        desactivarFavorito,
      } as never);

      await expect(operacion.ejecutar(servicio)).rejects.toThrow();
      expect(autorizar).not.toHaveBeenCalled();
      expect(consultarCola).not.toHaveBeenCalled();
      expect(listarFavoritos).not.toHaveBeenCalled();
      expect(guardarFavoritoDesdeVenta).not.toHaveBeenCalled();
      expect(desactivarFavorito).not.toHaveBeenCalled();
    },
  );

  it("permite operar únicamente con v2 activo y legacy apagado", async () => {
    const consultarCola = vi.fn(async () => rpcPage());
    const servicio = crearServicioColaFiscal({
      cargarFlags: () => leerFlagsFacturacion(async () => FLAGS_V2),
      autorizar: async () => ({ userId: UUID.user, esAdmin: true, sucursalId: null }),
      consultarCola,
      listarFavoritos: async () => [],
      guardarFavoritoDesdeVenta: async () => safeRow,
      desactivarFavorito: async () => undefined,
    } as never);

    await servicio.listarColaFiscal(UUID.user, { tab: "pendientes", page: 1, pageSize: 20 });
    expect(consultarCola).toHaveBeenCalledOnce();
  });
});

describe("contrato de consulta de la cola fiscal", () => {
  it.each([
    [{ tab: "pendientes", page: 1, pageSize: 101 }, /100/],
    [{ tab: "desconocida", page: 1, pageSize: 20 }, /tab/i],
    [{ tab: "pendientes", page: 0, pageSize: 20 }, /mayor/i],
    [{ tab: "pendientes", page: 1, pageSize: 20, desde: "2026-02-30" }, /fecha/i],
    [{ tab: "pendientes", page: 1, pageSize: 20, estado: "INVENTADO" }, /estado/i],
  ])("rechaza parámetros fuera del contrato", (entrada, mensaje) => {
    expect(() => colaFiscalQuerySchema.parse(entrada)).toThrow(mensaje);
  });

  it("fuerza la sucursal activa del empleado y delega página/conteos a una sola RPC", async () => {
    const recibidos: ColaFiscalRpcArgs[] = [];
    const servicio = crearServicioColaFiscal({
      cargarFlags: () => leerFlagsFacturacion(async () => FLAGS_V2),
      autorizar: async () => ({ userId: UUID.user, esAdmin: false, sucursalId: UUID.branchA }),
      consultarCola: async (args) => {
        recibidos.push(args);
        return rpcPage();
      },
      listarFavoritos: async () => [],
      guardarFavoritoDesdeVenta: async () => {
        throw new Error("no usado");
      },
      desactivarFavorito: async () => undefined,
    });

    const pagina = await servicio.listarColaFiscal(UUID.user, {
      tab: "pendientes",
      page: 1,
      pageSize: 20,
      sucursal_id: UUID.branchB,
    });

    expect(recibidos).toEqual([
      expect.objectContaining({
        p_tab: "pendientes",
        p_page: 1,
        p_page_size: 20,
        p_sucursal_id: UUID.branchA,
      }),
    ]);
    expect(pagina).toEqual({
      filas: [safeRow],
      page: 1,
      pageSize: 20,
      total: 1,
      paginas: 1,
      conteos: { pendientes: 1, revisar: 0, emitidas: 0, historial: 0 },
      filtrosDisponibles: {
        sucursales: [{ id: UUID.branchA, nombre: "General Paz" }],
        emisores: [{ id: UUID.emitter, razon_social: "Emisor", cuit: "30714199664" }],
      },
    });
  });

  it("permite al admin filtrar cualquier sucursal y conserva búsqueda exacta antigua", async () => {
    let recibidos: ColaFiscalRpcArgs | null = null;
    const servicio = crearServicioColaFiscal({
      cargarFlags: () => leerFlagsFacturacion(async () => FLAGS_V2),
      autorizar: async () => ({ userId: UUID.user, esAdmin: true, sucursalId: null }),
      consultarCola: async (args) => {
        recibidos = args;
        return rpcPage([{ ...safeRow, tab: "revisar", afip_estado: "ERROR" }]);
      },
      listarFavoritos: async () => [],
      guardarFavoritoDesdeVenta: async () => {
        throw new Error("no usado");
      },
      desactivarFavorito: async () => undefined,
    });

    const result = await servicio.listarColaFiscal(UUID.user, {
      tab: "pendientes",
      page: 7,
      pageSize: 20,
      desde: "2026-08-01",
      hasta: "2026-08-22",
      sucursal_id: UUID.branchB,
      emisor_id: UUID.emitter,
      documento: "30-71419966-4",
      estado: "ERROR",
      venta_id: UUID.sale,
    });

    expect(recibidos).toEqual(
      expect.objectContaining({
        p_sucursal_id: UUID.branchB,
        p_page: 1,
        p_emisor_id: UUID.emitter,
        p_documento: "30714199664",
        p_estado: "ERROR",
        p_venta_id: UUID.sale,
      }),
    );
    expect(result.filas[0]).toMatchObject({ venta_id: UUID.sale, tab: "revisar" });
    expect(result.page).toBe(1);
  });

  it("rechaza cualquier campo secreto agregado por error a la proyección RPC", async () => {
    const servicio = crearServicioColaFiscal({
      cargarFlags: () => leerFlagsFacturacion(async () => FLAGS_V2),
      autorizar: async () => ({ userId: UUID.user, esAdmin: true, sucursalId: null }),
      consultarCola: async () => rpcPage([{ ...safeRow, afip_snapshot_hash: "no-debe-salir" }]),
      listarFavoritos: async () => [],
      guardarFavoritoDesdeVenta: async () => {
        throw new Error("no usado");
      },
      desactivarFavorito: async () => undefined,
    });

    await expect(
      servicio.listarColaFiscal(UUID.user, { tab: "pendientes", page: 1, pageSize: 20 }),
    ).rejects.toThrow(/proyecci.n segura/i);
  });

  it("rechaza evidencia administrativa agregada a las opciones seguras de filtros", async () => {
    const respuesta = rpcPage();
    respuesta[0].filtros_disponibles.emisores[0] = {
      ...respuesta[0].filtros_disponibles.emisores[0],
      factura_a_evidencia: "secreto",
    } as any;
    const servicio = crearServicioColaFiscal({
      cargarFlags: () => leerFlagsFacturacion(async () => FLAGS_V2),
      autorizar: async () => ({ userId: UUID.user, esAdmin: true, sucursalId: null }),
      consultarCola: async () => respuesta,
      listarFavoritos: async () => [],
      guardarFavoritoDesdeVenta: async () => {
        throw new Error("no usado");
      },
      desactivarFavorito: async () => undefined,
    });

    await expect(
      servicio.listarColaFiscal(UUID.user, { tab: "pendientes", page: 1, pageSize: 20 }),
    ).rejects.toThrow(/proyecci.n segura/i);
  });
});

describe("favoritos fiscales user-bound", () => {
  it("lista sólo la proyección reutilizable activa en una consulta", async () => {
    const servicio = crearServicioColaFiscal({
      cargarFlags: () => leerFlagsFacturacion(async () => FLAGS_V2),
      autorizar: async () => ({ userId: UUID.user, esAdmin: false, sucursalId: UUID.branchA }),
      consultarCola: async () => rpcPage(),
      listarFavoritos: async ({ sucursalId }) => [
        {
          id: UUID.favorite,
          sucursal_id: sucursalId!,
          cliente_comercial_id: UUID.client,
          tipo_documento: "DNI",
          numero_documento: "12345678",
          razon_social: "Persona",
          condicion_iva: "CONSUMIDOR_FINAL",
          domicilio: null,
        },
      ],
      guardarFavoritoDesdeVenta: async () => {
        throw new Error("no usado");
      },
      desactivarFavorito: async () => undefined,
    });

    await expect(servicio.listarReceptoresFiscales(UUID.user, {})).resolves.toEqual([
      {
        id: UUID.favorite,
        sucursal_id: UUID.branchA,
        cliente_comercial_id: UUID.client,
        tipo_documento: "DNI",
        numero_documento: "12345678",
        razon_social: "Persona",
        condicion_iva: "CONSUMIDOR_FINAL",
        domicilio: null,
      },
    ]);
  });

  it("guarda por una única RPC autoritativa y sólo envía el UUID de la venta", async () => {
    const ventas: string[] = [];
    const servicio = crearServicioColaFiscal({
      cargarFlags: () => leerFlagsFacturacion(async () => FLAGS_V2),
      autorizar: async () => ({ userId: UUID.user, esAdmin: false, sucursalId: UUID.branchA }),
      consultarCola: async () => rpcPage(),
      listarFavoritos: async () => [],
      guardarFavoritoDesdeVenta: async (ventaId: string) => {
        ventas.push(ventaId);
        return {
          id: UUID.favorite,
          sucursal_id: UUID.branchA,
          cliente_comercial_id: UUID.client,
          tipo_documento: "DNI",
          numero_documento: "12345678",
          razon_social: "Persona",
          condicion_iva: "CONSUMIDOR_FINAL",
          domicilio: null,
        };
      },
      desactivarFavorito: async () => undefined,
    });

    await expect(
      servicio.guardarReceptorFiscal(UUID.user, { venta_id: UUID.sale }),
    ).resolves.toMatchObject({ id: UUID.favorite, numero_documento: "12345678" });
    expect(ventas).toEqual([UUID.sale]);
  });

  it("desactiva por UUID estricto y deja la idempotencia a la RPC autorizada", async () => {
    const desactivados: string[] = [];
    const servicio = crearServicioColaFiscal({
      cargarFlags: () => leerFlagsFacturacion(async () => FLAGS_V2),
      autorizar: async () => ({ userId: UUID.user, esAdmin: false, sucursalId: UUID.branchA }),
      consultarCola: async () => rpcPage(),
      listarFavoritos: async () => [],
      guardarFavoritoDesdeVenta: async () => {
        throw new Error("no usado");
      },
      desactivarFavorito: async (id) => {
        desactivados.push(id);
      },
    });

    await expect(
      servicio.desactivarReceptorFiscal(UUID.user, { receptor_id: "no-es-uuid" }),
    ).rejects.toThrow();
    await servicio.desactivarReceptorFiscal(UUID.user, { receptor_id: UUID.favorite });
    await servicio.desactivarReceptorFiscal(UUID.user, { receptor_id: UUID.favorite });
    expect(desactivados).toEqual([UUID.favorite, UUID.favorite]);
  });
});

const RUN_INTEGRATION = process.env.RUN_COLA_FISCAL_INTEGRATION === "true";
const integrationSuite = RUN_INTEGRATION ? describe : describe.skip;

integrationSuite("cola fiscal contra PostgreSQL local", () => {
  const ids = {
    admin: "a1110000-0000-4000-8000-000000000001",
    employee: "a1110000-0000-4000-8000-000000000002",
    client: "b1110000-0000-4000-8000-000000000001",
    receiverClient: "b1110000-0000-4000-8000-000000000002",
    oldSale: "c1110000-0000-4000-8000-000000000001",
    receiverSale: "c1110000-0000-4000-8000-000000000002",
    preCaeSale: "c1110000-0000-4000-8000-000000000003",
    legacyApprovedSale: "c1110000-0000-4000-8000-000000000004",
  };
  let sql: any;
  let branchA = "";
  let branchB = "";
  let emitterA = "";
  let emitterB = "";

  async function cleanup() {
    if (!sql) return;
    await sql`delete from public.ventas where numero_comprobante like 'T11-COLA-%'`;
    await sql`delete from public.receptores_fiscales where creado_por in (${ids.admin},${ids.employee})`;
    await sql`delete from public.clientes where id in (${ids.client},${ids.receiverClient})`;
    await sql`delete from auth.users where id in (${ids.admin},${ids.employee})`;
  }

  async function comoUsuario(userId: string, query: (tx: any) => Promise<any>) {
    return sql.begin(async (tx: any) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: userId, role: "authenticated" })},true)`;
      return query(tx);
    });
  }

  async function consultar(
    userId: string,
    input: {
      tab?: string;
      page?: number;
      pageSize?: number;
      desde?: string | null;
      hasta?: string | null;
      sucursalId?: string | null;
      emisorId?: string | null;
      documento?: string | null;
      estado?: string | null;
      ventaId?: string | null;
    } = {},
  ) {
    const rows = await comoUsuario(userId, async function (this: unknown, tx: any) {
      return tx`
        select * from public.cola_fiscal_lectura(
          ${input.tab ?? "pendientes"},
          ${input.page ?? 1},
          ${input.pageSize ?? 50},
          ${input.desde ?? null}::date,
          ${input.hasta ?? null}::date,
          ${input.sucursalId ?? null}::uuid,
          ${input.emisorId ?? null}::uuid,
          ${input.documento ?? null},
          ${input.estado ?? null},
          ${input.ventaId ?? null}::uuid
        )
      `;
    });
    return rows[0];
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL ?? process.env.DB_URL;
    if (!databaseUrl) throw new Error("La integración de cola exige DB_URL local.");
    const parsed = new URL(databaseUrl);
    if (!/^(127\.0\.0\.1|localhost)$/.test(parsed.hostname)) {
      throw new Error("La integración de cola sólo admite PostgreSQL local.");
    }
    const postgresModule = await import("postgres");
    sql = postgresModule.default(databaseUrl, { max: 3 });
    await cleanup();

    const branches = await sql`
      select s.id,s.emisor_id from public.sucursales s where s.activa order by s.numero limit 2
    `;
    if (branches.length !== 2) throw new Error("La integración exige dos sucursales activas.");
    branchA = branches[0].id;
    branchB = branches[1].id;
    emitterA = branches[0].emisor_id;
    emitterB = branches[1].emisor_id;

    const manualSnapshot = crearSnapshotFiscalV2({
      venta: {
        id: ids.receiverSale,
        numeroComercial: "T11-COLA-RECEPTOR",
        tipoComprobante: "VENTA",
        condicionVenta: "CONTADO",
        fechaComercial: "2026-08-23T12:00:00.000Z",
      },
      items: [
        {
          id: "d1110000-0000-4000-8000-000000000010",
          productoId: null,
          codigo: "T11",
          descripcion: "Item T11",
          cantidad: "1.00",
          precioUnitarioSinIva: "100.00",
          descuentoPorcentaje: "0.00",
          ivaPorcentaje: "21.00",
          subtotalNeto: "100.00",
          importeIva: "21.00",
          subtotalTotal: "121.00",
        },
      ],
      emisor: {
        id: emitterA,
        razonSocial: "EMISOR CONGELADO",
        nombreFantasia: null,
        cuit: "30717322467",
        domicilioFiscal: "Domicilio fiscal",
        condicionIva: "RESPONSABLE_INSCRIPTO",
        ingresosBrutos: null,
        inicioActividades: "2020-01-01",
        telefono: null,
      },
      sucursal: {
        id: branchA,
        nombre: "SUCURSAL CONGELADA",
        direccion: "Domicilio sucursal",
        telefono: null,
      },
      receptor: {
        razonSocial: "RECEPTOR MANUAL CONGELADO",
        domicilio: "Domicilio receptor",
        tipoDocumento: "CUIT",
        numeroDocumento: "30714199664",
        docTipoArca: 80,
        docNroArca: "30714199664",
        condicionIva: "RESPONSABLE_INSCRIPTO",
        origen: "MANUAL",
        origenId: null,
        verificadoArcaAt: null,
        condicionIvaReceptorId: 1,
      },
      identidad: {
        numero: 991004,
        emisorCuit: "30717322467",
        puntoVenta: 91,
        cbteTipo: 1,
        modo: "PRODUCCION",
        simulado: false,
        validez: "PRODUCCION",
      },
      letra: "A",
      concepto: 1,
      fechaComprobante: "2026-08-23",
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
      ivaContenido: "0.00",
      otrosImpuestosNacionalesIndirectos: "0.00",
      origen: "VENTA",
      comprobanteOriginalId: null,
      cbtesAsoc: [],
    });

    await sql`
      insert into auth.users (
        id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
      ) values
        (${ids.admin},'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t11-admin@test.local','x',now(),now(),now()),
        (${ids.employee},'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t11-employee@test.local','x',now(),now(),now())
    `;
    await sql`
      update public.profiles set activo=true,sucursal_id=${branchA}
       where id in (${ids.admin},${ids.employee})
    `;
    await sql`
      insert into public.profile_sucursales(profile_id,sucursal_id)
      values (${ids.admin},${branchA}),(${ids.admin},${branchB}),(${ids.employee},${branchA})
      on conflict do nothing
    `;
    await sql`
      insert into public.user_roles(user_id,role) values (${ids.admin},'admin')
    `;
    await comoUsuario(ids.admin, async (tx: any) => {
      await tx`select public.administrar_puede_facturar(${ids.employee},true)`;
    });
    await sql`
      insert into public.clientes(id,razon_social,cuit_dni,tipo) values
        (${ids.client},'T11 COMPRADOR','20-99999999-9','CONSUMIDOR_FINAL'),
        (${ids.receiverClient},'T11 OTRO COMPRADOR','11111111','CONSUMIDOR_FINAL')
    `;

    await sql`
      insert into public.ventas(
        sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,
        total,total_pagado,afip_estado,afip_version
      )
      select ${branchA},${ids.client},${ids.employee},
             'T11-COLA-A-'||lpad(g::text,3,'0'),'VENTA',
             statement_timestamp()-(g||' minutes')::interval,1210,1000,'SIN_FACTURAR',0
        from generate_series(1,205) g
    `;
    await sql`
      insert into public.ventas(
        sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,
        total,total_pagado,afip_estado,afip_version
      )
      select ${branchB},${ids.client},${ids.employee},
             'T11-COLA-B-'||lpad(g::text,3,'0'),'VENTA',
             statement_timestamp()-(g||' minutes')::interval,1210,1000,'SIN_FACTURAR',0
        from generate_series(1,3) g
    `;

    await sql`
      insert into public.ventas(
        id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,
        total,total_pagado,afip_estado,afip_version
      ) values (
        ${ids.oldSale},${branchA},${ids.client},${ids.employee},'T11-COLA-OLD','VENTA',
        '2020-01-01T12:00:00Z',100,0,'SIN_FACTURAR',0
      )
    `;
    await sql`
      insert into public.ventas(
        id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,
        total,total_pagado,afip_estado,afip_version,afip_legacy_incompleto,
        afip_numero,afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_modo,
        afip_simulado,afip_validez,cae
      ) values (
        ${ids.legacyApprovedSale},${branchA},${ids.client},${ids.employee},
        'T11-COLA-LEGACY-APROBADO','FACTURA_B',now(),100,100,'APROBADO',0,true,
        991005,'30714199664',91,6,'HOMOLOGACION',true,'SIMULADA','CAE-LEGACY-T11'
      )
    `;

    await sql`
      insert into public.ventas(
        sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,total,total_pagado,
        afip_estado,afip_fase,afip_claim_token,afip_claimed_at,afip_version
      ) values
        (${branchA},${ids.client},${ids.employee},'T11-COLA-EMITIENDO-VIGENTE','VENTA',now(),100,0,'EMITIENDO','PREFLIGHT','d1110000-0000-4000-8000-000000000001',now(),1),
        (${branchA},${ids.client},${ids.employee},'T11-COLA-EMITIENDO-VENCIDO','VENTA',now(),100,0,'EMITIENDO','PREFLIGHT','d1110000-0000-4000-8000-000000000002',now()-interval '301 seconds',1)
    `;

    const hashExpired = "e".repeat(64);
    const hashRecon = "b".repeat(64);
    const hashApproved = "a".repeat(64);
    await sql`
      insert into public.ventas(
        sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,total,total_pagado,
        afip_estado,afip_fase,afip_claim_token,afip_claimed_at,afip_version,
        afip_numero,afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_modo,afip_simulado,
        afip_validez,afip_fecha_comprobante,afip_imp_total,afip_snapshot_hash,afip_snapshot
      ) values (
        ${branchA},${ids.client},${ids.employee},'T11-COLA-VENCIDO-NUMERO','VENTA',now(),100,0,
        'EMITIENDO','REQUEST_INICIADO','d1110000-0000-4000-8000-000000000003',now()-interval '301 seconds',2,
        991001,'30714199664',91,6,'PRODUCCION',false,'PRODUCCION',current_date,100,${hashExpired},
        jsonb_build_object('version',2,'hash',${hashExpired}::text,'fechaComprobante',current_date::text,
          'identidad',jsonb_build_object('numero',991001,'emisorCuit','30714199664','puntoVenta',91,'cbteTipo',6,'modo','PRODUCCION','simulado',false))
      ),(
        ${branchA},${ids.client},${ids.employee},'T11-COLA-RECONCILIAR','VENTA',now(),100,0,
        'RECONCILIAR','REQUEST_INICIADO','d1110000-0000-4000-8000-000000000004',now()-interval '301 seconds',2,
        991002,'30714199664',91,6,'PRODUCCION',false,'PRODUCCION',current_date,100,${hashRecon},
        jsonb_build_object('version',2,'hash',${hashRecon}::text,'fechaComprobante',current_date::text,
          'identidad',jsonb_build_object('numero',991002,'emisorCuit','30714199664','puntoVenta',91,'cbteTipo',6,'modo','PRODUCCION','simulado',false))
      )
    `;
    await sql`
      insert into public.ventas(
        sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,total,total_pagado,
        afip_estado,afip_version
      ) values
        (${branchA},${ids.client},${ids.employee},'T11-COLA-CORREGIBLE','VENTA',now(),100,0,'ERROR_CORREGIBLE',0),
        (${branchA},${ids.client},${ids.employee},'T11-COLA-LEGACY-PENDIENTE','VENTA',now(),100,0,'PENDIENTE',0),
        (${branchA},${ids.client},${ids.employee},'T11-COLA-LEGACY-ERROR','VENTA',now(),100,0,'ERROR',0),
        (${branchA},${ids.client},${ids.employee},'T11-COLA-BLOQUEADO','VENTA',now(),100,0,'BLOQUEADO',0),
        (${branchA},${ids.client},${ids.employee},'T11-COLA-CANCELADO','VENTA',now(),100,0,'CANCELADO',0),
        (${branchB},${ids.client},${ids.employee},'T11-COLA-B-ERROR','VENTA',now(),100,0,'ERROR',0)
    `;
    await sql`
      insert into public.ventas(
        sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,total,total_pagado,
        afip_estado,afip_fase,afip_version,afip_numero,afip_emisor_cuit,afip_punto_venta,
        afip_cbte_tipo,afip_modo,afip_simulado,afip_validez,afip_fecha_comprobante,
        afip_imp_total,afip_snapshot_hash,afip_snapshot,cae,cae_vencimiento
      ) values (
        ${branchA},${ids.client},${ids.employee},'T11-COLA-APROBADO','VENTA',now(),100,100,
        'APROBADO','PERSISTIDO',2,991003,'30714199664',91,6,'PRODUCCION',false,'PRODUCCION',current_date,
        100,${hashApproved},jsonb_build_object('version',2,'hash',${hashApproved}::text,'fechaComprobante',current_date::text,
          'identidad',jsonb_build_object('numero',991003,'emisorCuit','30714199664','puntoVenta',91,'cbteTipo',6,'modo','PRODUCCION','simulado',false)),
        '74111111111111',current_date+10
      )
    `;
    await sql`
      insert into public.ventas(
        id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,total,total_pagado,
        afip_estado,afip_fase,afip_version,afip_numero,afip_emisor_cuit,afip_punto_venta,
        afip_cbte_tipo,afip_modo,afip_simulado,afip_validez,afip_fecha_comprobante,
        afip_imp_total,afip_snapshot_hash,afip_snapshot,cae,cae_vencimiento
      ) values (
        ${ids.receiverSale},${branchA},${ids.receiverClient},${ids.employee},'T11-COLA-RECEPTOR','VENTA','2026-08-23T12:00:00Z',121,121,
        'APROBADO','PERSISTIDO',2,991004,'30717322467',91,1,'PRODUCCION',false,'PRODUCCION','2026-08-23',
        121,${manualSnapshot.hash},${sql.json(manualSnapshot)},'74111111111112','2026-09-02'
      )
    `;
    await sql`
      insert into public.ventas(
        id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,fecha,
        total,total_pagado,afip_estado,afip_version
      ) values (
        ${ids.preCaeSale},${branchA},${ids.receiverClient},${ids.employee},
        'T11-COLA-PRE-CAE','VENTA',now(),121,0,'SIN_FACTURAR',0
      )
    `;
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("pagina más de 200 filas, mantiene orden y entrega conteos coherentes por tab", async () => {
    const page3 = await consultar(ids.employee, {
      tab: "pendientes",
      page: 3,
      pageSize: 50,
      desde: "2026-08-01",
      documento: "20-99999999-9",
    });
    expect(page3.filas).toHaveLength(50);
    expect(Number(page3.total)).toBe(206);
    expect(page3.paginas).toBe(5);
    expect(Number(page3.conteo_pendientes)).toBe(206);
    expect(Number(page3.conteo_revisar)).toBe(7);
    expect(Number(page3.conteo_emitidas)).toBe(2);
    expect(Number(page3.conteo_historial)).toBe(1);
    const pares = page3.filas.map((row: any) => `${row.fecha_comercial}|${row.venta_id}`);
    expect(pares).toEqual([...pares].sort().reverse());
  });

  it("fuerza employee a su sucursal y deja al admin filtrar la otra", async () => {
    const employee = await consultar(ids.employee, {
      tab: "pendientes",
      desde: "2026-08-01",
      sucursalId: branchB,
      documento: "20999999999",
    });
    expect(new Set(employee.filas.map((row: any) => row.sucursal_id))).toEqual(new Set([branchA]));
    expect(employee.filtros_disponibles).toEqual({
      sucursales: [expect.objectContaining({ id: branchA })],
      emisores: [expect.objectContaining({ id: emitterA })],
    });

    const admin = await consultar(ids.admin, {
      tab: "pendientes",
      desde: "2026-08-01",
      sucursalId: branchB,
      documento: "20999999999",
    });
    expect(Number(admin.total)).toBe(3);
    expect(new Set(admin.filas.map((row: any) => row.sucursal_id))).toEqual(new Set([branchB]));
    expect(admin.filtros_disponibles.sucursales.map((row: any) => row.id)).toEqual(
      expect.arrayContaining([branchA, branchB]),
    );
    expect(admin.filtros_disponibles.emisores.map((row: any) => row.id)).toEqual(
      expect.arrayContaining([emitterA, emitterB]),
    );
  });

  it("busca por documento comercial o receptor congelado y venta antigua exacta", async () => {
    const commercial = await consultar(ids.employee, {
      tab: "pendientes",
      pageSize: 5,
      documento: "20-99999999-9",
      desde: "2026-08-01",
    });
    expect(commercial.filas.every((row: any) => row.documento_comercial === "20999999999")).toBe(
      true,
    );

    const receiver = await consultar(ids.employee, {
      tab: "emitidas",
      documento: "30-71419966-4",
      desde: "2026-08-01",
    });
    expect(receiver.filas).toEqual([
      expect.objectContaining({
        venta_id: ids.receiverSale,
        tab: "emitidas",
        receptor_numero_documento: "30714199664",
      }),
    ]);

    const old = await consultar(ids.employee, {
      tab: "revisar",
      page: 99,
      desde: "2026-08-01",
      hasta: "2026-08-23",
      ventaId: ids.oldSale,
    });
    expect(old.filas).toEqual([
      expect.objectContaining({ venta_id: ids.oldSale, tab: "pendientes" }),
    ]);
    expect(old.pagina).toBe(1);
  });

  it("usa acceso por clave para venta exacta y sólo expande el tamaño de página solicitado", async () => {
    const explain = await sql.begin(async (tx: any) => {
      await tx`set local enable_seqscan=off`;
      return tx`
        explain (analyze,buffers,format json)
        select id
          from public.ventas
         where id=${ids.oldSale}
           and afip_estado in (
             'NO_APLICA','PENDIENTE','ERROR','SIN_FACTURAR','EMITIENDO','RECONCILIAR',
             'APROBADO','ERROR_CORREGIBLE','CANCELADO','BLOQUEADO'
           )
      `;
    });
    const payload = Object.values(explain[0])[0] as any;
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    const root = (Array.isArray(parsed) ? parsed[0] : parsed).Plan;
    const nodes: any[] = [];
    const visit = (node: any) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(root);
    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ "Index Name": "ventas_pkey", "Actual Rows": 1 }),
      ]),
    );

    const pagina = await consultar(ids.employee, {
      tab: "pendientes",
      page: 3,
      pageSize: 5,
      desde: "2026-08-01",
    });
    expect(pagina.filas).toHaveLength(5);
    expect(Number(pagina.total)).toBeGreaterThan(200);
  });

  it("cierra escritura directa y guarda idempotente sólo desde CAE con datos derivados", async () => {
    await expect(
      comoUsuario(
        ids.employee,
        (tx: any) => tx`
        insert into public.receptores_fiscales(
          sucursal_id,creado_por,tipo_documento,numero_documento,razon_social,condicion_iva
        ) values (${branchA},${ids.employee},'DNI','30111222','BYPASS','CONSUMIDOR_FINAL')
      `,
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      comoUsuario(
        ids.employee,
        (tx: any) => tx`
        update public.receptores_fiscales set razon_social='SPOOF'
      `,
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      comoUsuario(
        ids.employee,
        (tx: any) => tx`
        select * from public.guardar_receptor_fiscal_desde_venta(${ids.preCaeSale})
      `,
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const [primero, segundo] = await Promise.all([
      comoUsuario(
        ids.employee,
        (tx: any) => tx`
        select * from public.guardar_receptor_fiscal_desde_venta(${ids.receiverSale})
      `,
      ),
      comoUsuario(
        ids.employee,
        (tx: any) => tx`
        select * from public.guardar_receptor_fiscal_desde_venta(${ids.receiverSale})
      `,
      ),
    ]);
    expect(segundo).toEqual(primero);
    expect(primero).toEqual([
      expect.objectContaining({
        sucursal_id: branchA,
        cliente_comercial_id: ids.receiverClient,
        tipo_documento: "CUIT",
        numero_documento: "30714199664",
        razon_social: "RECEPTOR MANUAL CONGELADO",
        condicion_iva: "RESPONSABLE_INSCRIPTO",
        domicilio: "Domicilio receptor",
      }),
    ]);
    const [persistido] = await sql`
      select creado_por,count(*) over ()::integer as cantidad
        from public.receptores_fiscales
       where sucursal_id=${branchA} and tipo_documento='CUIT'
         and numero_documento='30714199664' and activo
         and creado_por=${ids.employee}
    `;
    expect(persistido).toMatchObject({ creado_por: ids.employee, cantidad: 1 });
  });

  it("proyecta la única marca legacy segura y mantiene APROBADO incompleto descargable", async () => {
    const legacy = await consultar(ids.employee, {
      tab: "pendientes",
      page: 88,
      ventaId: ids.legacyApprovedSale,
    });
    expect(legacy.pagina).toBe(1);
    expect(legacy.filas).toEqual([
      expect.objectContaining({
        venta_id: ids.legacyApprovedSale,
        afip_estado: "APROBADO",
        afip_fase: null,
        afip_legacy_incompleto: true,
        tab: "emitidas",
      }),
    ]);
  });

  it("revalida perfil, asignación y sucursal activa antes de desactivar", async () => {
    const [favorito] = await comoUsuario(
      ids.employee,
      (tx: any) => tx`
      select * from public.guardar_receptor_fiscal_desde_venta(${ids.receiverSale})
    `,
    );

    try {
      await sql`update public.profiles set activo=false where id=${ids.employee}`;
      await expect(
        comoUsuario(
          ids.employee,
          (tx: any) => tx`
          select public.desactivar_receptor_fiscal(${favorito.id})
        `,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await sql`update public.profiles set activo=true where id=${ids.employee}`;
    }

    try {
      await sql`update public.profiles set sucursal_id=null where id=${ids.employee}`;
      await sql`
        delete from public.profile_sucursales
         where profile_id=${ids.employee} and sucursal_id=${branchA}
      `;
      await expect(
        comoUsuario(
          ids.employee,
          (tx: any) => tx`
          select public.desactivar_receptor_fiscal(${favorito.id})
        `,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await sql`
        insert into public.profile_sucursales(profile_id,sucursal_id)
        values (${ids.employee},${branchA}) on conflict do nothing
      `;
      await sql`update public.profiles set sucursal_id=${branchA} where id=${ids.employee}`;
    }

    try {
      await sql`update public.sucursales set activa=false where id=${branchA}`;
      await expect(
        comoUsuario(
          ids.employee,
          (tx: any) => tx`
          select public.desactivar_receptor_fiscal(${favorito.id})
        `,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await sql`update public.sucursales set activa=true where id=${branchA}`;
    }

    await comoUsuario(
      ids.employee,
      (tx: any) => tx`
      select public.desactivar_receptor_fiscal(${favorito.id})
    `,
    );
    await comoUsuario(
      ids.employee,
      (tx: any) => tx`
      select public.desactivar_receptor_fiscal(${favorito.id})
    `,
    );
    const [fila] = await sql`
      select activo from public.receptores_fiscales where id=${favorito.id}
    `;
    expect(fila.activo).toBe(false);
  });

  it("expone sólo la proyección segura y clasifica estados legacy sin volverlos emitibles", async () => {
    const review = await consultar(ids.employee, {
      tab: "revisar",
      desde: "2026-08-01",
      documento: "20999999999",
    });
    expect(new Set(review.filas.map((row: any) => row.afip_estado))).toEqual(
      new Set(["EMITIENDO", "RECONCILIAR", "ERROR_CORREGIBLE", "PENDIENTE", "ERROR", "BLOQUEADO"]),
    );
    const serialized = JSON.stringify(review);
    for (const secreto of [
      "afip_snapshot",
      "afip_snapshot_hash",
      "afip_claim_token",
      "afip_error",
      "afip_intentos",
      "arca_cert_enc",
      "arca_key_enc",
      "factura_a_evidencia",
    ]) {
      expect(serialized).not.toContain(secreto);
    }
  });
});
