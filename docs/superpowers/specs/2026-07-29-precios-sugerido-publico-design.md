# Precio de venta desde el sugerido al público — Diseño

**Fecha:** 2026-07-29
**Estado:** Spec escrito. Pendiente: review del cliente, review con Codex, implementación.
**Viene de:** `2026-07-29-correcciones-cliente-backlog.md` §1 y §2.

---

## 1. El problema

El sistema vende **por debajo del precio que el propio proveedor sugiere**. Comprobado con
`4000-00400` (*IMPER* POLIURETANICA MEMBRANA LIQUIDA x4), lista Quimexur N° 125:

| | |
|---|---|
| Precio de lista Quimex (s/IVA) | $30.774,40 |
| Sugerido al público C/IVA (lo trae la misma lista) | $34.370,60 |
| **Lo que el sistema pone en góndola** | **$28.076,76** |

La causa es que el precio de venta se deriva **del costo**:

```
costo          = precio_lista × (1 − 42%)          = 17.849,15
precio_sin_iva = costo × (1 + 30% markup)          = 23.203,90
venta c/IVA    = precio_sin_iva × (1 + 21%)        = 28.076,72
```

(La pantalla muestra $28.076,76 y no $28.076,72 porque el producto en producción se importó de la
lista N° 123, con un precio de lista de unos centavos de diferencia. Los números de esta spec salen
de la N° 125, la del Excel que fotografió el cliente. La diferencia es del dato, no del cálculo.)

La columna **"Sugerido al público C/IVA"** de la lista **no se usa en ningún lado**: no existe en
`FIELDS_TARGET` (`src/lib/importar-productos.ts`), no existe como columna en `productos`, y no
aparece en ninguna pantalla. El negocio la mira en el Excel y la ignora el sistema.

Dos síntomas más, del mismo problema:

- **La pantalla de importar dejó mapear mal.** En la captura del cliente, `PRECIO DE LISTA` quedó
  mapeado a dos campos a la vez (*Precio de lista* y *Precio fábrica*) y `Sugerido al público
  C/IVA` terminó dentro de **IVA %**. Lo segundo no rompió porque hay una guarda que descarta un
  IVA fuera de `[0,100]` (`productos.importar.tsx:257`), pero la pantalla no dijo nada. El cliente:
  *"esta parte está media confusa"*.
- **El cálculo vive en cuatro lugares distintos**, cada uno con su propia copia de la fórmula:

  | Dónde | Qué hace |
  |---|---|
  | `productos.importar.tsx:208-221` | deriva costo y precio al importar |
  | `productos.index.tsx:62-66` (`calcPrecio`, `costoDeLista`) | el diálogo de alta/edición |
  | `productos.index.tsx:365` | el c/IVA que muestra la tabla |
  | `cobranzas.functions.ts:75-80` (`aplicarMarkup`) | el markup masivo |

  Cuatro copias con tres fallbacks distintos del markup default (`?? 50` en tres lugares, cuando
  `settings` dice 30). Cambiar la fórmula en una sola no alcanza.

---

## 2. Objetivos y no-objetivos

### Objetivos

1. Que el precio de venta salga del **sugerido al público × (1 + markup)** cuando el producto tiene
   sugerido.
2. Que la lista de precios **importe y guarde** el sugerido al público.
3. Que se vean las **cinco columnas** que pidió el cliente, tanto en la vista previa de la
   importación como en la tabla de productos.
4. Que la fórmula viva en **un solo archivo**, testeado, y que las cuatro pantallas lo usen.

### No-objetivos (YAGNI)

- **Recalcular los precios de producción con una migración SQL.** No se puede (el sugerido nunca se
  guardó) y no se debe: subir todos los precios ~59% de un saque tiene que ser un acto deliberado
  del negocio, no un efecto secundario de un deploy. Ver §9.
- **Proveedor por producto, filtro por proveedor, descuento por proveedor.** Es el chunk siguiente
  (backlog §3). Acá el descuento sigue siendo global en `settings`.
- **Redondeo comercial** (a $10, a $100, terminaciones en 9). Nadie lo pidió.
- **Historial de precios.** No se pidió y no existe hoy.
- **Batchear `aplicarMarkup`.** Hoy hace un `UPDATE` por producto en un loop. Con la selección
  actual (a mano) alcanza; cuando el chunk §3 permita seleccionar los cientos de productos de un
  proveedor de una, hay que medirlo. Se anota, no se hace acá.

---

## 3. La cadena de precios nueva

