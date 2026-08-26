import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModalidadFacturaAEditor } from "@/components/app/emisores-config";
import {
  actualizacionModalidadFacturaA,
  actualizacionResetCredencialPorCambioPuntoVenta,
  autorizarAntesDeClientePrivilegiado,
  confirmacionModalidadFacturaASchema,
  ejecutarPruebaActivacionPadron,
  estadoFiscalPublicoMinimo,
  exigirEmisorActualizado,
  normalizarCredencialesPublicas,
  probarAccesoSecuenciasFactura,
  probarConexionSegunModo,
  QUERY_KEY_CONFIG_FISCAL_ADMIN,
  QUERY_KEY_ESTADO_FISCAL_PUBLICO,
  validarHabilitacionCredencial,
} from "./config";
import {
  codigoErrorFiscalUsuario,
  crearErrorFiscalUsuario,
  mensajeCodigoErrorFiscalUsuario,
  mensajeErrorFiscal,
} from "./error-usuario";
import type { CodigoErrorPadronArca, ReceptorPadronArca } from "./padron-arca";
import { ejecutarPruebaPadronAdministrativa } from "./config.functions";

describe("estado público de credenciales ARCA", () => {
  it("si sólo existe producción igual devuelve ambos ambientes sin secretos", () => {
    const resultado = normalizarCredencialesPublicas([
      {
        ambiente: "PRODUCCION",
        arca_key_enc: "clave-cifrada-secreta",
        arca_cert_enc: null,
        cert_vence_at: null,
        cert_alias: "CasaForma",
        probada_at: null,
        habilitada: false,
        padron_probado_at: "2026-08-26T12:00:00.000Z",
        padron_validacion_activa: true,
        padron_ultimo_error_codigo: null,
        padron_ultimo_error_at: null,
      },
    ]);

    expect(resultado).toEqual([
      {
        ambiente: "HOMOLOGACION",
        tiene_clave: false,
        tiene_certificado: false,
        cert_vence_at: null,
        cert_alias: null,
        probada_at: null,
        habilitada: false,
        padron_probado_at: null,
        padron_validacion_activa: false,
        padron_ultimo_error_codigo: null,
        padron_ultimo_error_at: null,
      },
      {
        ambiente: "PRODUCCION",
        tiene_clave: true,
        tiene_certificado: false,
        cert_vence_at: null,
        cert_alias: "CasaForma",
        probada_at: null,
        habilitada: false,
        padron_probado_at: "2026-08-26T12:00:00.000Z",
        padron_validacion_activa: true,
        padron_ultimo_error_codigo: null,
        padron_ultimo_error_at: null,
      },
    ]);
    expect(resultado.every((fila) => !("arca_key_enc" in fila))).toBe(true);
    expect(resultado.every((fila) => !("arca_cert_enc" in fila))).toBe(true);
  });

  it("normaliza un código de padrón desconocido sin exponer secretos ni texto libre", () => {
    const [homologacion] = normalizarCredencialesPublicas([
      {
        ambiente: "HOMOLOGACION",
        arca_key_enc: "key-no-publica",
        arca_cert_enc: "cert-no-publico",
        cert_vence_at: null,
        cert_alias: null,
        probada_at: null,
        habilitada: false,
        padron_probado_at: null,
        padron_validacion_activa: false,
        padron_ultimo_error_codigo: "valor-ajeno-al-catalogo",
        padron_ultimo_error_at: "2026-08-26T12:05:00.000Z",
      },
    ]);

    expect(homologacion).toEqual({
      ambiente: "HOMOLOGACION",
      tiene_clave: true,
      tiene_certificado: true,
      cert_vence_at: null,
      cert_alias: null,
      probada_at: null,
      habilitada: false,
      padron_probado_at: null,
      padron_validacion_activa: false,
      padron_ultimo_error_codigo: "PADRON_CONFIG_INVALIDA",
      padron_ultimo_error_at: "2026-08-26T12:05:00.000Z",
    });
    expect(Object.keys(homologacion)).not.toContain("arca_key_enc");
    expect(Object.keys(homologacion)).not.toContain("arca_cert_enc");
  });

  it("sólo habilita una credencial vigente que ya pasó la prueba real", () => {
    const lista = {
      arca_key_enc: "key",
      arca_cert_enc: "cert",
      cert_vence_at: "2027-08-19T00:00:00.000Z",
      probada_at: "2026-08-19T18:00:00.000Z",
    };

    expect(() =>
      validarHabilitacionCredencial(lista, true, new Date("2026-08-19T19:00:00.000Z")),
    ).not.toThrow();
    expect(() =>
      validarHabilitacionCredencial(
        { ...lista, arca_cert_enc: null },
        true,
        new Date("2026-08-19T19:00:00.000Z"),
      ),
    ).toThrow(/certificado/i);
    expect(() =>
      validarHabilitacionCredencial(
        { ...lista, probada_at: null },
        true,
        new Date("2026-08-19T19:00:00.000Z"),
      ),
    ).toThrow(/probar.*conexión/i);
    expect(() =>
      validarHabilitacionCredencial(
        { ...lista, cert_vence_at: "2026-08-18T00:00:00.000Z" },
        true,
        new Date("2026-08-19T19:00:00.000Z"),
      ),
    ).toThrow(/vencido/i);

    expect(() =>
      validarHabilitacionCredencial(
        { arca_key_enc: null, arca_cert_enc: null, cert_vence_at: null, probada_at: null },
        false,
        new Date("2026-08-19T19:00:00.000Z"),
      ),
    ).not.toThrow();
  });

  it("sin filas devuelve ambos ambientes explícitamente deshabilitados", () => {
    expect(normalizarCredencialesPublicas([])).toHaveLength(2);
    expect(normalizarCredencialesPublicas([]).every((fila) => !fila.habilitada)).toBe(true);
  });

  it("la respuesta operativa mínima no entrega emisores, credenciales ni evidencia", () => {
    expect(estadoFiscalPublicoMinimo(true)).toEqual({ mock_mode: true });
    expect(Object.keys(estadoFiscalPublicoMinimo(false))).toEqual(["mock_mode"]);
  });

  it("separa la caché operativa mínima de la configuración administrativa", () => {
    expect(QUERY_KEY_ESTADO_FISCAL_PUBLICO).not.toEqual(QUERY_KEY_CONFIG_FISCAL_ADMIN);
  });
});

