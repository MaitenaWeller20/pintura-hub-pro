import { describe, expect, it } from "vitest";
import { crearSecuenciadorDetalleVenta } from "./ventas-detalle-concurrencia";

function diferida<T>() {
  let resolver!: (valor: T) => void;
  let rechazar!: (error: unknown) => void;
  const promesa = new Promise<T>((resolve, reject) => {
    resolver = resolve;
    rechazar = reject;
  });
  return { promesa, resolver, rechazar };
}

describe("detalle de ventas concurrente", () => {
  it("ignora una respuesta lenta anterior después de abrir la última selección", async () => {
    const secuenciador = crearSecuenciadorDetalleVenta();
    const primera = diferida<string>();
    const ultima = diferida<string>();
    const detallesAbiertos: string[] = [];

    const solicitar = async (respuesta: Promise<string>) => {
      const solicitud = secuenciador.iniciar();
      const detalle = await respuesta;
      if (secuenciador.esVigente(solicitud)) detallesAbiertos.push(detalle);
    };

    const cargaPrimera = solicitar(primera.promesa);
    const cargaUltima = solicitar(ultima.promesa);

    ultima.resolver("venta-ultima");
    await cargaUltima;
    primera.resolver("venta-anterior");
    await cargaPrimera;

    expect(detallesAbiertos).toEqual(["venta-ultima"]);
  });

  it("ignora el rechazo anterior y no muestra toast después de una selección nueva", async () => {
    const secuenciador = crearSecuenciadorDetalleVenta();
    const anterior = diferida<string>();
    const ultima = diferida<string>();
    const errores: string[] = [];

    const solicitar = async (respuesta: Promise<string>) => {
      const solicitud = secuenciador.iniciar();
      try {
        await respuesta;
      } catch {
        if (secuenciador.esVigente(solicitud)) errores.push("toast");
      }
    };

    const cargaAnterior = solicitar(anterior.promesa);
    const cargaUltima = solicitar(ultima.promesa);
    ultima.resolver("venta-ultima");
    await cargaUltima;
    anterior.rechazar(new Error("respuesta vieja"));
    await cargaAnterior;

    expect(errores).toEqual([]);
  });

  it("sólo la solicitud más nueva puede limpiar su estado de carga", async () => {
    const secuenciador = crearSecuenciadorDetalleVenta();
    const anterior = diferida<string>();
    const ultima = diferida<string>();
    let cargando: string | null = null;

    const solicitar = async (id: string, respuesta: Promise<string>) => {
      const solicitud = secuenciador.iniciar();
      cargando = id;
      try {
        await respuesta;
      } finally {
        if (secuenciador.esVigente(solicitud)) cargando = null;
      }
    };

    const cargaAnterior = solicitar("venta-anterior", anterior.promesa);
    const cargaUltima = solicitar("venta-ultima", ultima.promesa);
    anterior.resolver("venta-anterior");
    await cargaAnterior;
    expect(cargando).toBe("venta-ultima");
    ultima.resolver("venta-ultima");
    await cargaUltima;
    expect(cargando).toBeNull();
  });

  it("invalida al desmontar y bloquea success, toast y finally tardíos", async () => {
    const secuenciador = crearSecuenciadorDetalleVenta();
    const pendiente = diferida<string>();
    const efectos: string[] = [];
    const solicitud = secuenciador.iniciar();

    const carga = pendiente.promesa
      .then(() => {
        if (secuenciador.esVigente(solicitud)) efectos.push("success");
      })
      .catch(() => {
        if (secuenciador.esVigente(solicitud)) efectos.push("toast");
      })
      .finally(() => {
        if (secuenciador.esVigente(solicitud)) efectos.push("loading");
      });

    secuenciador.invalidar();
    pendiente.rechazar(new Error("terminó después del unmount"));
    await carga;

    expect(efectos).toEqual([]);
  });
});
