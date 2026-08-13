// Monto en letras, para los recibos.
//
// Un recibo de pago escribe el importe dos veces —en números y en letras— porque
// el número se puede retocar y las letras no. Es la práctica de cualquier recibo
// en papel y la razón por la que existe esto.
//
// Castellano rioplatense: "veintiuno", "un mil" no (se dice "mil"), y el femenino
// de "una" no aplica porque siempre son pesos.

const UNIDADES = [
  "cero",
  "uno",
  "dos",
  "tres",
  "cuatro",
  "cinco",
  "seis",
  "siete",
  "ocho",
  "nueve",
  "diez",
  "once",
  "doce",
  "trece",
  "catorce",
  "quince",
  "dieciséis",
  "diecisiete",
  "dieciocho",
  "diecinueve",
  "veinte",
];
const DECENAS = [
  "",
  "",
  "veinte",
  "treinta",
  "cuarenta",
  "cincuenta",
  "sesenta",
  "setenta",
  "ochenta",
  "noventa",
];
const CENTENAS = [
  "",
  "ciento",
  "doscientos",
  "trescientos",
  "cuatrocientos",
  "quinientos",
  "seiscientos",
  "setecientos",
  "ochocientos",
  "novecientos",
];

function hasta999(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "cien";
  const c = Math.floor(n / 100);
  const r = n % 100;
  const partes: string[] = [];
  if (c > 0) partes.push(CENTENAS[c]);
  if (r > 0) {
    if (r <= 20) partes.push(UNIDADES[r]);
    else {
      const d = Math.floor(r / 10);
      const u = r % 10;
      // 21-29 va junto ("veintiuno"); de 30 para arriba, con "y".
      if (d === 2 && u > 0) partes.push(`veinti${UNIDADES[u]}`);
      else partes.push(u > 0 ? `${DECENAS[d]} y ${UNIDADES[u]}` : DECENAS[d]);
    }
  }
  return partes.join(" ");
}

/** El tope que puede escribir esta función. Más arriba, mentiría. */
export const MAXIMO_EN_LETRAS = 999_999_999;

function enteroEnLetras(n: number): string {
  if (n === 0) return "cero";
  if (n < 0) return `menos ${enteroEnLetras(-n)}`;

  const millones = Math.floor(n / 1_000_000);
  const miles = Math.floor((n % 1_000_000) / 1000);
  const resto = n % 1000;
  const partes: string[] = [];

  if (millones > 0) {
    // `hasta999` sólo sabe hasta 999. Con más de mil millones devolvía "" y el
    // resultado quedaba PLAUSIBLE y equivocado: 1.234.567.890 se leía "treinta y
    // cuatro millones...". El "Son:" del recibo existe justamente para atrapar un
    // número mal tipeado; producirlo mal en silencio es peor que no producirlo.
    if (millones > 999) return "(importe fuera de rango)";
    // "veintiún millones", no "veintiuno millones".
    const m = hasta999(millones)
      .replace(/\bveintiuno$/, "veintiún")
      .replace(/\buno$/, "un");
    partes.push(millones === 1 ? "un millón" : `${m} millones`);
  }
  if (miles > 0) {
    // "mil", no "un mil".
    partes.push(miles === 1 ? "mil" : `${hasta999(miles)} mil`);
  }
  if (resto > 0) partes.push(hasta999(resto));

  return partes.join(" ");
}

/**
 * "1234.50" -> "un mil doscientos treinta y cuatro con 50/100 pesos".
 *
 * Los centavos van en números sobre 100, como en cualquier recibo: escribirlos en
 * letras no agrega seguridad y se lee peor.
 */
export function montoEnLetras(monto: number): string {
  const n = Number.isFinite(monto) ? Math.abs(monto) : 0;
  if (n > MAXIMO_EN_LETRAS) return "(importe fuera de rango)";
  // Los centavos se redondean ANTES de partir el entero: 0.999 daba
  // "cero con 100/100", que no es un centavo válido.
  const total = Math.round(n * 100);
  const entero = Math.floor(total / 100);
  const centavos = total % 100;
  const texto = enteroEnLetras(entero);
  const signo = monto < 0 ? "menos " : "";
  return `${signo}${texto} con ${String(centavos).padStart(2, "0")}/100 pesos`;
}