describe("prueba y activación del padrón ARCA", () => {
  const receptorEmisor: ReceptorPadronArca = {
    cuit: "30714199664",
    razonSocial: "Quimex SA",
    domicilioFiscal: "Córdoba 123",
    estado: "ACTIVO",
    tipoPersona: "JURIDICA",
    condicionIvaConfirmada: "RESPONSABLE_INSCRIPTO",
    verificadoArcaAt: "2026-08-26T12:00:00.000Z",
  };

  function base() {
    return {
      mockMode: false,
      cuitEmisor: receptorEmisor.cuit,
      consultar: vi.fn(async () => receptorEmisor),
      registrarExito: vi.fn(async () => undefined),
      registrarFallo: vi.fn(async () => undefined),
      ahora: () => new Date("2026-08-26T12:00:00.000Z"),
    };
  }

  it("rechaza el modo simulado antes de consultar o persistir una activación", async () => {
    const deps = base();
    const promesa = ejecutarPruebaActivacionPadron({ ...deps, mockMode: true });

    await expect(promesa).rejects.toSatisfy(
      (error: unknown) => codigoErrorFiscalUsuario(error) === "PADRON_CONFIG_INVALIDA",
    );
    expect(deps.consultar).not.toHaveBeenCalled();
    expect(deps.registrarExito).not.toHaveBeenCalled();
    expect(deps.registrarFallo).not.toHaveBeenCalled();
  });

  it("rechaza una fecha inválida antes de consultar o ejecutar callbacks de persistencia", async () => {
    const deps = base();
    const promesa = ejecutarPruebaActivacionPadron({
      ...deps,
      ahora: () => new Date(Number.NaN),
    });

    await expect(promesa).rejects.toSatisfy(
      (error: unknown) => codigoErrorFiscalUsuario(error) === "PADRON_CONFIG_INVALIDA",
    );
    expect(deps.consultar).not.toHaveBeenCalled();
    expect(deps.registrarExito).not.toHaveBeenCalled();
    expect(deps.registrarFallo).not.toHaveBeenCalled();
  });

  it("activa una sola vez cuando ARCA devuelve el CUIT propio", async () => {
    const deps = base();

    await expect(ejecutarPruebaActivacionPadron(deps)).resolves.toEqual({
      cuit: "30714199664",
      razon_social: "Quimex SA",
      probado_at: "2026-08-26T12:00:00.000Z",
    });
    expect(deps.consultar).toHaveBeenCalledWith("30714199664");
    expect(deps.registrarExito).toHaveBeenCalledOnce();
    expect(deps.registrarExito).toHaveBeenCalledWith("2026-08-26T12:00:00.000Z");
    expect(deps.registrarFallo).not.toHaveBeenCalled();
  });

  it("registra RESPUESTA_PADRON_INVALIDA si ARCA devuelve otro CUIT", async () => {
    const deps = base();
    deps.consultar.mockResolvedValue({ ...receptorEmisor, cuit: "30621146315" });

    await expect(ejecutarPruebaActivacionPadron(deps)).rejects.toSatisfy(
      (error: unknown) => codigoErrorFiscalUsuario(error) === "RESPUESTA_PADRON_INVALIDA",
    );
    expect(deps.registrarExito).not.toHaveBeenCalled();
    expect(deps.registrarFallo).toHaveBeenCalledWith({
      codigo: "RESPUESTA_PADRON_INVALIDA",
      fecha: "2026-08-26T12:00:00.000Z",
    });
  });

  it.each<CodigoErrorPadronArca>([
    "PADRON_NO_AUTORIZADO",
    "PADRON_CONFIG_INVALIDA",
    "PADRON_ARCA_CAIDO",
  ])("preserva el código cerrado %s al registrar el fallo", async (codigo) => {
    const deps = base();
    deps.consultar.mockRejectedValue(crearErrorFiscalUsuario(codigo));

    const error = await ejecutarPruebaActivacionPadron(deps).catch((cause) => cause);

    expect(deps.registrarFallo).toHaveBeenCalledWith({
      codigo,
      fecha: "2026-08-26T12:00:00.000Z",
    });
    expect(codigoErrorFiscalUsuario(error)).toBe(codigo);
    expect(mensajeErrorFiscal(error, "CONFIGURACION")).toBe(
      mensajeCodigoErrorFiscalUsuario(codigo),
    );
  });

  it("convierte una excepción no marcada sin filtrar su texto", async () => {
    const deps = base();
    deps.consultar.mockRejectedValue(new Error("SOAP secreto certificado=ABC123"));

    const error = await ejecutarPruebaActivacionPadron(deps).catch((cause) => cause);

    expect(deps.registrarFallo).toHaveBeenCalledWith({
      codigo: "PADRON_CONFIG_INVALIDA",
      fecha: "2026-08-26T12:00:00.000Z",
    });
    expect(codigoErrorFiscalUsuario(error)).toBe("PADRON_CONFIG_INVALIDA");
    expect(mensajeErrorFiscal(error, "CONFIGURACION")).toBe(
      mensajeCodigoErrorFiscalUsuario("PADRON_CONFIG_INVALIDA"),
    );
    expect(mensajeErrorFiscal(error, "CONFIGURACION")).not.toContain("ABC123");
  });

  it("encierra como configuración inválida incluso una excepción hostil", async () => {
    const deps = base();
    const hostil = new Proxy(
      {},
      {
        get() {
          throw new Error("getter secreto");
        },
      },
    );
    deps.consultar.mockRejectedValue(hostil);

    const error = await ejecutarPruebaActivacionPadron(deps).catch((cause) => cause);

    expect(deps.registrarFallo).toHaveBeenCalledWith({
      codigo: "PADRON_CONFIG_INVALIDA",
      fecha: "2026-08-26T12:00:00.000Z",
    });
    expect(codigoErrorFiscalUsuario(error)).toBe("PADRON_CONFIG_INVALIDA");
  });

  it("convierte un fallo de persistencia en PADRON_CONFIG_INVALIDA", async () => {
    const deps = base();
    deps.consultar.mockRejectedValue(crearErrorFiscalUsuario("PADRON_ARCA_CAIDO"));
    deps.registrarFallo.mockRejectedValue(new Error("SQL secreto"));

    const error = await ejecutarPruebaActivacionPadron(deps).catch((cause) => cause);

    expect(codigoErrorFiscalUsuario(error)).toBe("PADRON_CONFIG_INVALIDA");
    expect(mensajeErrorFiscal(error, "CONFIGURACION")).toBe(
      mensajeCodigoErrorFiscalUsuario("PADRON_CONFIG_INVALIDA"),
    );
    expect(mensajeErrorFiscal(error, "CONFIGURACION")).not.toContain("SQL secreto");
  });
});

