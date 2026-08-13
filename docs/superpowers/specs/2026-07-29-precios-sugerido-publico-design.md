# Precio de venta desde el sugerido al público — Diseño

**Fecha:** 2026-07-29
**Estado:** Implementado y verificado. Spec revisado con Codex (§13, 9 hallazgos). Código revisado
con Codex y tres agentes adversariales (§14, 20 hallazgos). 171 unit tests + e2e con navegador real
(`scripts/test-precios-sugerido-e2e.mjs`). Pendiente: deploy y reimportación de la lista (§12).
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

  Cuatro copias de la fórmula, más dos fallbacks sueltos del markup default en 50
  (`productos.importar.tsx:78`, `productos.index.tsx:86`) cuando `settings` de producción dice 30.
  Cambiar la fórmula en una sola no alcanza.

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
- **Volver read-only el precio de venta.** Se puede seguir poniendo un precio a dedo; lo que cambia
  es que el sistema lo declara (§3.3) en vez de disfrazarlo de calculado.
- **Historial de precios.** No se pidió y no existe hoy.
- **Batchear los `UPDATE` de `aplicarMarkup` y los `upsert` de la importación.** Los dos hacen un
  round-trip por producto. La LECTURA sí se troceó (era un bug: cortaba en 1000, §14.6); las
  escrituras siguen de a una para poder informar el error de cada fila. Con 1104 productos son 3 a 6
  minutos, y por eso la pantalla muestra el progreso y avisa antes de cerrar la pestaña (§6.6). Si
  molesta, se batchea en el chunk del filtro por proveedor.

---

## 3. La cadena de precios nueva

```
DATOS QUE TRAE LA LISTA DEL PROVEEDOR
  precio_lista                          s/IVA    obligatorio para derivar el costo
  precio_sugerido_publico               c/IVA    opcional — sólo Quimex lo trae

COSTO (lo que le pagan al proveedor)
  precio_fabrica = costoDeLista(precio_lista, descuento)         s/IVA
                 = precio_lista × (1 − descuento/100)
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

### 3.1 El costo NO se re-deriva dentro del cálculo de venta

`calcularPrecios` recibe el `precio_fabrica` **ya resuelto**; no lo vuelve a derivar de
`precio_lista`. Derivar el costo es un paso aparte (`costoDeLista`) que llaman sólo los dos lugares
que **ingieren** un precio de lista: la importación y el `onChange` del campo *Precio de lista* del
diálogo.

Importa porque hoy el diálogo deja **editar el costo a mano** aunque el producto tenga precio de
lista (`productos.index.tsx:674`). Si `calcularPrecios` hiciera ganar siempre a la lista, el
markup masivo le pisaría ese costo editado sin que nadie lo pida. Separando las dos operaciones,
`aplicarMarkup` sigue comportándose exactamente como hoy: usa el costo guardado, tal cual está.

### 3.2 Precedencia del precio de venta

Un mismo producto puede tener tres fuentes de precio. Gana la más específica:

```
1. precio_sin_iva mapeado en la planilla, con valor > 0     ← lo respeta tal cual (es de hoy)
2. precio_sugerido_publico > 0                              ← sugerido × (1 + markup)
3. precio_fabrica > 0                                       ← costo × (1 + markup)
```

El caso 1 se mantiene porque ya existe (`productos.importar.tsx:215-221`) y es lo que permite
importar una lista que ya trae el precio final calculado. Sacarlo sería romper un camino que hoy
funciona, sin que nadie lo haya pedido.

### 3.3 Dos preguntas distintas, dos funciones

Un producto necesita responder dos cosas que se confunden fácil:

| Pregunta | Función | Qué devuelve |
|---|---|---|
| ¿De qué dato sale su precio? | `baseDelPrecio` | `sugerido` si tiene uno cargado, si no `costo`, si no `manual` |
| ¿El precio guardado es el que da la fórmula hoy? | `coincideConFormula` | `true` / `false` |

La primera es un **hecho** sobre lo que el producto tiene cargado: no puede mentir. La segunda es un
**chequeo** contra los parámetros actuales.

Separarlas importa. Un intento anterior las mezclaba en un solo `origen` que devolvía `"manual"`
cuando el precio no coincidía — y eso **acusa a quien no hizo nada**: alcanza con cambiar el markup
default de 30 a 35 para que ~1100 productos que nadie tocó pasen a decir "precio puesto a mano". Con
las dos separadas, esos productos siguen diciendo `sugerido` (que es verdad) y suman un `≠` neutro
que dice lo único que se sabe: *este precio no sale de la fórmula actual, puede estar a mano o
calculado con un markup anterior*.

**El precio de venta sigue siendo editable a mano.** No se vuelve read-only: se vuelve honesto. El
diálogo deja escribirlo (`productos.index.tsx`) y el alta rápida de Ingresos de mercadería crea
productos con el neto directo (`20260724110000_ingresos_mercaderia_rpcs.sql:442`): los dos son
caminos legítimos.

---

## 4. Base de datos

Una columna y un default.

```sql
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS precio_sugerido_publico numeric(14,2)
    CHECK (precio_sugerido_publico IS NULL OR precio_sugerido_publico >= 0);

