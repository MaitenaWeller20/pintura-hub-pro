/**
 * Prender un producto apagado — la regla, en un solo lugar.
 *
 * Un producto se da de alta APAGADO cuando entra sin precio (la importación de
 * stock y el alta rápida de ingresos lo hacen a propósito: activo = precio > 0),
 * para que nadie lo venda a $0. Lo que faltaba era la puerta de salida: hasta el
 * 10/08/2026 no había NINGUNA forma de prenderlo desde la app salvo reimportar la
 * lista de precios, y eso sólo funciona si el precio guardado todavía es 0. La
 * clienta les cargó el precio con "Cambiar precios" —que no toca `activo`, no es
 * su tema— y quedaron con precio y apagados, o sea invendibles y sin salida.
 * Ver docs/superpowers/specs/2026-08-10-activar-productos-design.md
 *
 * La regla vive acá porque la usan DOS pantallas: el switch del diálogo de
 * edición y el botón "Activar" masivo. Que puedan divergir es el riesgo real —
 * es el mismo error que tuvo la fórmula de precios copiada en cuatro lados.
 */

export type ProductoActivable = {
  id: string;
  activo?: boolean | null;
  archivado?: boolean | null;
  precio_sin_iva?: number | string | null;
};

/**
 * Por qué NO se puede prender. `null` = se puede.
 *
 * Devuelve UN motivo, como `faltanteUsuario`: la pantalla tiene que decir qué
 * hacer ahora, no listar reglas. Un control deshabilitado y mudo es el bug que
 * generó el reporte "no me deja crear usuarios".
 */
export function motivoNoActivar(p: ProductoActivable): string | null {
  // Primero el archivado: un archivado sin precio tiene los dos problemas, y el
  // que hay que resolver primero es que está borrado.
  if (p.archivado) {
    return "Está archivado. Restauralo desde la lista y después prendelo.";
  }
  if (Number(p.precio_sin_iva ?? 0) <= 0) {
    return "Sin precio no se puede prender: se vendería a $0. Cargale el precio s/IVA.";
  }
  return null;
}

/** Atajo para los `disabled` de la pantalla. */
export function puedeActivar(p: ProductoActivable): boolean {
  return motivoNoActivar(p) === null;
}

export type Reparto = {
  /** Los que el botón va a prender. */
  prender: string[];
  /** Cuántos quedan afuera porque no tienen precio. Se dicen en el toast. */
  sinPrecio: number;
  /** Cuántos de los seleccionados están apagados. Si es 0, el botón no aparece. */
  apagados: number;
};

/**
 * Parte la selección en lo que se prende y lo que no.
 *
 * Los que YA están activos no cuentan para nada: ni se prenden ni se reportan.
 * Seleccionar toda la lista y apretar Activar tiene que decir "3 activados", no
 * "1104 activados".
 *
 * Los archivados se cuentan como apagados pero no se prenden. En la práctica no
 * llegan (el botón sólo se muestra cuando no se están viendo los archivados),
 * pero si llegaran, prenderlos fabricaría una fila que dice "Archivado" y está
 * viva a la vez — y `crear_venta` mira `activo`, no `archivado`.
 */
export function activables(seleccionados: ProductoActivable[]): Reparto {
  const apagados = seleccionados.filter((p) => !p.activo);
  return {
    prender: apagados.filter(puedeActivar).map((p) => p.id),
    sinPrecio: apagados.filter((p) => !p.archivado && Number(p.precio_sin_iva ?? 0) <= 0).length,
    apagados: apagados.length,
  };
}