describe("reset de evidencia ARCA al cambiar el punto de venta", () => {
  it("resetea WSFE y padrón en ambos ambientes cuando cambia el modo", () => {
    expect(actualizacionResetCredencialPorCambioPuntoVenta("HOMOLOGACION", "PRODUCCION")).toEqual({
      ambientes: ["HOMOLOGACION", "PRODUCCION"],
      campos: {
        probada_at: null,
        habilitada: false,
        padron_probado_at: null,
        padron_validacion_activa: false,
        padron_ultimo_error_codigo: null,
        padron_ultimo_error_at: null,
      },
    });
  });

  it("un cambio de número en el mismo modo conserva la evidencia del padrón", () => {
    expect(actualizacionResetCredencialPorCambioPuntoVenta("PRODUCCION", "PRODUCCION")).toEqual({
      ambientes: ["PRODUCCION"],
      campos: { probada_at: null, habilitada: false },
    });
  });
});

describe("acción administrativa de prueba del padrón", () => {
  const entrada = {
    emisor_id: "36d48748-42ff-4aa5-a7d7-d476572cb429",
    ambiente: "PRODUCCION" as const,
  };
  const receptor: ReceptorPadronArca = {
    cuit: "30714199664",
    razonSocial: "Quimex SA",
    domicilioFiscal: "Córdoba 123",
    estado: "ACTIVO",
    tipoPersona: "JURIDICA",
    condicionIvaConfirmada: "RESPONSABLE_INSCRIPTO",
    verificadoArcaAt: "2026-08-26T12:00:00.000Z",
  };

  type Operacion = {
    tabla: string;
    select: string | null;
    filtros: Array<[string, unknown]>;
    update: unknown;
  };

  function clienteAdmin(input?: { consultaError?: Error; actualizacionError?: Error }) {
    const operaciones: Operacion[] = [];
    const cliente = {
      from(tabla: string) {
        const operacion: Operacion = { tabla, select: null, filtros: [], update: null };
        operaciones.push(operacion);
        const builder = {
          select(columnas: string) {
            operacion.select = columnas;
            return builder;
          },
          eq(campo: string, valor: unknown) {
            operacion.filtros.push([campo, valor]);
            return builder;
          },
          update(campos: unknown) {
            operacion.update = campos;
            return builder;
          },
          async maybeSingle() {
            if (operacion.update) {
              return input?.actualizacionError
                ? { data: null, error: input.actualizacionError }
                : {
                    data: { emisor_id: entrada.emisor_id, ambiente: entrada.ambiente },
                    error: null,
                  };
            }
            if (input?.consultaError) return { data: null, error: input.consultaError };
            if (tabla === "emisores") {
              return { data: { id: entrada.emisor_id, cuit: receptor.cuit }, error: null };
            }
            return {
              data: {
                emisor_id: entrada.emisor_id,
                ambiente: entrada.ambiente,
                arca_key_enc: "key-cifrada",
                arca_cert_enc: "cert-cifrado",
              },
              error: null,
            };
          },
        };
        return builder;
      },
    };
    return { cliente, operaciones };
  }

  function deps(
    admin: ReturnType<typeof clienteAdmin>["cliente"],
    consultarPadron = vi.fn(async () => receptor),
  ) {
    return {
      mockMode: false,
      ahora: () => new Date("2026-08-26T12:00:00.000Z"),
      exigirAdmin: vi.fn(async () => undefined),
      crearClientePrivilegiado: vi.fn(async () => admin),
      consultarPadron,
    };
  }

  it("autoriza con el cliente del usuario antes de siquiera crear service-role", async () => {
    const { cliente } = clienteAdmin();
    const userClient = { alcance: "usuario" };
    const dependencias = deps(cliente);
    dependencias.exigirAdmin.mockRejectedValue(new Error("Sólo admin"));

    await expect(
      ejecutarPruebaPadronAdministrativa(
        { entrada, userClient: userClient as never, userId: "admin-id" },
        dependencias as never,
      ),
    ).rejects.toThrow(/sólo admin/i);
    expect(dependencias.exigirAdmin).toHaveBeenCalledWith(userClient, "admin-id");
    expect(dependencias.crearClientePrivilegiado).not.toHaveBeenCalled();
    expect(dependencias.consultarPadron).not.toHaveBeenCalled();
  });

  it("consulta el CUIT propio y activa sólo la credencial exacta del emisor y ambiente", async () => {
    const { cliente, operaciones } = clienteAdmin();
    const dependencias = deps(cliente);

    await expect(
      ejecutarPruebaPadronAdministrativa(
        { entrada, userClient: { alcance: "usuario" } as never, userId: "admin-id" },
        dependencias as never,
      ),
    ).resolves.toEqual({
      cuit: receptor.cuit,
      razon_social: receptor.razonSocial,
      probado_at: "2026-08-26T12:00:00.000Z",
    });

    expect(dependencias.consultarPadron).toHaveBeenCalledWith({
      cuit: receptor.cuit,
      emisor: {
        cuit: receptor.cuit,
        arca_key_enc: "key-cifrada",
        arca_cert_enc: "cert-cifrado",
      },
      ambiente: "PRODUCCION",
      admin: cliente,
    });
    expect(operaciones).toEqual([
      {
        tabla: "emisores",
        select: "id,cuit",
        filtros: [["id", entrada.emisor_id]],
        update: null,
      },
      {
        tabla: "credenciales_arca",
        select: "emisor_id,ambiente,arca_key_enc,arca_cert_enc",
        filtros: [
          ["emisor_id", entrada.emisor_id],
          ["ambiente", "PRODUCCION"],
        ],
        update: null,
      },
      {
        tabla: "credenciales_arca",
        select: "emisor_id,ambiente",
        filtros: [
          ["emisor_id", entrada.emisor_id],
          ["ambiente", "PRODUCCION"],
        ],
        update: {
          padron_probado_at: "2026-08-26T12:00:00.000Z",
          padron_validacion_activa: true,
          padron_ultimo_error_codigo: null,
          padron_ultimo_error_at: null,
        },
      },
    ]);
  });

  it("desactiva la credencial exacta y guarda sólo código cerrado y fecha si ARCA falla", async () => {
    const { cliente, operaciones } = clienteAdmin();
    const consultarPadron = vi.fn(async (): Promise<ReceptorPadronArca> => {
      throw crearErrorFiscalUsuario("PADRON_ARCA_CAIDO");
    });
    const dependencias = deps(cliente, consultarPadron);

    const error = await ejecutarPruebaPadronAdministrativa(
      { entrada, userClient: { alcance: "usuario" } as never, userId: "admin-id" },
      dependencias as never,
    ).catch((cause) => cause);

    expect(codigoErrorFiscalUsuario(error)).toBe("PADRON_ARCA_CAIDO");
    expect(operaciones.at(-1)).toEqual({
      tabla: "credenciales_arca",
      select: "emisor_id,ambiente",
      filtros: [
        ["emisor_id", entrada.emisor_id],
        ["ambiente", "PRODUCCION"],
      ],
      update: {
        padron_probado_at: null,
        padron_validacion_activa: false,
        padron_ultimo_error_codigo: "PADRON_ARCA_CAIDO",
        padron_ultimo_error_at: "2026-08-26T12:00:00.000Z",
      },
    });
    expect(JSON.stringify(operaciones.at(-1))).not.toContain("FISCAL_USUARIO");
  });

  it("no consulta ni activa en mock mode", async () => {
    const { cliente, operaciones } = clienteAdmin();
    const dependencias = { ...deps(cliente), mockMode: true };

    const error = await ejecutarPruebaPadronAdministrativa(
      { entrada, userClient: { alcance: "usuario" } as never, userId: "admin-id" },
      dependencias as never,
    ).catch((cause) => cause);

    expect(codigoErrorFiscalUsuario(error)).toBe("PADRON_CONFIG_INVALIDA");
    expect(dependencias.consultarPadron).not.toHaveBeenCalled();
    expect(operaciones.every((operacion) => operacion.update === null)).toBe(true);
  });

  it("reemplaza un error de persistencia por PADRON_CONFIG_INVALIDA", async () => {
    const { cliente } = clienteAdmin({ actualizacionError: new Error("SQL secreto") });
    const dependencias = deps(cliente);

    const error = await ejecutarPruebaPadronAdministrativa(
      { entrada, userClient: { alcance: "usuario" } as never, userId: "admin-id" },
      dependencias as never,
    ).catch((cause) => cause);

    expect(codigoErrorFiscalUsuario(error)).toBe("PADRON_CONFIG_INVALIDA");
    expect(mensajeErrorFiscal(error, "CONFIGURACION")).toBe(
      mensajeCodigoErrorFiscalUsuario("PADRON_CONFIG_INVALIDA"),
    );
  });

  it("no filtra errores de creación del cliente privilegiado ni de lectura de configuración", async () => {
    const { cliente: clienteLectura, operaciones } = clienteAdmin({
      consultaError: new Error("PostgREST secreto tabla=credenciales"),
    });
    const errorCliente = new Error("SUPABASE_SERVICE_ROLE_KEY=secreto");
    const depsCliente = deps(clienteLectura);
    depsCliente.crearClientePrivilegiado.mockRejectedValue(errorCliente);

    const falloCliente = await ejecutarPruebaPadronAdministrativa(
      { entrada, userClient: { alcance: "usuario" } as never, userId: "admin-id" },
      depsCliente as never,
    ).catch((cause) => cause);

    expect(codigoErrorFiscalUsuario(falloCliente)).toBe("PADRON_CONFIG_INVALIDA");
    expect(mensajeErrorFiscal(falloCliente, "CONFIGURACION")).not.toContain("service_role");
    expect(operaciones).toEqual([]);

    const depsLectura = deps(clienteLectura);
    const falloLectura = await ejecutarPruebaPadronAdministrativa(
      { entrada, userClient: { alcance: "usuario" } as never, userId: "admin-id" },
      depsLectura as never,
    ).catch((cause) => cause);

    expect(codigoErrorFiscalUsuario(falloLectura)).toBe("PADRON_CONFIG_INVALIDA");
    expect(mensajeErrorFiscal(falloLectura, "CONFIGURACION")).not.toContain("credenciales");
    expect(depsLectura.consultarPadron).not.toHaveBeenCalled();
  });
});