```
DATOS QUE TRAE LA LISTA DEL PROVEEDOR
  precio_lista                          s/IVA    obligatorio para derivar el costo
  precio_sugerido_publico               c/IVA    opcional — sólo Quimex lo trae

COSTO (lo que le pagan al proveedor)
  precio_fabrica = precio_lista × (1 − descuento/100)            s/IVA
  costo_c_iva    = precio_fabrica × (1 + iva/100)                sólo para mostrar

VENTA
  si precio_sugerido_publico > 0:          ← origen: "sugerido"
      venta_c_iva    = precio_sugerido_publico × (1 + markup/100)
      precio_sin_iva = venta_c_iva / (1 + iva/100)
  si no:                                   ← origen: "costo"  (el cálculo de hoy)
      precio_sin_iva = precio_fabrica × (1 + markup/100)
      venta_c_iva    = precio_sin_iva × (1 + iva/100)

  markup = productos.markup_porcentaje ?? settings.markup_default_porcentaje
```

Con los números reales:

| | con sugerido | sin sugerido |
|---|---|---|
| precio_lista | 30.774,40 | 30.774,40 |
| precio_fabrica (−42%) | 17.849,15 | 17.849,15 |
| costo_c_iva | 21.597,47 | 21.597,47 |
| precio_sugerido_publico | 34.370,60 | — |
| precio_sin_iva (guardado) | **36.927,09** | 23.203,90 |
| venta c/IVA | **44.681,78** | 28.076,72 |

### Por qué se sigue guardando `precio_sin_iva`

Porque es lo que se factura. `venta_items.precio_lista_sin_iva` y toda la facturación AFIP leen el
neto y el % de IVA por separado. El sugerido viene c/IVA, así que se **des-IVA-iza al guardar** y
`precio_sin_iva` sigue siendo el único número que las ventas consultan. No cambia nada aguas abajo.

**Regla de redondeo:** `precio_sin_iva` se redondea a 2 decimales al guardar, y el c/IVA que
muestran las pantallas **siempre se deriva de ese `precio_sin_iva` guardado** — nunca se muestra el
`sugerido × markup` crudo. Puede dar un centavo de diferencia contra la multiplicación directa, y
eso es deliberado: lo que se ve en pantalla tiene que coincidir con lo que va a salir en la
factura, no con un número intermedio.

---

## 4. Base de datos

Una columna. Nada más.

```sql
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS precio_sugerido_publico numeric(14,2);
```

**Nullable a propósito**, sin `DEFAULT 0`: hay que poder distinguir *"este producto no tiene precio
sugerido"* de *"su sugerido es cero"*. `precio_lista` se creó como `NOT NULL DEFAULT 0` y por eso
hoy el código tiene que preguntar `precio_lista > 0` para saber si existe — no se repite el error.

No hace falta tocar RLS ni grants: la escritura de `productos` ya es admin-only por política
existente. Después de la migración hay que **regenerar `src/integrations/supabase/types.ts`**.

---

## 5. `src/lib/precios.ts` — la única fuente de verdad

Archivo nuevo, sin dependencias de red ni de React, testeado con vitest. Reemplaza las cuatro
copias de la fórmula.

```ts
export const MARKUP_DEFAULT = 30;              // reemplaza los tres `?? 50` sueltos
export const DESCUENTO_PROVEEDOR_DEFAULT = 42;

export type EntradaPrecio = {
  precio_lista?: number | null;
  precio_fabrica?: number | null;
  precio_sugerido_publico?: number | null;
  markup_porcentaje?: number | null;
  iva_porcentaje?: number | null;
};

export type PrecioCalculado = {
  precio_fabrica: number;    // costo s/IVA
  costo_c_iva: number;       // display
  precio_sin_iva: number;    // lo que se guarda y se factura
  venta_c_iva: number;       // display, derivado de precio_sin_iva
  markup: number;            // el efectivo (propio o default)
  origen: "sugerido" | "costo";
};

export function costoDeLista(lista: number, descuento: number): number;
export function calcularPrecios(
  e: EntradaPrecio,
  p: { descuento: number; markupDefault: number },
): PrecioCalculado;
```

`precio_fabrica` se resuelve como hoy: si viene `precio_lista > 0` se deriva con el descuento; si
no, se usa el `precio_fabrica` que le pasen. Esa precedencia no cambia.

`origen` es lo que alimenta la marquita de la tabla y el contador de la importación.

---

## 6. Pantalla de importar

### 6.1 El campo nuevo

En `FIELDS_TARGET` (`src/lib/importar-productos.ts`):

```ts
{ key: "precio_sugerido_publico", label: "Sugerido al público (C/IVA)" }
```

Sinónimos: `sugeridoalpublicociva`, `sugeridoalpublico`, `preciosugerido`, `sugerido`,
`preciopublico`, `pvp`.