COMMENT ON COLUMN public.productos.precio_sugerido_publico IS
  'Precio sugerido al público que publica el proveedor en su lista, CON IVA incluido. NULL = la
   lista no lo trae. Cuando existe, el precio de venta se deriva de acá:
   precio_sin_iva = precio_sugerido_publico × (1 + markup/100) / (1 + iva/100).';

-- El negocio trabaja con 30%. La tabla se creó con DEFAULT 50 y producción ya
-- tiene 30 cargado; esto alinea las instalaciones nuevas. NO se toca la fila
-- existente: cambiar el markup de un catálogo cargado es decisión del negocio.
ALTER TABLE public.settings
  ALTER COLUMN markup_default_porcentaje SET DEFAULT 30;
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
export const ALICUOTAS_IVA = [0, 2.5, 5, 10.5, 21, 27] as const;

/** Costo desde el precio de lista del proveedor. Se llama SOLO al ingerir una lista. */
export function costoDeLista(lista: number, descuento: number): number;

/** Devuelve una alícuota válida de AFIP, o 21 si el valor no lo es. */
export function normalizarIva(v: unknown): number;

export type EntradaPrecio = {
  precio_fabrica?: number | null;          // ya resuelto (ver §3.1)
  precio_sugerido_publico?: number | null;
  precio_sin_iva?: number | null;          // sólo el override explícito de §3.2 caso 1
  markup_porcentaje?: number | null;
  iva_porcentaje?: number | null;
};

export type PrecioCalculado = {
  costo_c_iva: number;       // display
  precio_sin_iva: number;    // lo que se guarda y se factura
  venta_c_iva: number;       // display, derivado de precio_sin_iva
  markup: number;            // el efectivo (propio o default)
  origen: "sugerido" | "costo" | "manual";
};

export function calcularPrecios(
  e: EntradaPrecio,
  p: { markupDefault: number },
): PrecioCalculado;

