import { describe, expect, it } from "vitest";
import {
  ejecutarConciliacionFiscal,
  ejecutarEmisionFiscal,
  type AccionTransicionFiscal,
  type DependenciasEmisionFiscal,
  type EstadoTransicionFiscal,
  type PreparacionEmisionFiscal,
  type ReservaFiscalPersistida,
  type SolicitudCaeFiscal,
} from "./emision";
import type { SelectorReceptorFiscal } from "./receptor";
import type { SnapshotFiscalV2 } from "./snapshot";

const MANUAL_A: SelectorReceptorFiscal = {
  origen: "MANUAL",
  tipo_documento: "CUIT",
  numero_documento: "30714199664",
  razon_social: "RECEPTOR A",
  condicion_iva: "RESPONSABLE_INSCRIPTO",
  domicilio: "Domicilio A",
  guardar_para_proximas: false,
  confirma_datos_manuales: true,
};

const MANUAL_B: SelectorReceptorFiscal = {
  ...MANUAL_A,
  numero_documento: "30504480917",
  razon_social: "RECEPTOR B",
};

const ORIGINAL: SelectorReceptorFiscal = { origen: "COMPROBANTE_ORIGINAL" };

type TransitionCall = {
  accion: AccionTransicionFiscal;
  claimToken: string | null;
  payload: Record<string, unknown>;
};

function snapshot(numero: number, receptor = "RECEPTOR A"): SnapshotFiscalV2 {
  return {
    version: 2,
    hash: `${numero}`.padStart(64, "a"),
    identidad: {
      numero,
      emisorCuit: "30714199664",
      puntoVenta: 5,
      cbteTipo: 1,
      modo: "PRODUCCION",
      simulado: false,
      validez: "PRODUCCION",
    },
    receptor: { razonSocial: receptor },
    importeTotal: "1210.00",
    fechaComprobante: "2026-08-22",
  } as unknown as SnapshotFiscalV2;
}

class FiscalDouble {
  readonly calls: TransitionCall[] = [];
  readonly payloadsCae: Array<{ reserva: ReservaFiscalPersistida; payload: unknown }> = [];
  readonly receptoresPreparados: SelectorReceptorFiscal[] = [];
  version = 0;
  claim: string | null = null;
  numero: number | null = null;
  persistedSnapshot: SnapshotFiscalV2 | null = null;
  tipo: "VENTA" | "NOTA_CREDITO" | "NOTA_DEBITO" = "VENTA";
  simulado = false;
  ultimoLocal = 0;
  ultimoRemoto = 0;
  remote: unknown | null = null;
  decision:
    | { accion: "RECUPERAR_CAE"; cae: string; vencimiento: string | null }
    | { accion: "REENVIAR_MISMO_NUMERO" }
    | { accion: "BLOQUEAR"; diferencias: string[] } = {
    accion: "BLOQUEAR",
    diferencias: ["remoto"],
  };
  solicitud: SolicitudCaeFiscal = {
    resultado: "APROBADA",
    cae: "74123456789012",
    vencimiento: "2026-09-01",
  };
  throwBeforeSequence: unknown | null = null;
  throwSolicitud: unknown | null = null;
  throwPayload: unknown | null = null;
  throwTransitionOnce: AccionTransicionFiscal | null = null;
  commitThenThrowOnce: AccionTransicionFiscal | null = null;
  preparedSnapshot: SnapshotFiscalV2 | null = null;
  nextClaim = 1;
  estadoActual = "SIN_FACTURAR";
  faseActual: string | null = null;
  reloads = 0;

  estado(
    estado = this.estadoActual,
    fase: string | null = this.faseActual,
  ): EstadoTransicionFiscal {
    return {
      venta_id: "71000000-0000-4000-8000-000000000001",
      afip_estado: estado,
      afip_fase: fase,
      afip_claim_token: this.claim,
      afip_numero: this.numero,
      afip_version: this.version,
    };
  }

