/* eslint-disable @typescript-eslint/no-explicit-any -- dobles dinámicos y clientes locales deliberadamente acotados al test */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.RUN_FISCAL_INTEGRATION === "true";
const suite = RUN ? describe : describe.skip;

suite("motor fiscal contra Supabase local", () => {
  const ids = {
    user: "a9000000-0000-4000-8000-000000000001",
    client: "b9000000-0000-4000-8000-000000000001",
    sales: [1, 2, 3, 4, 5, 6, 7].map(
      (n) => `c9000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    ),
    items: [1, 2, 3, 4, 5, 6, 7].map(
      (n) => `d9000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    ),
  };
  let sql: any;
  let supabase: any;
  let sucursalId = "";
  let ejecutarEmisionFiscal: any;
  let ejecutarConciliacionFiscal: any;
  let crearSnapshotFiscalV2: any;
  let crearHuellaConfirmacionFiscal: any;
  let restoreFetch: typeof fetch;

  async function cleanup() {
    if (!sql) return;
    await sql`delete from public.emision_fiscal_intentos where venta_id = any(${ids.sales}::uuid[])`;
    await sql`delete from public.venta_items where venta_id = any(${ids.sales}::uuid[])`;
    await sql`delete from public.ventas where id = any(${ids.sales}::uuid[])`;
    await sql`delete from public.clientes where id = ${ids.client}`;
    await sql`delete from auth.users where id = ${ids.user}`;
  }

  beforeAll(async () => {
    const apiUrl = process.env.SUPABASE_URL ?? process.env.API_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY;
    const databaseUrl = process.env.DATABASE_URL ?? process.env.DB_URL;
    if (!apiUrl || !serviceKey || !databaseUrl) {
      throw new Error(
        "La integración fiscal exige SUPABASE_URL/API_URL, SERVICE_ROLE_KEY y DB_URL locales.",
      );
    }
    const origin = new URL(apiUrl).origin;
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
      throw new Error(`La integración fiscal sólo admite Supabase local; recibió ${origin}.`);
    }
    const database = new URL(databaseUrl);
    if (!/^(127\.0\.0\.1|localhost)$/.test(database.hostname)) {
      throw new Error("La base de integración fiscal debe ser local.");
    }

    restoreFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url,
      );
      if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin) {
        throw new Error(`RED EXTERNA BLOQUEADA EN TEST FISCAL: ${url.origin}`);
      }
      return restoreFetch(input, init);
    }) as typeof fetch;

    const [{ createClient }, postgresModule, engine, snapshot, confirmacion, websocket] =
      await Promise.all([
        import("@supabase/supabase-js"),
        import("postgres"),
        import("./emision"),
        import("./snapshot"),
        import("./confirmacion"),
        import("@/lib/ws-polyfill"),
      ]);
    websocket.ensureNodeWebSocket();
    supabase = createClient(apiUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    sql = postgresModule.default(databaseUrl, { max: 1 });
    ejecutarEmisionFiscal = engine.ejecutarEmisionFiscal;
    ejecutarConciliacionFiscal = engine.ejecutarConciliacionFiscal;
    crearSnapshotFiscalV2 = snapshot.crearSnapshotFiscalV2;
    crearHuellaConfirmacionFiscal = confirmacion.crearHuellaConfirmacionFiscal;

    await cleanup();
    const [sucursal] = await sql`select id from public.sucursales order by numero limit 1`;
    sucursalId = sucursal.id;
    await sql`
      insert into auth.users (
        id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
      ) values (
        ${ids.user},'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
        'task9-integration@test.local','x',now(),now(),now()
      )
    `;
    await sql`
      insert into public.clientes (id,razon_social,tipo,activo)
      values (${ids.client},'TASK 9 INTEGRATION','CONSUMIDOR_FINAL',true)
    `;
    for (let index = 0; index < ids.sales.length; index += 1) {
      await sql`
        insert into public.ventas (
          id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
          condicion_venta,fecha,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
          estado_pago,afip_estado,afip_version
        ) values (
          ${ids.sales[index]},${sucursalId},${ids.client},${ids.user},
          ${`T9-INTEGRATION-${index + 1}`},'VENTA','CONTADO','2026-08-22T15:00:00.000Z',
          1000,210,0,1210,0,'PENDIENTE','SIN_FACTURAR',0
        )
      `;
      await sql`
        insert into public.venta_items (
          id,venta_id,producto_id,codigo,descripcion,cantidad,precio_unitario_sin_iva,
          descuento_porcentaje,iva_porcentaje,subtotal_sin_iva,iva_monto,subtotal_con_iva
        ) values (
          ${ids.items[index]},${ids.sales[index]},null,'T9','Item T9',1,1000,0,21,1000,210,1210
        )
      `;
    }
  }, 30_000);

  afterAll(async () => {
    try {
      await cleanup();
      await sql?.end({ timeout: 5 });
    } finally {
      if (restoreFetch) globalThis.fetch = restoreFetch;
    }
  });

  function snapshot(
    ventaId: string,
    itemId: string,
    numero: number,
    puntoVenta: number,
    letraSolicitada: "A" | "B",
  ) {
    const facturaA = letraSolicitada === "A";
    return crearSnapshotFiscalV2({
      venta: {
        id: ventaId,
        numeroComercial: `T9-${numero}`,
        tipoComprobante: "VENTA",
        condicionVenta: "CONTADO",
        fechaComercial: "2026-08-22T15:00:00.000Z",
      },
      items: [
        {
          id: itemId,
          productoId: null,
          codigo: "T9",
          descripcion: "Item T9",
          cantidad: "1.00",
          precioUnitarioSinIva: "1000.00",
          descuentoPorcentaje: "0.00",
          ivaPorcentaje: "21.00",
          subtotalNeto: "1000.00",
          importeIva: "210.00",
          subtotalTotal: "1210.00",
        },
      ],
      emisor: {
        id: "e9000000-0000-4000-8000-000000000001",
        razonSocial: "EMISOR TASK 9",
        nombreFantasia: null,
        cuit: "30717322467",
        domicilioFiscal: "Domicilio 1",
        condicionIva: "RESPONSABLE_INSCRIPTO",
        ingresosBrutos: null,
        inicioActividades: "2020-01-01",
        telefono: null,
      },
      sucursal: { id: sucursalId, nombre: "Sucursal", direccion: "Domicilio", telefono: null },
      receptor: facturaA
        ? {
            razonSocial: "RECEPTOR TASK 9",
            domicilio: null,
            tipoDocumento: "CUIT",
            numeroDocumento: "30714199664",
            docTipoArca: 80,
            docNroArca: "30714199664",
            condicionIva: "RESPONSABLE_INSCRIPTO",
            origen: "MANUAL",
            origenId: null,
            verificadoArcaAt: null,
            condicionIvaReceptorId: 1,
          }
        : {
            razonSocial: "Consumidor Final",
            domicilio: null,
            tipoDocumento: "SIN_IDENTIFICAR",
            numeroDocumento: null,
            docTipoArca: 99,
            docNroArca: "0",
            condicionIva: "CONSUMIDOR_FINAL",
            origen: "CLIENTE_COMERCIAL",
            origenId: null,
            verificadoArcaAt: null,
            condicionIvaReceptorId: 5,
          },
      identidad: {
        numero,
        emisorCuit: "30717322467",
        puntoVenta,
        cbteTipo: facturaA ? 1 : 6,
        modo: "HOMOLOGACION",
        simulado: true,
        validez: "SIMULADA",
      },
      letra: letraSolicitada,
      concepto: 1,
      fechaComprobante: "2026-08-22",
      importeNeto: "1000.00",
      importeExento: "0.00",
      importeNoGravado: "0.00",
      importeIva: "210.00",
      importeTributos: "0.00",
      importeTotal: "1210.00",
      alicuotasIva: [{ id: 5, baseImponible: "1000.00", importe: "210.00" }],
      tributos: [],
      moneda: "PES",
      cotizacion: "1.000000",
      ivaContenido: facturaA ? "0.00" : "210.00",
      otrosImpuestosNacionalesIndirectos: "0.00",
      origen: "VENTA",
      comprobanteOriginalId: null,
      cbtesAsoc: [],
    });
  }

  function deps(
    ventaId: string,
    itemId: string,
    puntoVenta: number,
    outcomes: Array<"OK" | "TIMEOUT">,
    letraSolicitada: "A" | "B",
  ) {
    let arcaCalls = 0;
    const transitionActions: string[] = [];
    const facturaA = letraSolicitada === "A";
    const confirmacionAutoritativa = {
      version: 1 as const,
      importe: "1210.00",
      emisorCuit: "30717322467",
      puntoVenta,
      modo: "HOMOLOGACION" as const,
      letra: letraSolicitada,
      cbteTipo: facturaA ? 1 : 6,
      fechaFiscal: "2026-08-22",
      receptor: facturaA
        ? {
            razonSocial: "RECEPTOR",
            domicilio: null,
            tipoDocumento: "CUIT" as const,
            numeroDocumento: "30714199664",
            docTipoArca: 80 as const,
            docNroArca: "30714199664",
            condicionIva: "RESPONSABLE_INSCRIPTO" as const,
            origen: "MANUAL" as const,
            origenId: null,
            verificadoArcaAt: null,
          }
        : {
            razonSocial: "Consumidor Final",
            domicilio: null,
            tipoDocumento: "SIN_IDENTIFICAR" as const,
            numeroDocumento: null,
            docTipoArca: 99 as const,
            docNroArca: "0",
            condicionIva: "CONSUMIDOR_FINAL" as const,
            origen: "CLIENTE_COMERCIAL" as const,
            origenId: null,
            verificadoArcaAt: null,
          },
    };
    const huellaConfirmacion = crearHuellaConfirmacionFiscal(confirmacionAutoritativa);
    const transition = async ({ ventaId: id, accion, claimToken, payload }: any) => {
      transitionActions.push(accion);
      const { data, error } = await supabase.rpc("transicionar_emision_fiscal", {
        p_venta_id: id,
        p_accion: accion,
        p_claim_token: claimToken,
        p_payload: payload,
      });
      if (error) {
        const failure: any = new Error(error.message);
        failure.code = error.code;
        throw failure;
      }
      return data[0];
    };
    const dependencies: any = {
      generarClaimToken: () => crypto.randomUUID(),
      ahoraIso: () => "2026-08-22T16:00:00.000Z",
      autorizarEmision: async () => ({ tipoComprobante: "VENTA", afipVersion: 0 }),
      autorizarConciliacion: async () => undefined,
      prepararEmision: async (input: { letraSolicitada: "A" | "B" }) => {
        if (input.letraSolicitada !== letraSolicitada) {
          throw new Error("El motor no propagó la letra solicitada al preflight.");
        }
        return {
          ventaId,
          tipoComprobante: "VENTA",
          emisorCuit: "30717322467",
          puntoVenta,
          cbteTipo: facturaA ? 1 : 6,
          modo: "HOMOLOGACION",
          simulado: true,
          validez: "SIMULADA",
          fechaComprobante: "2026-08-22",
          confirmacionAutoritativa,
          huellaConfirmacion,
        };
      },
      consultarSecuencia: async () => ({
        ultimoRemoto: 0,
        ultimaFechaRemota: null,
        ultimoLocal: 0,
      }),
      validarFechaFiscal: () => undefined,
      crearSnapshot: async ({ numero }: any) =>
        snapshot(ventaId, itemId, numero, puntoVenta, letraSolicitada),
      transicionar: transition,
      async cargarEstadoPersistido() {
        const { data, error } = await supabase.rpc("leer_venta_fiscal_exacta", {
          p_venta_id: ventaId,
        });
        if (error) throw error;
        const row = data.venta;
        return {
          venta_id: row.id,
          afip_estado: row.afipEstado,
          afip_fase: row.afipFase,
          afip_claim_token: row.afipClaimToken,
          afip_numero: row.afipNumero,
          afip_version: row.afipVersion,
        };
      },
      async cargarReservaPersistida() {
        const { data, error } = await supabase.rpc("leer_venta_fiscal_exacta", {
          p_venta_id: ventaId,
        });
        if (error) throw error;
        const row = data.venta;
        return {
          ventaId,
          claimToken: row.afipClaimToken,
          afipVersion: row.afipVersion,
          numero: row.afipNumero,
          snapshot: row.afipSnapshot,
          payloadHash: row.afipSnapshotHash,
          emisorCuit: row.afipEmisorCuit,
          puntoVenta: row.afipPuntoVenta,
          cbteTipo: row.afipCbteTipo,
          modo: row.afipModo,
        };
      },
      crearPayloadCae: (frozen: any) => ({ hash: frozen.hash, numero: frozen.identidad.numero }),
      async solicitarCae() {
        arcaCalls += 1;
        const outcome = outcomes.shift();
        if (outcome === "TIMEOUT") throw new Error("ARCA double timeout");
        return { resultado: "APROBADA", cae: "74123456789012", vencimiento: "2026-09-01" };
      },
      esConflictoClaim: (error: any) => error?.code === "40001",
      esConflictoSecuencia: (error: any) =>
        error?.code === "PT409" &&
        String(error?.message ?? "").startsWith("EMISION_FISCAL_SECUENCIA_OBSOLETA"),
      consultarComprobanteCompleto: async () => null,
      consultarUltimoAutorizado: async () => 0,
      decidirConciliacion: ({ numeroReservado, ultimoRemoto }: any) =>
        ultimoRemoto === numeroReservado - 1
          ? { accion: "REENVIAR_MISMO_NUMERO" }
          : { accion: "BLOQUEAR", diferencias: ["secuencia"] },
    };
    return {
      dependencies,
      arcaCalls: () => arcaCalls,
      transition,
      transitionActions,
      huellaConfirmacion,
    };
  }

  it("aprueba, conserva lo comercial y hace coincidir los payloads TS con las allowlists", async () => {
    const before = await sql`
      select (select count(*) from public.venta_items where venta_id=${ids.sales[0]})::int items,
             (select count(*) from public.venta_pagos where venta_id=${ids.sales[0]})::int pagos,
             (select total::text from public.ventas where id=${ids.sales[0]}) total
    `;
    const runtime = deps(ids.sales[0], ids.items[0], 901, ["OK"], "A");
    const result = await ejecutarEmisionFiscal(
      {
        ventaId: ids.sales[0],
        receptor: {
          origen: "MANUAL",
          tipo_documento: "CUIT",
          numero_documento: "30714199664",
          razon_social: "RECEPTOR",
          condicion_iva: "RESPONSABLE_INSCRIPTO",
          domicilio: null,
          guardar_para_proximas: false,
          confirma_datos_manuales: true,
        },
        letraSolicitada: "A",
        confirmaVentaAntigua: false,
        huellaConfirmacion: runtime.huellaConfirmacion,
      },
      runtime.dependencies,
    );
    expect(result).toMatchObject({ estado: "APROBADO", cae: "74123456789012", numero: 1 });
    expect(runtime.arcaCalls()).toBe(1);
    const after = await sql`
      select (select count(*) from public.venta_items where venta_id=${ids.sales[0]})::int items,
             (select count(*) from public.venta_pagos where venta_id=${ids.sales[0]})::int pagos,
             (select total::text from public.ventas where id=${ids.sales[0]}) total
    `;
    expect(after[0]).toEqual(before[0]);
  });

  it("un timeout post-request queda durable en RECONCILIAR", async () => {
    const runtime = deps(ids.sales[1], ids.items[1], 902, ["TIMEOUT"], "B");
    const result = await ejecutarEmisionFiscal(
      {
        ventaId: ids.sales[1],
        receptor: { origen: "CLIENTE_COMERCIAL" },
        letraSolicitada: "B",
        confirmaVentaAntigua: false,
        huellaConfirmacion: runtime.huellaConfirmacion,
      },
      runtime.dependencies,
    );
    expect(result.estado).toBe("RECONCILIAR");
    const [sale] =
      await sql`select afip_estado,afip_fase,afip_numero from public.ventas where id=${ids.sales[1]}`;
    expect(sale).toMatchObject({
      afip_estado: "RECONCILIAR",
      afip_fase: "REQUEST_INICIADO",
      afip_numero: 1,
    });
  });

  it("reenvía sólo tras ausencia verificada y conserva número/snapshot/hash", async () => {
    const runtime = deps(ids.sales[2], ids.items[2], 903, ["TIMEOUT", "OK"], "B");
    await ejecutarEmisionFiscal(
      {
        ventaId: ids.sales[2],
        receptor: { origen: "CLIENTE_COMERCIAL" },
        letraSolicitada: "B",
        confirmaVentaAntigua: false,
        huellaConfirmacion: runtime.huellaConfirmacion,
      },
      runtime.dependencies,
    );
    const [before] =
      await sql`select afip_numero,afip_snapshot,afip_snapshot_hash from public.ventas where id=${ids.sales[2]}`;
    const result = await ejecutarConciliacionFiscal(
      { ventaId: ids.sales[2] },
      runtime.dependencies,
    );
    expect(result).toMatchObject({ estado: "APROBADO", recuperado: false, numero: 1 });
    const [after] =
      await sql`select afip_numero,afip_snapshot,afip_snapshot_hash from public.ventas where id=${ids.sales[2]}`;
    expect(after).toEqual(before);
    expect(runtime.arcaCalls()).toBe(2);
  });

  it("la RPC real rechaza claves desconocidas sin mutar", async () => {
    const token = crypto.randomUUID();
    const { error } = await supabase.rpc("transicionar_emision_fiscal", {
      p_venta_id: ids.sales[3],
      p_accion: "RECLAMAR",
      p_claim_token: token,
      p_payload: { expected_version: 0, lease_segundos: 300, desconocida: true },
    });
    expect(error?.message).toMatch(/Clave.*no permitida/i);
    const [sale] =
      await sql`select afip_estado,afip_version from public.ventas where id=${ids.sales[3]}`;
    expect(sale).toMatchObject({ afip_estado: "SIN_FACTURAR", afip_version: 0 });
  });

  it("recupera contra la RPC real un commit de RESPUESTA_RECIBIDA cuya respuesta se perdió", async () => {
    const runtime = deps(ids.sales[4], ids.items[4], 904, ["OK"], "B");
    const transicionarReal = runtime.dependencies.transicionar;
    let perderRespuesta = true;
    runtime.dependencies.transicionar = async (input: any) => {
      const persistido = await transicionarReal(input);
      if (input.accion === "RESPUESTA_RECIBIDA" && perderRespuesta) {
        perderRespuesta = false;
        throw new Error("conexión perdida después del commit");
      }
      return persistido;
    };

    const result = await ejecutarEmisionFiscal(
      {
        ventaId: ids.sales[4],
        receptor: { origen: "CLIENTE_COMERCIAL" },
        letraSolicitada: "B",
        confirmaVentaAntigua: false,
        huellaConfirmacion: runtime.huellaConfirmacion,
      },
      runtime.dependencies,
    );

    expect(result).toMatchObject({ estado: "APROBADO", cae: "74123456789012", numero: 1 });
    expect(runtime.arcaCalls()).toBe(1);
    const [sale] = await sql`
      select afip_estado,afip_fase,afip_version,cae
        from public.ventas
       where id=${ids.sales[4]}
    `;
    expect(sale).toMatchObject({
      afip_estado: "APROBADO",
      afip_fase: "PERSISTIDO",
      afip_version: 5,
      cae: "74123456789012",
    });
  });

  it("propaga RECUPERAR_CAE desde el motor TS hasta la RPC real", async () => {
    const runtime = deps(ids.sales[5], ids.items[5], 905, ["TIMEOUT"], "B");
    await ejecutarEmisionFiscal(
      {
        ventaId: ids.sales[5],
        receptor: { origen: "CLIENTE_COMERCIAL" },
        letraSolicitada: "B",
        confirmaVentaAntigua: false,
        huellaConfirmacion: runtime.huellaConfirmacion,
      },
      runtime.dependencies,
    );
    runtime.transitionActions.length = 0;
    runtime.dependencies.consultarComprobanteCompleto = async () => ({ voucher: "exacto" });
    runtime.dependencies.decidirConciliacion = () => ({
      accion: "RECUPERAR_CAE",
      cae: "74123456789013",
      vencimiento: "2026-09-02",
    });

    await expect(
      ejecutarConciliacionFiscal({ ventaId: ids.sales[5] }, runtime.dependencies),
    ).resolves.toMatchObject({
      estado: "APROBADO",
      recuperado: true,
      cae: "74123456789013",
    });
    expect(runtime.transitionActions).toEqual(["RECUPERAR_CAE"]);
    const [sale] = await sql`
      select afip_estado,afip_fase,cae,afip_numero
        from public.ventas
       where id=${ids.sales[5]}
    `;
    expect(sale).toMatchObject({
      afip_estado: "APROBADO",
      afip_fase: "PERSISTIDO",
      cae: "74123456789013",
      afip_numero: 1,
    });
  });

  it("propaga una divergencia como BLOQUEAR hasta la RPC real", async () => {
    const runtime = deps(ids.sales[6], ids.items[6], 906, ["TIMEOUT"], "B");
    await ejecutarEmisionFiscal(
      {
        ventaId: ids.sales[6],
        receptor: { origen: "CLIENTE_COMERCIAL" },
        letraSolicitada: "B",
        confirmaVentaAntigua: false,
        huellaConfirmacion: runtime.huellaConfirmacion,
      },
      runtime.dependencies,
    );
    runtime.transitionActions.length = 0;
    runtime.dependencies.consultarComprobanteCompleto = async () => ({ voucher: "divergente" });
    runtime.dependencies.decidirConciliacion = () => ({
      accion: "BLOQUEAR",
      diferencias: ["receptor.docNro", "total", "total"],
    });

    await expect(
      ejecutarConciliacionFiscal({ ventaId: ids.sales[6] }, runtime.dependencies),
    ).resolves.toEqual({
      estado: "BLOQUEADO",
      diferencias: ["receptor.docNro", "total"],
    });
    expect(runtime.transitionActions).toEqual(["BLOQUEAR"]);
    const [sale] = await sql`
      select afip_estado,afip_fase,afip_numero,afip_error_clase
        from public.ventas
       where id=${ids.sales[6]}
    `;
    expect(sale).toMatchObject({
      afip_estado: "BLOQUEADO",
      afip_fase: "REQUEST_INICIADO",
      afip_numero: 1,
      afip_error_clase: "DIVERGENCIA",
    });
  });
});