/** Para la tabla: qué explica el precio YA guardado (§3.3). */
export function origenDelPrecio(
  producto: EntradaPrecio & { precio_sin_iva: number },
  p: { markupDefault: number },
): "sugerido" | "costo" | "manual";
```

`calcularPrecios` **calcula** el precio (importación, diálogo, markup masivo). `origenDelPrecio`
**explica** un precio ya guardado (la tabla, el badge). Son dos preguntas distintas y por eso son
dos funciones: la primera decide, la segunda audita.

`normalizarIva` existe porque el IVA pasó a ser un divisor: con el cálculo viejo un IVA basura sólo
ensuciaba la vista; ahora corrompe el neto que se factura. La validación actual del importador
acepta cualquier cosa en `[0,100]` (`productos.importar.tsx:257`) mientras la base sólo admite las
alícuotas de AFIP (`20260713130000_auditoria_correcciones.sql:54`).

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
cabeceras en orden y las marca como usadas (`importar-productos.ts:82`). `precio_sin_iva` tiene
`"precio"` entre sus sinónimos (`importar-productos.ts:44`), así que una cabecera
`PRECIO SUGERIDO AL PUBLICO` se la quedaría él si fuera primero. Poniéndolo antes, el sugerido
gana.

*(La cabecera exacta de Quimex, `Sugerido al público C/IVA`, hoy ya no se engancha al % de IVA:
existe una guarda específica para eso en `importar-productos.ts:92`. El reordenamiento no es para
arreglar eso, es para `precio_sin_iva`.)*

**Guarda nueva: una columna "sugerido" que sea NETA no puede caer acá.** El campo asume un valor
**c/IVA** y lo divide por `(1 + iva/100)`. Si una planilla trae `PVP S/IVA` o
`Precio sugerido s/IVA`, el sinónimo amplio (`pvp`, `sugerido`) se la llevaría y el sistema
dividiría por IVA un número que ya era neto: los precios bajarían ~17% en silencio. Se descarta
cualquier candidato cuya cabecera normalizada contenga `siva` sin contener `civa`:

```
"Sugerido al público C/IVA"  → sugeridoalpublicociva  → tiene "civa"  → OK
"PVP S/IVA"                  → pvpsiva                → tiene "siva"  → descartado
"Precio sugerido s/IVA"      → preciosugeridosiva     → tiene "siva"  → descartado
```

Es el mismo patrón que ya usa la guarda de `iva_porcentaje`: un sinónimo amplio con una excepción
explícita, en vez de una lista de sinónimos larguísima e imposible de mantener.

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
- El IVA pasa por `normalizarIva` antes de usarse como divisor.
- `precio_sin_iva` se calcula con `calcularPrecios`, no a mano.

#### Omitir la columna no alcanza: hay que leer el sugerido guardado

Omitir `precio_sugerido_publico` del payload conserva la columna, **pero no el precio**. El
importador manda `precio_sin_iva` en cada fila, siempre (`productos.importar.tsx:243-272`). Si la
columna no está mapeada, `calcularPrecios` no ve sugerido, cae en la rama de costo y **pisa el neto
derivado del sugerido con uno derivado del costo** — exactamente el bug que esta spec arregla,
reintroducido en silencio por una importación a la que se le olvidó mapear una columna.

Por eso: **cuando la columna no está mapeada, antes del loop se trae el sugerido ya guardado**, por
código, y se lo pasa a `calcularPrecios`.

```
si NO está mapeado precio_sugerido_publico:
    traer de productos: codigo → precio_sugerido_publico     (traerTodo, una query paginada)
    para cada fila: usar el sugerido de ese mapa
si SÍ está mapeado:
    usar el de la planilla (o null si la celda está vacía)