**Va ubicado antes de `precio_sin_iva` en el array**, y esto importa: `autoMapear` reclama las
cabeceras en orden y las marca como usadas. `precio_sin_iva` tiene `"precio"` entre sus sinónimos,
así que una cabecera `PRECIO SUGERIDO AL PUBLICO` se la quedaría él si fuera primero. Poniéndolo
antes, el sugerido gana. Como beneficio adicional queda también antes de `iva_porcentaje`, que era
el campo al que se enganchaba en la captura del cliente.

### 6.2 Avisos (no bloqueos)

La pantalla avisa, en amarillo, arriba de la vista previa:

1. **Una misma columna mapeada en dos campos.** Es lo que le pasó al cliente. No rompe (hay
   precedencias que lo salvan) pero casi nunca es lo que quiso hacer.
2. **El archivo tiene una columna que parece "sugerido" y no está mapeada.** Sin esto, re-importar
   olvidándose de mapearla haría que los precios vuelvan silenciosamente al cálculo por costo — el
   bug que esta spec arregla, de vuelta y sin que nadie se entere.

Ninguno de los dos bloquea el botón. El botón sigue pidiendo sólo Código y Nombre.

### 6.3 Qué se escribe

- `precio_sugerido_publico` entra al payload **sólo si la columna está mapeada**. Si no está
  mapeada, la clave se omite y el upsert **no pisa** lo que ya estaba guardado. Re-importar una
  lista parcial no debe borrar el sugerido de los productos que no vinieron en ella.
- Si la columna **está** mapeada pero la celda de esa fila está vacía o no es un número, se escribe
  `null` — ese producto no tiene sugerido en esta lista y su precio pasa a derivarse del costo. Es
  el mismo criterio que ya usa `tamano_envase`.
- La validación de `LIMITE` (999.999.999, la que atrapa el Excel argentino que lee `2136004.80`
  como `213600480`) suma el sugerido a los campos que revisa.
- `precio_sin_iva` se calcula con `calcularPrecios`, no a mano.

### 6.4 La vista previa pasa a mostrar el cálculo

Hoy la vista previa vuelca las columnas crudas del archivo. Pasa a mostrar, por fila, lo que el
cliente pidió ver:

```
Código · Nombre · Env. · Lista Quimex · Costo (−42%) · Costo c/IVA · Sugerido público · Venta c/IVA
```

Es estrictamente más útil: si el mapeo está mal, se ve acá en números que el negocio reconoce, en
vez de tener que leer cabeceras. El mapeo está justo arriba para corregirlo.

Debajo, un resumen: *"1104 filas · 1104 con sugerido · 0 por costo"*.

### 6.5 Textos

- El helper del markup dice hoy *"Se aplica al costo para el precio de venta"*. Pasa a *"Se aplica
  al precio sugerido al público; si el producto no tiene sugerido, se aplica al costo"*.
- El `useState(50)` del markup default pasa a `MARKUP_DEFAULT`.

---

## 7. Pantalla de productos

### 7.1 La tabla

| Hoy | Nueva |
|---|---|
| Código · Nombre · Env. · Marca · P. Fábrica · % Markup · P. s/IVA · IVA · P. c/IVA | Código · Nombre · Env. · Marca · **Lista** · **Costo** · **Costo c/IVA** · **Sugerido** · % Markup · **Venta c/IVA** |

Se van de la tabla `P. s/IVA` y la columna `IVA`, para que las cinco columnas de precio entren sin
scroll horizontal en la notebook del negocio. **Siguen en el Excel y el PDF exportados** y en el
diálogo de edición, que es donde alguien las necesita. Es una decisión reversible: si molesta, se
vuelven a agregar.

En **Venta c/IVA** va una marquita chica: `sug.` si el precio salió del sugerido, `costo` si salió
del costo. Así se ve de un vistazo qué productos siguen con el cálculo viejo. La marquita `def` del
markup queda como está.

### 7.2 Exportar

El Excel y el PDF (`productos.index.tsx:189-230`) suman `Precio de lista`, `Costo c/IVA`,
`Sugerido al público` y `Venta c/IVA`, y conservan `P. s/IVA` e `IVA`.

### 7.3 Diálogo de alta / edición

Campo nuevo **Sugerido al público (c/IVA)**, debajo de Precio de lista. Vacío = sin sugerido.
Tocarlo recalcula la venta, igual que hoy tocar el costo o el markup. Los tres `recalcPrecio` /
`costoDeLista` locales se reemplazan por `calcularPrecios`.

Abajo del todo, donde hoy muestra el c/IVA, pasa a mostrar la cadena completa en chiquito:
`lista → costo → costo c/IVA → sugerido → venta`, para que se entienda de dónde sale el número.

---

## 8. Markup masivo (`aplicarMarkup`)

`src/lib/cobranzas.functions.ts:47`. Cambios:

- El `select` suma `precio_sugerido_publico, iva_porcentaje` (hoy trae `id, precio_fabrica,
  markup_porcentaje`).
