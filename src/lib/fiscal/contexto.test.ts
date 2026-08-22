import { describe, expect, it } from "vitest";
import { construirContextoFiscal, validarModalidadFacturaA } from "./contexto";
import { cargarContextoFiscal } from "./contexto.server";

const base = {
  sucursal: {
    id: "s-general-paz",
    nombre: "CasaForma General Paz",
    telefono: "3513229459",
    emisor_id: "e-aplicaciones",
  },
  emisor: {
    id: "e-aplicaciones",
    razon_social: "APLICACIONES Y SERVICIOS S.R.L.",
    nombre_fantasia: "CasaForma",
    cuit: "30714199664",
    domicilio_fiscal: "SARMIENTO 1398",
    condicion_iva: "RESPONSABLE_INSCRIPTO" as const,
    ingresos_brutos: "280970280",
    inicio_actividades: "2018-09-01",
    factura_a_modalidad: "ESTANDAR_CONFIRMADA" as const,
    factura_a_revalidar_at: "2027-08-22",
  },
  pv: {
    sucursal_id: "s-general-paz",
    emisor_id: "e-aplicaciones",
    numero: 5,
    modo: "PRODUCCION" as const,
    activo: true,
  },
  credencial: {
    emisor_id: "e-aplicaciones",
    ambiente: "PRODUCCION" as const,
    arca_key_enc: "key",
    arca_cert_enc: "cert",
    habilitada: true,
  },
};