```

Se usa `traerTodo` de `src/lib/supabase-paginado.ts` — la misma defensa contra el corte silencioso
de PostgREST en 1000 filas que ya usa `/productos`. Con 1104 productos, sin paginar, el mapa
saldría incompleto y el bug volvería sólo para los últimos 104.

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

En **Venta c/IVA** va una marquita chica con el resultado de `origenDelPrecio` (§3.3): `sug.` si el
precio se explica por el sugerido, `costo` si se explica por el costo, `manual` si no se explica por
ninguno de los dos. Así se ve de un vistazo qué productos siguen con el cálculo viejo y cuáles
tienen un precio puesto a dedo. La marquita `def` del markup queda como está.

### 7.2 Exportar

El Excel y el PDF (`productos.index.tsx:189-230`) suman `Precio de lista`, `Costo c/IVA`,
`Sugerido al público` y `Venta c/IVA`, y conservan `P. s/IVA` e `IVA`.

### 7.3 Diálogo de alta / edición

Campo nuevo **Sugerido al público (c/IVA)**, debajo de Precio de lista. Vacío = sin sugerido.
Tocarlo recalcula la venta, igual que hoy tocar el costo o el markup. Los `calcPrecio` /
`costoDeLista` locales se reemplazan por los de `precios.ts`.

Qué recalcula qué (el modelo actual de interacción no cambia):

| Campo que tocás | Efecto |
|---|---|
| Precio de lista | recalcula el costo (`costoDeLista`) y después la venta |
| Sugerido al público | recalcula la venta |
| Costo / % Markup | recalcula la venta |
| **Precio s/IVA** | **no recalcula nada — es el override manual** |

Abajo del todo, donde hoy muestra el c/IVA, pasa a mostrar la cadena completa en chiquito:
`lista → costo → costo c/IVA → sugerido → venta`, para que se entienda de dónde sale el número.

**Aviso de precio manual.** Si el `precio_sin_iva` cargado no coincide con lo que da la fórmula
(o sea, `origenDelPrecio` devuelve `manual`), abajo del campo aparece en gris:
*"la fórmula daría $X — este precio está puesto a mano"*, con un botón chiquito para volver al
calculado. No bloquea nada: poner un precio a dedo es legítimo (una promo, un producto raro). Lo
que no puede pasar es que se haga sin darse cuenta y después la tabla muestre `sug.` sobre un
precio que el sugerido no explica.

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

- La cadena con sugerido: costo 17.849,15 · sugerido 34.370,60 · markup 30 · IVA 21 →
  `costo_c_iva` 21.597,47 · `precio_sin_iva` 36.927,09 · `venta_c_iva` 44.681,78 ·
  `origen: "sugerido"`.
- `costoDeLista(30.774,40, 42)` → 17.849,15.
- La misma entrada sin sugerido → 23.203,90 / 28.076,72 / `origen: "costo"`. Es el comportamiento
  viejo: prueba que nada existente se rompe.
- `sugerido = 0` y `sugerido = null` van los dos por la rama de costo.
- Markup propio del producto le gana al default.
- Precedencia §3.2: con `precio_sin_iva` explícito > 0, gana ese aunque haya sugerido y costo.
- Ida y vuelta del redondeo: `precio_sin_iva × (1 + iva)` no se despega más de un centavo de
  `sugerido × (1 + markup)`.
- `origenDelPrecio`: mismo producto con el precio guardado a mano → `"manual"`; con el precio
  derivado → `"sugerido"` / `"costo"`; con un centavo de diferencia → sigue siendo el derivado
  (tolerancia).
- `normalizarIva`: 21 / 10.5 / 0 pasan; 34370.6, 105, −1, `"abc"` y `null` caen a 21.
- Sugerido absurdo (999.999.999.999) no revienta el `numeric(14,2)` del neto: se atrapa antes.

**Unit (`src/lib/importar-productos.test.ts`, que ya existe):**

- `autoMapear` con las cabeceras reales de la lista N° 125 (ya están en el fixture `LISTA_PLANA`)
  manda ` Sugerido al público C/IVA ` a `precio_sugerido_publico`.
- El test existente *"no engancha 'Sugerido al público C/IVA' al % de IVA"* tiene que seguir
  pasando.
- Una cabecera `PRECIO SUGERIDO AL PUBLICO` va al sugerido y **no** a `precio_sin_iva`.
- **`PVP S/IVA` y `Precio sugerido s/IVA` NO van al sugerido** (guarda `siva`/`civa` de §6.1).
- El test existente *"no reutiliza una misma columna para dos campos"* tiene que seguir pasando.
- La detección de columna mapeada dos veces marca el caso de la captura del cliente
  (`PRECIO DE LISTA` en `precio_lista` y en `precio_fabrica`).

**Integración (contra la base local):**

- Importar **sin** mapear el sugerido, sobre productos que ya lo tienen: no se borra la columna
  **y `precio_sin_iva` sigue derivado del sugerido** (el bloqueante de §6.3). Este es el test que
  importa: sin él la regresión es invisible.
- Importar con el sugerido mapeado y una celda vacía → ese producto queda en `null` y su precio
  pasa a la rama de costo.
- El corte de 1000 filas: con más de 1000 productos cargados, el mapa de sugeridos los trae a
  todos.
- `aplicarMarkup` sobre un set mixto (con sugerido / sin sugerido / sin nada) → recalcula por la
  rama correcta cada uno y cuenta bien `sin_base`.

**Playwright** (según `procedimiento-desarrollo-quimex`): subir una planilla chica, ver las cinco
columnas en la vista previa con los números correctos, confirmar, y verificar la fila del producto
en `/productos` con la marquita `sug.`.

**Siempre:** `bun run test`, `bun run typecheck`, `bun run lint`.

---

## 11. Orden de implementación

1. Migración SQL (`20260729100000_precio_sugerido_publico.sql`): columna + `CHECK` + `COMMENT` +
   `SET DEFAULT 30` en settings. Regenerar `types.ts`.
2. `src/lib/precios.ts` + `precios.test.ts`: `costoDeLista`, `normalizarIva`, `calcularPrecios`,
   `origenDelPrecio`. Nada lo usa todavía.
3. `src/lib/importar-productos.ts`: campo nuevo, sinónimos, orden en `FIELDS_TARGET`, guarda
   `siva`/`civa`, detección de columna mapeada dos veces. Tests de mapeo.
4. `productos.importar.tsx`: mapa de sugeridos guardados (§6.3), `calcularPrecios`, avisos, vista
   previa de cinco columnas, textos, `normalizarIva`, `LIMITE`.
5. `productos.index.tsx`: tabla + badge de origen, exportaciones, diálogo de edición con el campo
   nuevo y el aviso de precio manual. Se borran `calcPrecio` y `costoDeLista` locales.
6. `cobranzas.functions.ts`: `aplicarMarkup` con `calcularPrecios` y `sin_base`.
7. Tests de integración contra la base local.
8. Playwright.

Del 2 al 6 el sistema queda funcionando en cada paso: sin sugeridos cargados, todo cae en la rama
`origen: "costo"`, que es idéntica al comportamiento actual. No hay un estado intermedio roto.

## 12. Después del deploy

Volver a importar la lista de Quimex una vez, con **Sugerido al público (C/IVA)** mapeado. Recién
ahí cambian los precios. Conviene hacerlo con el negocio mirando: es el momento en que la góndola
pasa de $28.076 a $44.681 y nadie se tiene que sorprender.

---

## 13. Hallazgos del review del spec con Codex

Revisión adversarial del diseño, antes de implementar. Nueve hallazgos; todos incorporados.

### Bloqueantes

1. **Omitir la columna del payload no protegía el precio.** El importador manda `precio_sin_iva`
   siempre, así que una importación sin mapear el sugerido volvía a derivar del costo y pisaba el
   neto. El sugerido sobrevivía en la base, pero el precio no. → §6.3: se trae el sugerido guardado
   por código y se calcula con ese. Es el hallazgo más grave: reintroducía el bug original en
   silencio.
2. **La marquita `sug.` podía mentir.** El diálogo deja editar `precio_sin_iva` a mano
   (`productos.index.tsx:702`) y el alta rápida de Ingresos crea productos con el neto directo. →
   §3.3: `origen` se calcula comparando el precio guardado contra la fórmula, no suponiendo. Se
   agregó el estado `manual` y el aviso del §7.3. El precio sigue siendo editable: la corrección
   es de honestidad, no de permisos.

### Importantes

3. **Sinónimos amplios (`pvp`, `sugerido`) robaban columnas netas.** `PVP S/IVA` habría entrado
   como bruto y se lo habría dividido por IVA: −17% en todos esos precios. → guarda `siva`/`civa`
   en §6.1.
4. **El costo re-derivado de la lista contradecía el diálogo,** que deja editarlo a mano
   (`productos.index.tsx:674`), y le habría pisado ese valor en el markup masivo. → §3.1:
   `calcularPrecios` recibe el costo ya resuelto; derivarlo es un paso aparte.
5. **No estaba definido qué pasa con una columna `precio_sin_iva` mapeada.** → §3.2, precedencia
   explícita de tres niveles. Se conserva el comportamiento actual.
6. **`MARKUP_DEFAULT = 30` en el código no cambiaba el default de la base**, que es 50
   (`20260630021321…sql:5`). Producción ya tiene 30 cargado. → §4: `SET DEFAULT 30` para
   instalaciones nuevas, sin tocar la fila existente.
7. **El alta rápida de Ingresos de mercadería** crea productos con el neto directo, sin
   lista/costo/sugerido. → declarado en §3.3 como camino manual legítimo; `origen: "manual"` lo
   representa sin contradecir la "única fuente de verdad".

### Menores

8. **Validación de IVA.** El importador acepta cualquier valor en `[0,100]` mientras la base sólo
   admite alícuotas de AFIP. Con el IVA convertido en divisor eso corrompe el neto facturado. →
   `normalizarIva` en §5.
9. **Falta `CHECK >= 0` y `COMMENT`** en la columna nueva. → §4.

### Confirmaciones útiles (no requieren cambios)

Codex verificó que nada más depende de esto: la venta lee `productos.precio_sin_iva`
(`ventas.nueva.tsx:156`, y la RPC en `20260721170000…sql:222`), AFIP recalcula desde `venta_items`
y no desde `productos` (`fiscal.functions.ts:386`), Compras usa `precio_fabrica` como costo
(`compras.nueva.tsx:106`), Remitos no lee precios, y Stock/conteo tampoco. La condición es que el
importador deje el neto consistente — de ahí el peso del hallazgo 1.

---

## 14. Hallazgos del review del CÓDIGO

Cuatro revisiones independientes sobre el commit `7b61bef`: Codex, y tres agentes adversariales con
lentes distintos (corrección del cálculo, regresiones, flujo real de uso). Veinte hallazgos; todos
incorporados. Los tres más graves eran **preexistentes** y los habría disparado el paso §12 de este
mismo spec — reimportar la lista de Quimex.

### Lo que borraba datos

1. **Reimportar la lista borraba marca, categoría, unidad, stock mínimo y envase de los 1104
   productos.** El upsert mandaba esos campos **siempre**; la lista de Quimex es CÓDIGO /
   DESCRIPCIÓN / ENV. / PRECIO DE LISTA / Sugerido y no trae ninguno, así que quedaban en null / 0 /
   "unidad". Adiós al filtro por categoría, a la columna Marca y a las alertas de reposición de
   `/stock`. Es la misma clase de bug que puso el tamaño de envase como stock: **escribir un campo
   que el archivo no trae**. → la importación ahora sólo escribe lo que la planilla realmente tiene.
2. **Una celda vacía en la columna del sugerido borraba el sugerido guardado** y devolvía ese
   producto al cálculo por costo. La protección de §6.3 era por COLUMNA y tenía que ser por FILA:
   las listas de proveedor no llenan el sugerido en todos los renglones, y un blanco no significa
   "este producto ya no tiene precio sugerido". Había un test que bendecía el comportamiento
   equivocado; se dio vuelta.
3. **Una fila sin ningún precio dejaba el producto a $0** y se vendía así en el mostrador. Pasa con
   los renglones "consultar" o discontinuados. La vista previa muestra 10 filas de 1104, así que no
   se veía. → esas filas no se importan y se cuentan en rojo en el resumen.

### Lo que rompía precios

4. **`normalizarIva` perdió el parseo de números argentinos** (regresión introducida por este mismo
   cambio): un IVA `"10,5"` de un CSV se leía como 21. Antes eso sólo cambiaba lo que se le cobraba
   al cliente; ahora el IVA **divide** al sugerido, así que también decide el neto: ~8,7% menos por
   unidad para el negocio, y una alícuota mal declarada. → se parsea con `parseNumAr` **antes** de
   `normalizarIva`, que ahora documenta que sólo acepta números.
5. **El diálogo ponía el precio en $0 al tocar el IVA.** Regresión: antes el select de IVA no
   recalculaba. Un producto sin costo ni sugerido (los que crea el alta rápida de Ingresos de
   mercadería) daba fórmula = 0 y el form lo guardaba. → `recalcVenta` deja el precio como está
   cuando no hay de dónde calcular.
6. **`aplicarMarkup` se cortaba en 1000 productos, en silencio.** El `.in("id", ...)` no estaba
   paginado, y la pantalla ofrece "seleccionar los 1104 visibles": 104 quedaban con el precio viejo
   y el toast decía "1000 recalculados". → se lee en tandas de 500 y se aborta si falta alguno.
7. **`aplicarMarkup` con `sobrescribir_individual: false`** recalculaba con el % nuevo sin
   guardarlo, dejando precio y markup incoherentes. No es alcanzable desde la UI, pero la server fn
   lo acepta. → sin sobrescribir, cada producto conserva su markup y el % nuevo actúa de default.
8. **Un descuento > 100% escribía precios negativos** y dejaba el catálogo invendible
   (`crear_venta` los rechaza). → la guarda de valores absurdos ahora también mira el límite
   inferior.
9. **Un markup de 0% se convertía en 30%** (`|| MARKUP_DEFAULT`). Vender al costo es una decisión
   válida, no un campo vacío.

### Lo que mentía

10. **La marquita se volvía ámbar en masa.** Con `origen` calculado por comparación, cambiar el
    markup default dejaba ~1100 productos diciendo "precio puesto a mano" sin que nadie los tocara.
    → se separó en `baseDelPrecio` (hecho) y `coincideConFormula` (chequeo), §3.3.
11. **`coincideConFormula` se comparaba contra sí misma** si se le pasaba el precio guardado a
    `calcularPrecios`: tomaba la rama del override explícito y todo coincidía siempre. → se excluye
    el precio guardado al calcular la fórmula, con test.
12. **El aviso "está puesto a mano" aparecía en un producto nuevo vacío**, diciendo "la fórmula
    daría $0,00".
13. **Al sacar la columna IVA de la tabla**, un producto mal seteado en 10,5% o Exento dejaba de
    verse — y es lo que se le factura a AFIP. → se muestra un chip con la alícuota **sólo cuando no
    es 21%**: la anomalía salta y el caso común no ocupa lugar.

### Lo que dejaba a alguien colgado

14. **Si fallaba la lectura del catálogo, el botón quedaba muerto para siempre** con el cartel
    "Leyendo el catálogo…". Error y carga eran el mismo estado. → tres estados, mensaje que dice qué
    pasó, y botón de reintentar.
15. **1103 upserts sin progreso ni guarda al cerrar la pestaña**: 3 a 6 minutos con sólo un spinner,
    que se lee como "se colgó". Cortarlo a la mitad deja medio catálogo a precio nuevo y medio al
    viejo. → contador "N de 1104", `beforeunload`, botón de volver deshabilitado, y un texto que
    aclara que reimportar el mismo archivo no duplica nada.
16. **El mapa de sugeridos quedaba viejo** si una importación fallaba y se reintentaba sin recargar.
    → se relee después de importar.

### Lo que no avisaba

17. **Una lista de actualización sin la columna del sugerido congela el precio de venta** en el
    sugerido de la lista anterior mientras el costo sube. Es mejor que degradar al costo, pero
    envejece: con un aumento de lista del 60% el margen se come solo y la pantalla no decía nada. →
    aviso con el número de productos afectados.
18. **Una columna de precio explícito le gana al sugerido** (§3.2) y lo anula sin que se note. →
    aviso.
19. **`sugeridoSinMapear` se callaba si la columna del sugerido estaba mapeada a otro campo** —
    justo lo que hizo el cliente (la mandó a "IVA %"), que es peor que no mapearla.
20. **Códigos con espacios de más** no encontraban su sugerido guardado (el mapa se indexaba con el
    código crudo y la fila se buscaba con `.trim()`). → se indexa recortado.

### Menores incorporados

Sinónimos `NETO` y `sin impuestos` en la guarda de columnas netas (`PVP NETO` habría entrado como
bruto). Un `·` colgado en el resumen del caso feliz. Textos: se sacó "mapear" del vocabulario de la
pantalla, los avisos nombran los campos concretos en vez de hablar en general, y el diálogo del
markup masivo explica la cuenta en castellano en vez de en notación matemática.

### Verificado, sin hallazgo

El redondeo (fuzz sobre miles de combinaciones de sugerido × markup × IVA: la deriva máxima es el
centavo declarado). La migración (idempotente, no recalcula nada, el `SET DEFAULT` sólo afecta
instalaciones nuevas). Ventas, facturación AFIP, remitos, compras, cuentas corrientes, ingresos y
stock: ninguno lee la columna nueva ni cambia de comportamiento. Y la afirmación central —"todo cae
en la rama por costo hasta que se reimporte"— se confirmó con los números reales de producción.