- El precio nuevo sale de `calcularPrecios`, no de `fabrica × (1 + %)`.
- El contador `sin_costo` pasa a `sin_base`: un producto sin sugerido **y** sin costo no se puede
  recalcular. Se le guarda igual el markup (comportamiento actual, deliberado: cuando le carguen el
  costo, el precio se deriva solo) y se informa cuántos quedaron así.
- El texto del diálogo dice hoy *"Recalcula precio s/IVA = fábrica × (1 + %)"*. Pasa a *"Recalcula
  el precio de venta: sugerido al público × (1 + %), o costo × (1 + %) si el producto no tiene
  sugerido"*.

---

## 9. Qué NO se toca

- **El stock.** Nada de esto lo mueve. La regla del encabezado de `productos.importar.tsx` sigue
  vigente palabra por palabra (ver `2026-07-24-stock-no-es-envase-design.md`).
- **Las ventas ya emitidas.** Guardan su propio precio en `venta_items`; cambiar el catálogo no las
  altera. El `FOR UPDATE` que serializa `crear_venta` contra `aplicarMarkup`
  (`20260713130000_auditoria_correcciones.sql:236`) sigue haciendo su trabajo sin cambios.
- **La facturación AFIP.** Sigue leyendo `precio_sin_iva` + `iva_porcentaje`.
- **Los precios de producción.** La columna se agrega en `NULL`, todos los productos existentes
  caen en la rama `origen: "costo"` y **se comportan exactamente como hoy**. Los precios cambian
  recién cuando el negocio vuelva a importar la lista de Quimex con la columna mapeada. Sin
  sorpresas post-deploy.

---

## 10. Verificación

**Unit (`src/lib/precios.test.ts`):**

- La cadena con sugerido: lista 30.774,40 · desc 42 · sugerido 34.370,60 · markup 30 · IVA 21 →
  `precio_fabrica` 17.849,15 · `costo_c_iva` 21.597,47 · `precio_sin_iva` 36.927,09 ·
  `venta_c_iva` 44.681,78 · `origen: "sugerido"`.
- La misma entrada sin sugerido → 23.203,90 / 28.076,72 / `origen: "costo"`. Es el comportamiento
  viejo: prueba que nada existente se rompe.
- `sugerido = 0` y `sugerido = null` van los dos por la rama de costo.
- Markup propio del producto le gana al default.
- Ida y vuelta del redondeo: `precio_sin_iva × (1 + iva) ` no se despega más de un centavo de
  `sugerido × (1 + markup)`.

**Unit (`src/lib/importar-productos.test.ts`, que ya existe):**

- `autoMapear` con las cabeceras reales de la lista N° 125 (`CÓDIGO`, `DESCRIPCIÓN`, `ENV`,
  `PRECIO DE LISTA`, `Sugerido al público C/IVA`) manda el sugerido a `precio_sugerido_publico` y
  **no** a `iva_porcentaje` ni a `precio_sin_iva`.
- Una cabecera `PRECIO SUGERIDO AL PUBLICO` tampoco se la queda `precio_sin_iva`.
- Detección de columna mapeada dos veces.

**Integración:** importar sin mapear el sugerido no borra el `precio_sugerido_publico` guardado.

**Playwright** (según `procedimiento-desarrollo-quimex`): subir una planilla chica, ver las cinco
columnas en la vista previa con los números correctos, confirmar, y verificar la fila del producto
en `/productos` con la marquita `sug.`.

**Siempre:** `bun run test`, `bun run typecheck`, `bun run lint`.

---

## 11. Orden de implementación

1. Migración SQL (`20260729100000_precio_sugerido_publico.sql`) + regenerar `types.ts`.
2. `src/lib/precios.ts` + sus tests. Nada lo usa todavía.
3. `src/lib/importar-productos.ts`: campo, sinónimos, orden en `FIELDS_TARGET`, detección de
   columna duplicada. Tests de mapeo.
4. `productos.importar.tsx`: usa `calcularPrecios`, avisos, vista previa de cinco columnas, textos.
5. `productos.index.tsx`: tabla, exportaciones, diálogo de edición. Se borran `calcPrecio` y
   `costoDeLista` locales.
6. `cobranzas.functions.ts`: `aplicarMarkup`.
7. Playwright.

Del 2 al 6 el sistema queda funcionando en cada paso: la rama `origen: "costo"` es idéntica al
comportamiento actual, así que no hay un estado intermedio roto.

## 12. Después del deploy

Volver a importar la lista de Quimex una vez, con **Sugerido al público (C/IVA)** mapeado. Recién
ahí cambian los precios. Conviene hacerlo con el negocio mirando: es el momento en que la góndola
pasa de $28.076 a $44.681 y nadie se tiene que sorprender.