  confirmarTransicion(
    accion: AccionTransicionFiscal,
    estado: string,
    fase: string | null,
  ): EstadoTransicionFiscal {
    this.estadoActual = estado;
    this.faseActual = fase;
    const persistido = this.estado();
    if (this.commitThenThrowOnce === accion) {
      this.commitThenThrowOnce = null;
      throw new Error(`respuesta perdida ${accion}`);
    }
    return persistido;
  }

  reserva(): ReservaFiscalPersistida {
    if (!this.claim || !this.numero || !this.persistedSnapshot) throw new Error("sin reserva");
    return {
      ventaId: "71000000-0000-4000-8000-000000000001",
      claimToken: this.claim,
      afipVersion: this.version,
      numero: this.numero,
      snapshot: structuredClone(this.persistedSnapshot),
      payloadHash: this.persistedSnapshot.hash,
      emisorCuit: "30714199664",
      puntoVenta: 5,
      cbteTipo: this.tipo === "NOTA_CREDITO" ? 3 : 1,
      modo: "PRODUCCION",
    };
  }

  deps(): DependenciasEmisionFiscal {
    return {
      generarClaimToken: () =>
        `81000000-0000-4000-8000-${String(this.nextClaim++).padStart(12, "0")}`,
      ahoraIso: () => "2026-08-22T15:00:00.000Z",
      autorizarEmision: async () => ({ tipoComprobante: this.tipo, afipVersion: this.version }),
      autorizarConciliacion: async () => undefined,
      prepararEmision: async ({ receptor }) => {
        this.receptoresPreparados.push(structuredClone(receptor));
        const preparacion: PreparacionEmisionFiscal = {
          ventaId: "71000000-0000-4000-8000-000000000001",
          tipoComprobante: this.tipo === "NOTA_CREDITO" ? "NOTA_CREDITO" : "VENTA",
          emisorCuit: "30714199664",
          puntoVenta: 5,
          cbteTipo: this.tipo === "NOTA_CREDITO" ? 3 : 1,
          modo: "PRODUCCION",
          simulado: this.simulado,
          validez: this.simulado ? "SIMULADA" : "PRODUCCION",
          fechaComprobante: "2026-08-22",
        };
        return preparacion;
      },
      consultarSecuencia: async () => {
        if (this.throwBeforeSequence) throw this.throwBeforeSequence;
        return {
          ultimoRemoto: this.ultimoRemoto,
          ultimaFechaRemota: this.ultimoRemoto === 0 ? null : "2026-08-22",
          ultimoLocal: this.ultimoLocal,
        };
      },
      validarFechaFiscal: () => undefined,
      crearSnapshot: async ({ numero, receptor }) => {
        const result = snapshot(
          numero,
          receptor.origen === "COMPROBANTE_ORIGINAL"
            ? "ORIGINAL"
            : receptor.origen === "MANUAL"
              ? receptor.razon_social
              : receptor.origen,
        );
        result.identidad.simulado = this.simulado;
        result.identidad.validez = this.simulado ? "SIMULADA" : "PRODUCCION";
        result.identidad.cbteTipo = this.tipo === "NOTA_CREDITO" ? 3 : 1;
        this.preparedSnapshot = result;
        return result;
      },
      transicionar: async ({ accion, claimToken, payload }) => {
        this.calls.push({ accion, claimToken, payload: structuredClone(payload) });
        if (this.throwTransitionOnce === accion) {
          this.throwTransitionOnce = null;
          throw new Error(`persistencia ${accion}`);
        }
        if (payload.expected_version !== this.version) {
          const error = new Error("VERSION_INCORRECTA");
          if (accion === "RECLAMAR") error.name = "ClaimFiscalConflict";
          throw error;
        }
        if (accion === "RECLAMAR") {
          if (this.claim) {
            const error = new Error("CLAIM_CONFLICT");
            error.name = "ClaimFiscalConflict";
            throw error;
          }
          this.claim = claimToken;
          this.version += 1;
          return this.confirmarTransicion(accion, "EMITIENDO", "PREFLIGHT");
        }
        if (claimToken !== this.claim) throw new Error("TOKEN_INCORRECTO");
        if (accion === "RESERVAR") {
          this.numero = payload.numero_propuesto as number;
          this.persistedSnapshot = structuredClone(payload.snapshot as SnapshotFiscalV2);
          this.ultimoLocal = Math.max(this.ultimoLocal, this.numero);
          this.version += 1;
          return this.confirmarTransicion(accion, "EMITIENDO", "RESERVADO");
        }
        if (accion === "REQUEST_INICIADO") {
          this.version += 1;
          return this.confirmarTransicion(accion, "EMITIENDO", "REQUEST_INICIADO");
        }
        if (accion === "RESPUESTA_RECIBIDA") {
          this.version += 1;
          return this.confirmarTransicion(accion, "EMITIENDO", "RESPUESTA_RECIBIDA");
        }
        if (accion === "APROBAR" || accion === "RECUPERAR_CAE") {
          this.version += 1;
          this.claim = null;
          return this.confirmarTransicion(accion, "APROBADO", "PERSISTIDO");
        }
        if (accion === "REENVIO_VERIFICADO") {
          this.claim = payload.nuevo_claim_token as string;
          this.version += 1;
          return this.confirmarTransicion(accion, "EMITIENDO", "RESERVADO");
        }
        if (accion === "RECONCILIAR") {
          this.version += 1;
          return this.confirmarTransicion(accion, "RECONCILIAR", "REQUEST_INICIADO");
        }
        if (accion === "BLOQUEAR") {
          this.version += 1;
          return this.confirmarTransicion(accion, "BLOQUEADO", "REQUEST_INICIADO");
        }
        if (accion === "ERROR_CORREGIBLE" || accion === "LIBERAR") {
          this.version += 1;
          this.claim = null;
          this.numero = null;
          this.persistedSnapshot = null;
          return this.confirmarTransicion(accion, "ERROR_CORREGIBLE", null);
        }
        throw new Error(`acción doble no implementada: ${accion}`);
      },
      cargarEstadoPersistido: async () => {
        this.reloads += 1;
        return this.estado();
      },
      cargarReservaPersistida: async () => this.reserva(),
      crearPayloadCae: (reserved) => {
        if (this.throwPayload) throw this.throwPayload;
        return {
          numero: reserved.identidad.numero,
          receptor: reserved.receptor.razonSocial,
          total: reserved.importeTotal,
          hash: reserved.hash,
        };
      },
      solicitarCae: async (reserva, payload) => {
        this.payloadsCae.push({
          reserva: structuredClone(reserva),
          payload: structuredClone(payload),
        });
        if (this.throwSolicitud) throw this.throwSolicitud;
        return this.solicitud;
      },
      esConflictoClaim: (error) => (error as Error)?.name === "ClaimFiscalConflict",
      consultarComprobanteCompleto: async () => this.remote,
      consultarUltimoAutorizado: async () => this.ultimoRemoto,
      decidirConciliacion: () => this.decision,
    };
  }
}

