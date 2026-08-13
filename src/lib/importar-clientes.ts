// Importar una lista de clientes desde un archivo.
//
// El caso: la clienta migra desde 3C Informática y tiene ~1400 clientes en un
// listado. Cargarlos a mano no es una opción, y `/clientes` ya sabe crear uno.
// Ver docs/superpowers/specs/2026-08-04-importar-clientes-design.md
//
// QUÉ SE IMPORTA, decidido por Leo el 04/08:
//
//   Razón social  → razon_social
//   CUIT          → cuit_dni
//   Cta Cte (S/N) → condicion_cta_cte
//   Domicilio     → direccion
//   Teléfono      → telefono
//
// Y qué NO, también decidido: la categoría de IVA, el número de lista de precios
// y el estado (H/B) del sistema viejo. Ojo con la primera: sin ella todos entran
// como CONSUMIDOR_FINAL, que es el default de la tabla — está anotado en la spec
// porque cambia qué comprobante se les emite.

import { normalizar } from "./importar-productos";
import { soloDigitos } from "./documento";
import { validarCuitDni } from "./fiscal/codigos";

export type ColumnasCliente = {
  razon_social: string | null;
  cuit: string | null;
  cta_cte: string | null;
  domicilio: string | null;
  telefono: string | null;
};

const SINONIMOS: Record<keyof ColumnasCliente, string[]> = {
  razon_social: ["razonsocial", "razon", "nombre", "cliente", "denominacion", "apellidoynombre"],
  cuit: ["cuit", "cuitdni", "cuil", "dni", "documento", "cuitcuil"],
  cta_cte: ["ctacte", "cuentacorriente", "ctacorriente", "cc"],
  domicilio: ["domicilio", "direccion", "dom"],
  telefono: ["telefono", "tel", "celular", "telefonos"],
};

export function detectarColumnasCliente(encabezados: string[]): ColumnasCliente {
  const out: ColumnasCliente = {
    razon_social: null,
    cuit: null,
    cta_cte: null,
    domicilio: null,
    telefono: null,
  };
  for (const campo of Object.keys(SINONIMOS) as Array<keyof ColumnasCliente>) {
    const syn = SINONIMOS[campo];
    out[campo] =
      encabezados.find((h) => syn.includes(normalizar(h))) ??
      encabezados.find((h) => syn.some((s) => normalizar(h).startsWith(s))) ??
      null;
  }
  return out;
}

export type ClienteNuevo = {
  razon_social: string;
  cuit_dni: string | null;
  condicion_cta_cte: boolean;
  direccion: string | null;
  telefono: string | null;
};

export type ClienteExistente = { razon_social: string; cuit_dni: string | null };

export type ResultadoClientes = {
  filasLeidas: number;
  aCrear: ClienteNuevo[];
  /** Sin razón social: no se puede crear un cliente sin nombre. */
  sinNombre: number;
  /** CUIT repetido DENTRO del archivo. Se sacan todos (decisión de Leo). */
  cuitRepetido: Array<{ cuit: string; razon_social: string }>;
  /** El CUIT ya existe en la base. */
  yaExistenPorCuit: Array<{ cuit: string; razon_social: string }>;
  /** El nombre ya está en la base (con o sin CUIT). Posible duplicado. */
  yaExistenPorNombre: string[];
  /** Sin CUIT y con el nombre repetido dentro del archivo. */
  nombreRepetido: string[];
  /** El CUIT/DNI no es válido. Se reporta, no se corrige. */
  cuitInvalido: Array<{ cuit: string; razon_social: string; motivo: string }>;
};

/**
 * CUIT comparable: sólo los dígitos. Vive en `./documento`, se re-exporta acá
 * porque era de este módulo y varios lo importan desde acá.
 *
 * Es la MISMA normalización que usa el índice único de la base
 * (`regexp_replace(cuit_dni, '\D', '', 'g')` en `uq_clientes_cuit_dni_activo`).
 * Si acá se comparara el texto tal cual, "30-12345678-9" y "30123456789" pasarían
 * como distintos y el INSERT reventaría contra el índice a mitad del lote.
 */
export { soloDigitos };

/** Nombre comparable: sin acentos, sin dobles espacios, sin mayúsculas. */
export const claveNombre = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const texto = (v: unknown) => String(v ?? "").trim();
const oNull = (v: string) => (v === "" ? null : v);

/**
 * Cruza el archivo contra los clientes que ya existen y arma la lista a crear.
 *
 * Todo lo que no entra se REPORTA, nunca se resuelve solo. Duplicar un cliente
 * es peor que no crearlo: la cuenta corriente y el historial de ventas quedan
 * partidos entre dos fichas y arreglarlo después es a mano.
 */