describe("prueba read-only de secuencias A/B", () => {
  it("en modo simulado devuelve A/B en cero sin cargar contexto ni credenciales", async () => {
    const ejecutarReal = vi.fn(async () => ({
      secuencia_b: { cbte_tipo: 6 as const, ultimo: 3 },
      secuencia_a: { cbte_tipo: 1 as const, ultimo: 2 },
    }));

    await expect(probarConexionSegunModo(true, ejecutarReal)).resolves.toEqual({
      secuencia_b: { cbte_tipo: 6, ultimo: 0 },
      secuencia_a: { cbte_tipo: 1, ultimo: 0 },
    });
    expect(ejecutarReal).not.toHaveBeenCalled();
  });

  it("consulta por separado B tipo 6 y A tipo 1 y devuelve únicamente ambas secuencias", async () => {
    const tipos: number[] = [];
    const registrarConexion = vi.fn(async () => undefined);

    const resultado = await probarAccesoSecuenciasFactura(
      async (cbteTipo) => {
        tipos.push(cbteTipo);
        return cbteTipo === 6 ? 31 : 7;
      },
      registrarConexion,
      new Date("2026-08-22T16:30:00.000Z"),
    );

    expect(tipos).toEqual([6, 1]);
    expect(resultado).toEqual({
      secuencia_b: { cbte_tipo: 6, ultimo: 31 },
      secuencia_a: { cbte_tipo: 1, ultimo: 7 },
    });
    expect(registrarConexion).toHaveBeenCalledWith({
      probada_at: "2026-08-22T16:30:00.000Z",
    });
  });

  it("no registra conexión si falla cualquiera de las dos consultas", async () => {
    const registrarConexion = vi.fn(async () => undefined);

    await expect(
      probarAccesoSecuenciasFactura(async (cbteTipo) => {
        if (cbteTipo === 1) throw new Error("sin acceso a A");
        return 31;
      }, registrarConexion),
    ).rejects.toThrow(/sin acceso a A/i);
    expect(registrarConexion).not.toHaveBeenCalled();
  });
});