function acciones(doble: FiscalDouble): string[] {
  return doble.calls.map((call) => call.accion);
}

describe("ejecutarEmisionFiscal", () => {
  it("persiste cada fase y consume la versión recién devuelta antes de aprobar", async () => {
    const doble = new FiscalDouble();

    const result = await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: MANUAL_A,
        confirmaVentaAntigua: false,
      },
      doble.deps(),
    );

    expect(result).toMatchObject({ estado: "APROBADO", cae: "74123456789012", numero: 1 });
    expect(acciones(doble)).toEqual([
      "RECLAMAR",
      "RESERVAR",
      "REQUEST_INICIADO",
      "RESPUESTA_RECIBIDA",
      "APROBAR",
    ]);
    expect(doble.calls.map((call) => call.payload.expected_version)).toEqual([0, 1, 2, 3, 4]);
    expect(doble.payloadsCae).toHaveLength(1);
  });

  it("un timeout de preflight libera como error corregible sin pedir CAE", async () => {
    const doble = new FiscalDouble();
    doble.throwBeforeSequence = new Error("timeout secuencia");

    const result = await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: MANUAL_A,
        confirmaVentaAntigua: false,
      },
      doble.deps(),
    );

    expect(result.estado).toBe("ERROR_CORREGIBLE");
    expect(acciones(doble)).toEqual(["RECLAMAR", "ERROR_CORREGIBLE"]);
    expect(doble.payloadsCae).toHaveLength(0);
  });

  it("un timeout después de REQUEST_INICIADO concilia y nunca libera ni reemite", async () => {
    const doble = new FiscalDouble();
    doble.throwSolicitud = new Error("timeout emisión");

    const result = await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: MANUAL_A,
        confirmaVentaAntigua: false,
      },
      doble.deps(),
    );

    expect(result.estado).toBe("RECONCILIAR");
    expect(acciones(doble)).toEqual(["RECLAMAR", "RESERVAR", "REQUEST_INICIADO", "RECONCILIAR"]);
    expect(acciones(doble)).not.toContain("LIBERAR");
    expect(doble.payloadsCae).toHaveLength(1);
  });

  it("una identidad de detalle ARCA incierta conserva la reserva y termina en RECONCILIAR", async () => {
    const doble = new FiscalDouble();
    const respuestaIncierta = new Error("ARCA devolvió un detalle con identidad distinta.");
    respuestaIncierta.name = "ArcaRespuestaIncierta";
    doble.throwSolicitud = respuestaIncierta;

    const result = await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: MANUAL_A,
        confirmaVentaAntigua: false,
      },
      doble.deps(),
    );

    expect(result.estado).toBe("RECONCILIAR");
    expect(acciones(doble)).toEqual(["RECLAMAR", "RESERVAR", "REQUEST_INICIADO", "RECONCILIAR"]);
    expect(acciones(doble)).not.toContain("ERROR_CORREGIBLE");
    expect(doble.claim).not.toBeNull();
    expect(doble.numero).toBe(1);
  });

  it("un fallo al mapear el snapshot después de REQUEST_INICIADO también concilia", async () => {
    const doble = new FiscalDouble();
    doble.throwPayload = new Error("snapshot no mapeable");

    const result = await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: MANUAL_A,
        confirmaVentaAntigua: false,
      },
      doble.deps(),
    );

    expect(result.estado).toBe("RECONCILIAR");
    expect(acciones(doble)).toEqual(["RECLAMAR", "RESERVAR", "REQUEST_INICIADO", "RECONCILIAR"]);
    expect(doble.payloadsCae).toHaveLength(0);
  });

  it("un rechazo definitivo audita la respuesta antes de liberar identidad", async () => {
    const doble = new FiscalDouble();
    doble.solicitud = {
      resultado: "RECHAZADA",
      codigo: "10013",
      mensajeMascarado: "receptor rechazado",
    };

    const result = await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: MANUAL_A,
        confirmaVentaAntigua: false,
      },
      doble.deps(),
    );

    expect(result.estado).toBe("ERROR_CORREGIBLE");
    expect(acciones(doble)).toEqual([
      "RECLAMAR",
      "RESERVAR",
      "REQUEST_INICIADO",
      "RESPUESTA_RECIBIDA",
      "ERROR_CORREGIBLE",
    ]);
    expect(doble.calls[3].payload.respuesta_resumen).toEqual({
      tipo: "EMISION",
      resultado: "R",
      fuente: "FECAESolicitar",
      rechazo_confirmado: true,
      codigo: "10013",
      mensaje: "receptor rechazado",
      observaciones: [],
    });
  });

  it("si no puede persistir un rechazo definitivo conserva la identidad para conciliar", async () => {
    const doble = new FiscalDouble();
    doble.solicitud = {
      resultado: "RECHAZADA",
      codigo: "10013",
      mensajeMascarado: "receptor rechazado",
    };
    doble.throwTransitionOnce = "RESPUESTA_RECIBIDA";

    const result = await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: MANUAL_A,
        confirmaVentaAntigua: false,
      },
      doble.deps(),
    );

    expect(result.estado).toBe("RECONCILIAR");
    expect(acciones(doble)).toEqual([
      "RECLAMAR",
      "RESERVAR",
      "REQUEST_INICIADO",
      "RESPUESTA_RECIBIDA",
      "RECONCILIAR",
    ]);
  });

  it("si falla persistir después de recibir CAE no responde éxito y exige conciliación", async () => {
    const doble = new FiscalDouble();
    doble.throwTransitionOnce = "RESPUESTA_RECIBIDA";

    const result = await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: MANUAL_A,
        confirmaVentaAntigua: false,
      },
      doble.deps(),
    );

    expect(result.estado).toBe("RECONCILIAR");
    expect(acciones(doble)).toEqual([
      "RECLAMAR",
      "RESERVAR",
      "REQUEST_INICIADO",
      "RESPUESTA_RECIBIDA",
      "RECONCILIAR",
    ]);
  });

  it.each(["RECLAMAR", "RESERVAR", "REQUEST_INICIADO", "RESPUESTA_RECIBIDA", "APROBAR"] as const)(
    "recupera el commit cuya respuesta se perdió en %s sin repetir la llamada CAE",
    async (accion) => {
      const doble = new FiscalDouble();
      doble.commitThenThrowOnce = accion;

      const result = await ejecutarEmisionFiscal(
        {
          ventaId: "71000000-0000-4000-8000-000000000001",
          receptor: MANUAL_A,
          confirmaVentaAntigua: false,
        },
        doble.deps(),
      );

      expect(result).toMatchObject({ estado: "APROBADO", cae: "74123456789012", numero: 1 });
      expect(doble.calls.filter((call) => call.accion === accion)).toHaveLength(1);
      expect(doble.payloadsCae).toHaveLength(1);
      expect(doble.reloads).toBeGreaterThan(0);
      expect(doble.estadoActual).toBe("APROBADO");
    },
  );

  it("relee un RECONCILIAR confirmado cuya respuesta se perdió y no deja EMITIENDO varado", async () => {
    const doble = new FiscalDouble();
    doble.throwSolicitud = new Error("timeout luego de enviar");
    doble.commitThenThrowOnce = "RECONCILIAR";

    const result = await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: MANUAL_A,
        confirmaVentaAntigua: false,
      },
      doble.deps(),
    );

    expect(result.estado).toBe("RECONCILIAR");
    expect(doble.calls.filter((call) => call.accion === "RECONCILIAR")).toHaveLength(1);
    expect(doble.payloadsCae).toHaveLength(1);
    expect(doble.estadoActual).toBe("RECONCILIAR");
    expect(doble.faseActual).toBe("REQUEST_INICIADO");
  });

  it("dos submits con receptores distintos dejan un claim, una preparación y una llamada ARCA", async () => {
    const doble = new FiscalDouble();
    const deps = doble.deps();

    const [primero, segundo] = await Promise.all([
      ejecutarEmisionFiscal(
        {
          ventaId: "71000000-0000-4000-8000-000000000001",
          receptor: MANUAL_A,
          confirmaVentaAntigua: false,
        },
        deps,
      ),
      ejecutarEmisionFiscal(
        {
          ventaId: "71000000-0000-4000-8000-000000000001",
          receptor: MANUAL_B,
          confirmaVentaAntigua: false,
        },
        deps,
      ),
    ]);

    expect([primero.estado, segundo.estado].sort()).toEqual(["APROBADO", "EN_CURSO"]);
    expect(doble.calls.filter((call) => call.accion === "RECLAMAR")).toHaveLength(2);
    expect(doble.receptoresPreparados).toHaveLength(1);
    expect(doble.payloadsCae).toHaveLength(1);
  });

  it("dos emisiones simuladas secuenciales usan números locales 1 y 2 aunque remoto informa cero", async () => {
    const doble = new FiscalDouble();
    doble.simulado = true;
    const deps = doble.deps();

    await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: MANUAL_A,
        confirmaVentaAntigua: false,
      },
      deps,
    );
    doble.version = 0;
    doble.claim = null;
    doble.numero = null;
    doble.persistedSnapshot = null;
    await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000002",
        receptor: MANUAL_A,
        confirmaVentaAntigua: false,
      },
      deps,
    );

    expect(
      doble.calls
        .filter((call) => call.accion === "RESERVAR")
        .map((call) => call.payload.numero_propuesto),
    ).toEqual([1, 2]);
    expect(doble.ultimoRemoto).toBe(0);
  });

  it("ediciones vivas posteriores a RESERVAR no cambian el payload persistido", async () => {
    const doble = new FiscalDouble();
    const deps = doble.deps();
    const originalCargar = deps.cargarReservaPersistida;
    deps.cargarReservaPersistida = async (ventaId) => {
      if (doble.preparedSnapshot) {
        (doble.preparedSnapshot.receptor as { razonSocial: string }).razonSocial = "EDITADO VIVO";
      }
      return originalCargar(ventaId);
    };

    await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: MANUAL_A,
        confirmaVentaAntigua: false,
      },
      deps,
    );

    expect(doble.payloadsCae[0].payload).toMatchObject({
      receptor: "RECEPTOR A",
      total: "1210.00",
    });
  });

  it("rechaza una nota de débito antes de claim y red", async () => {
    const doble = new FiscalDouble();
    doble.tipo = "NOTA_DEBITO";

    await expect(
      ejecutarEmisionFiscal(
        {
          ventaId: "71000000-0000-4000-8000-000000000001",
          receptor: ORIGINAL,
          confirmaVentaAntigua: false,
        },
        doble.deps(),
      ),
    ).rejects.toThrow(/débito.*fuera de alcance/i);
    expect(doble.calls).toHaveLength(0);
    expect(doble.payloadsCae).toHaveLength(0);
  });

  it("una NC sólo acepta COMPROBANTE_ORIGINAL y emite el snapshot heredado", async () => {
    const doble = new FiscalDouble();
    doble.tipo = "NOTA_CREDITO";

    await expect(
      ejecutarEmisionFiscal(
        {
          ventaId: "71000000-0000-4000-8000-000000000001",
          receptor: MANUAL_A,
          confirmaVentaAntigua: false,
        },
        doble.deps(),
      ),
    ).rejects.toThrow(/comprobante original/i);
    expect(doble.calls).toHaveLength(0);

    const result = await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: ORIGINAL,
        confirmaVentaAntigua: false,
      },
      doble.deps(),
    );
    expect(result.estado).toBe("APROBADO");
    expect(doble.payloadsCae[0].payload).toMatchObject({ receptor: "ORIGINAL", numero: 1 });
  });

  it("un fallo guardando el favorito post-CAE sólo agrega una advertencia", async () => {
    const doble = new FiscalDouble();
    const deps = doble.deps();
    deps.guardarFavoritoConfirmado = async () => {
      throw new Error("RLS favorito");
    };

    const result = await ejecutarEmisionFiscal(
      {
        ventaId: "71000000-0000-4000-8000-000000000001",
        receptor: { ...MANUAL_A, guardar_para_proximas: true },
        confirmaVentaAntigua: false,
      },
      deps,
    );

    expect(result).toMatchObject({
      estado: "APROBADO",
      cae: "74123456789012",
      advertencias: ["El comprobante fue aprobado, pero no se pudo guardar el receptor favorito."],
    });
  });
});

