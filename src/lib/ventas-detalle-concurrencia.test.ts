import { describe, expect, it } from "vitest";
import { crearSecuenciadorDetalleVenta } from "./ventas-detalle-concurrencia";

function diferida<T>() {
  let resolver!: (valor: T) => void;
  const promesa = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return { promesa, resolver };
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
});