export function procesarClientes(
  filas: Array<Record<string, unknown>>,
  cols: ColumnasCliente,
  existentes: ClienteExistente[],
): ResultadoClientes {
  const cuitsEnBase = new Set(
    existentes.map((c) => soloDigitos(c.cuit_dni)).filter((c) => c !== ""),
  );
  const nombresEnBase = new Set(existentes.map((c) => claveNombre(c.razon_social)));

  // Primera pasada: contar CUIT y nombres para detectar los repetidos ANTES de
  // decidir nada. Resolviéndolo sobre la marcha entraría el primero y quedaría
  // afuera el segundo, que es elegir al azar cuál de los dos es el bueno.
  const vecesCuit = new Map<string, number>();
  const vecesNombre = new Map<string, number>();
  for (const f of filas) {
    const cuit = soloDigitos(cols.cuit ? f[cols.cuit] : "");
    const nombre = claveNombre(cols.razon_social ? f[cols.razon_social] : "");
    if (cuit) vecesCuit.set(cuit, (vecesCuit.get(cuit) ?? 0) + 1);
    else if (nombre) vecesNombre.set(nombre, (vecesNombre.get(nombre) ?? 0) + 1);
  }

  const aCrear: ClienteNuevo[] = [];
  const cuitRepetido: ResultadoClientes["cuitRepetido"] = [];
  const yaExistenPorCuit: ResultadoClientes["yaExistenPorCuit"] = [];
  const yaExistenPorNombre: string[] = [];
  const cuitInvalido: ResultadoClientes["cuitInvalido"] = [];
  // Array y NO Set: un Set colapsa dos filas escritas igual y entonces el
  // resumen deja de cerrar — se saltean dos filas y se lista una sola. Toda fila
  // leída tiene que aparecer en exactamente una categoría, o la pantalla está
  // ocultando algo.
  const nombreRepetido: string[] = [];
  let sinNombre = 0;

  for (const f of filas) {
    const razon = texto(cols.razon_social ? f[cols.razon_social] : "");
    if (!razon) {
      sinNombre++;
      continue;
    }
    const cuitBruto = texto(cols.cuit ? f[cols.cuit] : "");
    const cuit = soloDigitos(cuitBruto);

    if (cuit) {
      // La misma validación que el alta a mano. Un CUIT inventado se guardaría
      // igual y recién explotaría al querer facturarle a ese cliente.
      const motivo = validarCuitDni(cuitBruto);
      if (motivo) {
        cuitInvalido.push({ cuit: cuitBruto, razon_social: razon, motivo });
        continue;
      }
      if ((vecesCuit.get(cuit) ?? 0) > 1) {
        cuitRepetido.push({ cuit: cuitBruto, razon_social: razon });
        continue;
      }
      if (cuitsEnBase.has(cuit)) {
        yaExistenPorCuit.push({ cuit: cuitBruto, razon_social: razon });
        continue;
      }
    } else {
      const k = claveNombre(razon);
      if ((vecesNombre.get(k) ?? 0) > 1) {
        nombreRepetido.push(razon);
        continue;
      }
    }

    // El nombre se chequea contra la base SIEMPRE, tenga CUIT o no.
    //
    // La primera versión sólo lo hacía cuando la fila venía sin CUIT, y eso
    // dejaba pasar el caso más probable de esta migración: "ACME" ya cargado a
    // mano sin CUIT, y el archivo viejo trae "ACME" con CUIT. Entraba como
    // cliente nuevo y quedaban dos fichas del mismo cliente, con la cuenta
    // corriente partida al medio.
    //
    // Sí, esto también frena a dos empresas distintas que se llamen igual. Es el
    // lado barato de equivocarse: se agregan a mano en dos minutos. Al revés hay
    // que fusionar movimientos.
    if (nombresEnBase.has(claveNombre(razon))) {
      yaExistenPorNombre.push(razon);
      continue;
    }

    // "S" es sí; cualquier otra cosa (N, vacío) es no. Se pregunta por lo que
    // habilita, no por lo que niega: un valor raro no puede terminar dándole
    // cuenta corriente a alguien.
    const cc = texto(cols.cta_cte ? f[cols.cta_cte] : "").toUpperCase();

    aCrear.push({
      razon_social: razon,
      // Normalizado, igual que el alta a mano. Guardar el texto crudo del
      // archivo ("30-71582607-7") fue el origen del bug: el índice único
      // comparaba la forma normalizada y los buscadores el texto, así que un
      // CUIT ya cargado rebotaba al darlo de alta y no se podía encontrar.
      // El trigger `normalizar_cuit_dni` lo garantiza igual del lado de la base.
      cuit_dni: oNull(cuit),
      condicion_cta_cte: cc === "S" || cc === "SI" || cc === "SÍ" || cc === "TRUE",
      direccion: oNull(texto(cols.domicilio ? f[cols.domicilio] : "").replace(/\s{2,}/g, " ")),
      telefono: oNull(texto(cols.telefono ? f[cols.telefono] : "")),
    });
  }

  return {
    filasLeidas: filas.length,
    aCrear,
    sinNombre,
    cuitRepetido,
    yaExistenPorCuit,
    yaExistenPorNombre,
    nombreRepetido,
    cuitInvalido,
  };
}