describe("ejecutarConciliacionFiscal", () => {
  function reconciliable(doble: FiscalDouble) {
    doble.version = 4;
    doble.claim = "81000000-0000-4000-8000-000000000099";
    doble.numero = 7;
    doble.persistedSnapshot = snapshot(7);
    doble.estadoActual = "RECONCILIAR";
    doble.faseActual = "REQUEST_INICIADO";
  }

  it("un remoto exacto usa la transición dedicada RECUPERAR_CAE", async () => {
    const doble = new FiscalDouble();
    reconciliable(doble);
    doble.remote = { voucher: "completo" };
    doble.decision = { accion: "RECUPERAR_CAE", cae: "74123456789077", vencimiento: null };

    const result = await ejecutarConciliacionFiscal(
      { ventaId: "71000000-0000-4000-8000-000000000001" },
      doble.deps(),
    );

    expect(result).toMatchObject({ estado: "APROBADO", recuperado: true, cae: "74123456789077" });
    expect(doble.calls).toHaveLength(1);
    expect(doble.calls[0]).toMatchObject({
      accion: "RECUPERAR_CAE",
      claimToken: "81000000-0000-4000-8000-000000000099",
      payload: {
        expected_version: 4,
        cae: "74123456789077",
        cae_vencimiento: null,
        payload_hash: doble.persistedSnapshot?.hash,
        respuesta_resumen: {
          tipo: "CONSULTA_ARCA",
          resultado: "COINCIDE",
          fuente: "FECompConsultar",
          coincidencia_completa: true,
          observaciones: [],
        },
      },
    });
  });

  it("una diferencia bloquea con campos únicos ordenados y sin valores fiscales", async () => {
    const doble = new FiscalDouble();
    reconciliable(doble);
    doble.remote = { voucher: "distinto" };
    doble.decision = { accion: "BLOQUEAR", diferencias: ["total", "receptor.docNro", "total"] };

    const result = await ejecutarConciliacionFiscal(
      { ventaId: "71000000-0000-4000-8000-000000000001" },
      doble.deps(),
    );

    expect(result.estado).toBe("BLOQUEADO");
    expect(doble.calls[0].payload.diferencias).toEqual({
      campos: ["receptor.docNro", "total"],
    });
    expect(JSON.stringify(doble.calls[0].payload)).not.toContain("distinto");
  });

  it("una ausencia segura rota claim y reenvía exactamente número, receptor, importes y hash", async () => {
    const doble = new FiscalDouble();
    reconciliable(doble);
    const frozen = structuredClone(doble.persistedSnapshot!);
    doble.remote = null;
    doble.ultimoRemoto = 6;
    doble.decision = { accion: "REENVIAR_MISMO_NUMERO" };

    const result = await ejecutarConciliacionFiscal(
      { ventaId: "71000000-0000-4000-8000-000000000001" },
      doble.deps(),
    );

    expect(result.estado).toBe("APROBADO");
    expect(acciones(doble)).toEqual([
      "REENVIO_VERIFICADO",
      "REQUEST_INICIADO",
      "RESPUESTA_RECIBIDA",
      "APROBAR",
    ]);
    expect(doble.calls[0].payload).toMatchObject({
      expected_version: 4,
      ultimo_remoto: 6,
      payload_hash: frozen.hash,
      respuesta_resumen: {
        tipo: "CONSULTA_ARCA",
        resultado: "AUSENTE",
        fuente: "FECompConsultar",
        ausencia_confirmada: true,
        observaciones: [],
      },
    });
    expect(doble.payloadsCae[0].reserva.numero).toBe(7);
    expect(doble.payloadsCae[0].reserva.snapshot).toEqual(frozen);
    expect(doble.payloadsCae[0].payload).toMatchObject({ numero: 7, hash: frozen.hash });
  });

  it("continúa un REENVIO_VERIFICADO confirmado cuya respuesta se perdió sin duplicar CAE", async () => {
    const doble = new FiscalDouble();
    reconciliable(doble);
    doble.remote = null;
    doble.ultimoRemoto = 6;
    doble.decision = { accion: "REENVIAR_MISMO_NUMERO" };
    doble.commitThenThrowOnce = "REENVIO_VERIFICADO";

    const result = await ejecutarConciliacionFiscal(
      { ventaId: "71000000-0000-4000-8000-000000000001" },
      doble.deps(),
    );

    expect(result).toMatchObject({ estado: "APROBADO", numero: 7 });
    expect(doble.calls.filter((call) => call.accion === "REENVIO_VERIFICADO")).toHaveLength(1);
    expect(doble.payloadsCae).toHaveLength(1);
    expect(doble.reloads).toBeGreaterThan(0);
  });
});