describe("contexto fiscal multiemisor", () => {
  it("resuelve CUIT, PV y contacto desde la sucursal", () => {
    const r = construirContextoFiscal(base, { exigirHabilitada: true });

    expect(r.emisor.cuit).toBe("30714199664");
    expect(r.emisorImpreso.telefono).toBe("3513229459");
    expect(r.pv).toEqual({ numero: 5, modo: "PRODUCCION" });
    expect(r.facturaA).toEqual({
      modalidad: "ESTANDAR_CONFIRMADA",
      revalidar_at: "2027-08-22",
    });
  });

  it("General Paz no acepta el emisor, PV ni credencial de O'Higgins", () => {
    const sas = {
      ...base.emisor,
      id: "e-grupo",
      razon_social: "GRUPO CASA FORMA S.A.S.",
      cuit: "30717322467",
    };

    expect(() =>
      construirContextoFiscal(
        {
          ...base,
          emisor: sas,
          pv: { ...base.pv, emisor_id: sas.id },
          credencial: { ...base.credencial, emisor_id: sas.id },
        },
        { exigirHabilitada: true },
      ),
    ).toThrow(/emisor.*sucursal/i);
  });

  it("rechaza un PV de otro emisor", () => {
    expect(() =>
      construirContextoFiscal(
        { ...base, pv: { ...base.pv, emisor_id: "e-grupo" } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/punto de venta.*emisor/i);
  });

  it("rechaza el PV de otra sucursal aunque pertenezca al mismo emisor", () => {
    expect(() =>
      construirContextoFiscal(
        { ...base, pv: { ...base.pv, sucursal_id: "s-otra" } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/punto de venta.*sucursal/i);
  });

  it("rechaza una credencial de otro emisor o ambiente", () => {
    expect(() =>
      construirContextoFiscal(
        { ...base, credencial: { ...base.credencial, emisor_id: "e-grupo" } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/credencial.*producción/i);
    expect(() =>
      construirContextoFiscal(
        { ...base, credencial: { ...base.credencial, ambiente: "HOMOLOGACION" } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/credencial.*producción/i);
  });

  it("rechaza credencial ausente, incompleta o deshabilitada", () => {
    expect(() =>
      construirContextoFiscal({ ...base, credencial: null }, { exigirHabilitada: true }),
    ).toThrow(/credencial.*producción/i);
    expect(() =>
      construirContextoFiscal(
        { ...base, credencial: { ...base.credencial, arca_cert_enc: null } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/certificado/i);
    expect(() =>
      construirContextoFiscal(
        { ...base, credencial: { ...base.credencial, habilitada: false } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/deshabilitada/i);
  });

  it("permite inspeccionar una credencial completa aunque todavía esté deshabilitada", () => {
    const r = construirContextoFiscal(
      { ...base, credencial: { ...base.credencial, habilitada: false } },
      { exigirHabilitada: false },
    );

    expect(r.emisor.cuit).toBe("30714199664");
  });

  it("falla cerrado si faltan datos legales o el PV está inactivo", () => {
    expect(() =>
      construirContextoFiscal(
        { ...base, emisor: { ...base.emisor, inicio_actividades: null } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/datos fiscales obligatorios/i);
    expect(() =>
      construirContextoFiscal(
        { ...base, emisor: { ...base.emisor, cuit: "30714199665" } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/CUIT.*inválido/i);
    expect(() =>
      construirContextoFiscal(
        { ...base, pv: { ...base.pv, activo: false } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/inactivo/i);
    expect(() =>
      construirContextoFiscal(
        { ...base, pv: { ...base.pv, numero: 0 } },
        { exigirHabilitada: true },
      ),
    ).toThrow(/número.*punto de venta/i);
  });
});

describe("modalidad administrativa de Factura A", () => {
  const ahora = new Date("2026-08-22T15:00:00.000Z");

  it.each([
    ["DESCONOCIDA", "2027-08-22"],
    ["NO_SOPORTADA", "2027-08-22"],
    ["ESTANDAR_CONFIRMADA", null],
    ["ESTANDAR_CONFIRMADA", "fecha-invalida"],
    ["ESTANDAR_CONFIRMADA", "2026-08-21"],
  ] as const)("bloquea A con modalidad %s y revalidación %s", (modalidad, revalidarAt) => {
    expect(() => validarModalidadFacturaA("A", modalidad, revalidarAt, ahora)).toThrow(
      /Factura A|modalidad|revalid/i,
    );
  });

  it("permite A estándar con evidencia vigente, incluido el día de revalidación", () => {
    expect(() =>
      validarModalidadFacturaA("A", "ESTANDAR_CONFIRMADA", "2026-08-22", ahora),
    ).not.toThrow();
  });

  it.each(["B", "C"] as const)("no condiciona la letra %s a evidencia de A", (letra) => {
    expect(() => validarModalidadFacturaA(letra, "DESCONOCIDA", null, ahora)).not.toThrow();
  });

  it("falla cerrado ante una modalidad guardada fuera de la allowlist", () => {
    expect(() =>
      validarModalidadFacturaA(
        "A",
        "VARIANTE_ESPECIAL" as "ESTANDAR_CONFIRMADA",
        "2027-08-22",
        ahora,
      ),
    ).toThrow(/modalidad/i);
  });
});

describe("resolución server-side por sucursal", () => {
  it("filtra PV y credencial con el emisor APLI vinculado a General Paz", async () => {
    const consultas: Array<{ tabla: string; filtros: Array<[string, unknown]> }> = [];
    const respuestas: Record<string, unknown> = {
      sucursales: {
        id: base.sucursal.id,
        nombre: base.sucursal.nombre,
        telefono: base.sucursal.telefono,
        emisor_id: base.sucursal.emisor_id,
        emisor: base.emisor,
      },
      puntos_venta: base.pv,
      credenciales_arca: base.credencial,
    };
    const sb = {
      from(tabla: string) {
        const consulta = { tabla, filtros: [] as Array<[string, unknown]> };
        consultas.push(consulta);
        const cadena = {
          select() {
            return cadena;
          },
          eq(campo: string, valor: unknown) {
            consulta.filtros.push([campo, valor]);
            return cadena;
          },
          async maybeSingle() {
            return { data: respuestas[tabla], error: null };
          },
        };
        return cadena;
      },
    };

    const resultado = await cargarContextoFiscal(sb as never, base.sucursal.id);

    expect(resultado.emisor.cuit).toBe("30714199664");
    expect(resultado.pv.numero).toBe(5);
    expect(resultado.emisor.arca_key_enc).toBe("key");
    expect(consultas).toEqual([
      { tabla: "sucursales", filtros: [["id", "s-general-paz"]] },
      { tabla: "puntos_venta", filtros: [["sucursal_id", "s-general-paz"]] },
      {
        tabla: "credenciales_arca",
        filtros: [
          ["emisor_id", "e-aplicaciones"],
          ["ambiente", "PRODUCCION"],
        ],
      },
    ]);
  });
});