describe("confirmación administrativa de modalidad A", () => {
  const entrada = {
    emisor_id: "36d48748-42ff-4aa5-a7d7-d476572cb429",
    modalidad: "ESTANDAR_CONFIRMADA" as const,
    evidencia: "Constancia de la contadora del 22/08/2026",
    revalidar_at: "2027-08-22",
  };

  it("el esquema es estricto y sólo acepta las dos decisiones soportadas", () => {
    expect(confirmacionModalidadFacturaASchema.parse(entrada)).toEqual(entrada);
    expect(() =>
      confirmacionModalidadFacturaASchema.parse({ ...entrada, modalidad: "DESCONOCIDA" }),
    ).toThrow();
    expect(() =>
      confirmacionModalidadFacturaASchema.parse({ ...entrada, modalidad: "PAGO_CBU" }),
    ).toThrow();
    expect(() =>
      confirmacionModalidadFacturaASchema.parse({ ...entrada, evidencia: "   " }),
    ).toThrow();
    expect(() =>
      confirmacionModalidadFacturaASchema.parse({ ...entrada, revalidar_at: "2026-02-30" }),
    ).toThrow();
    expect(() =>
      confirmacionModalidadFacturaASchema.parse({
        ...entrada,
        confirmada_por: "usuario-del-browser",
      }),
    ).toThrow();
  });

  it("construye usuario y timestamp exclusivamente desde el servidor", () => {
    expect(
      actualizacionModalidadFacturaA(
        entrada,
        "2cfe41cf-06e0-4a29-a315-61c86b9c7019",
        new Date("2026-08-22T17:00:00.000Z"),
      ),
    ).toEqual({
      factura_a_modalidad: "ESTANDAR_CONFIRMADA",
      factura_a_confirmada_at: "2026-08-22T17:00:00.000Z",
      factura_a_confirmada_por: "2cfe41cf-06e0-4a29-a315-61c86b9c7019",
      factura_a_evidencia: "Constancia de la contadora del 22/08/2026",
      factura_a_revalidar_at: "2027-08-22",
    });
  });

  it("autoriza antes de crear o usar el cliente privilegiado", async () => {
    const orden: string[] = [];
    const cliente = { tipo: "service-role" };
    const resultado = await autorizarAntesDeClientePrivilegiado(
      async () => {
        orden.push("autorizar");
      },
      async () => {
        orden.push("crear-admin");
        return cliente;
      },
    );
    expect(orden).toEqual(["autorizar", "crear-admin"]);
    expect(resultado).toBe(cliente);

    const crearDenegado = vi.fn(async () => cliente);
    await expect(
      autorizarAntesDeClientePrivilegiado(async () => {
        throw new Error("Sólo admin");
      }, crearDenegado),
    ).rejects.toThrow(/sólo admin/i);
    expect(crearDenegado).not.toHaveBeenCalled();
  });

  it("falla si la actualización no encontró exactamente al emisor", () => {
    expect(() => exigirEmisorActualizado(null)).toThrow(/emisor.*no existe/i);
    expect(() => exigirEmisorActualizado({ id: entrada.emisor_id })).not.toThrow();
  });

  it("un empleado no recibe evidencia ni controles para editarla", () => {
    const html = renderToStaticMarkup(
      createElement(ModalidadFacturaAEditor, {
        emisor: {
          id: entrada.emisor_id,
          factura_a_modalidad: "ESTANDAR_CONFIRMADA",
          factura_a_confirmada_at: "2026-08-22T17:00:00.000Z",
          factura_a_revalidar_at: "2027-08-22",
          factura_a_evidencia: "SECRETO ADMINISTRATIVO",
        },
        esAdmin: false,
        guardando: false,
        onGuardar: vi.fn(),
      }),
    );

    expect(html).toContain("Factura A estándar");
    expect(html).not.toContain("SECRETO ADMINISTRATIVO");
    expect(html).not.toContain("Fuente o evidencia");
    expect(html).not.toContain("Confirmar modalidad A");
  });
});
